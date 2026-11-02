import { createConnection } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAuthenticationDevelopmentServer } from './authentication-development-server.js';
const servers: ReturnType<typeof createAuthenticationDevelopmentServer>[] = [];
const start = async () => {
  const handler = vi.fn(() =>
    Promise.resolve(
      new Response(null, {
        status: 204,
        headers: { 'Set-Cookie': 'synthetic=one; HttpOnly' },
      }),
    ),
  );
  const server = createAuthenticationDevelopmentServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('試験Portが必要');
  const raw = (headers: string) =>
    new Promise<string>((resolve, reject) => {
      const socket = createConnection(address.port, '127.0.0.1');
      let response = '';
      socket.setTimeout(3000, () => {
        socket.destroy();
        reject(new Error('試験timeout'));
      });
      socket.on('connect', () =>
        socket.end(
          'POST /auth/google/attempt HTTP/1.1\r\nHost: localhost:3001\r\nConnection: close\r\nContent-Length: 2\r\n' +
            headers +
            '\r\n{}',
        ),
      );
      socket.on('data', (value) => {
        response += value.toString();
      });
      socket.on('end', () => resolve(response));
      socket.on('error', reject);
    });
  return { raw, handler };
};
afterEach(async () => {
  for (const server of servers.splice(0))
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
});
describe('Node開発入口のHTTP制限', () => {
  it('Header数上限を黙って切り捨てず、認証へ進む前に拒否する', async () => {
    const s = await start();
    const response = await s.raw(
      Array.from(
        { length: 65 },
        (_, n) => 'X-Synthetic-' + n + ': yes\r\n',
      ).join(''),
    );
    expect(response).toContain('400');
    expect(response.toLowerCase()).toContain('cache-control: no-store');
    expect(s.handler).not.toHaveBeenCalled();
  });
  it('Origin重複をNodeのHeader正規化より前に拒否する', async () => {
    const s = await start();
    const response = await s.raw(
      'Origin: http://localhost:3000\r\nOrigin: http://localhost:3000\r\n',
    );
    expect(response).toContain('403');
    expect(s.handler).not.toHaveBeenCalled();
  });
  it('Header総量のParser拒否でも入力/Stackを返さない', async () => {
    const s = await start();
    const response = await s.raw(
      'X-Synthetic: ' + 'private-token'.repeat(1600) + '\r\n',
    );
    expect(response).toContain('400');
    expect(response).not.toMatch(/private-token|Error|stack/);
    expect(s.handler).not.toHaveBeenCalled();
  });
});
