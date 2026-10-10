/**
 * Entrypoint: load config from env, open the store (Postgres, or in-memory with a loud warning),
 * listen, run maintenance jobs, and shut down gracefully on SIGTERM/SIGINT.
 *
 *   node --disable-warning=ExperimentalWarning src/index.ts [--dev]
 *
 * `--dev` enables the development IdP and the `log` mail transport (local use only).
 */
import { createCloudApp } from './app.ts';
import { type BlobStore, FsBlobStore } from './blob.ts';
import { type CloudConfig, ConfigError, enabledIdps, loadConfig } from './config.ts';
import { loadKeyMaterial } from './crypto.ts';
import { createLogger } from './logger.ts';
import { insecurePublicUrl } from './routes/oauth.ts';
import { S3BlobStore } from './s3.ts';
import { MemoryStore } from './store/memory.ts';
import { PgStore } from './store/pg.ts';
import type { Store } from './store/types.ts';

const logger = createLogger();

function readConfig(): CloudConfig {
  try {
    return loadConfig(process.env, process.argv.slice(2));
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`${err.message}\n`);
      process.exit(78); // EX_CONFIG
    }
    throw err;
  }
}

async function main(): Promise<void> {
  const config = readConfig();
  const keys = loadKeyMaterial(config);

  let store: Store;
  if (config.databaseUrl) {
    store = await PgStore.open({ connectionString: config.databaseUrl });
  } else {
    store = new MemoryStore();
    process.stderr.write(
      '\n*** GH_CLOUD_DATABASE_URL is not set: using the IN-MEMORY store. All accounts, patches and ***\n' +
        '*** settings are lost on restart. Never run like this in production.                     ***\n\n',
    );
  }
  if (config.devLogin) logger.warn({ msg: 'GH_CLOUD_DEV_LOGIN is enabled: anyone can sign in as any email' });
  if (insecurePublicUrl(config.publicUrl)) {
    logger.warn({
      msg: 'GH_CLOUD_PUBLIC_URL is plain http on a non-loopback host; put TLS in front of this server',
    });
  }

  const blobs: BlobStore = config.s3
    ? new S3BlobStore(config.s3, keys.secret)
    : new FsBlobStore(config.blobDir, keys.secret);
  const app = createCloudApp(config, { store, blobs, keys });
  const stopJobs = app.startJobs();

  app.server.listen(config.port, config.host, () => {
    const addr = app.server.address();
    logger.info({
      msg: 'githappens-cloud listening',
      port: typeof addr === 'object' && addr ? addr.port : config.port,
      idps: enabledIdps(config),
      store: store.kind,
      blobs: config.s3 ? `s3${config.s3.direct ? ' (direct)' : ''}` : 'fs',
    });
  });

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ msg: `received ${signal}, shutting down` });
    stopJobs();
    app.server.close(() => {
      void store.close().finally(() => {
        logger.info({ msg: 'shutdown complete' });
        process.exit(0);
      });
    });
    app.server.closeIdleConnections();
    setTimeout(() => {
      logger.warn({ msg: 'forcing shutdown' });
      app.server.closeAllConnections();
      process.exit(0);
    }, 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err: unknown) => {
  process.stderr.write(`githappens-cloud failed to start: ${(err as Error)?.message ?? String(err)}\n`);
  process.exit(1);
});
