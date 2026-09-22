import { buildApp } from './app.js';
import { createPool } from './db/pool.js';
import { loadServerConfig } from './env.js';
import { ensureDemoButton, ensureManagementTenant } from './lib/bootstrap.js';

async function main(): Promise<void> {
  const config = loadServerConfig();
  const pool = createPool(config.databaseUrl);
  // Before the app is built, because the app serves the demo key.
  const demo = config.demoButton ? await ensureDemoButton(pool, config) : undefined;
  const app = await buildApp({ config, pool, demoPublicKey: demo?.publicKey ?? null });

  if (demo !== undefined) {
    app.log.info(
      { tenantId: demo.tenantId, buttonId: demo.buttonId, created: demo.created },
      'demo button ready',
    );
  }

  if (config.managementSecret !== undefined) {
    const { tenantId, created } = await ensureManagementTenant(pool, config.managementSecret);
    app.log.info({ tenantId, created }, 'management tenant ready');
  }

  const shutdown = (signal: string): void => {
    app.log.info({ signal }, 'shutting down');
    void app
      .close()
      .then(() => pool.end())
      .catch((error: unknown) => {
        app.log.error({ err: error }, 'error during shutdown');
        process.exitCode = 1;
      });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  await app.listen({ port: config.port, host: config.host });
}

main().catch((error: unknown) => {
  // The process has no logger yet if config or the pool failed, so this is the
  // one place a bare console write is the right answer.
  console.error(error instanceof Error ? error.message : 'Failed to start server');
  process.exitCode = 1;
});
