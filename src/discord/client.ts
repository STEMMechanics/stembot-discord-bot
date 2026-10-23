import { Client, Events, GatewayIntentBits, type APIEmbed, type Message } from 'discord.js';
import { hostname } from 'node:os';

import type { AppConfig } from '../config/env.js';
import type { StemCraftIntegration } from '../integrations/stemcraft.js';
import type { WebsiteIntegration } from '../integrations/website.js';
import type { AppLogger } from '../logging/logger.js';
import { configureNetworkDefaults } from '../network.js';
import type {
  CountingChainGameStatus,
  CountingChainHistoryMessage,
  CountingChainInfoPublisher,
  CountingChainMessage,
  CountingChainService,
} from '../services/counting-chain.js';
import { handleInteraction } from './interaction-handler.js';

export interface DiscordGateway {
  start(): Promise<void>;
  stop(): Promise<void>;
  getGatewayPing(): number;
  sendChannelMessage(channelId: string, message: DiscordChannelMessage | string): Promise<string>;
}

export interface DiscordChannelMessage {
  content?: string;
  embeds?: APIEmbed[];
  /** Internal image URL that is downloaded and attached to the message. */
  heroImageUrl?: string;
}

export interface DiscordCommandDependencies {
  website: WebsiteIntegration;
  stemcraft: StemCraftIntegration;
  timeZone: string;
  countingChain?: CountingChainService;
}

export function createDiscordGateway(
  config: AppConfig,
  logger: AppLogger,
  dependencies: DiscordCommandDependencies,
): DiscordGateway {
  configureNetworkDefaults();

  const intents = [GatewayIntentBits.Guilds];
  if (config.countingChain.enabled && dependencies.countingChain) {
    intents.push(GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent);
  }

  const client = new Client({
    intents,
  });

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
          )
        : undefined;

      void dependencies.countingChain
        .initialize(
          () => fetchCountingChainHistory(client, config.countingChain.channelId!),
          infoPublisher,
        )
        .catch((error: unknown) => {
          logger.warn(
            { err: error, channelId: config.countingChain.channelId },
            'Counting chain startup initialization failed',
          );
        })
        .finally(() => {
          resolveClientReady();
        });
      return;
    }

    resolveClientReady();
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
      timeZone: dependencies.timeZone,
    });
  });

  if (dependencies.countingChain && config.countingChain.enabled) {
    client.on(Events.MessageCreate, (message) => {
      if (message.channelId === config.countingChain.channelId) {
        logger.info(
          {
            channelId: message.channelId,
            messageId: message.id,
            attachmentCount: message.attachments.size,
            authorIsBot: message.author.bot,
          },
          'Counting chain Discord message received',
        );
      }
      void dependencies.countingChain?.handleMessage(toCountingChainMessage(message));
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

      const { heroImageUrl, ...messagePayload } = message;
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
        allowedMentions: { parse: [] },
      };
      const sentMessage = await channel.send(payload);
      return sentMessage.id;
    },
  };
}

function toCountingChainMessage(message: Message): CountingChainMessage {
  return {
    id: message.id,
    channelId: message.channelId,
    authorId: message.author.id,
    authorIsBot: message.author.bot,
    attachments: [...message.attachments.values()].map((attachment) => ({
      url: attachment.url,
      ...(attachment.name ? { name: attachment.name } : {}),
      ...(attachment.contentType ? { contentType: attachment.contentType } : {}),
      ...(attachment.size !== undefined ? { size: attachment.size } : {}),
    })),
    react: async (emoji: string): Promise<void> => {
      await message.react(emoji);
    },
    reply: async (content: string): Promise<void> => {
      await message.reply({
        content,
        allowedMentions: { parse: [] },
      });
    },
  };
}

function toCountingChainHistoryMessage(message: Message): CountingChainHistoryMessage {
  const baseMessage = toCountingChainMessage(message);
  return {
    ...baseMessage,
    content: message.content,
    botReactionEmojis: [...message.reactions.cache.values()]
      .filter((reaction) => reaction.me)
      .map((reaction) => reaction.emoji.name ?? reaction.emoji.toString()),
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

  return messages.sort(compareMessagesNewestFirst).map(toCountingChainHistoryMessage);
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
): CountingChainInfoPublisher {
  let messageId = configuredMessageId;

  return {
    async update(
      status: CountingChainGameStatus,
      persistedMessageId?: string,
    ): Promise<string | undefined> {
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
            candidate.embeds.some((embed) => embed.title === 'Counting Chain Game'),
        );
      }

      const embed = buildCountingChainInfoEmbed(status, timeZone);
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
    },
  };
}

function buildCountingChainInfoEmbed(status: CountingChainGameStatus, timeZone: string): APIEmbed {
  return {
    title: 'Counting Chain Game',
    color: 0x58d5d8,
    description: [
      'The goal is to get to the highest number we can!',
      '',
      '**Rule #1**',
      'Post a GIF or picture containing a number.',
      '',
      '**Rule #2**',
      'The next number must be 1 higher than the previous number.',
      '',
      '**Rule #3**',
      'You cannot post twice in a row.',
      '',
      '**When does the chain break?**',
      'An incorrect number or a consecutive post resets the chain to 1.',
      '',
      'Have fun!',
    ].join('\n'),
    fields: [
      { name: 'Current number', value: String(status.expectedNumber), inline: true },
      {
        name: 'Current Highscore',
        value: formatCountingChainStat(status.highScore, status.highScoreAt, timeZone),
        inline: true,
      },
      {
        name: 'Last round',
        value: formatCountingChainStat(
          status.lastRound,
          status.lastRoundAt,
          timeZone,
          status.lastRoundReason,
        ),
        inline: false,
      },
    ],
    footer: { text: 'STEMBot counting chain' },
  };
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
