import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';

import type { NumberRecognizer } from '../src/integrations/openai.js';
import {
  PersistentCountingChainService,
  type CountingChainConfig,
  type CountingChainHistoryMessage,
  type CountingChainMessage,
} from '../src/services/counting-chain.js';
import type { JsonState, StateStore } from '../src/state/state-store.js';

const logger = pino({ level: 'silent' });
const config: CountingChainConfig = {
  enabled: true,
  channelId: 'counting-channel',
  maxAttachmentBytes: 1024 * 1024,
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
  overrides: Partial<CountingChainMessage> = {},
): CountingChainMessage {
  return {
    id,
    channelId: 'counting-channel',
    authorId,
    authorIsBot: false,
    content: '',
    attachments: [
      {
        url: `https://cdn.discordapp.com/attachments/1/${id}/number.gif`,
        name: 'number.gif',
        contentType: 'image/gif',
        size: 4,
      },
    ],
    react: vi.fn().mockResolvedValue(undefined),
    reply: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function createService(
  state: MemoryStateStore,
  recognizer: NumberRecognizer,
): PersistentCountingChainService {
  return new PersistentCountingChainService({
    config,
    recognizer,
    state,
    logger,
    fetchImplementation: vi.fn<typeof fetch>().mockImplementation(
      async () =>
        new Response(Buffer.from('gif-data'), {
          headers: { 'content-type': 'image/gif' },
        }),
    ),
    clock: () => new Date('2026-10-23T00:00:00.000Z'),
  });
}

function createHistoryMessage(
  authorId: string,
  id: string,
  overrides: Partial<CountingChainHistoryMessage> = {},
): CountingChainHistoryMessage {
  return {
    ...createMessage(authorId, id),
    content: '',
    botReactionEmojis: [],
    ...overrides,
  };
}

describe('counting-chain service', () => {
  it('reacts to valid images and persists the next expected number', async () => {
    const state = new MemoryStateStore();
    const recognizer = {
      recognizeNumber: vi
        .fn<NumberRecognizer['recognizeNumber']>()
        .mockResolvedValueOnce(1)
        .mockResolvedValueOnce(2),
    };
    const service = createService(state, recognizer);
    const first = createMessage('user-1', 'message-1');
    const second = createMessage('user-2', 'message-2');

    await service.handleMessage(first);
    await service.handleMessage(second);

    expect(first.react).toHaveBeenCalledWith('👍');
    expect(second.react).toHaveBeenCalledWith('👍');
    expect(first.reply).not.toHaveBeenCalled();
    expect(second.reply).not.toHaveBeenCalled();
    expect(state.state).toMatchObject({
      countingChain: {
        expectedNumber: 3,
        lastAuthorId: 'user-2',
        lastMessageId: 'message-2',
      },
    });
  });

  it('processes a direct approved GIF URL in message content', async () => {
    const state = new MemoryStateStore();
    const recognizer = {
      recognizeNumber: vi.fn<NumberRecognizer['recognizeNumber']>().mockResolvedValue(1),
    };
    const service = createService(state, recognizer);
    const message = createMessage('user-1', 'message-url', {
      content: 'https://media.tenor.com/example/number.gif',
      attachments: [],
    });

    await service.handleMessage(message);

    expect(recognizer.recognizeNumber).toHaveBeenCalledOnce();
    expect(message.react).toHaveBeenCalledWith('👍');
    expect(state.state).toMatchObject({
      countingChain: { expectedNumber: 2, lastMessageId: 'message-url' },
    });
  });

  it('processes a GIF when Discord adds the embed after the message event', async () => {
    const state = new MemoryStateStore();
    const recognizer = {
      recognizeNumber: vi.fn<NumberRecognizer['recognizeNumber']>().mockResolvedValue(1),
    };
    const service = createService(state, recognizer);
    const created = createMessage('user-1', 'message-updated', {
      content: 'https://tenor.com/view/example',
      attachments: [],
    });
    const updated = createMessage('user-1', 'message-updated', {
      content: 'https://tenor.com/view/example',
      attachments: [],
      imageUrls: ['https://media.tenor.com/example/number.gif'],
    });

    await service.handleMessage(created);
    await service.handleMessage(updated);
    await service.handleMessage({ ...updated, botReactionEmojis: ['👍'] });

    expect(recognizer.recognizeNumber).toHaveBeenCalledOnce();
    expect(updated.react).toHaveBeenCalledWith('👍');
    expect(state.state).toMatchObject({
      countingChain: { expectedNumber: 2, lastMessageId: 'message-updated' },
    });
  });

  it('processes an image URL supplied by a Discord embed during history recovery', async () => {
    const state = new MemoryStateStore();
    const recognizer = {
      recognizeNumber: vi.fn<NumberRecognizer['recognizeNumber']>().mockResolvedValue(8),
    };
    const service = createService(state, recognizer);
    const message = createHistoryMessage('user-1', 'history-gif-url', {
      attachments: [],
      content: 'https://tenor.com/view/example',
      imageUrls: ['https://media.tenor.com/example/number.gif'],
    });

    await service.initialize(() => Promise.resolve([message]));

    expect(recognizer.recognizeNumber).toHaveBeenCalledOnce();
    expect(state.state).toMatchObject({
      countingChain: { expectedNumber: 9, lastMessageId: 'history-gif-url' },
    });
  });

  it('reconciles an approved GIF URL posted while the bot was offline', async () => {
    const state = new MemoryStateStore();
    const firstService = createService(state, {
      recognizeNumber: vi.fn().mockResolvedValue(1),
    });
    const checkpointMessageId = '1562802766370447400';
    await firstService.handleMessage(createMessage('user-1', checkpointMessageId));

    const offlineGif = createHistoryMessage('user-2', '1562802766370447401', {
      attachments: [],
      content: 'https://media.giphy.com/media/example/number.gif',
    });
    const checkpoint = createHistoryMessage('user-1', checkpointMessageId, {
      botReactionEmojis: ['👍'],
    });
    const recognizer = {
      recognizeNumber: vi.fn<NumberRecognizer['recognizeNumber']>().mockResolvedValue(2),
    };
    const service = createService(state, recognizer);

    await service.initialize(() => Promise.resolve([offlineGif, checkpoint]));

    expect(recognizer.recognizeNumber).toHaveBeenCalledOnce();
    expect(offlineGif.react).toHaveBeenCalledWith('👍');
    expect(state.state).toMatchObject({
      countingChain: {
        expectedNumber: 3,
        lastMessageId: '1562802766370447401',
        lastProcessedMessageId: '1562802766370447401',
      },
    });
  });

  it('ignores unapproved page URLs without treating them as image sources', async () => {
    const state = new MemoryStateStore();
    const recognizer = { recognizeNumber: vi.fn<NumberRecognizer['recognizeNumber']>() };
    const service = createService(state, recognizer);
    const message = createMessage('user-1', 'message-page-url', {
      content: 'https://example.com/number.gif',
      attachments: [],
    });

    await service.handleMessage(message);

    expect(recognizer.recognizeNumber).not.toHaveBeenCalled();
    expect(message.react).not.toHaveBeenCalled();
    expect(state.state).toEqual({});
  });

  it('reacts and resets when the number is wrong', async () => {
    const state = new MemoryStateStore();
    const recognizer = {
      recognizeNumber: vi
        .fn<NumberRecognizer['recognizeNumber']>()
        .mockResolvedValueOnce(1)
        .mockResolvedValueOnce(4),
    };
    const service = createService(state, recognizer);
    const first = createMessage('user-1', 'message-1');
    const wrong = createMessage('user-2', 'message-2');

    await service.handleMessage(first);
    await service.handleMessage(wrong);

    expect(wrong.react).toHaveBeenCalledWith('❌');
    expect(wrong.reply).toHaveBeenCalledWith(
      'Counting chain over — the next number was not accepted. Starting again at 1.',
    );
    expect(state.state).toMatchObject({
      countingChain: {
        expectedNumber: 1,
        lastAuthorId: null,
        lastMessageId: null,
      },
    });
  });

  it('reacts and resets when one user posts twice in a row', async () => {
    const state = new MemoryStateStore();
    const recognizer = {
      recognizeNumber: vi
        .fn<NumberRecognizer['recognizeNumber']>()
        .mockResolvedValueOnce(1)
        .mockResolvedValueOnce(2),
    };
    const service = createService(state, recognizer);
    const first = createMessage('same-user', 'message-1');
    const second = createMessage('same-user', 'message-2');

    await service.handleMessage(first);
    await service.handleMessage(second);

    expect(second.react).toHaveBeenCalledWith('❌');
    expect(second.reply).toHaveBeenCalledOnce();
    expect(state.state).toMatchObject({
      countingChain: {
        expectedNumber: 1,
      },
    });
  });

  it('does not change the game for an unreadable image', async () => {
    const state = new MemoryStateStore();
    const recognizer = {
      recognizeNumber: vi.fn<NumberRecognizer['recognizeNumber']>().mockResolvedValue(null),
    };
    const service = createService(state, recognizer);
    const message = createMessage('user-1', 'message-1');

    await service.handleMessage(message);

    expect(message.react).toHaveBeenCalledWith('⚠️');
    expect(message.reply).toHaveBeenCalledWith('I could not read that image. Please try again.');
    expect(state.state).toMatchObject({
      countingChain: {
        expectedNumber: 1,
        lastProcessedMessageId: 'message-1',
      },
    });
  });

  it('does not change the game when the recognizer fails', async () => {
    const state = new MemoryStateStore();
    const recognizer = {
      recognizeNumber: vi
        .fn<NumberRecognizer['recognizeNumber']>()
        .mockRejectedValue(new Error('OpenAI unavailable')),
    };
    const service = createService(state, recognizer);
    const message = createMessage('user-1', 'message-1');

    await service.handleMessage(message);

    expect(message.react).toHaveBeenCalledWith('⚠️');
    expect(message.reply).toHaveBeenCalledWith('I could not read that image. Please try again.');
    expect(state.state).toMatchObject({
      countingChain: {
        expectedNumber: 1,
        lastProcessedMessageId: 'message-1',
      },
    });
  });

  it('serializes simultaneous messages in arrival order', async () => {
    const state = new MemoryStateStore();
    const recognizer = {
      recognizeNumber: vi
        .fn<NumberRecognizer['recognizeNumber']>()
        .mockResolvedValueOnce(1)
        .mockResolvedValueOnce(2),
    };
    const service = createService(state, recognizer);
    const first = createMessage('user-1', 'message-1');
    const second = createMessage('user-2', 'message-2');

    await Promise.all([service.handleMessage(first), service.handleMessage(second)]);

    expect(first.react).toHaveBeenCalledWith('👍');
    expect(second.react).toHaveBeenCalledWith('👍');
    expect(state.state).toMatchObject({
      countingChain: {
        expectedNumber: 3,
      },
    });
  });

  it('continues from persistent state after a service restart', async () => {
    const state = new MemoryStateStore();
    const firstService = createService(state, {
      recognizeNumber: vi.fn().mockResolvedValue(1),
    });
    await firstService.handleMessage(createMessage('user-1', 'message-1'));

    const secondService = createService(state, {
      recognizeNumber: vi.fn().mockResolvedValue(2),
    });
    const second = createMessage('user-2', 'message-2');
    await secondService.handleMessage(second);

    expect(second.react).toHaveBeenCalledWith('👍');
    expect(state.state).toMatchObject({
      countingChain: {
        expectedNumber: 3,
      },
    });
  });

  it('reconciles image messages posted while the bot was offline and does not replay them', async () => {
    const state = new MemoryStateStore();
    const firstService = createService(state, {
      recognizeNumber: vi.fn().mockResolvedValue(1),
    });
    const checkpointMessageId = '1562802766370447380';
    await firstService.handleMessage(createMessage('user-1', checkpointMessageId));

    const offlineFirst = createHistoryMessage('user-2', '1562802766370447381');
    const offlineSecond = createHistoryMessage('user-3', '1562802766370447382');
    const latestText = createHistoryMessage('user-4', '1562802766370447383', {
      attachments: [],
    });
    const checkpoint = createHistoryMessage('user-1', checkpointMessageId, {
      botReactionEmojis: ['👍'],
    });
    const recognizer = {
      recognizeNumber: vi
        .fn<NumberRecognizer['recognizeNumber']>()
        .mockResolvedValueOnce(2)
        .mockResolvedValueOnce(3),
    };
    const service = createService(state, recognizer);
    const historyProvider = vi
      .fn<() => Promise<readonly CountingChainHistoryMessage[]>>()
      .mockResolvedValue([latestText, offlineSecond, checkpoint, offlineFirst]);

    await service.initialize(historyProvider);

    expect(historyProvider).toHaveBeenCalledOnce();
    expect(recognizer.recognizeNumber).toHaveBeenCalledTimes(2);
    expect(offlineFirst.react).toHaveBeenCalledWith('👍');
    expect(offlineSecond.react).toHaveBeenCalledWith('👍');
    expect(state.state).toMatchObject({
      countingChain: {
        expectedNumber: 4,
        lastAuthorId: 'user-3',
        lastMessageId: '1562802766370447382',
        lastProcessedMessageId: '1562802766370447383',
      },
    });

    const restartedRecognizer = {
      recognizeNumber: vi.fn<NumberRecognizer['recognizeNumber']>(),
    };
    const restartedService = createService(state, restartedRecognizer);
    await restartedService.initialize(() =>
      Promise.resolve([latestText, offlineSecond, checkpoint, offlineFirst]),
    );

    expect(restartedRecognizer.recognizeNumber).not.toHaveBeenCalled();
    expect(offlineFirst.react).toHaveBeenCalledTimes(1);
    expect(offlineSecond.react).toHaveBeenCalledTimes(1);
  });

  it('reconciles an offline failure before continuing the reset chain', async () => {
    const state = new MemoryStateStore();
    const firstService = createService(state, {
      recognizeNumber: vi.fn().mockResolvedValue(1),
    });
    const checkpointMessageId = '1562802766370447390';
    await firstService.handleMessage(createMessage('user-1', checkpointMessageId));

    const failedMessage = createHistoryMessage('user-2', '1562802766370447391');
    const acceptedAfterReset = createHistoryMessage('user-3', '1562802766370447392');
    const checkpoint = createHistoryMessage('user-1', checkpointMessageId, {
      botReactionEmojis: ['👍'],
    });
    const recognizer = {
      recognizeNumber: vi
        .fn<NumberRecognizer['recognizeNumber']>()
        .mockResolvedValueOnce(9)
        .mockResolvedValueOnce(1),
    };
    const service = createService(state, recognizer);

    await service.initialize(() =>
      Promise.resolve([acceptedAfterReset, failedMessage, checkpoint]),
    );

    expect(failedMessage.react).toHaveBeenCalledWith('❌');
    expect(failedMessage.reply).toHaveBeenCalledOnce();
    expect(acceptedAfterReset.react).toHaveBeenCalledWith('👍');
    expect(state.state).toMatchObject({
      countingChain: {
        expectedNumber: 2,
        lastAuthorId: 'user-3',
        lastMessageId: '1562802766370447392',
        lastProcessedMessageId: '1562802766370447392',
        lastRound: 1,
        lastRoundReason: 'wrong-number',
      },
    });
  });

  it('recovers a missing state from the latest accepted image in channel history', async () => {
    const state = new MemoryStateStore();
    const recognizer = {
      recognizeNumber: vi
        .fn<NumberRecognizer['recognizeNumber']>()
        .mockResolvedValueOnce(7)
        .mockResolvedValueOnce(8),
    };
    const service = createService(state, recognizer);
    const historyMessage = createHistoryMessage('user-1', 'history-message');
    const infoPublisher = { update: vi.fn().mockResolvedValue('info-message') };

    await service.initialize(() => Promise.resolve([historyMessage]), infoPublisher);

    expect(recognizer.recognizeNumber).toHaveBeenCalledOnce();
    expect(historyMessage.react).not.toHaveBeenCalled();
    expect(historyMessage.reply).not.toHaveBeenCalled();
    expect(infoPublisher.update).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedNumber: 8,
        highScore: 7,
        lastAuthorId: 'user-1',
        lastMessageId: 'history-message',
      }),
      undefined,
    );

    const next = createMessage('user-2', 'message-2');
    await service.handleMessage(next);

    expect(next.react).toHaveBeenCalledWith('👍');
    expect(state.state).toMatchObject({
      countingChain: { infoMessageId: 'info-message' },
    });

    expect(state.state).toMatchObject({
      countingChain: {
        expectedNumber: 9,
      },
    });
  });

  it('recovers from history longer than the previous 50-message window', async () => {
    const state = new MemoryStateStore();
    const recognizer = {
      recognizeNumber: vi.fn<NumberRecognizer['recognizeNumber']>().mockResolvedValue(263),
    };
    const service = createService(state, recognizer);
    const latestAccepted = createHistoryMessage('user-263', 'history-263');
    const olderMessages = Array.from({ length: 262 }, (_, index) =>
      createHistoryMessage('user-old', `history-old-${index}`, { attachments: [] }),
    );

    await service.initialize(() => Promise.resolve([latestAccepted, ...olderMessages]));

    expect(recognizer.recognizeNumber).toHaveBeenCalledOnce();
    expect(state.state).toMatchObject({
      countingChain: {
        expectedNumber: 264,
        lastMessageId: 'history-263',
      },
    });
  });

  it('selects the newest Discord snowflake when history is not already ordered', async () => {
    const state = new MemoryStateStore();
    const recognizer = {
      recognizeNumber: vi.fn<NumberRecognizer['recognizeNumber']>().mockResolvedValue(264),
    };
    const service = createService(state, recognizer);
    const olderMessage = createHistoryMessage('user-old', '1085790972702642226');
    const newerMessage = createHistoryMessage('user-new', '1562802766370447380');

    await service.initialize(() => Promise.resolve([olderMessage, newerMessage]));

    expect(state.state).toMatchObject({
      countingChain: {
        expectedNumber: 265,
        lastMessageId: '1562802766370447380',
      },
    });
  });

  it('treats an empty legacy game record as missing and writes the single-game shape', async () => {
    const state = new MemoryStateStore();
    state.state = {
      countingChain: {
        version: 1,
        games: { 'counting-channel': {} },
        infoMessageId: 'info-message',
      },
    };
    const recognizer = {
      recognizeNumber: vi.fn<NumberRecognizer['recognizeNumber']>().mockResolvedValue(12),
    };
    const service = createService(state, recognizer);
    const historyMessage = createHistoryMessage('user-1', 'history-message');
    const historyProvider = vi.fn().mockResolvedValue([historyMessage]);

    await service.initialize(historyProvider);

    expect(historyProvider).toHaveBeenCalledOnce();
    expect(state.state).toMatchObject({
      countingChain: {
        infoMessageId: 'info-message',
        expectedNumber: 13,
        lastMessageId: 'history-message',
      },
    });
    expect(state.state.countingChain).not.toHaveProperty('games');
  });

  it.each([
    {
      description: 'a failed reaction',
      overrides: { botReactionEmojis: ['❌'] },
    },
    {
      description: 'a bot failure reply',
      overrides: {
        authorIsBot: true,
        content: 'Counting chain over — the next number was not accepted.',
      },
    },
  ])('silently resets when history is marked by $description', async ({ overrides }) => {
    const state = new MemoryStateStore();
    const recognizer = { recognizeNumber: vi.fn().mockResolvedValue(7) };
    const service = createService(state, recognizer);
    const failedMessage = createHistoryMessage('user-1', 'failed-message', overrides);

    await service.initialize(() => Promise.resolve([failedMessage]));

    expect(recognizer.recognizeNumber).not.toHaveBeenCalled();
    expect(failedMessage.react).not.toHaveBeenCalled();
    expect(failedMessage.reply).not.toHaveBeenCalled();
    expect(state.state).toMatchObject({
      countingChain: {
        expectedNumber: 1,
        highScore: 0,
        lastRound: 0,
      },
    });
  });

  it('silently starts at one when no relevant history exists', async () => {
    const state = new MemoryStateStore();
    const recognizer = { recognizeNumber: vi.fn().mockResolvedValue(7) };
    const service = createService(state, recognizer);

    await service.initialize(() => Promise.resolve([]));

    expect(recognizer.recognizeNumber).not.toHaveBeenCalled();
    expect(state.state).toMatchObject({
      countingChain: {
        expectedNumber: 1,
      },
    });
  });

  it('persists a reset and retries history recovery after Discord history cannot be read', async () => {
    const state = new MemoryStateStore();
    const recognizer = {
      recognizeNumber: vi.fn<NumberRecognizer['recognizeNumber']>().mockResolvedValue(7),
    };
    const historyMessage = createHistoryMessage('user-1', 'history-message');
    const historyProvider = vi
      .fn<() => Promise<readonly CountingChainHistoryMessage[]>>()
      .mockRejectedValueOnce(new Error('Unknown Channel'))
      .mockResolvedValueOnce([historyMessage]);

    await createService(state, recognizer).initialize(historyProvider);

    expect(recognizer.recognizeNumber).not.toHaveBeenCalled();
    expect(state.state).toMatchObject({
      countingChain: {
        version: 1,
        historyRecoveryPending: true,
        expectedNumber: 1,
        lastAuthorId: null,
        lastMessageId: null,
        highScore: 0,
      },
    });

    await createService(state, recognizer).initialize(historyProvider);

    expect(historyProvider).toHaveBeenCalledTimes(2);
    expect(recognizer.recognizeNumber).toHaveBeenCalledOnce();
    expect(state.state).toMatchObject({
      countingChain: {
        expectedNumber: 8,
        lastMessageId: 'history-message',
      },
    });
    expect(state.state.countingChain).not.toHaveProperty('historyRecoveryPending');
  });

  it('ignores messages outside the configured channel and bot messages', async () => {
    const state = new MemoryStateStore();
    const recognizer = { recognizeNumber: vi.fn().mockResolvedValue(1) };
    const service = createService(state, recognizer);
    const otherChannel = createMessage('user-1', 'message-1', {
      channelId: 'other-channel',
    });
    const botMessage = createMessage('bot', 'message-2', { authorIsBot: true });

    await service.handleMessage(otherChannel);
    await service.handleMessage(botMessage);

    expect(recognizer.recognizeNumber).not.toHaveBeenCalled();
    expect(state.state).toEqual({});
  });
});
