import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';

import type { StemAskAnswerer } from '../src/integrations/openai-ask.js';
import {
  PersistentStemAskService,
  type StemAskConfig,
  type StemAskMessage,
} from '../src/services/stem-ask.js';
import type { JsonState, StateStore } from '../src/state/state-store.js';

const logger = pino({ level: 'silent' });
const config: StemAskConfig = {
  enabled: true,
  channelId: 'ask-channel',
  maxQuestionLength: 100,
  userCooldownMs: 60_000,
  userDailyLimit: 2,
  globalDailyLimit: 3,
};

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
  question: string,
  overrides: Partial<StemAskMessage> = {},
): StemAskMessage {
  return {
    id,
    channelId: 'ask-channel',
    authorId,
    authorIsBot: false,
    question,
    reply: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('STEM ask service', () => {
  it('answers questions and enforces per-user cooldown and daily limits', async () => {
    const state = new MemoryStateStore();
    const answer = vi
      .fn<StemAskAnswerer['answer']>()
      .mockResolvedValueOnce('Gravity pulls objects towards Earth.')
      .mockResolvedValueOnce('Water freezes at 0°C.');
    let now = new Date('2026-10-23T02:00:00.000Z');
    const service = new PersistentStemAskService({
      config,
      answerer: { answer },
      state,
      logger,
      clock: () => now,
    });

    const first = createMessage('user-1', 'message-1', 'Why do objects fall?');
    await service.handleMessage(first);
    await service.handleMessage(createMessage('user-1', 'message-2', 'What is water?'));

    now = new Date(now.getTime() + config.userCooldownMs);
    const second = createMessage('user-1', 'message-3', 'When does water freeze?');
    await service.handleMessage(second);
    await service.handleMessage(createMessage('user-1', 'message-4', 'What is a star?'));

    now = new Date(now.getTime() + config.userCooldownMs);
    await service.handleMessage(createMessage('user-1', 'message-5', 'What is a planet?'));

    expect(answer).toHaveBeenCalledTimes(2);
    expect(first.reply).toHaveBeenCalledWith('Gravity pulls objects towards Earth.');
    expect(second.reply).toHaveBeenCalledWith('Water freezes at 0°C.');
    expect(state.state).toMatchObject({
      stemAsk: {
        totalRequests: 2,
        userRequests: { 'user-1': 2 },
      },
    });
  });

  it('enforces the global daily limit across users and resets it on a new UTC day', async () => {
    const state = new MemoryStateStore();
    const answer = vi
      .fn<StemAskAnswerer['answer']>()
      .mockResolvedValueOnce('First answer.')
      .mockResolvedValueOnce('Next day answer.');
    let now = new Date('2026-10-23T23:59:00.000Z');
    const service = new PersistentStemAskService({
      config: { ...config, globalDailyLimit: 1, userDailyLimit: 10 },
      answerer: { answer },
      state,
      logger,
      clock: () => now,
    });

    await service.handleMessage(createMessage('user-1', 'message-1', 'Question one?'));
    const blocked = createMessage('user-2', 'message-2', 'Question two?');
    await service.handleMessage(blocked);

    now = new Date('2026-10-24T00:01:00.000Z');
    const nextDay = createMessage('user-2', 'message-3', 'Question three?');
    await service.handleMessage(nextDay);

    expect(answer).toHaveBeenCalledTimes(2);
    expect(blocked.reply).not.toHaveBeenCalled();
    expect(nextDay.reply).toHaveBeenCalledWith('Next day answer.');
  });

  it('ignores bots, other channels, empty questions and oversized questions', async () => {
    const state = new MemoryStateStore();
    const answer = vi.fn<StemAskAnswerer['answer']>().mockResolvedValue('answer');
    const service = new PersistentStemAskService({
      config,
      answerer: { answer },
      state,
      logger,
    });

    await service.handleMessage(
      createMessage('bot-1', 'message-1', 'Question', { authorIsBot: true }),
    );
    await service.handleMessage(
      createMessage('user-1', 'message-2', 'Question', { channelId: 'other-channel' }),
    );
    await service.handleMessage(createMessage('user-1', 'message-3', '   '));
    await service.handleMessage(createMessage('user-1', 'message-4', 'x'.repeat(101)));

    expect(answer).not.toHaveBeenCalled();
  });
});
