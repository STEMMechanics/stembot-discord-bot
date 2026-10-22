import { Client, Events, GatewayIntentBits } from 'discord.js';

import type { AppConfig } from '../config/env.js';
import type { StemCraftIntegration } from '../integrations/stemcraft.js';
import type { WebsiteIntegration } from '../integrations/website.js';
import type { AppLogger } from '../logging/logger.js';
import { handleInteraction } from './interaction-handler.js';

export interface DiscordGateway {
  start(): Promise<void>;
  stop(): Promise<void>;
  getGatewayPing(): number;
  sendChannelMessage(channelId: string, content: string): Promise<string>;
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
  const client = new Client({
    intents: [GatewayIntentBits.Guilds],
  });

  client.once(Events.ClientReady, (readyClient) => {
    logger.info({ userTag: readyClient.user.tag }, 'Discord client ready');
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

    async sendChannelMessage(channelId: string, content: string): Promise<string> {
      const channel = await client.channels.fetch(channelId);
      if (!channel || !channel.isTextBased() || !('send' in channel)) {
        throw new Error(`Discord channel is not a writable text channel: ${channelId}`);
      }

      const message = await channel.send({ content, allowedMentions: { parse: [] } });
      return message.id;
    },
  };
}
