import type { AppConfig } from './config/env.js';
import { buildCakeDayCard } from './discord/cake-day-card.js';
import {
  createDiscordGateway,
  type DiscordChannelMessage,
  type DiscordGateway,
} from './discord/client.js';
import { toDiscordButtonRows } from './discord/button-components.js';
import { createOpenAINumberRecognizer } from './integrations/openai.js';
import { createOpenAIStemAskAnswerer } from './integrations/openai-ask.js';
import { createOpenAIStemQuizEngine } from './integrations/openai-quiz.js';
import { createOpenAIScrambleWordGenerator } from './integrations/openai-scramble.js';
import { createOpenAIStemWordChainValidator } from './integrations/openai-word-chain.js';
import { createOpenAIWordRevealGenerator } from './integrations/openai-word-reveal.js';
import { createOpenAICodeFixEngine } from './integrations/openai-code-fix.js';
import {
  createMinecraftProfileLookup,
  type MinecraftProfileLookup,
} from './integrations/minecraft-profile.js';
import {
  createMinecraftPlayerProfileLookup,
  type MinecraftPlayerProfileLookup,
} from './integrations/minecraft-player-profile.js';
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
  createAdminReminderService,
  type AdminReminderService,
} from './services/admin-reminders.js';
import {
  createCountingChainService,
  type CountingChainService,
} from './services/counting-chain.js';
import {
  createCakeDayService,
  type CakeDayAnnouncement,
  type CakeDayService,
} from './services/cake-days.js';
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
  createServerStatusNotificationService,
  type ServerStatusNotificationService,
} from './services/server-status-notifications.js';
import { createChatDiscordBridge, type ChatDiscordBridge } from './http/chat-discord-bridge.js';
import { createStemCodeFixService, type StemCodeFixService } from './services/code-fix.js';
import { createNumberGameService, type NumberGameService } from './services/number-game.js';
import { createConnectFourService, type ConnectFourService } from './services/connect-four.js';
import { createGlobalChaseService, type GlobalChaseService } from './services/global-chase.js';
import { createTicTacToeService, type TicTacToeService } from './services/tic-tac-toe.js';
import { createStemWordRevealService, type StemWordRevealService } from './services/word-reveal.js';
import {
  createUserLevelService,
  type UserLevelAnnouncement,
  type UserLevelService,
} from './services/user-levels.js';
import {
  createPlayerNotificationService,
  type PlayerNotificationService,
} from './services/player-notifications.js';
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
  serverStatusNotifications?: ServerStatusNotificationService;
  countingChain?: CountingChainService;
  quiz?: StemQuizService;
  scramble?: StemScrambleService;
  wordChain?: StemWordChainService;
  wordReveal?: StemWordRevealService;
  codeFix?: StemCodeFixService;
  reminders?: AdminReminderService;
  ask?: StemAskService;
  chatDiscordBridge?: ChatDiscordBridge;
  minecraftProfiles?: MinecraftProfileLookup;
  minecraftPlayerProfiles?: MinecraftPlayerProfileLookup;
  playerNotifications?: PlayerNotificationService;
  userLevels?: UserLevelService;
  numberGame?: NumberGameService;
  ticTacToe?: TicTacToeService;
  connectFour?: ConnectFourService;
  globalChase?: GlobalChaseService;
  cakeDays?: CakeDayService;
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
  const minecraftProfiles =
    dependencies?.minecraftProfiles ??
    createMinecraftProfileLookup({ requestTimeoutMs: config.stemcraft.requestTimeoutMs });
  const minecraftPlayerProfiles =
    dependencies?.minecraftPlayerProfiles ??
    (config.stemcraft.playerApiToken
      ? createMinecraftPlayerProfileLookup({
          apiUrl:
            config.stemcraft.playerApiUrl ??
            deriveMinecraftPlayerApiUrl(config.stemcraft.statusUrl),
          token: config.stemcraft.playerApiToken,
          requestTimeoutMs: config.stemcraft.requestTimeoutMs,
        })
      : undefined);
  const playerNotifications =
    dependencies?.playerNotifications ?? createPlayerNotificationService({ state, logger });
  const discordGatewayRef: { current?: DiscordGateway } = {};
  const serverStatusNotifications =
    dependencies?.serverStatusNotifications ??
    (config.serverStatus.offlineAlertsEnabled && config.serverStatus.offlineAlertChannelId
      ? createServerStatusNotificationService({
          stemcraft,
          state,
          logger,
          config: {
            enabled: config.serverStatus.offlineAlertsEnabled,
            channelId: config.serverStatus.offlineAlertChannelId,
            offlineThresholdMs: config.serverStatus.offlineAlertThresholdMs,
          },
          discord: {
            sendChannelMessage: (channelId, message) => {
              if (!discordGatewayRef.current) {
                return Promise.reject(
                  new Error('Discord gateway is not ready for server status notifications'),
                );
              }

              return discordGatewayRef.current.sendChannelMessage(channelId, message);
            },
          },
        })
      : undefined);
  const numberGame =
    dependencies?.numberGame ??
    createNumberGameService({
      state,
      logger,
    });
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

                    const message: DiscordChannelMessage = {
                      content: announcement.content,
                      ...(announcement.embeds ? { embeds: announcement.embeds } : {}),
                      ...(announcement.allowedUserIds && announcement.allowedUserIds.length > 0
                        ? { allowedMentions: { users: [...announcement.allowedUserIds] } }
                        : {}),
                    };
                    await discordGatewayRef.current.sendChannelMessage(
                      announcement.channelId,
                      message,
                    );
                  },
                },
              }
            : {}),
        })
      : undefined);
  const ticTacToe =
    dependencies?.ticTacToe ??
    (config.ticTacToe.enabled
      ? createTicTacToeService({
          config: config.ticTacToe,
          publisher: {
            send: (channelId, board) => {
              if (!discordGatewayRef.current) {
                return Promise.reject(new Error('Discord gateway is not ready for Tic Tac Toe'));
              }

              return discordGatewayRef.current.sendChannelMessage(channelId, {
                content: board.content,
                components: toDiscordButtonRows(board),
                allowedMentions: { parse: [] },
              });
            },
            edit: (channelId, messageId, board) => {
              if (!discordGatewayRef.current) {
                return Promise.reject(new Error('Discord gateway is not ready for Tic Tac Toe'));
              }

              return discordGatewayRef.current.editChannelMessage(channelId, messageId, {
                content: board.content,
                components: toDiscordButtonRows(board),
                allowedMentions: { parse: [] },
              });
            },
          },
          state,
          logger,
          ...(userLevels ? { userLevels } : {}),
        })
      : undefined);
  const connectFour =
    dependencies?.connectFour ??
    (config.connectFour.enabled
      ? createConnectFourService({
          config: config.connectFour,
          publisher: {
            send: (channelId, board) => {
              if (!discordGatewayRef.current) {
                return Promise.reject(new Error('Discord gateway is not ready for Connect 4'));
              }

              return discordGatewayRef.current.sendChannelMessage(channelId, {
                content: board.content,
                components: toDiscordButtonRows(board),
                allowedMentions: { parse: [] },
              });
            },
            edit: (channelId, messageId, board) => {
              if (!discordGatewayRef.current) {
                return Promise.reject(new Error('Discord gateway is not ready for Connect 4'));
              }

              return discordGatewayRef.current.editChannelMessage(channelId, messageId, {
                content: board.content,
                components: toDiscordButtonRows(board),
                allowedMentions: { parse: [] },
              });
            },
          },
          state,
          logger,
          ...(userLevels ? { userLevels } : {}),
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
          publisher: {
            send: (channelId, content) => {
              if (!discordGatewayRef.current) {
                return Promise.reject(
                  new Error('Discord gateway is not ready for counting-chain reminders'),
                );
              }

              return discordGatewayRef.current.sendChannelMessage(channelId, content);
            },
          },
          ...(userLevels ? { userLevels } : {}),
        })
      : undefined);
  const reminders =
    dependencies?.reminders ??
    (config.reminders.enabled
      ? createAdminReminderService({
          config: config.reminders,
          publisher: {
            send: (channelId, content, mentionUserId) => {
              if (!discordGatewayRef.current) {
                return Promise.reject(
                  new Error('Discord gateway is not ready for admin reminders'),
                );
              }

              return discordGatewayRef.current.sendChannelMessage(channelId, {
                content,
                allowedMentions: mentionUserId ? { users: [mentionUserId] } : { parse: [] },
              });
            },
          },
          state,
          logger,
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
          themeValidator: createOpenAIStemWordChainValidator({
            apiKey: config.openai.apiKey!,
            model: config.openai.model,
            reasoningEffort: config.openai.reasoningEffort,
            timeoutMs: config.openai.timeoutMs,
            logger,
          }),
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
  const wordReveal =
    dependencies?.wordReveal ??
    (config.wordReveal.enabled
      ? createStemWordRevealService({
          config: config.wordReveal,
          generator: createOpenAIWordRevealGenerator({
            apiKey: config.openai.apiKey!,
            model: config.openai.model,
            reasoningEffort: config.openai.reasoningEffort,
            timeoutMs: config.openai.timeoutMs,
            logger,
          }),
          publisher: {
            send: (channelId, message) => {
              if (!discordGatewayRef.current) {
                return Promise.reject(new Error('Discord gateway is not ready for Mystery Lab'));
              }

              return discordGatewayRef.current.sendChannelMessage(channelId, {
                ...message,
                allowedMentions: { parse: [] },
              });
            },
          },
          state,
          logger,
          ...(userLevels ? { userLevels } : {}),
        })
      : undefined);
  const codeFix =
    dependencies?.codeFix ??
    (config.codeFix.enabled
      ? createStemCodeFixService({
          config: config.codeFix,
          engine: createOpenAICodeFixEngine({
            apiKey: config.openai.apiKey!,
            model: config.openai.model,
            reasoningEffort: config.openai.reasoningEffort,
            timeoutMs: config.openai.timeoutMs,
            logger,
          }),
          publisher: {
            send: (channelId, content) => {
              if (!discordGatewayRef.current) {
                return Promise.reject(new Error('Discord gateway is not ready for Code Fix'));
              }

              return discordGatewayRef.current.sendChannelMessage(channelId, content);
            },
          },
          state,
          logger,
          ...(userLevels ? { userLevels } : {}),
        })
      : undefined);
  const globalChase =
    dependencies?.globalChase ??
    (config.globalChase.enabled
      ? createGlobalChaseService({
          config: config.globalChase,
          publisher: {
            send: (channelId, message) => {
              if (!discordGatewayRef.current) {
                return Promise.reject(new Error('Discord gateway is not ready for Global Chase'));
              }

              return discordGatewayRef.current.sendChannelMessage(channelId, {
                ...message,
                allowedMentions: { parse: [] },
              });
            },
            edit: (channelId, messageId, message) => {
              if (!discordGatewayRef.current) {
                return Promise.reject(new Error('Discord gateway is not ready for Global Chase'));
              }

              return discordGatewayRef.current.editChannelMessage(channelId, messageId, {
                ...message,
                allowedMentions: { parse: [] },
              });
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
  const chatDiscordBridge =
    dependencies?.chatDiscordBridge ??
    (config.chatDiscordBridge.enabled
      ? createChatDiscordBridge({
          config: config.chatDiscordBridge,
          publisher: {
            send: (channelId, message) => {
              if (!discordGatewayRef.current) {
                return Promise.reject(
                  new Error('Discord gateway is not ready for the Minecraft chat bridge'),
                );
              }

              return discordGatewayRef.current.sendChannelMessage(
                channelId,
                typeof message === 'string'
                  ? { content: message, allowedMentions: { parse: [] } }
                  : message,
              );
            },
          },
          state,
          logger,
          playerNotifications,
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
      ...(wordReveal ? { wordReveal } : {}),
      ...(codeFix ? { codeFix } : {}),
      ...(reminders ? { reminders } : {}),
      ...(ask ? { ask } : {}),
      ...(userLevels ? { userLevels } : {}),
      ...(numberGame ? { numberGame } : {}),
      ...(ticTacToe ? { ticTacToe } : {}),
      ...(connectFour ? { connectFour } : {}),
      ...(globalChase ? { globalChase } : {}),
      ...(uptime ? { uptime } : {}),
      ...(chatDiscordBridge ? { chatDiscordBridge } : {}),
      minecraftProfiles,
      ...(minecraftPlayerProfiles ? { minecraftPlayerProfiles } : {}),
      playerNotifications,
    });
  discordGatewayRef.current = discord;
  const cakeDayAnnouncementChannelId = config.cakeDays.announcementChannelId;
  const cakeDays =
    dependencies?.cakeDays ??
    (config.cakeDays.enabled && cakeDayAnnouncementChannelId
      ? createCakeDayService({
          config: config.cakeDays,
          timeZone: config.workshops.timeZone,
          state,
          logger,
          memberProvider: {
            getMembers: async () => {
              if (!discordGatewayRef.current) {
                throw new Error('Discord gateway is not ready for cake-day checks');
              }

              return discordGatewayRef.current.getGuildMembers();
            },
          },
          publisher: {
            send: async (announcement: CakeDayAnnouncement): Promise<void> => {
              if (!discordGatewayRef.current) {
                throw new Error('Discord gateway is not ready for cake-day announcements');
              }

              const card = await buildCakeDayCard(announcement);
              await discordGatewayRef.current.sendChannelMessage(announcement.channelId, {
                content: announcement.content,
                files: [{ attachment: card, name: 'stembot-cake-day.png' }],
                ...(announcement.allowedUserIds.length > 0
                  ? { allowedMentions: { users: [...announcement.allowedUserIds] } }
                  : {}),
              });
            },
          },
        })
      : undefined);
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

  if (cakeDays && config.cakeDays.enabled) {
    scheduler.register({
      name: 'cake-day-announcements',
      intervalMs: config.cakeDays.checkIntervalMs,
      run: () => cakeDays.check(),
    });
  }

  if (quiz && config.quiz.enabled) {
    scheduler.register({
      name: 'stem-quiz-maintenance',
      intervalMs: config.quiz.retryIntervalMs,
      run: async () => {
        await quiz.checkInactivity();
        await quiz.ensureQuestion();
      },
    });
  }

  if (scramble && config.scramble.enabled) {
    scheduler.register({
      name: 'stem-scramble-maintenance',
      intervalMs: config.scramble.retryIntervalMs,
      run: async () => {
        await scramble.checkInactivity();
        await scramble.ensureRound();
      },
    });
  }

  if (wordChain && config.wordChain.enabled) {
    scheduler.register({
      name: 'stem-word-chain-maintenance',
      intervalMs: config.wordChain.retryIntervalMs,
      run: async () => {
        await wordChain.checkInactivity();
        await wordChain.ensureRound();
      },
    });
  }

  if (wordReveal && config.wordReveal.enabled) {
    scheduler.register({
      name: 'stem-word-reveal-maintenance',
      intervalMs: config.wordReveal.retryIntervalMs,
      run: async () => {
        await wordReveal.checkInactivity();
        await wordReveal.ensureRound();
      },
    });
  }

  if (codeFix && config.codeFix.enabled) {
    scheduler.register({
      name: 'stem-code-fix-maintenance',
      intervalMs: config.codeFix.retryIntervalMs,
      run: async () => {
        await codeFix.checkInactivity();
        await codeFix.ensureChallenge();
      },
    });
  }

  if (ticTacToe && config.ticTacToe.enabled) {
    scheduler.register({
      name: 'tic-tac-toe-maintenance',
      intervalMs: config.ticTacToe.retryIntervalMs,
      run: async () => {
        await ticTacToe.checkInactivity();
        await ticTacToe.ensureRound();
      },
    });
  }

  if (connectFour && config.connectFour.enabled) {
    scheduler.register({
      name: 'connect-four-maintenance',
      intervalMs: config.connectFour.retryIntervalMs,
      run: async () => {
        await connectFour.checkInactivity();
        await connectFour.ensureRound();
      },
    });
  }

  if (globalChase && config.globalChase.enabled) {
    scheduler.register({
      name: 'global-chase-maintenance',
      intervalMs: config.globalChase.retryIntervalMs,
      run: async () => {
        await globalChase.checkInactivity();
        await globalChase.ensureRound();
      },
    });
  }

  if (reminders && config.reminders.enabled) {
    scheduler.register({
      name: 'admin-reminder-delivery',
      intervalMs: config.reminders.checkIntervalMs,
      run: () => reminders.deliverDueReminders(),
    });
  }

  if (countingChain && config.countingChain.enabled) {
    scheduler.register({
      name: 'counting-chain-maintenance',
      intervalMs: Math.min(config.countingChain.idleNudgeMs, 300000),
      run: () => countingChain.checkInactivity(),
    });
  }

  if (uptimeStatus && config.uptime.enabled) {
    scheduler.register({
      name: 'uptime-status-synchronization',
      intervalMs: config.uptime.pollIntervalMs,
      run: () => uptimeStatus.synchronize(),
    });
  }

  if (serverStatusNotifications && config.serverStatus.offlineAlertsEnabled) {
    scheduler.register({
      name: 'server-status-notifications',
      intervalMs: config.serverStatus.pollIntervalMs,
      run: () => serverStatusNotifications.synchronize(),
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
        await chatDiscordBridge?.start();
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
        if (serverStatusNotifications && config.serverStatus.offlineAlertsEnabled) {
          void serverStatusNotifications.synchronize().catch((error: unknown) => {
            logger.error({ err: error }, 'Initial server status notification check failed');
          });
        }
        if (cakeDays && config.cakeDays.enabled) {
          void cakeDays.check().catch((error: unknown) => {
            logger.error({ err: error }, 'Initial cake-day check failed');
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
      await chatDiscordBridge?.stop();
      await discord.stop();
      logger.info('STEMBot application stopped');
    },
  };
}

function deriveMinecraftPlayerApiUrl(statusUrl: string): string {
  const url = new URL(statusUrl);
  const statusPath = url.pathname.replace(/\/status\/?$/i, '').replace(/\/+$/, '');
  url.pathname = `${statusPath}/api/v1`;
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}
