import type { AppConfig } from './config/env.js';
import { createDiscordGateway, type DiscordGateway } from './discord/client.js';
import { createOpenAINumberRecognizer } from './integrations/openai.js';
import { createOpenAIStemAskAnswerer } from './integrations/openai-ask.js';
import { createOpenAIStemQuizEngine } from './integrations/openai-quiz.js';
import { createOpenAIScrambleWordGenerator } from './integrations/openai-scramble.js';
import { createStemCraftIntegration, type StemCraftIntegration } from './integrations/stemcraft.js';
import {
  createUptimeKumaIntegration,
  type UptimeKumaIntegration,
} from './integrations/uptime-kuma.js';
import { createWebsiteIntegration, type WebsiteIntegration } from './integrations/website.js';
import { IntervalJobScheduler, type JobScheduler } from './jobs/scheduler.js';
import type { AppLogger } from './logging/logger.js';
import { registerCommands } from './register-commands.js';
import {
  createCountingChainService,
  type CountingChainService,
} from './services/counting-chain.js';
import { createStemAskService, type StemAskService } from './services/stem-ask.js';
import {
  createWorkshopNotificationService,
  type WorkshopNotificationService,
} from './services/workshop-notifications.js';
import { createStemScrambleService, type StemScrambleService } from './services/scramble.js';
import { createStemQuizService, type StemQuizService } from './services/stem-quiz.js';
import { createStemWordChainService, type StemWordChainService } from './services/word-chain.js';
import { createUptimeStatusService, type UptimeStatusService } from './services/uptime-status.js';
import {
  createUserLevelService,
  type UserLevelAnnouncement,
  type UserLevelService,
} from './services/user-levels.js';
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
  uptime?: UptimeKumaIntegration;
  uptimeStatus?: UptimeStatusService;
  countingChain?: CountingChainService;
  quiz?: StemQuizService;
  scramble?: StemScrambleService;
  wordChain?: StemWordChainService;
  ask?: StemAskService;
  userLevels?: UserLevelService;
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
  const uptime =
    dependencies?.uptime ??
    (config.uptime.enabled && config.uptime.statusPageUrl
      ? createUptimeKumaIntegration({
          statusPageUrl: config.uptime.statusPageUrl,
          requestTimeoutMs: config.uptime.requestTimeoutMs,
        })
      : undefined);
  const state = dependencies?.state ?? createJsonFileStateStore(config.statePath, logger);
  const discordGatewayRef: { current?: DiscordGateway } = {};
  const userLevels =
    dependencies?.userLevels ??
    (config.levels.enabled
      ? createUserLevelService({
          config: config.levels,
          state,
          logger,
          ...(config.levels.announcementChannelId
            ? {
                announcementPublisher: {
                  send: async (announcement: UserLevelAnnouncement): Promise<void> => {
                    if (!discordGatewayRef.current) {
                      throw new Error('Discord gateway is not ready for level-up announcements');
                    }

                    await discordGatewayRef.current.sendChannelMessage(announcement.channelId, {
                      content: announcement.content,
                      ...(announcement.allowedUserIds && announcement.allowedUserIds.length > 0
                        ? { allowedMentions: { users: [...announcement.allowedUserIds] } }
                        : {}),
                    });
                  },
                },
              }
            : {}),
        })
      : undefined);
  const countingChain =
    dependencies?.countingChain ??
    (config.countingChain.enabled
      ? createCountingChainService({
          config: config.countingChain,
          recognizer: createOpenAINumberRecognizer({
            apiKey: config.openai.apiKey!,
            model: config.openai.model,
            reasoningEffort: config.openai.reasoningEffort,
            timeoutMs: config.openai.timeoutMs,
            logger,
          }),
          state,
          logger,
          ...(userLevels ? { userLevels } : {}),
        })
      : undefined);
  const quiz =
    dependencies?.quiz ??
    (config.quiz.enabled
      ? createStemQuizService({
          config: config.quiz,
          engine: createOpenAIStemQuizEngine({
            apiKey: config.openai.apiKey!,
            model: config.openai.model,
            reasoningEffort: config.openai.reasoningEffort,
            timeoutMs: config.openai.timeoutMs,
            logger,
          }),
          publisher: {
            send: (channelId, content) => {
              if (!discordGatewayRef.current) {
                return Promise.reject(new Error('Discord gateway is not ready for STEM quiz'));
              }

              return discordGatewayRef.current.sendChannelMessage(channelId, content);
            },
          },
          state,
          logger,
          ...(userLevels ? { userLevels } : {}),
        })
      : undefined);
  const scramble =
    dependencies?.scramble ??
    (config.scramble.enabled
      ? createStemScrambleService({
          config: config.scramble,
          generator: createOpenAIScrambleWordGenerator({
            apiKey: config.openai.apiKey!,
            model: config.openai.model,
            reasoningEffort: config.openai.reasoningEffort,
            timeoutMs: config.openai.timeoutMs,
            logger,
          }),
          publisher: {
            send: (channelId, content) => {
              if (!discordGatewayRef.current) {
                return Promise.reject(new Error('Discord gateway is not ready for STEM scramble'));
              }

              return discordGatewayRef.current.sendChannelMessage(channelId, content);
            },
          },
          state,
          logger,
          ...(userLevels ? { userLevels } : {}),
        })
      : undefined);
  const wordChain =
    dependencies?.wordChain ??
    (config.wordChain.enabled
      ? createStemWordChainService({
          config: config.wordChain,
          publisher: {
            send: (channelId, content) => {
              if (!discordGatewayRef.current) {
                return Promise.reject(
                  new Error('Discord gateway is not ready for STEM word chain'),
                );
              }

              return discordGatewayRef.current.sendChannelMessage(channelId, content);
            },
          },
          state,
          logger,
          ...(userLevels ? { userLevels } : {}),
        })
      : undefined);
  const ask =
    dependencies?.ask ??
    (config.ask.enabled
      ? createStemAskService({
          config: config.ask,
          answerer: createOpenAIStemAskAnswerer({
            apiKey: config.openai.apiKey!,
            model: config.openai.model,
            reasoningEffort: config.openai.reasoningEffort,
            timeoutMs: config.openai.timeoutMs,
            logger,
          }),
          state,
          logger,
        })
      : undefined);
  const discord =
    dependencies?.discord ??
    createDiscordGateway(config, logger, {
      website,
      stemcraft,
      timeZone: config.workshops.timeZone,
      ...(countingChain ? { countingChain } : {}),
      ...(quiz ? { quiz } : {}),
      ...(scramble ? { scramble } : {}),
      ...(wordChain ? { wordChain } : {}),
      ...(ask ? { ask } : {}),
      ...(userLevels ? { userLevels } : {}),
      ...(uptime ? { uptime } : {}),
    });
  discordGatewayRef.current = discord;
  const scheduler = dependencies?.scheduler ?? new IntervalJobScheduler(logger);
  const uptimeStatus =
    dependencies?.uptimeStatus ??
    (uptime && config.uptime.enabled && config.uptime.statusChannelId && config.uptime.statusPageUrl
      ? createUptimeStatusService({
          uptime,
          discord,
          state,
          logger,
          config: {
            statusPageUrl: config.uptime.statusPageUrl,
            statusChannelId: config.uptime.statusChannelId,
          },
        })
      : undefined);
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

  if (quiz && config.quiz.enabled) {
    scheduler.register({
      name: 'stem-quiz-maintenance',
      intervalMs: config.quiz.retryIntervalMs,
      run: () => quiz.ensureQuestion(),
    });
  }

  if (scramble && config.scramble.enabled) {
    scheduler.register({
      name: 'stem-scramble-maintenance',
      intervalMs: config.scramble.retryIntervalMs,
      run: () => scramble.ensureRound(),
    });
  }

  if (wordChain && config.wordChain.enabled) {
    scheduler.register({
      name: 'stem-word-chain-maintenance',
      intervalMs: config.wordChain.retryIntervalMs,
      run: () => wordChain.ensureRound(),
    });
  }

  if (uptimeStatus && config.uptime.enabled) {
    scheduler.register({
      name: 'uptime-status-synchronization',
      intervalMs: config.uptime.pollIntervalMs,
      run: () => uptimeStatus.synchronize(),
    });
  }

  let started = false;
  let stopped = false;

  return {
    async start(): Promise<void> {
      if (started) {
        return;
      }

      await state.load();

      try {
        await registerCommands(config, logger);
        await discord.start();
        scheduler.start();
        started = true;
        logger.info('STEMBot application started');
        void workshopNotifications.synchronizeWorkshops().catch((error: unknown) => {
          logger.error({ err: error }, 'Initial workshop synchronization failed');
        });
        if (uptimeStatus && config.uptime.enabled) {
          void uptimeStatus.synchronize().catch((error: unknown) => {
            logger.error({ err: error }, 'Initial uptime status synchronization failed');
          });
        }
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
