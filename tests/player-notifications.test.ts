import pino from 'pino';
import { describe, expect, it } from 'vitest';

import {
  createPlayerNotificationService,
  type PlayerNotificationService,
} from '../src/services/player-notifications.js';
import type { JsonState, StateStore } from '../src/state/state-store.js';

class MemoryStateStore implements StateStore<JsonState> {
  public state: JsonState = {};

  public async load(): Promise<JsonState> {
    return this.state;
  }

  public async save(state: JsonState): Promise<void> {
    this.state = state;
  }
}

function service(store: MemoryStateStore): PlayerNotificationService {
  return createPlayerNotificationService({
    state: store,
    logger: pino({ level: 'silent' }),
  });
}

describe('player notification exclusions', () => {
  it('persists UUID-backed ignored players and matches hyphenated event UUIDs', async () => {
    const store = new MemoryStateStore();
    const notifications = service(store);

    await notifications.addIgnoredPlayer({
      username: 'Alex',
      uuid: '0123456789abcdef0123456789abcdef',
    });

    expect(await notifications.isIgnored('01234567-89ab-cdef-0123-456789abcdef')).toBe(true);
    expect(await notifications.isIgnored('fedcba98-7654-3210-fedc-ba9876543210')).toBe(false);
    expect(await notifications.listIgnoredPlayers()).toEqual([
      { username: 'Alex', uuid: '0123456789abcdef0123456789abcdef' },
    ]);
    expect(store.state.playerNotifications).toEqual({
      version: 1,
      ignoredPlayers: [{ username: 'Alex', uuid: '0123456789abcdef0123456789abcdef' }],
    });
  });

  it('updates the readable username without duplicating a UUID', async () => {
    const notifications = service(new MemoryStateStore());

    await notifications.addIgnoredPlayer({
      username: 'OldName',
      uuid: '01234567-89ab-cdef-0123-456789abcdef',
    });
    const result = await notifications.addIgnoredPlayer({
      username: 'NewName',
      uuid: '0123456789abcdef0123456789abcdef',
    });

    expect(result.alreadyIgnored).toBe(true);
    expect(await notifications.listIgnoredPlayers()).toEqual([
      { username: 'NewName', uuid: '0123456789abcdef0123456789abcdef' },
    ]);
  });

  it('removes an ignored player by UUID or readable username', async () => {
    const notifications = service(new MemoryStateStore());
    await notifications.addIgnoredPlayer({ username: 'Alex', uuid: 'player-1' });

    expect(await notifications.findIgnoredPlayerByUsername('alex')).toEqual({
      username: 'Alex',
      uuid: 'player-1',
    });
    expect(await notifications.removeIgnoredPlayer('PLAYER-1')).toEqual({
      username: 'Alex',
      uuid: 'player-1',
    });
    expect(await notifications.listIgnoredPlayers()).toEqual([]);
  });
});
