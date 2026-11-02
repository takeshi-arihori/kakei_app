import { readAuthenticationDevelopmentConfig } from './authentication-development-config.js';
import { openAuthenticationDevelopmentRuntime } from './authentication-development-runtime.js';
import { createAuthenticationDevelopmentServer } from './authentication-development-server.js';

// 通常mainと別の明示入口。失敗した設定/DB/SDKの詳細をconsoleへ出さない。
try {
  const config = readAuthenticationDevelopmentConfig(process.env);
  let leaseLost = false;
  let stop = () => {
    leaseLost = true;
    process.exitCode = 1;
  };
  const runtime = await openAuthenticationDevelopmentRuntime(process.env, () =>
    stop(),
  );
  if (leaseLost) {
    await runtime.close();
    throw new Error();
  }
  const server = createAuthenticationDevelopmentServer(runtime.authentication);
  let stopping = false;
  stop = () => {
    if (stopping) return;
    stopping = true;
    server.close();
    server.closeAllConnections();
    void runtime.close().catch(() => {
      process.exitCode = 1;
    });
  };
  server.on('error', () => {
    console.error('AUTH_DEVELOPMENT_START_FAILED');
    process.exitCode = 1;
    stop();
  });
  server.listen(config.port, config.hostname);
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
} catch {
  console.error('AUTH_DEVELOPMENT_START_FAILED');
  process.exitCode = 1;
}
