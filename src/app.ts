import type { AppConfig } from './config/env.js';
import { createDiscordGateway, type DiscordGateway } from './discord/client.js';
import { createStemCraftIntegration, type StemCraftIntegration } from './integrations/stemcraft.js';
import { createWebsiteIntegration, type WebsiteIntegration } from './integrations/website.js';
import { IntervalJobScheduler, type JobScheduler } from './jobs/scheduler.js';
import type { AppLogger } from './logging/logger.js';
import {
  createWorkshopNotificationService,
  type WorkshopNotificationService,
} from './services/workshop-notifications.js';
import { createJsonFileStateStore } from './state/json-file-state-store.js';
import type { JsonState, StateStore } from './state/state-store.js';

export interface Application {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface ApplicationDependencies {
  discord: DiscordGateway;
  scheduler: JobScheduler;
  state: StateStore<JsonState>;
  website: WebsiteIntegration;
  stemcraft: StemCraftIntegration;
  workshopNotifications: WorkshopNotificationService;
}

export function createApplication(
  config: AppConfig,
  logger: AppLogger,
  dependencies?: Partial<ApplicationDependencies>,
): Application {
  const website =
    dependencies?.website ??
    createWebsiteIntegration({
      feedUrl: config.website.feedUrl,
      requestTimeoutMs: config.website.requestTimeoutMs,
      logger,
    });
  const stemcraft =
    dependencies?.stemcraft ??
    createStemCraftIntegration({
      statusUrl: config.stemcraft.statusUrl,
      requestTimeoutMs: config.stemcraft.requestTimeoutMs,
      logger,
      ...(config.stemcraft.token ? { token: config.stemcraft.token } : {}),
    });
  const discord =
    dependencies?.discord ??
    createDiscordGateway(config, logger, {
      website,
      stemcraft,
      timeZone: config.workshops.timeZone,
    });
  const scheduler = dependencies?.scheduler ?? new IntervalJobScheduler(logger);
  const state = dependencies?.state ?? createJsonFileStateStore(config.statePath, logger);
  const workshopNotifications =
    dependencies?.workshopNotifications ??
    createWorkshopNotificationService({
      website,
      discord,
      state,
      logger,
      config: config.workshops,
    });

  scheduler.register({
    name: 'workshop-synchronization',
    intervalMs: config.workshops.pollIntervalMs,
    run: () => workshopNotifications.synchronizeWorkshops(),
  });

  let started = false;
  let stopped = false;

  return {
    async start(): Promise<void> {
      if (started) {
        return;
      }

      await state.load();

      try {
        await discord.start();
        scheduler.start();
        started = true;
        logger.info('STEMBot application started');
        void workshopNotifications.synchronizeWorkshops().catch((error: unknown) => {
          logger.error({ err: error }, 'Initial workshop synchronization failed');
        });
      } catch (error: unknown) {
        scheduler.stop();
        throw error;
      }
    },

    async stop(): Promise<void> {
      if (stopped) {
        return;
      }

      stopped = true;
      scheduler.stop();
      await discord.stop();
      logger.info('STEMBot application stopped');
    },
  };
}
