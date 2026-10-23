import {
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  PermissionsBitField,
  type APIEmbed,
  type Message,
  type MessageMentionOptions,
  type MessageReaction,
  type PartialMessageReaction,
  type PartialUser,
  type User,
} from 'discord.js';
import { hostname } from 'node:os';

import type { AppConfig } from '../config/env.js';
import type { StemCraftIntegration } from '../integrations/stemcraft.js';
import type { UptimeKumaIntegration } from '../integrations/uptime-kuma.js';
import type { WebsiteIntegration } from '../integrations/website.js';
import type { AppLogger } from '../logging/logger.js';
import { configureNetworkDefaults } from '../network.js';
import type {
  CountingChainGameStatus,
  CountingChainHistoryMessage,
  CountingChainInfoPublisher,
  CountingChainMessage,
  CountingChainReplyOptions,
  CountingChainService,
} from '../services/counting-chain.js';
import type { StemAskMessage, StemAskService } from '../services/stem-ask.js';
import type { StemScrambleMessage, StemScrambleService } from '../services/scramble.js';
import type { StemQuizMessage, StemQuizService } from '../services/stem-quiz.js';
import type {
  MinigameLeaderboardEntry,
  MinigameLeaderboardProvider,
} from '../services/minigame-leaderboards.js';
import type { UserLevelService } from '../services/user-levels.js';
import type { StemWordChainMessage, StemWordChainService } from '../services/word-chain.js';
import { handleInteraction } from './interaction-handler.js';

const COUNTING_CHAIN_EMBED_SETTLE_MS = 2_000;

export interface DiscordGateway {
  start(): Promise<void>;
  stop(): Promise<void>;
  getGatewayPing(): number;
  sendChannelMessage(channelId: string, message: DiscordChannelMessage | string): Promise<string>;
  editChannelMessage(
    channelId: string,
    messageId: string,
    message: DiscordChannelMessage | string,
  ): Promise<boolean>;
}

export interface DiscordChannelMessage {
  content?: string;
  embeds?: APIEmbed[];
  allowedMentions?: MessageMentionOptions;
  /** Internal image URL that is downloaded and attached to the message. */
  heroImageUrl?: string;
  /** Publish the sent message to followers when this is an announcement-channel message. */
  crosspost?: boolean;
}

export interface DiscordCommandDependencies {
  website: WebsiteIntegration;
  stemcraft: StemCraftIntegration;
  timeZone: string;
  countingChain?: CountingChainService;
  quiz?: StemQuizService;
  scramble?: StemScrambleService;
  wordChain?: StemWordChainService;
  ask?: StemAskService;
  userLevels?: UserLevelService;
  uptime?: UptimeKumaIntegration;
}

export function createDiscordGateway(
  config: AppConfig,
  logger: AppLogger,
  dependencies: DiscordCommandDependencies,
): DiscordGateway {
  configureNetworkDefaults();

  const intents = [GatewayIntentBits.Guilds];
  const askMessageTrackingEnabled = Boolean(config.ask.enabled && dependencies.ask);
  const messageTrackingEnabled =
    (config.countingChain.enabled && dependencies.countingChain) ||
    (config.quiz.enabled && dependencies.quiz) ||
    (config.scramble.enabled && dependencies.scramble) ||
    (config.wordChain.enabled && dependencies.wordChain) ||
    askMessageTrackingEnabled ||
    (config.levels.enabled && dependencies.userLevels);
  const reactionTrackingEnabled =
    (config.countingChain.enabled && config.countingChain.reviewEnabled) || config.levels.enabled;
  if (messageTrackingEnabled) {
    intents.push(GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent);
  }
  if (askMessageTrackingEnabled) {
    intents.push(GatewayIntentBits.DirectMessages);
  }
  if (reactionTrackingEnabled) {
    intents.push(GatewayIntentBits.GuildMessageReactions);
  }

  const partials = reactionTrackingEnabled
    ? [Partials.Channel, Partials.Message, Partials.Reaction, Partials.User]
    : askMessageTrackingEnabled
      ? [Partials.Channel]
      : undefined;
  const clientOptions = {
    intents,
    ...(partials ? { partials } : {}),
  };
  const client = new Client(clientOptions);
  let countingChainEventQueue: Promise<void> = Promise.resolve();
  let refreshMinigameDashboard: (() => Promise<void>) | undefined;
  let minigameDashboardRefreshQueue: Promise<void> = Promise.resolve();
  const requestCountingChainReview =
    dependencies.countingChain && config.countingChain.enabled && config.countingChain.reviewEnabled
      ? (channelId: string) =>
          requestCountingChainReviewFromDiscord(
            client,
            config.countingChain.channelId!,
            channelId,
            dependencies.countingChain!,
            logger,
          )
      : undefined;
  const refreshDashboardSafely = (): void => {
    const refresh = refreshMinigameDashboard;
    if (!refresh) {
      return;
    }

    const next = minigameDashboardRefreshQueue
      .catch(() => undefined)
      .then(refresh)
      .catch((error: unknown) => {
        logger.warn({ err: error }, 'STEM minigame dashboard refresh failed');
      });
    minigameDashboardRefreshQueue = next.then(
      () => undefined,
      () => undefined,
    );
    void next;
  };

  let resolveClientReady!: () => void;
  const clientReady = new Promise<void>((resolve) => {
    resolveClientReady = resolve;
  });

  client.once(Events.ClientReady, (readyClient) => {
    logger.info(
      {
        userTag: readyClient.user.tag,
        processId: process.pid,
        host: hostname(),
      },
      'Discord client ready',
    );

    const initializationTasks: Promise<void>[] = [];
    if (
      dependencies.countingChain &&
      config.countingChain.enabled &&
      config.countingChain.channelId
    ) {
      const infoPublisher = config.countingChain.infoChannelId
        ? createCountingChainInfoPublisher(
            client,
            readyClient.user.id,
            config.countingChain.infoChannelId,
            config.countingChain.infoMessageId,
            config.workshops.timeZone,
            dependencies.countingChain,
            dependencies.quiz,
            dependencies.scramble,
            dependencies.wordChain,
          )
        : undefined;
      refreshMinigameDashboard = infoPublisher?.refresh;

      initializationTasks.push(
        dependencies.countingChain
          .initialize(
            () => fetchCountingChainHistory(client, config.countingChain.channelId!),
            infoPublisher,
          )
          .catch((error: unknown) => {
            logger.warn(
              { err: error, channelId: config.countingChain.channelId },
              'Counting chain startup initialization failed',
            );
          }),
      );
    }

    if (dependencies.quiz && config.quiz.enabled && config.quiz.channelId) {
      initializationTasks.push(
        dependencies.quiz.initialize().catch((error: unknown) => {
          logger.warn(
            { err: error, channelId: config.quiz.channelId },
            'STEM quiz startup initialization failed',
          );
        }),
      );
    }

    if (dependencies.scramble && config.scramble.enabled && config.scramble.channelId) {
      initializationTasks.push(
        dependencies.scramble.initialize().catch((error: unknown) => {
          logger.warn(
            { err: error, channelId: config.scramble.channelId },
            'STEM scramble startup initialization failed',
          );
        }),
      );
    }

    if (dependencies.wordChain && config.wordChain.enabled && config.wordChain.channelId) {
      initializationTasks.push(
        dependencies.wordChain.initialize().catch((error: unknown) => {
          logger.warn(
            { err: error, channelId: config.wordChain.channelId },
            'STEM word chain startup initialization failed',
          );
        }),
      );
    }

    void Promise.all(initializationTasks).finally(() => {
      resolveClientReady();
    });
  });

  client.on(Events.ShardDisconnect, (closeEvent, shardId) => {
    logger.warn(
      { shardId, closeCode: closeEvent.code, processId: process.pid, host: hostname() },
      'Discord gateway disconnected',
    );
  });

  client.on(Events.ShardReconnecting, (shardId) => {
    logger.warn(
      { shardId, processId: process.pid, host: hostname() },
      'Discord gateway reconnecting',
    );
  });

  client.on(Events.ShardResume, (shardId, replayedEvents) => {
    logger.info(
      { shardId, replayedEvents, processId: process.pid, host: hostname() },
      'Discord gateway resumed',
    );
  });

  client.on(Events.InteractionCreate, (interaction) => {
    void handleInteraction(interaction, {
      getGatewayPing: () => client.ws.ping,
      logger,
      website: dependencies.website,
      stemcraft: dependencies.stemcraft,
      ...(dependencies.scramble ? { scramble: dependencies.scramble } : {}),
      ...(dependencies.uptime ? { uptime: dependencies.uptime } : {}),
      timeZone: dependencies.timeZone,
      ...(dependencies.userLevels ? { userLevels: dependencies.userLevels } : {}),
      ...(requestCountingChainReview ? { requestCountingChainReview } : {}),
    });
  });

  if (dependencies.countingChain && config.countingChain.enabled) {
    const handleCountingChainMessage = (message: Message, eventType: string): void => {
      if (message.channelId !== config.countingChain.channelId) {
        return;
      }

      logger.info(
        {
          channelId: message.channelId,
          messageId: message.id,
          attachmentCount: message.attachments.size,
          imageUrlCount: getCountingChainImageUrls(message).length,
          imageUrlHosts: getCountingChainImageHosts(message),
          authorIsBot: message.author.bot,
          eventType,
        },
        'Counting chain Discord message received',
      );

      if (message.author.bot || messageMentionsBot(message, client.user?.id)) {
        return;
      }

      const previous = countingChainEventQueue;
      const next = previous
        .catch(() => undefined)
        .then(async () => {
          try {
            if (message.attachments.size === 0 && /https?:\/\//i.test(message.content)) {
              await new Promise<void>((resolve) => {
                setTimeout(resolve, COUNTING_CHAIN_EMBED_SETTLE_MS);
              });
            }

            const recentHistory = await fetchCountingChainRecentHistory(
              client,
              config.countingChain.channelId!,
            );
            const candidates = new Map<string, CountingChainMessage>();
            for (const historyMessage of recentHistory) {
              if (contentMentionsBot(historyMessage.content, client.user?.id)) {
                continue;
              }
              candidates.set(historyMessage.id, historyMessage);
            }
            candidates.set(message.id, toCountingChainMessage(message));

            const orderedMessages = [...candidates.values()].sort(
              compareCountingChainMessagesOldestFirst,
            );
            for (const candidate of orderedMessages) {
              await dependencies.countingChain?.handleMessage(candidate);
            }
            refreshDashboardSafely();
          } catch (error: unknown) {
            logger.warn(
              { err: error, channelId: message.channelId, messageId: message.id },
              'Counting chain recent history could not be read; processing the current message',
            );
            await dependencies.countingChain?.handleMessage(toCountingChainMessage(message));
            refreshDashboardSafely();
          }
        });
      countingChainEventQueue = next.then(
        () => undefined,
        () => undefined,
      );
      void next;
    };

    client.on(Events.MessageCreate, (message) => {
      handleCountingChainMessage(message, 'created');
    });
    client.on(Events.MessageUpdate, (_oldMessage, updatedMessage) => {
      if (updatedMessage.channelId !== config.countingChain.channelId) {
        return;
      }

      void (async (): Promise<void> => {
        try {
          const message = updatedMessage.partial ? await updatedMessage.fetch() : updatedMessage;
          handleCountingChainMessage(message, 'updated');
        } catch (error: unknown) {
          logger.warn(
            {
              err: error,
              channelId: updatedMessage.channelId,
              messageId: updatedMessage.id,
            },
            'Counting chain Discord message update could not be read',
          );
        }
      })();
    });

    if (config.countingChain.reviewEnabled) {
      client.on(Events.MessageReactionAdd, (reaction, user) => {
        if (
          user.bot ||
          !isCountingChainReviewReaction(reaction.emoji.name ?? reaction.emoji.toString())
        ) {
          return;
        }

        void handleCountingChainReviewReaction(
          reaction,
          user,
          config,
          dependencies.countingChain!,
          logger,
        );
      });
    }
  }

  if (dependencies.quiz && config.quiz.enabled && config.quiz.channelId) {
    client.on(Events.MessageCreate, (message) => {
      if (message.channelId !== config.quiz.channelId) {
        return;
      }

      if (message.author.bot || messageMentionsBot(message, client.user?.id)) {
        return;
      }

      logger.info(
        {
          channelId: message.channelId,
          messageId: message.id,
          authorId: message.author.id,
          contentLength: message.content.length,
        },
        'STEM quiz Discord message received',
      );

      void dependencies
        .quiz!.handleMessage(toStemQuizMessage(message))
        .catch((error: unknown) => {
          logger.warn(
            { err: error, channelId: message.channelId, messageId: message.id },
            'STEM quiz message could not be processed',
          );
        })
        .finally(refreshDashboardSafely);
    });
  }

  if (dependencies.scramble && config.scramble.enabled && config.scramble.channelId) {
    client.on(Events.MessageCreate, (message) => {
      if (
        message.channelId !== config.scramble.channelId ||
        message.author.bot ||
        messageMentionsBot(message, client.user?.id)
      ) {
        return;
      }

      logger.info(
        {
          channelId: message.channelId,
          messageId: message.id,
          authorId: message.author.id,
          contentLength: message.content.length,
        },
        'STEM scramble Discord message received',
      );

      void dependencies
        .scramble!.handleMessage(toStemScrambleMessage(message))
        .catch((error: unknown) => {
          logger.warn(
            { err: error, channelId: message.channelId, messageId: message.id },
            'STEM scramble message could not be processed',
          );
        })
        .finally(refreshDashboardSafely);
    });
  }

  if (dependencies.wordChain && config.wordChain.enabled && config.wordChain.channelId) {
    client.on(Events.MessageCreate, (message) => {
      if (
        message.channelId !== config.wordChain.channelId ||
        message.author.bot ||
        messageMentionsBot(message, client.user?.id)
      ) {
        return;
      }

      logger.info(
        {
          channelId: message.channelId,
          messageId: message.id,
          authorId: message.author.id,
          contentLength: message.content.length,
        },
        'STEM word chain Discord message received',
      );

      void dependencies
        .wordChain!.handleMessage(toStemWordChainMessage(message))
        .catch((error: unknown) => {
          logger.warn(
            { err: error, channelId: message.channelId, messageId: message.id },
            'STEM word chain message could not be processed',
          );
        })
        .finally(refreshDashboardSafely);
    });
  }

  if (dependencies.ask && config.ask.enabled) {
    client.on(Events.MessageCreate, (message) => {
      if (message.author.bot || !client.user || !messageMentionsBot(message, client.user.id)) {
        return;
      }

      const question = removeBotMentions(message.content, client.user.id);
      logger.info(
        {
          channelId: message.channelId,
          messageId: message.id,
          authorId: message.author.id,
          questionLength: question.length,
        },
        'STEM ask Discord message received',
      );

      void dependencies
        .ask!.handleMessage(toStemAskMessage(message, question))
        .catch((error: unknown) => {
          logger.warn(
            { err: error, channelId: message.channelId, messageId: message.id },
            'STEM ask message could not be processed',
          );
        });
    });
  }

  if (dependencies.userLevels && config.levels.enabled) {
    client.on(Events.MessageCreate, (message) => {
      if (message.author.bot) {
        return;
      }

      void dependencies.userLevels!.recordMessage(message.author.id).catch((error: unknown) => {
        logger.warn(
          { err: error, userId: message.author.id, messageId: message.id },
          'User message XP could not be recorded',
        );
      });
    });

    client.on(Events.MessageReactionAdd, (_reaction, user) => {
      if (user.bot) {
        return;
      }

      void dependencies.userLevels!.recordReaction(user.id).catch((error: unknown) => {
        logger.warn({ err: error, userId: user.id }, 'User reaction XP could not be recorded');
      });
    });
  }

  client.on(Events.Error, (error) => {
    logger.error({ err: error }, 'Discord client error');
  });

  let stopped = false;

  return {
    async start(): Promise<void> {
      await client.login(config.discord.token);
      await clientReady;
    },

    async stop(): Promise<void> {
      if (stopped) {
        return;
      }

      stopped = true;
      client.destroy();
    },

    getGatewayPing(): number {
      return client.ws.ping;
    },

    async sendChannelMessage(
      channelId: string,
      message: DiscordChannelMessage | string,
    ): Promise<string> {
      const channel = await client.channels.fetch(channelId);
      if (!channel || !channel.isTextBased() || !('send' in channel)) {
        throw new Error(`Discord channel is not a writable text channel: ${channelId}`);
      }

      if (typeof message === 'string') {
        const sentMessage = await channel.send({
          content: message,
          allowedMentions: { parse: [] },
        });
        return sentMessage.id;
      }

      const { heroImageUrl, crosspost, allowedMentions, ...messagePayload } = message;
      const heroImage = heroImageUrl ? await downloadHeroImage(heroImageUrl, logger) : undefined;
      const embeds = heroImage
        ? messagePayload.embeds?.map((embed) =>
            embed.image?.url === heroImageUrl
              ? { ...embed, image: { url: `attachment://${heroImage.filename}` } }
              : embed,
          )
        : messagePayload.embeds;
      const payload = {
        ...messagePayload,
        ...(embeds ? { embeds } : {}),
        ...(heroImage
          ? {
              files: [{ attachment: heroImage.data, name: heroImage.filename }],
            }
          : {}),
        allowedMentions: allowedMentions ?? { parse: [] },
      };
      const sentMessage = await channel.send(payload);
      if (crosspost) {
        await crosspostMessage(sentMessage, channelId, logger);
      }
      return sentMessage.id;
    },

    async editChannelMessage(
      channelId: string,
      messageId: string,
      message: DiscordChannelMessage | string,
    ): Promise<boolean> {
      const channel = await client.channels.fetch(channelId);
      if (!channel || !channel.isTextBased() || !('messages' in channel)) {
        throw new Error(`Discord channel is not a readable text channel: ${channelId}`);
      }

      let targetMessage: Message;
      try {
        targetMessage = await channel.messages.fetch(messageId);
      } catch (error: unknown) {
        if (isDiscordMessageNotFound(error)) {
          return false;
        }

        throw error;
      }

      if (typeof message === 'string') {
        await targetMessage.edit({ content: message, allowedMentions: { parse: [] } });
        return true;
      }

      await targetMessage.edit({
        ...(message.content !== undefined ? { content: message.content } : {}),
        ...(message.embeds !== undefined ? { embeds: message.embeds } : {}),
        allowedMentions: message.allowedMentions ?? { parse: [] },
      });
      return true;
    },
  };
}

function isDiscordMessageNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 10008;
}

async function crosspostMessage(
  message: Message,
  channelId: string,
  logger: AppLogger,
): Promise<void> {
  if (!message.crosspostable) {
    logger.debug(
      { channelId, messageId: message.id, channelType: message.channel.type },
      'Discord message was sent but is not eligible for automatic crossposting',
    );
    return;
  }

  try {
    await message.crosspost();
    logger.info(
      { channelId, messageId: message.id },
      'Discord announcement message crossposted to followers',
    );
  } catch (error: unknown) {
    logger.warn(
      { err: error, channelId, messageId: message.id },
      'Discord announcement message was sent but could not be crossposted',
    );
  }
}

function toCountingChainMessage(message: Message): CountingChainMessage {
  return {
    id: message.id,
    channelId: message.channelId,
    authorId: message.author.id,
    authorIsBot: message.author.bot,
    content: message.content,
    attachments: [...message.attachments.values()].map((attachment) => ({
      url: attachment.url,
      ...(attachment.name ? { name: attachment.name } : {}),
      ...(attachment.contentType ? { contentType: attachment.contentType } : {}),
      ...(attachment.size !== undefined ? { size: attachment.size } : {}),
    })),
    imageUrls: getCountingChainImageUrls(message),
    botReactionEmojis: getBotReactionEmojis(message),
    react: async (emoji: string): Promise<void> => {
      await message.react(emoji);
    },
    reply: async (content: string, options?: CountingChainReplyOptions): Promise<string> => {
      const reply = await message.reply({
        content,
        allowedMentions: {
          parse: [],
          ...(options?.mentionRoleId ? { roles: [options.mentionRoleId] } : {}),
          ...(options?.mentionUserId ? { users: [options.mentionUserId] } : {}),
        },
      });
      return reply.id;
    },
    clearReactions: async (): Promise<void> => {
      await message.reactions.removeAll();
    },
    deleteMessage: async (messageId: string): Promise<void> => {
      const channel = message.channel;
      if (!channel.isTextBased() || !('messages' in channel)) {
        throw new Error(`Counting chain channel cannot delete message: ${message.channelId}`);
      }

      const reply = await channel.messages.fetch(messageId);
      await reply.delete();
    },
  };
}

function toStemQuizMessage(message: Message): StemQuizMessage {
  return {
    id: message.id,
    channelId: message.channelId,
    authorId: message.author.id,
    authorIsBot: message.author.bot,
    content: message.content,
    react: async (emoji: string): Promise<void> => {
      await message.react(emoji);
    },
  };
}

function toStemScrambleMessage(message: Message): StemScrambleMessage {
  return {
    id: message.id,
    channelId: message.channelId,
    authorId: message.author.id,
    authorIsBot: message.author.bot,
    content: message.content,
    react: async (emoji: string): Promise<void> => {
      await message.react(emoji);
    },
  };
}

function toStemWordChainMessage(message: Message): StemWordChainMessage {
  return {
    id: message.id,
    channelId: message.channelId,
    authorId: message.author.id,
    authorIsBot: message.author.bot,
    content: message.content,
    react: async (emoji: string): Promise<void> => {
      await message.react(emoji);
    },
  };
}

function toStemAskMessage(message: Message, question: string): StemAskMessage {
  return {
    id: message.id,
    channelId: message.channelId,
    authorId: message.author.id,
    authorIsBot: message.author.bot,
    question,
    reply: async (content: string): Promise<void> => {
      await message.reply({
        content,
        allowedMentions: { parse: [] },
      });
    },
  };
}

function removeBotMentions(content: string, botUserId: string): string {
  return content.replace(new RegExp(`<@!?${botUserId}>`, 'g'), '').trim();
}

function messageMentionsBot(message: Message, botUserId: string | undefined): boolean {
  return Boolean(
    botUserId &&
    (message.mentions.users.has(botUserId) || contentMentionsBot(message.content, botUserId)),
  );
}

function contentMentionsBot(content: string, botUserId: string | undefined): boolean {
  return Boolean(
    botUserId && (content.includes(`<@${botUserId}>`) || content.includes(`<@!${botUserId}>`)),
  );
}

function getCountingChainImageUrls(message: Message): string[] {
  return message.embeds.flatMap((embed) =>
    [embed.image?.url, embed.thumbnail?.url].filter(
      (url): url is string => typeof url === 'string' && url.length > 0,
    ),
  );
}

function getCountingChainImageHosts(message: Message): string[] {
  return getCountingChainImageUrls(message).flatMap((url) => {
    try {
      return [new URL(url).hostname];
    } catch {
      return [];
    }
  });
}

function getBotReactionEmojis(message: Message): string[] {
  return [...message.reactions.cache.values()]
    .filter((reaction) => reaction.me)
    .map((reaction) => reaction.emoji.name ?? reaction.emoji.toString());
}

function toCountingChainHistoryMessage(message: Message): CountingChainHistoryMessage {
  const baseMessage = toCountingChainMessage(message);
  return {
    ...baseMessage,
    content: message.content,
    botReactionEmojis: getBotReactionEmojis(message),
  };
}

async function fetchCountingChainHistory(
  client: Client,
  channelId: string,
): Promise<readonly CountingChainHistoryMessage[]> {
  const channel = await client.channels.fetch(channelId);
  if (!channel || !channel.isTextBased() || !('messages' in channel)) {
    throw new Error(`Counting chain channel is not a readable text channel: ${channelId}`);
  }

  const pageSize = 100;
  const messages: Message[] = [];
  let before: string | undefined;

  while (true) {
    const page = await channel.messages.fetch({
      limit: pageSize,
      ...(before ? { before } : {}),
    });
    messages.push(...page.values());

    if (page.size < pageSize) {
      break;
    }

    const oldestMessage = [...page.values()].sort(compareMessagesNewestFirst).at(-1);
    if (!oldestMessage) {
      break;
    }

    before = oldestMessage.id;
  }

  return messages
    .filter((message) => !messageMentionsBot(message, client.user?.id))
    .sort(compareMessagesNewestFirst)
    .map(toCountingChainHistoryMessage);
}

async function fetchCountingChainRecentHistory(
  client: Client,
  channelId: string,
): Promise<readonly CountingChainHistoryMessage[]> {
  const channel = await client.channels.fetch(channelId);
  if (!channel || !channel.isTextBased() || !('messages' in channel)) {
    throw new Error(`Counting chain channel is not a readable text channel: ${channelId}`);
  }

  const messages = await channel.messages.fetch({ limit: 100 });
  return [...messages.values()]
    .filter((message) => !messageMentionsBot(message, client.user?.id))
    .sort(compareMessagesNewestFirst)
    .map(toCountingChainHistoryMessage);
}

async function requestCountingChainReviewFromDiscord(
  client: Client,
  configuredChannelId: string | undefined,
  channelId: string,
  service: CountingChainService,
  logger: AppLogger,
): Promise<boolean> {
  if (!configuredChannelId || channelId !== configuredChannelId) {
    return false;
  }

  const targetMessageId = await service.getReviewTargetMessageId();
  if (!targetMessageId) {
    return false;
  }

  const channel = await client.channels.fetch(channelId);
  if (!channel || !channel.isTextBased() || !('messages' in channel)) {
    return false;
  }

  let targetMessage: Message;
  try {
    targetMessage = await channel.messages.fetch(targetMessageId);
  } catch (error: unknown) {
    logger.warn(
      { err: error, channelId, messageId: targetMessageId },
      'Counting chain review target could not be fetched',
    );
    return false;
  }

  if (targetMessage.author.bot) {
    return false;
  }

  logger.info(
    { channelId, messageId: targetMessage.id },
    'Counting chain review command selected the last game-ending message',
  );
  return service.requestReview(toCountingChainMessage(targetMessage));
}

async function handleCountingChainReviewReaction(
  reaction: MessageReaction | PartialMessageReaction,
  user: User | PartialUser,
  config: AppConfig,
  service: CountingChainService,
  logger: AppLogger,
): Promise<void> {
  try {
    const resolvedReaction = reaction.partial ? await reaction.fetch() : reaction;
    const partialMessage = resolvedReaction.message;
    const message = partialMessage.partial ? await partialMessage.fetch() : partialMessage;
    const emoji = resolvedReaction.emoji.name ?? resolvedReaction.emoji.toString();

    if (
      message.channelId !== config.countingChain.channelId ||
      message.guildId !== config.discord.guildId
    ) {
      return;
    }

    const guild = message.guild;
    if (!guild) {
      return;
    }

    const member = await guild.members.fetch(user.id);
    const authorized =
      member.permissions.has(PermissionsBitField.Flags.Administrator) ||
      member.permissions.has(PermissionsBitField.Flags.ManageMessages) ||
      (config.countingChain.reviewRoleId !== undefined &&
        member.roles.cache.has(config.countingChain.reviewRoleId));
    if (!authorized) {
      logger.warn(
        { channelId: message.channelId, messageId: message.id, userId: user.id, emoji },
        'Ignoring counting chain review reaction from an unauthorized member',
      );
      return;
    }

    const decision = emoji === '✅' ? 'approve' : 'reject';
    const applied = await service.reviewMessage(toCountingChainMessage(message), decision, user.id);
    logger.info(
      { channelId: message.channelId, messageId: message.id, userId: user.id, decision, applied },
      'Counting chain review reaction processed',
    );
  } catch (error: unknown) {
    logger.warn(
      { err: error, channelId: config.countingChain.channelId, userId: user.id },
      'Counting chain review reaction could not be processed',
    );
  }
}

function isCountingChainReviewReaction(emoji: string): boolean {
  return emoji === '✅' || emoji === '❌';
}

function compareCountingChainMessagesOldestFirst(
  left: CountingChainMessage,
  right: CountingChainMessage,
): number {
  if (/^\d+$/.test(left.id) && /^\d+$/.test(right.id)) {
    const leftValue = BigInt(left.id);
    const rightValue = BigInt(right.id);
    return leftValue === rightValue ? 0 : leftValue < rightValue ? -1 : 1;
  }

  return left.id.localeCompare(right.id);
}

function compareMessagesNewestFirst(left: Message, right: Message): number {
  const leftValue = BigInt(left.id);
  const rightValue = BigInt(right.id);
  return leftValue === rightValue ? 0 : leftValue > rightValue ? -1 : 1;
}

function createCountingChainInfoPublisher(
  client: Client,
  botUserId: string,
  channelId: string,
  configuredMessageId: string | undefined,
  timeZone: string,
  countingChain: CountingChainService | undefined,
  quiz: StemQuizService | undefined,
  scramble: StemScrambleService | undefined,
  wordChain: StemWordChainService | undefined,
): CountingChainInfoPublisher & { refresh(): Promise<void> } {
  let messageId = configuredMessageId;
  let latestStatus: CountingChainGameStatus | undefined;
  let updateQueue: Promise<string | undefined> = Promise.resolve(undefined);

  const updateDashboard = async (
    status: CountingChainGameStatus,
    persistedMessageId?: string,
    providedCountingLeaderboard?: readonly MinigameLeaderboardEntry[],
  ): Promise<string | undefined> => {
    const channel = await client.channels.fetch(channelId);
    if (!channel || !channel.isTextBased() || !('messages' in channel) || !('send' in channel)) {
      throw new Error(`Counting chain info channel is not writable: ${channelId}`);
    }

    let infoMessage: Message | undefined;
    const requestedMessageId = persistedMessageId ?? messageId;
    if (requestedMessageId) {
      try {
        const candidate = await channel.messages.fetch(requestedMessageId);
        if (candidate.author.id === botUserId) {
          infoMessage = candidate;
        }
      } catch {
        messageId = undefined;
      }
    }

    if (!infoMessage) {
      const recentMessages = await channel.messages.fetch({ limit: 100 });
      infoMessage = recentMessages.find(
        (candidate) =>
          candidate.author.id === botUserId &&
          candidate.embeds.some(
            (embed) => embed.title === 'STEMBot Minigames' || embed.title === 'Counting Chain Game',
          ),
      );
    }

    const [countingLeaderboard, quizLeaderboard, scrambleLeaderboard, wordChainLeaderboard] =
      await Promise.all([
        readMinigameLeaderboard(countingChain, providedCountingLeaderboard),
        readMinigameLeaderboard(quiz),
        readMinigameLeaderboard(scramble),
        readMinigameLeaderboard(wordChain),
      ]);
    const embed = buildMinigameInfoEmbed(status, timeZone, {
      counting: countingChain ? countingLeaderboard : undefined,
      quiz: quiz ? quizLeaderboard : undefined,
      scramble: scramble ? scrambleLeaderboard : undefined,
      wordChain: wordChain ? wordChainLeaderboard : undefined,
    });
    if (infoMessage) {
      await infoMessage.edit({ embeds: [embed], allowedMentions: { parse: [] } });
      messageId = infoMessage.id;
      return infoMessage.id;
    }

    const createdMessage = await channel.send({
      embeds: [embed],
      allowedMentions: { parse: [] },
    });
    messageId = createdMessage.id;
    return createdMessage.id;
  };

  const update = (
    status: CountingChainGameStatus,
    persistedMessageId?: string,
    countingLeaderboard?: readonly MinigameLeaderboardEntry[],
  ): Promise<string | undefined> => {
    latestStatus = status;
    const next = updateQueue
      .catch(() => undefined)
      .then(() => updateDashboard(status, persistedMessageId, countingLeaderboard));
    updateQueue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  return {
    update,
    async refresh(): Promise<void> {
      if (latestStatus) {
        await update(latestStatus);
      }
    },
  };
}

export function buildMinigameInfoEmbed(
  status: CountingChainGameStatus,
  timeZone: string,
  leaderboards: MinigameLeaderboards,
): APIEmbed {
  return {
    title: 'STEMBot Minigames',
    color: 0x58d5d8,
    description: [
      'Play STEMBot’s minigames to build your streak and level up.',
      '',
      '**Counting chain**',
      'Post a GIF or picture containing the next number.',
      '',
      '**Other games**',
      'Answer the STEM quiz, solve the scramble, or keep the themed word chain going.',
      '',
      'Each game has its own top-three record leaderboard.',
    ].join('\n'),
    fields: [
      {
        name: 'Counting streak',
        value: `${Math.max(0, status.expectedNumber - 1)} accepted · next **${status.expectedNumber}**`,
        inline: true,
      },
      {
        name: 'Best counting streak',
        value: formatCountingChainStat(status.highScore, status.highScoreAt, timeZone),
        inline: true,
      },
      {
        name: 'Counting · highest number',
        value: formatMinigameLeaderboard(
          leaderboards.counting,
          'highest number reached',
          'Counting chain is not enabled.',
        ),
        inline: false,
      },
      {
        name: 'Quiz · correct answers',
        value: formatMinigameLeaderboard(
          leaderboards.quiz,
          'correct answers',
          'STEM quiz is not enabled.',
        ),
        inline: false,
      },
      {
        name: 'Scramble · solved rounds',
        value: formatMinigameLeaderboard(
          leaderboards.scramble,
          'solved rounds',
          'STEM scramble is not enabled.',
        ),
        inline: false,
      },
      {
        name: 'Word chain · best round streak',
        value: formatMinigameLeaderboard(
          leaderboards.wordChain,
          'correct guesses in one round',
          'STEM word chain is not enabled.',
        ),
        inline: false,
      },
      {
        name: 'Last counting round',
        value: formatCountingChainStat(
          status.lastRound,
          status.lastRoundAt,
          timeZone,
          status.lastRoundReason,
        ),
        inline: false,
      },
    ],
    footer: { text: 'STEMBot minigames' },
  };
}

interface MinigameLeaderboards {
  counting: readonly MinigameLeaderboardEntry[] | undefined;
  quiz: readonly MinigameLeaderboardEntry[] | undefined;
  scramble: readonly MinigameLeaderboardEntry[] | undefined;
  wordChain: readonly MinigameLeaderboardEntry[] | undefined;
}

async function readMinigameLeaderboard(
  service: MinigameLeaderboardProvider | undefined,
  preloadedLeaderboard?: readonly MinigameLeaderboardEntry[],
): Promise<readonly MinigameLeaderboardEntry[]> {
  if (preloadedLeaderboard !== undefined) {
    return preloadedLeaderboard;
  }

  if (!service) {
    return [];
  }

  try {
    return await service.getLeaderboard(3);
  } catch {
    return [];
  }
}

function formatMinigameLeaderboard(
  entries: readonly MinigameLeaderboardEntry[] | undefined,
  unit: string,
  disabledMessage: string,
): string {
  if (entries === undefined) {
    return disabledMessage;
  }
  if (entries.length === 0) {
    return 'No records yet.';
  }

  return entries
    .slice(0, 3)
    .map((entry, index) => `**${index + 1}.** <@${entry.userId}> · **${entry.score}** ${unit}`)
    .join('\n');
}

function formatCountingChainStat(
  score: number,
  timestamp: string | null,
  timeZone: string,
  reason?: string | null,
): string {
  const date = timestamp
    ? `As of ${new Intl.DateTimeFormat('en-AU', {
        dateStyle: 'short',
        timeStyle: 'short',
        timeZone,
      }).format(new Date(timestamp))}`
    : 'No completed round yet';
  const formattedReason = reason ? ` · ${formatCountingChainReason(reason)}` : '';
  return `${score} (${date}${formattedReason})`;
}

function formatCountingChainReason(reason: string): string {
  return (
    {
      'same-user': 'reset after a consecutive post',
      'wrong-number': 'reset after an incorrect number',
      'moderator-rejected': 'reset after moderator review',
      'history-failure': 'reset after a failed history check',
    }[reason] ?? reason
  );
}

const MAX_HERO_IMAGE_BYTES = 8 * 1024 * 1024;

interface HeroImage {
  data: Buffer;
  filename: string;
}

async function downloadHeroImage(url: string, logger: AppLogger): Promise<HeroImage | undefined> {
  try {
    const response = await fetch(url, {
      headers: { Accept: 'image/*' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new Error(`Hero image request returned HTTP ${response.status}`);
    }

    const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.toLowerCase();
    if (!contentType?.startsWith('image/')) {
      throw new Error(`Hero image response was not an image: ${contentType ?? 'unknown type'}`);
    }

    const data = Buffer.from(await response.arrayBuffer());
    if (data.byteLength > MAX_HERO_IMAGE_BYTES) {
      throw new Error(`Hero image exceeds ${MAX_HERO_IMAGE_BYTES} bytes`);
    }

    return {
      data,
      filename: `workshop-hero.${imageExtension(contentType)}`,
    };
  } catch (error) {
    logger.warn({ err: error, imageUrl: url }, 'Workshop hero image could not be attached');
    return undefined;
  }
}

function imageExtension(contentType: string): string {
  return (
    {
      'image/avif': 'avif',
      'image/gif': 'gif',
      'image/jpeg': 'jpg',
      'image/png': 'png',
      'image/webp': 'webp',
    }[contentType] ?? 'bin'
  );
}
