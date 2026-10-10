/** Entrypoint: load config from env, listen, shut down gracefully on SIGTERM/SIGINT. */
import { type BrokerConfig, ConfigError, loadConfig, PROVIDER_IDS } from './config.ts';
import { createLogger } from './logger.ts';
import { isProviderEnabled } from './providers.ts';
import { createBroker } from './server.ts';

const logger = createLogger();

function readConfig(): BrokerConfig {
  try {
    return loadConfig(process.env);
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`${err.message}\n`);
      process.exit(78); // EX_CONFIG
    }
    throw err;
  }
}

function main(): void {
  const config = readConfig();
  const server = createBroker(config);
  server.listen(config.port, config.host, () => {
    const addr = server.address();
    logger.info({
      msg: 'oauth-broker listening',
      port: typeof addr === 'object' && addr ? addr.port : config.port,
      providers: PROVIDER_IDS.filter((id) => isProviderEnabled(config, id)),
    });
  });

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ msg: `received ${signal}, shutting down` });
    server.close(() => {
      logger.info({ msg: 'shutdown complete' });
      process.exit(0);
    });
    server.closeIdleConnections();
    // In-flight exchanges are bounded by the upstream timeout; don't wait forever.
    setTimeout(() => {
      logger.warn({ msg: 'forcing shutdown' });
      server.closeAllConnections();
      process.exit(0);
    }, config.upstreamTimeoutMs + 2_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main();
