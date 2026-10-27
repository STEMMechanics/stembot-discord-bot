import { Routes, type REST } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';

import {
  getCommandRegistrationTargets,
  replaceCommandScopes,
} from '../src/discord/command-registration.js';
import { getCommandDefinitions } from '../src/discord/commands.js';

describe('Discord command synchronization', () => {
  it('targets global and the configured guild for the same application', () => {
    const clientId = '123456789012345678';
    const guildId = '987654321098765432';

    expect(getCommandRegistrationTargets(clientId, guildId)).toEqual([
      {
        scope: 'global',
        route: Routes.applicationCommands(clientId),
      },
      {
        scope: 'guild',
        route: Routes.applicationGuildCommands(clientId, guildId),
      },
    ]);
  });

  it('clears global commands and registers only the supported guild commands', async () => {
    const clientId = '123456789012345678';
    const guildId = '987654321098765432';
    const definitions = getCommandDefinitions();
    const get = vi.fn().mockResolvedValue([
      { id: 'global-ping', name: 'ping' },
      { id: 'global-joke', name: 'joke' },
    ]);
    const remove = vi.fn().mockResolvedValue({});
    const put = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce(definitions);
    const rest = { get, put, delete: remove } as unknown as Pick<REST, 'get' | 'put' | 'delete'>;

    const results = await replaceCommandScopes(rest, clientId, guildId, [], definitions);

    expect(results).toEqual([
      { scope: 'global', commandCount: 0 },
      { scope: 'guild', commandCount: 14 },
    ]);
    expect(put).toHaveBeenCalledTimes(2);
    expect(get).toHaveBeenCalledWith(Routes.applicationCommands(clientId));
    expect(remove).toHaveBeenCalledTimes(2);
    expect(remove).toHaveBeenNthCalledWith(1, Routes.applicationCommand(clientId, 'global-ping'));
    expect(remove).toHaveBeenNthCalledWith(2, Routes.applicationCommand(clientId, 'global-joke'));
    expect(put).toHaveBeenNthCalledWith(1, Routes.applicationCommands(clientId), {
      body: [],
    });
    expect(put).toHaveBeenNthCalledWith(2, Routes.applicationGuildCommands(clientId, guildId), {
      body: definitions,
    });
    expect(definitions.map((definition) => definition.name)).toEqual([
      'ping',
      'workshops',
      'joke',
      'number',
      'level',
      'status',
      'scramble',
      'mystery-lab',
      'code-fix',
      'leaderboard',
      'review',
      'counting-chain',
      'remind',
      'minecraft',
    ]);
  });
});
