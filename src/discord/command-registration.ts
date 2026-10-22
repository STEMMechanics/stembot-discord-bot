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

interface ApplicationCommandIdentity {
  id: string;
}

/**
 * Returns the application command scopes that this deployment is allowed to replace.
 *
 * The global scope is included so stale global commands can be cleared. The
 * configured guild scope is the only scope that receives supported commands.
 */
export function getCommandRegistrationTargets(
  clientId: string,
  guildId: string,
): CommandRegistrationTarget[] {
  const targets: CommandRegistrationTarget[] = [
    {
      scope: 'global',
      route: Routes.applicationCommands(clientId),
    },
  ];

  targets.push({
    scope: 'guild',
    route: Routes.applicationGuildCommands(clientId, guildId),
  });

  return targets;
}

/**
 * Replaces the global and configured guild command scopes. Discord removes
 * commands that are absent from the PUT body. The caller supplies an empty
 * global body to clear global registrations and the supported body for the
 * single target guild.
 */
export async function replaceCommandScopes(
  rest: Pick<REST, 'get' | 'put' | 'delete'>,
  clientId: string,
  guildId: string,
  globalCommandDefinitions: RESTPostAPIChatInputApplicationCommandsJSONBody[],
  guildCommandDefinitions: RESTPostAPIChatInputApplicationCommandsJSONBody[],
): Promise<CommandRegistrationResult[]> {
  const results: CommandRegistrationResult[] = [];

  for (const target of getCommandRegistrationTargets(clientId, guildId)) {
    if (target.scope === 'global') {
      await deleteExistingGlobalCommands(rest, clientId);
    }

    const definitions =
      target.scope === 'guild' ? guildCommandDefinitions : globalCommandDefinitions;
    const response = await rest.put(target.route, {
      body: definitions,
    });
    const commandCount = Array.isArray(response) ? response.length : definitions.length;
    results.push({ scope: target.scope, commandCount });
  }

  return results;
}

/**
 * Removes global commands individually before the bulk replacement. The bulk
 * PUT is authoritative, but the explicit deletes also clear older global
 * registrations promptly when a deployment changes from global-plus-guild to
 * guild-only commands.
 */
async function deleteExistingGlobalCommands(
  rest: Pick<REST, 'get' | 'delete'>,
  clientId: string,
): Promise<void> {
  const route = Routes.applicationCommands(clientId);
  const response = await rest.get(route);

  if (!Array.isArray(response)) {
    return;
  }

  for (const candidate of response) {
    const command = asApplicationCommandIdentity(candidate);
    if (command) {
      await rest.delete(Routes.applicationCommand(clientId, command.id));
    }
  }
}

function asApplicationCommandIdentity(value: unknown): ApplicationCommandIdentity | undefined {
  if (typeof value !== 'object' || value === null || !('id' in value)) {
    return undefined;
  }

  return typeof value.id === 'string' ? { id: value.id } : undefined;
}
