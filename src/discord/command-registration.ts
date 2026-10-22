import {
  Routes,
  type REST,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
} from 'discord.js';

export type CommandRegistrationScope = 'global' | 'guild';

export interface CommandRegistrationTarget {
  scope: CommandRegistrationScope;
  route: `/${string}`;
}

export interface CommandRegistrationResult {
  scope: CommandRegistrationScope;
  commandCount: number;
}

/**
 * Returns the application command scopes that this deployment is allowed to replace.
 *
 * Global commands are always synchronized. A guild scope is included only when
 * DISCORD_GUILD_ID is configured, so the script cannot guess or alter unrelated guilds.
 */
export function getCommandRegistrationTargets(
  clientId: string,
  guildId?: string,
): CommandRegistrationTarget[] {
  const targets: CommandRegistrationTarget[] = [
    {
      scope: 'global',
      route: Routes.applicationCommands(clientId),
    },
  ];

  if (guildId) {
    targets.push({
      scope: 'guild',
      route: Routes.applicationGuildCommands(clientId, guildId),
    });
  }

  return targets;
}

/**
 * Replaces each selected Discord command scope with the complete supported command set.
 * Discord removes commands that are absent from the PUT body.
 */
export async function replaceCommandScopes(
  rest: Pick<REST, 'put'>,
  clientId: string,
  guildId: string | undefined,
  commandDefinitions: RESTPostAPIChatInputApplicationCommandsJSONBody[],
): Promise<CommandRegistrationResult[]> {
  const results: CommandRegistrationResult[] = [];

  for (const target of getCommandRegistrationTargets(clientId, guildId)) {
    const response = await rest.put(target.route, {
      body: commandDefinitions,
    });
    const commandCount = Array.isArray(response) ? response.length : commandDefinitions.length;
    results.push({ scope: target.scope, commandCount });
  }

  return results;
}
