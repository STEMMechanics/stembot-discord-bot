import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';

import {
  PersistentNumberGameService,
  type NumberGameMessage,
} from '../src/services/number-game.js';
import type { JsonState, StateStore } from '../src/state/state-store.js';

const logger = pino({ level: 'silent' });

class MemoryStateStore implements StateStore<JsonState> {
  public state: JsonState = {};

  public async load(): Promise<JsonState> {
    return this.state;
  }

  public async save(state: JsonState): Promise<void> {
    this.state = state;
  }
}

function createMessage(
  authorId: string,
  id: string,
  content: string,
  referencedMessageId?: string,
): NumberGameMessage {
  return {
    id,
    channelId: 'number-channel',
    authorId,
    authorIsBot: false,
    content,
    ...(referencedMessageId ? { referencedMessageId } : {}),
    reply: vi.fn().mockResolvedValue(undefined),
  };
}

function createService(state: MemoryStateStore): PersistentNumberGameService {
  return new PersistentNumberGameService({
    state,
    logger,
    random: () => 0.3,
    idFactory: () => 'challenge-1',
  });
}

describe('number game service', () => {
  it('starts a challenge and accepts one correct reply', async () => {
    const state = new MemoryStateStore();
    const service = createService(state);
    const challenge = await service.startChallenge('user-1', 'number-channel');
    await service.activateChallenge(challenge.challengeId, 'prompt-1');
    const message = createMessage('user-1', 'guess-1', '7', 'prompt-1');

    await service.handleMessage(message);

    expect(message.reply).toHaveBeenCalledWith('🎉 Correct! I was thinking of **7**.');
    expect(state.state).toMatchObject({ numberGame: { active: {} } });
    await expect(service.getLeaderboard(3)).resolves.toEqual([{ userId: 'user-1', score: 1 }]);
  });

  it('consumes the first wrong reply and ignores later attempts', async () => {
    const state = new MemoryStateStore();
    const service = createService(state);
    const challenge = await service.startChallenge('user-1', 'number-channel');
    await service.activateChallenge(challenge.challengeId, 'prompt-1');
    const wrongMessage = createMessage('user-1', 'guess-1', '8', 'prompt-1');
    const laterMessage = createMessage('user-1', 'guess-2', '7', 'prompt-1');

    await service.handleMessage(wrongMessage);
    await service.handleMessage(laterMessage);

    expect(wrongMessage.reply).toHaveBeenCalledWith(
      '❌ Not quite — I was thinking of **7**. That was your one attempt.',
    );
    expect(laterMessage.reply).not.toHaveBeenCalled();
    expect(state.state).toMatchObject({ numberGame: { active: {} } });
  });

  it('requires a reply to the exact prompt from the challenge owner', async () => {
    const state = new MemoryStateStore();
    const service = createService(state);
    const challenge = await service.startChallenge('user-1', 'number-channel');
    await service.activateChallenge(challenge.challengeId, 'prompt-1');

    await service.handleMessage(createMessage('user-1', 'guess-1', '7'));
    await service.handleMessage(createMessage('user-1', 'guess-2', '7', 'other-prompt'));
    await service.handleMessage(createMessage('user-2', 'guess-3', '7', 'prompt-1'));

    expect(state.state).toMatchObject({
      numberGame: {
        active: {
          'number-channel:user-1': { promptMessageId: 'prompt-1' },
        },
      },
    });
  });
});
