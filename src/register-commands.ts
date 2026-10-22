import { REST, Routes } from 'discord.js';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { loadConfig, type AppConfig } from './config/env.js';
import { replaceCommandScopes } from './discord/command-registration.js';
import { getCommandDefinitions } from './discord/commands.js';
import { createLogger, type AppLogger } from './logging/logger.js';

interface CurrentApplicationResponse {
  id?: string;
}

/**
 * Replaces the supported command set in the configured Discord application.
 *
 * Global commands are always replaced. When DISCORD_GUILD_ID is configured,
 * that guild's command set is replaced as well.
 */
export async function registerCommands(
  config: AppConfig = loadConfig(),
  logger: AppLogger = createLogger(config),
): Promise<void> {
  const rest = new REST({ version: '10' }).setToken(config.discord.token);
  const commandDefinitions = getCommandDefinitions();

  try {
    const application = (await rest.get(Routes.currentApplication())) as CurrentApplicationResponse;
    if (application.id !== config.discord.clientId) {
      throw new Error(
        `Discord token belongs to application ${application.id ?? 'unknown'}, not ${config.discord.clientId}`,
      );
    }

    const results = await replaceCommandScopes(
      rest,
      config.discord.clientId,
      config.discord.guildId,
      commandDefinitions,
    );

    logger.info(
      {
        applicationId: config.discord.clientId,
        commandNames: commandDefinitions.map((command) => command.name),
        scopes: results,
      },
      'Discord application commands synchronized',
    );

    if (!config.discord.guildId) {
      logger.warn(
        'DISCORD_GUILD_ID is not configured; global commands were synchronized but no guild scope was changed',
      );
    }
  } catch (error: unknown) {
    logger.error({ err: error }, 'Failed to synchronize Discord application commands');
    throw error;
  }
}

export async function main(): Promise<void> {
  try {
    await registerCommands();
  } catch (error: unknown) {
    process.stderr.write(`${JSON.stringify({ level: 'fatal', error: String(error) })}\n`);
    process.exitCode = 1;
  }
}

function isMainModule(moduleUrl: string): boolean {
  const entryPath = process.argv[1];
  return entryPath !== undefined && moduleUrl === pathToFileURL(resolve(entryPath)).href;
}

if (isMainModule(import.meta.url)) {
  void main();
}
