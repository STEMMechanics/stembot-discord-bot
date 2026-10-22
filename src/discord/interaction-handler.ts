import type { Interaction } from 'discord.js';

import type { StemCraftIntegration } from '../integrations/stemcraft.js';
import type { AppLogger } from '../logging/logger.js';
import type { WebsiteIntegration } from '../integrations/website.js';
import { commands, type CommandContext } from './commands.js';

export interface InteractionHandlerContext extends CommandContext {
  logger: AppLogger;
  website?: WebsiteIntegration;
  stemcraft?: StemCraftIntegration;
  timeZone?: string;
}

export async function handleInteraction(
  interaction: Interaction,
  context: InteractionHandlerContext,
): Promise<void> {
  if (!interaction.isChatInputCommand()) {
    return;
  }

  const command = commands.find((candidate) => candidate.data.name === interaction.commandName);

  if (!command) {
    context.logger.warn(
      { commandName: interaction.commandName },
      'Received an unknown Discord command',
    );
    return;
  }

  const commandContext: CommandContext = {
    getGatewayPing: context.getGatewayPing,
    ...(context.website ? { website: context.website } : {}),
    ...(context.stemcraft ? { stemcraft: context.stemcraft } : {}),
    ...(context.timeZone ? { timeZone: context.timeZone } : {}),
    ...(context.getCurrentTime ? { getCurrentTime: context.getCurrentTime } : {}),
  };

  try {
    await command.execute(interaction, commandContext);
  } catch (error: unknown) {
    context.logger.error(
      { commandName: interaction.commandName, err: error },
      'Discord command failed',
    );

    try {
      const response = {
        content: 'Something went wrong while handling that command.',
        ephemeral: true,
      };

      if (interaction.replied || interaction.deferred) {
        await interaction.followUp(response);
      } else {
        await interaction.reply(response);
      }
    } catch (replyError: unknown) {
      context.logger.error(
        { commandName: interaction.commandName, err: replyError },
        'Failed to send Discord command error response',
      );
    }
  }
}
