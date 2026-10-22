import { createApplication } from './app.js';
import { loadConfig } from './config/env.js';
import { createLogger } from './logging/logger.js';
import { configureNetworkDefaults } from './network.js';

function serializeError(error: unknown): { message: string; stack?: string } {
  if (error instanceof Error) {
    return {
      message: error.message,
      ...(error.stack ? { stack: error.stack } : {}),
    };
  }

  return { message: String(error) };
}

async function main(): Promise<void> {
  configureNetworkDefaults();
  const config = loadConfig();
  const logger = createLogger(config);
  const application = createApplication(config, logger);

  let shutdownPromise: Promise<void> | undefined;

  const shutdown = (reason: string, exitCode = 0): Promise<void> => {
    if (shutdownPromise) {
      return shutdownPromise;
    }

    shutdownPromise = (async () => {
      logger.info({ reason }, 'STEMBot shutdown requested');

      const forceExitTimer = setTimeout(() => {
        logger.fatal({ reason }, 'STEMBot shutdown timed out');
        process.exit(1);
      }, config.shutdownTimeoutMs);

      try {
        await application.stop();
        process.exitCode = exitCode;
      } catch (error: unknown) {
        logger.error({ err: error }, 'Error during STEMBot shutdown');
        process.exitCode = 1;
      } finally {
        clearTimeout(forceExitTimer);
      }
    })();

    return shutdownPromise;
  };

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      void shutdown(signal);
    });
  }

  process.once('uncaughtException', (error: Error) => {
    logger.fatal({ err: error }, 'Uncaught exception');
    void shutdown('uncaughtException', 1);
  });

  process.once('unhandledRejection', (reason: unknown) => {
    logger.fatal({ reason }, 'Unhandled promise rejection');
    void shutdown('unhandledRejection', 1);
  });

  try {
    await application.start();
  } catch (error: unknown) {
    logger.fatal({ err: error }, 'STEMBot failed to start');
    await shutdown('startup-failure', 1);
  }
}

void main().catch((error: unknown) => {
  const serialized = serializeError(error);
  const payload = {
    error: serialized,
    level: 'fatal',
    service: 'stembot',
    message: 'STEMBot terminated unexpectedly',
  };

  process.stderr.write(`${JSON.stringify(payload)}\n`);
  process.exitCode = 1;
});
