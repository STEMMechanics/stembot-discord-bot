import { REST, Routes } from 'discord.js';

import { loadConfig } from '../src/config/env.js';
import { getCommandDefinitions } from '../src/discord/commands.js';
import { createLogger } from '../src/logging/logger.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config);
  const rest = new REST({ version: '10' }).setToken(config.discord.token);
  const commandDefinitions = getCommandDefinitions();
  const route = config.discord.guildId
    ? Routes.applicationGuildCommands(config.discord.clientId, config.discord.guildId)
    : Routes.applicationCommands(config.discord.clientId);

  try {
    const result = await rest.put(route, { body: commandDefinitions });
    const commandCount = Array.isArray(result) ? result.length : commandDefinitions.length;

    logger.info(
      {
        commandCount,
        scope: config.discord.guildId ? 'guild' : 'global',
      },
      'Discord application commands registered',
    );
  } catch (error: unknown) {
    logger.error({ err: error }, 'Failed to register Discord application commands');
    process.exitCode = 1;
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`${JSON.stringify({ level: 'fatal', error: String(error) })}\n`);
  process.exitCode = 1;
});
