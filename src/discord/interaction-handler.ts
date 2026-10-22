import { MessageFlags, type Interaction } from 'discord.js';

import type { StemCraftIntegration } from '../integrations/stemcraft.js';
import type { AppLogger } from '../logging/logger.js';
import type { WebsiteIntegration } from '../integrations/website.js';
import { commands, type CommandContext } from './commands.js';

const INTERACTION_DEDUPLICATION_WINDOW_MS = 10 * 60 * 1000;
const seenInteractionIds = new Map<string, number>();

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

  const interactionAgeMs = Math.max(0, Date.now() - interaction.createdTimestamp);
  if (!claimInteraction(interaction.id)) {
    context.logger.warn(
      {
        commandName: interaction.commandName,
        interactionId: interaction.id,
        interactionAgeMs,
      },
      'Ignoring duplicate Discord interaction delivery',
    );
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
    if (isUnknownInteractionError(error)) {
      context.logger.warn(
        {
          commandName: interaction.commandName,
          interactionId: interaction.id,
          interactionAgeMs: Math.max(0, Date.now() - interaction.createdTimestamp),
          err: error,
        },
        'Discord interaction expired or was acknowledged by another bot process',
      );
      return;
    }

    context.logger.error(
      { commandName: interaction.commandName, err: error },
      'Discord command failed',
    );

    try {
      const response = {
        content: 'Something went wrong while handling that command.',
        flags: MessageFlags.Ephemeral,
      } as const;

      if (interaction.deferred) {
        await interaction.editReply({ content: response.content });
      } else if (interaction.replied) {
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

function claimInteraction(interactionId: string): boolean {
  const now = Date.now();
  for (const [seenId, seenAt] of seenInteractionIds) {
    if (now - seenAt > INTERACTION_DEDUPLICATION_WINDOW_MS) {
      seenInteractionIds.delete(seenId);
    }
  }

  if (seenInteractionIds.has(interactionId)) {
    return false;
  }

  seenInteractionIds.set(interactionId, now);
  return true;
}

function isUnknownInteractionError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return false;
  }

  return error.code === 10062;
}
