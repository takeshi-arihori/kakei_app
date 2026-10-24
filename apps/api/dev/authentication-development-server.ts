import { createServer, type ServerResponse, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { getRequestListener } from '@hono/node-server';
import { createApp } from '../src/app.js';
import type { AuthenticationHttpHandler } from '../src/presentation/http/authentication/authentication-http.js';

const errorBody = (status: number) =>
  JSON.stringify({
    error: {
      code:
        status === 403
          ? 'REQUEST_REJECTED'
          : status === 503
            ? 'AUTHENTICATION_UNAVAILABLE'
            : 'INVALID_REQUEST',
      requestId: randomUUID(),
    },
  });
const reject = (outgoing: ServerResponse, status: number) => {
  outgoing.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    Connection: 'close',
  });
  outgoing.end(errorBody(status));
};

/**
 * Header切詰め/重複解釈の前に認証のTransport上限を強制する開発専用Server。
 * @param authentication 必須能力を組立済みの認証Handler。
 * @returns 未listenのServer。呼出し元が固定loopbackでのみlistenする。
 */
export const createAuthenticationDevelopmentServer = (
  authentication: AuthenticationHttpHandler,
): Server => {
  const app = createApp({ authentication });
  const listener = getRequestListener(app.fetch, {
    overrideGlobalObjects: false,
    hostname: 'localhost',
    errorHandler: () =>
      new Response(errorBody(503), {
        status: 503,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        },
      }),
  });
  const server = createServer(
    { maxHeaderSize: 16_384, headersTimeout: 5000, requestTimeout: 10_000 },
    (incoming, outgoing) => {
      if (incoming.rawHeaders.length > 128) {
        reject(outgoing, 400);
        return;
      }
      const seen = new Set<string>();
      for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
        const name = incoming.rawHeaders[index].toLowerCase();
        if (
          ![
            'origin',
            'x-kakei-request',
            'x-csrf-token',
            'sec-fetch-site',
            'content-type',
            'content-encoding',
            'host',
          ].includes(name)
        )
          continue;
        if (seen.has(name)) {
          reject(
            outgoing,
            name === 'content-type' ||
              name === 'content-encoding' ||
              name === 'host'
              ? 400
              : 403,
          );
          return;
        }
        seen.add(name);
      }
      void listener(incoming, outgoing).catch(() => {
        if (!outgoing.headersSent) reject(outgoing, 503);
        else outgoing.destroy();
      });
    },
  );
  // NodeのmaxHeadersCountによる黙示切詰めを無効化し、rawHeadersで明示拒否する。
  server.maxHeadersCount = 0;
  server.on('clientError', (_error, socket) => {
    if (!socket.writable) return;
    const body = errorBody(400);
    socket.end(
      `HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
    );
  });
  return server;
};
