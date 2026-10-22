import { Client, Events, GatewayIntentBits, type APIEmbed } from 'discord.js';
import { hostname } from 'node:os';

import type { AppConfig } from '../config/env.js';
import type { StemCraftIntegration } from '../integrations/stemcraft.js';
import type { WebsiteIntegration } from '../integrations/website.js';
import type { AppLogger } from '../logging/logger.js';
import { configureNetworkDefaults } from '../network.js';
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
}

export function createDiscordGateway(
  config: AppConfig,
  logger: AppLogger,
  dependencies: DiscordCommandDependencies,
): DiscordGateway {
  configureNetworkDefaults();

  const client = new Client({
    intents: [GatewayIntentBits.Guilds],
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

  client.on(Events.Error, (error) => {
    logger.error({ err: error }, 'Discord client error');
  });

  let stopped = false;

  return {
    async start(): Promise<void> {
      await client.login(config.discord.token);
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
