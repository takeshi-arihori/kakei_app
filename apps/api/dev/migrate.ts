import { migrateAuthenticationDevelopmentDatabase } from './authentication-development-migrations.js';

try {
  await migrateAuthenticationDevelopmentDatabase(process.env);
} catch {
  console.error('AUTH_DEVELOPMENT_MIGRATION_FAILED');
  process.exitCode = 1;
}
