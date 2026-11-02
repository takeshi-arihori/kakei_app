// Browser E2E専用process。通常dev/ProductionからImportしない。
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import { Client } from 'pg';
import { gaxios } from 'google-auth-library';
import { migrateAuthenticationDevelopmentDatabase } from '../../dev/authentication-development-migrations.js';
import { openAuthenticationDevelopmentRuntime } from '../../dev/authentication-development-runtime.js';
import { createAuthenticationDevelopmentServer } from '../../dev/authentication-development-server.js';
if (
  process.env.NODE_ENV !== 'test' ||
  process.env.KAKEI_BROWSER_FIXTURE !== '1'
)
  throw new Error('Test専用入口です');
const observer = new Client({
  connectionString: process.env.TEST_DATABASE_URL,
  connectionTimeoutMillis: 3000,
});
const name = 'synthetic_219_' + randomUUID().replaceAll('-', '') + '_auth_dev';
let owned = false;
let stopped = false;
let runtime:
  Awaited<ReturnType<typeof openAuthenticationDevelopmentRuntime>> | undefined;
let api: ReturnType<typeof createAuthenticationDevelopmentServer> | undefined;
let control: ReturnType<typeof createServer> | undefined;
const stop = async () => {
  if (stopped) return;
  stopped = true;
  if (api) {
    await new Promise<void>((resolve) => {
      api!.close(() => resolve());
      api!.closeAllConnections();
    });
  }
  if (control) {
    await new Promise<void>((resolve) => {
      control!.close(() => resolve());
      control!.closeAllConnections();
    });
  }
  await runtime?.close();
  if (owned) await observer.query('DROP DATABASE ' + name + ' WITH (FORCE)');
  await observer.end();
};
const record = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null;
const read = async (req: IncomingMessage): Promise<unknown> => {
  let body = '';
  for await (const chunk of req) {
    body += String(chunk);
    if (body.length > 2048) throw new Error();
  }
  return JSON.parse(body);
};
try {
  await observer.connect();
  const info = (
    await observer.query<{ name: string; version: number }>(
      "SELECT current_database() AS name,current_setting('server_version_num')::int AS version",
    )
  ).rows[0];
  if (
    !info.name.endsWith('_test') ||
    info.version < 170000 ||
    info.version >= 180000
  )
    throw new Error();
  await observer.query('CREATE DATABASE ' + name);
  owned = true;
  const target = new URL(process.env.TEST_DATABASE_URL!);
  target.pathname = '/' + name;
  const env = {
    NODE_ENV: 'development',
    AUTH_DEV_DATABASE_URL: target.toString(),
    GOOGLE_CLIENT_ID: 'synthetic-browser.apps.googleusercontent.com',
  };
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const wrong = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const certificate = keys.publicKey.export({ type: 'spki', format: 'pem' });
  // Googleの公開鍵通信だけを隔離する。SDKの署名/Claim判定は実行する。
  Object.defineProperty(gaxios.Gaxios.prototype, 'request', {
    value: (options: unknown) => {
      if (
        !record(options) ||
        (typeof options.url !== 'string' && !(options.url instanceof URL))
      )
        throw new Error();
      if (String(options.url) !== 'https://www.googleapis.com/oauth2/v1/certs')
        throw new Error();
      return Promise.resolve(
        Object.assign(
          new Response(null, {
            headers: { 'cache-control': 'public, max-age=3600' },
          }),
          {
            config: {
              url: new URL(String(options.url)),
              headers: new Headers(),
            },
            data: { 'synthetic-browser-key': certificate },
          },
        ),
      );
    },
  });
  const realNow = Date.now;
  let offset = 0;
  Date.now = () => realNow() + offset;
  await migrateAuthenticationDevelopmentDatabase(env);
  runtime = await openAuthenticationDevelopmentRuntime(env, () => {
    void stop();
  });
  api = createAuthenticationDevelopmentServer(runtime.authentication);
  await new Promise<void>((resolve, reject) => {
    api!.once('error', reject);
    api!.listen(3001, '127.0.0.1', resolve);
  });
  control = createServer((req, res) => {
    void (async () => {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-store');
      if (req.method === 'POST' && req.url === '/credential') {
        const body = await read(req);
        if (
          !record(body) ||
          typeof body.nonce !== 'string' ||
          !/^[A-Za-z0-9_-]{43}$/.test(body.nonce)
        )
          throw new Error();
        const now = Math.floor(Date.now() / 1000);
        const payload = {
          iss: 'https://accounts.google.com',
          aud: env.GOOGLE_CLIENT_ID,
          sub: 'synthetic-219-browser-subject',
          nonce: body.mode === 'bad-nonce' ? 'wrong' : body.nonce,
          iat: now - 1,
          exp: now + 3600,
        };
        const parts = [{ alg: 'RS256', kid: 'synthetic-browser-key' }, payload]
          .map((v) => Buffer.from(JSON.stringify(v)).toString('base64url'))
          .join('.');
        const token =
          parts +
          '.' +
          sign(
            'RSA-SHA256',
            Buffer.from(parts),
            body.mode === 'bad-signature' ? wrong.privateKey : keys.privateKey,
          ).toString('base64url');
        res.end(JSON.stringify({ credential: token }));
      } else if (req.method === 'POST' && req.url === '/advance') {
        const body = await read(req);
        if (
          !record(body) ||
          typeof body.milliseconds !== 'number' ||
          !Number.isSafeInteger(body.milliseconds) ||
          body.milliseconds < 0 ||
          body.milliseconds > 172800000
        )
          throw new Error();
        offset += body.milliseconds;
        res.end('{}');
      } else if (req.method === 'GET' && req.url === '/state') {
        const db = new Client({ connectionString: target.toString() });
        try {
          await db.connect();
          const actors = (
            await db.query<{ count: number }>(
              'SELECT count(*)::int AS count FROM authentication.actor',
            )
          ).rows[0].count;
          const sessions = (
            await db.query<{ state: string; count: number }>(
              'SELECT state,count(*)::int AS count FROM authentication.session_record GROUP BY state',
            )
          ).rows;
          res.end(JSON.stringify({ actors, sessions }));
        } finally {
          await db.end();
        }
      } else {
        res.statusCode = 404;
        res.end('{}');
      }
    })().catch(() => {
      res.statusCode = 400;
      res.end('{}');
    });
  });
  await new Promise<void>((resolve, reject) => {
    control!.once('error', reject);
    control!.listen(0, '127.0.0.1', resolve);
  });
  const address = control.address();
  if (!address || typeof address === 'string') throw new Error();
  console.log(
    JSON.stringify({ fixtureReady: true, controlPort: address.port }),
  );
  process.once('SIGTERM', () => {
    void stop().catch(() => {
      process.exitCode = 1;
    });
  });
  process.once('SIGINT', () => {
    void stop().catch(() => {
      process.exitCode = 1;
    });
  });
} catch {
  console.error('AUTH_BROWSER_FIXTURE_FAILED');
  await stop().catch(() => {});
  process.exitCode = 1;
}
