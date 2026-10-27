import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';

import type { NumberRecognizer } from '../src/integrations/openai.js';
import {
  PersistentCountingChainService,
  type CountingChainConfig,
  type CountingChainPublisher,
  type CountingChainRemoteAddressLookup,
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
    reply: vi.fn().mockResolvedValue('review-reply-message'),
    clearReactions: vi.fn().mockResolvedValue(undefined),
    deleteMessage: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function createService(
  state: MemoryStateStore,
  recognizer: NumberRecognizer,
  options: {
    fetchImplementation?: typeof fetch;
    lookupImplementation?: CountingChainRemoteAddressLookup;
    config?: Partial<CountingChainConfig>;
    publisher?: CountingChainPublisher;
  } = {},
): PersistentCountingChainService {
  return new PersistentCountingChainService({
    config: { ...config, ...options.config },
    recognizer,
    state,
    logger,
    fetchImplementation:
      options.fetchImplementation ??
      vi.fn<typeof fetch>().mockImplementation(
        async () =>
          new Response(Buffer.from('gif-data'), {
            headers: { 'content-type': 'image/gif' },
          }),
      ),
    lookupImplementation:
      options.lookupImplementation ??
      (async () => [{ address: '93.184.216.34', family: 4 as const }]),
    ...(options.publisher ? { publisher: options.publisher } : {}),
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
  it('posts one reminder after the chain has been idle without changing the next number', async () => {
    const state = new MemoryStateStore();
    state.state = {
      countingChain: {
        version: 1,
        expectedNumber: 14,
        lastAuthorId: 'user-13',
        lastMessageId: 'message-13',
        updatedAt: '2026-10-19T00:00:00.000Z',
        highScore: 13,
        highScoreAt: '2026-10-19T00:00:00.000Z',
        lastRound: 0,
        lastRoundAt: null,
        lastRoundReason: null,
        lastProcessedMessageId: 'message-13',
      },
    };
    const publisher = { send: vi.fn().mockResolvedValue('reminder-message-1') };
    const service = createService(state, { recognizeNumber: vi.fn() }, { publisher });

    await service.checkInactivity();
    await service.checkInactivity();

    expect(publisher.send).toHaveBeenCalledOnce();
    expect(publisher.send.mock.calls[0]?.[1]).toContain('**14**');
    expect(state.state).toMatchObject({ countingChain: { expectedNumber: 14 } });
    expect(state.state.countingChain).toHaveProperty('lastNudgeAt', '2026-10-23T00:00:00.000Z');
  });

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
    await expect(service.getLeaderboard(3)).resolves.toEqual([
      { userId: 'user-2', score: 2 },
      { userId: 'user-1', score: 1 },
    ]);
  });

  it('does not wait on the game queue for a concurrent leaderboard read', async () => {
    const state = new MemoryStateStore();
    const serviceHolder: { service?: PersistentCountingChainService } = {};
    const recognizer = {
      recognizeNumber: vi.fn<NumberRecognizer['recognizeNumber']>(async () => {
        await serviceHolder.service?.getLeaderboard(3);
        return 1;
      }),
    };
    const service = createService(state, recognizer);
    serviceHolder.service = service;

    await service.handleMessage(createMessage('user-1', 'message-1'));

    expect(recognizer.recognizeNumber).toHaveBeenCalledOnce();
    expect(state.state).toMatchObject({
      countingChain: { expectedNumber: 2, lastMessageId: 'message-1' },
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

  it('processes numbered GIFs from variant Tenor CDN hosts', async () => {
    const state = new MemoryStateStore();
    const recognizer = {
      recognizeNumber: vi.fn<NumberRecognizer['recognizeNumber']>().mockResolvedValue(1),
    };
    const service = createService(state, recognizer);
    const message = createMessage('user-1', 'message-tenor-variant', {
      content: 'https://media1.tenor.com/example/number.gif',
      attachments: [],
    });

    await service.handleMessage(message);

    expect(recognizer.recognizeNumber).toHaveBeenCalledOnce();
    expect(message.react).toHaveBeenCalledWith('👍');
  });

  it('falls back to an unambiguous number in the image URL', async () => {
    const state = new MemoryStateStore();
    const recognizer = {
      recognizeNumber: vi
        .fn<NumberRecognizer['recognizeNumber']>()
        .mockResolvedValueOnce(1)
        .mockResolvedValueOnce(null),
    };
    const service = createService(state, recognizer);
    await service.handleMessage(createMessage('user-0', 'message-url-seed'));
    const message = createMessage('user-1', 'message-url-number', {
      content: 'https://static.example/counting-chain-2.gif',
      attachments: [],
    });

    await service.handleMessage(message);

    expect(recognizer.recognizeNumber).toHaveBeenCalledTimes(2);
    expect(message.react).toHaveBeenCalledWith('👍');
    expect(message.reply).not.toHaveBeenCalled();
    expect(state.state).toMatchObject({
      countingChain: {
        expectedNumber: 3,
        lastMessageId: 'message-url-number',
      },
    });
  });

  it('uses an explicit image URL query value when the image cannot be read', async () => {
    const state = new MemoryStateStore();
    const recognizer = {
      recognizeNumber: vi.fn<NumberRecognizer['recognizeNumber']>().mockResolvedValue(null),
    };
    const service = createService(state, recognizer);
    const message = createMessage('user-1', 'message-query-number', {
      content: 'https://static.example/counting-chain.gif?number=1',
      attachments: [],
    });

    await service.handleMessage(message);

    expect(message.react).toHaveBeenCalledWith('👍');
    expect(state.state).toMatchObject({
      countingChain: {
        expectedNumber: 2,
        lastMessageId: 'message-query-number',
      },
    });
  });

  it('combines a tens word and a unit word in an image URL fallback', async () => {
    const state = new MemoryStateStore();
    state.state = {
      countingChain: {
        version: 1,
        expectedNumber: 21,
        lastAuthorId: null,
        lastMessageId: null,
        updatedAt: '2026-10-23T00:00:00.000Z',
      },
    };
    const recognizer = {
      recognizeNumber: vi.fn<NumberRecognizer['recognizeNumber']>().mockResolvedValue(null),
    };
    const service = createService(state, recognizer);
    const message = createMessage('user-1', 'message-word-number', {
      content: 'https://static.example/counting-chain-twenty-one.gif',
      attachments: [],
    });

    await service.handleMessage(message);

    expect(message.react).toHaveBeenCalledWith('👍');
    expect(state.state).toMatchObject({
      countingChain: { expectedNumber: 22, lastMessageId: 'message-word-number' },
    });
  });

  it('does not treat ambiguous URL numbers as a valid game number', async () => {
    const state = new MemoryStateStore();
    const recognizer = {
      recognizeNumber: vi.fn<NumberRecognizer['recognizeNumber']>().mockResolvedValue(null),
    };
    const service = createService(state, recognizer);
    const message = createMessage('user-1', 'message-ambiguous-url', {
      content: 'https://static.example/counting-chain-44-45.gif',
      attachments: [],
    });

    await service.handleMessage(message);

    expect(message.react).toHaveBeenCalledWith('⚠️');
    expect(message.reply).toHaveBeenCalledWith('I could not read that image. Please try again.');
    expect(state.state).toMatchObject({
      countingChain: {
        expectedNumber: 1,
        lastProcessedMessageId: 'message-ambiguous-url',
      },
    });
  });

  it('processes GIF-picker images from an unlisted provider', async () => {
    const state = new MemoryStateStore();
    const recognizer = {
      recognizeNumber: vi.fn<NumberRecognizer['recognizeNumber']>().mockResolvedValue(1),
    };
    const service = createService(state, recognizer);
    const message = createMessage('user-1', 'message-klipy', {
      content: 'https://klipy.com/gifs/example',
      attachments: [],
      imageUrls: ['https://new-provider.example/number.gif'],
    });

    await service.handleMessage(message);

    expect(recognizer.recognizeNumber).toHaveBeenCalledOnce();
    expect(message.react).toHaveBeenCalledWith('👍');
  });

  it('rejects image hosts that resolve to private network addresses', async () => {
    const state = new MemoryStateStore();
    const recognizer = {
      recognizeNumber: vi.fn<NumberRecognizer['recognizeNumber']>().mockResolvedValue(1),
    };
    const fetchImplementation = vi.fn<typeof fetch>();
    const service = createService(state, recognizer, {
      fetchImplementation,
      lookupImplementation: async () => [{ address: '10.0.0.5', family: 4 }],
    });
    const message = createMessage('user-1', 'message-private-host', {
      attachments: [],
      imageUrls: ['https://internal.example/number.gif'],
    });

    await service.handleMessage(message);

    expect(fetchImplementation).not.toHaveBeenCalled();
    expect(recognizer.recognizeNumber).not.toHaveBeenCalled();
    expect(message.react).toHaveBeenCalledWith('⚠️');
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

  it('ignores ordinary page URLs without treating them as image sources', async () => {
    const state = new MemoryStateStore();
    const recognizer = { recognizeNumber: vi.fn<NumberRecognizer['recognizeNumber']>() };
    const service = createService(state, recognizer);
    const message = createMessage('user-1', 'message-page-url', {
      content: 'https://example.com/view/number',
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
      'Nope — the next number was meant to be **2**, not **4**. Starting the chain again at 1.',
    );
    expect(state.state).toMatchObject({
      countingChain: {
        expectedNumber: 1,
        lastAuthorId: null,
        lastMessageId: null,
        lastGameEnding: {
          messageId: 'message-2',
          authorId: 'user-2',
          expectedNumber: 2,
          proposedNumber: 4,
          reason: 'wrong-number',
        },
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
    expect(second.reply).toHaveBeenCalledWith(
      "Hey <@same-user>, you can't post twice in a row! Starting the chain again at 1.",
      { mentionUserId: 'same-user' },
    );
    expect(state.state).toMatchObject({
      countingChain: {
        expectedNumber: 1,
      },
    });
  });

  it('applies the consecutive-user rule even when the second image is unreadable', async () => {
    const state = new MemoryStateStore();
    const recognizer = {
      recognizeNumber: vi
        .fn<NumberRecognizer['recognizeNumber']>()
        .mockResolvedValueOnce(1)
        .mockResolvedValueOnce(null),
    };
    const service = createService(state, recognizer);
    const first = createMessage('same-user', 'unreadable-same-user-1');
    const second = createMessage('same-user', 'unreadable-same-user-2');

    await service.handleMessage(first);
    await service.handleMessage(second);

    expect(second.react).toHaveBeenCalledWith('❌');
    expect(second.react).not.toHaveBeenCalledWith('⚠️');
    expect(second.reply).toHaveBeenCalledWith(
      "Hey <@same-user>, you can't post twice in a row! Starting the chain again at 1.",
      { mentionUserId: 'same-user' },
    );
    expect(state.state).toMatchObject({
      countingChain: {
        expectedNumber: 1,
        lastRoundReason: 'same-user',
        lastGameEnding: {
          messageId: 'unreadable-same-user-2',
          reason: 'same-user',
          proposedNumber: null,
        },
      },
    });
  });

  it('resets an unreadable consecutive post even when review is enabled', async () => {
    const state = new MemoryStateStore();
    const recognizer = {
      recognizeNumber: vi
        .fn<NumberRecognizer['recognizeNumber']>()
        .mockResolvedValueOnce(1)
        .mockResolvedValueOnce(null),
    };
    const service = createService(state, recognizer, {
      config: { reviewEnabled: true, reviewRoleId: 'moderator-role' },
    });
    const first = createMessage('same-user', 'review-unreadable-same-user-1');
    const second = createMessage('same-user', 'review-unreadable-same-user-2');

    await service.handleMessage(first);
    await service.handleMessage(second);

    expect(second.react).toHaveBeenCalledWith('❌');
    expect(second.react).not.toHaveBeenCalledWith('🔎');
    expect(second.reply).toHaveBeenCalledWith(
      "Hey <@same-user>, you can't post twice in a row! Starting the chain again at 1.",
      { mentionUserId: 'same-user' },
    );
    expect(state.state).toMatchObject({
      countingChain: {
        expectedNumber: 1,
        lastRoundReason: 'same-user',
        lastGameEnding: {
          messageId: 'review-unreadable-same-user-2',
          reason: 'same-user',
          proposedNumber: null,
        },
      },
    });
    expect(state.state.countingChain).not.toHaveProperty('pendingReview');
  });

  it('pauses an unreadable post from another member for moderator review', async () => {
    const state = new MemoryStateStore();
    const recognizer = {
      recognizeNumber: vi
        .fn<NumberRecognizer['recognizeNumber']>()
        .mockResolvedValueOnce(1)
        .mockResolvedValueOnce(null),
    };
    const service = createService(state, recognizer, {
      config: { reviewEnabled: true, reviewRoleId: 'moderator-role' },
    });
    const first = createMessage('user-1', 'review-unreadable-user-1');
    const second = createMessage('user-2', 'review-unreadable-user-2');
    const later = createMessage('user-3', 'review-paused-later');

    await service.handleMessage(first);
    await service.handleMessage(second);
    await service.handleMessage(later);

    expect(second.react).toHaveBeenCalledWith('🔎');
    expect(second.react).toHaveBeenCalledWith('✅');
    expect(second.react).toHaveBeenCalledWith('❌');
    expect(second.react).not.toHaveBeenCalledWith('⚠️');
    expect(second.reply).toHaveBeenCalledWith(expect.stringContaining('<@&moderator-role>'), {
      mentionRoleId: 'moderator-role',
    });
    expect(later.react).not.toHaveBeenCalled();
    expect(state.state).toMatchObject({
      countingChain: {
        expectedNumber: 2,
        pendingReview: {
          messageId: 'review-unreadable-user-2',
          reason: 'unreadable',
          proposedNumber: null,
          reviewMessageId: 'review-reply-message',
        },
      },
    });
    expect(recognizer.recognizeNumber).toHaveBeenCalledTimes(2);
  });

  it('always resets a recognized consecutive post instead of sending it to review', async () => {
    const state = new MemoryStateStore();
    const recognizer = {
      recognizeNumber: vi
        .fn<NumberRecognizer['recognizeNumber']>()
        .mockResolvedValueOnce(1)
        .mockResolvedValueOnce(2),
    };
    const service = createService(state, recognizer, {
      config: { reviewEnabled: true, reviewRoleId: 'moderator-role' },
    });
    const first = createMessage('same-user', 'same-user-review-1');
    const second = createMessage('same-user', 'same-user-review-2');

    await service.handleMessage(first);
    await service.handleMessage(second);

    expect(second.react).toHaveBeenCalledWith('❌');
    expect(second.react).not.toHaveBeenCalledWith('🔎');
    expect(second.reply).toHaveBeenCalledWith(
      "Hey <@same-user>, you can't post twice in a row! Starting the chain again at 1.",
      { mentionUserId: 'same-user' },
    );
    expect(state.state.countingChain).not.toHaveProperty('pendingReview');
  });

  it('pauses an incorrect post for moderator review and approves the proposed number', async () => {
    const state = new MemoryStateStore();
    const recognizer = {
      recognizeNumber: vi
        .fn<NumberRecognizer['recognizeNumber']>()
        .mockResolvedValueOnce(1)
        .mockResolvedValueOnce(4),
    };
    const service = createService(state, recognizer, {
      config: { reviewEnabled: true, reviewRoleId: 'moderator-role' },
    });
    const first = createMessage('user-1', 'review-message-1');
    const wrong = createMessage('user-2', 'review-message-2');

    await service.handleMessage(first);
    await service.handleMessage(wrong);

    expect(wrong.react).toHaveBeenCalledWith('🔎');
    expect(wrong.react).toHaveBeenCalledWith('✅');
    expect(wrong.react).toHaveBeenCalledWith('❌');
    expect(wrong.reply).toHaveBeenCalledWith(expect.stringContaining('<@&moderator-role>'), {
      mentionRoleId: 'moderator-role',
    });
    expect(state.state).toMatchObject({
      countingChain: {
        expectedNumber: 2,
        pendingReview: {
          messageId: 'review-message-2',
          expectedNumber: 2,
          proposedNumber: 4,
          reason: 'wrong-number',
        },
      },
    });

    expect(await service.getReviewTargetMessageId()).toBe('review-message-2');
    expect(await service.getReviewRequestMessageId()).toBe('review-reply-message');
    await expect(service.getReviewRequestMessageIds()).resolves.toEqual(['review-reply-message']);
    expect(await service.reviewMessage(wrong, 'approve', 'moderator-1')).toBe(true);
    expect(wrong.react).toHaveBeenCalledWith('👍');
    expect(wrong.clearReactions).toHaveBeenCalledOnce();
    expect(wrong.deleteMessage).toHaveBeenCalledWith('review-reply-message');
    expect(state.state).toMatchObject({
      countingChain: {
        expectedNumber: 5,
        lastMessageId: 'review-message-2',
      },
    });
    expect(state.state.countingChain).not.toHaveProperty('pendingReview');
    expect(state.state.countingChain).not.toHaveProperty('lastGameEnding');
    expect(await service.getReviewRequestMessageId()).toBeUndefined();
    await expect(service.getReviewRequestMessageIds()).resolves.toEqual([]);
  });

  it('deletes every stored review request when a moderator approves a post', async () => {
    const state = new MemoryStateStore();
    const recognizer = {
      recognizeNumber: vi.fn<NumberRecognizer['recognizeNumber']>().mockResolvedValue(4),
    };
    const service = createService(state, recognizer, {
      config: { reviewEnabled: true, reviewRoleId: 'moderator-role' },
    });
    const message = createMessage('user-1', 'review-multiple-requests');

    await service.handleMessage(message);
    const countingState = state.state.countingChain as {
      pendingReview: { reviewMessageIds: string[] };
    };
    countingState.pendingReview.reviewMessageIds = [
      'review-reply-message-old',
      'review-reply-message',
    ];

    await expect(service.reviewMessage(message, 'approve', 'moderator-1')).resolves.toBe(true);

    expect(message.deleteMessage).toHaveBeenNthCalledWith(1, 'review-reply-message-old');
    expect(message.deleteMessage).toHaveBeenNthCalledWith(2, 'review-reply-message');
  });

  it('catches up messages posted while a moderator review was pending', async () => {
    const state = new MemoryStateStore();
    const recognizer = {
      recognizeNumber: vi
        .fn<NumberRecognizer['recognizeNumber']>()
        .mockResolvedValueOnce(1)
        .mockResolvedValueOnce(4)
        .mockResolvedValueOnce(5),
    };
    let history: readonly CountingChainHistoryMessage[] = [];
    const historyProvider = vi.fn<() => Promise<readonly CountingChainHistoryMessage[]>>(
      async () => history,
    );
    const service = createService(state, recognizer, {
      config: { reviewEnabled: true, reviewRoleId: 'moderator-role' },
    });
    await service.initialize(historyProvider);

    const first = createMessage('user-1', '1562802766370447500');
    const pending = createMessage('user-2', '1562802766370447501');
    const later = createHistoryMessage('user-3', '1562802766370447502');
    await service.handleMessage(first);
    await service.handleMessage(pending);

    history = [
      later,
      createHistoryMessage('user-2', pending.id, {
        botReactionEmojis: ['🔎', '✅', '❌'],
      }),
    ];
    expect(await service.reviewMessage(pending, 'approve', 'moderator-1')).toBe(true);
    await service.reconcileHistory();

    expect(later.react).toHaveBeenCalledWith('👍');
    expect(historyProvider).toHaveBeenCalledTimes(2);
    expect(state.state).toMatchObject({
      countingChain: {
        expectedNumber: 6,
        lastMessageId: '1562802766370447502',
        lastProcessedMessageId: '1562802766370447502',
      },
    });
  });

  it('lets a moderator override the next number and checkpoint existing posts', async () => {
    const state = new MemoryStateStore();
    const recognizer = {
      recognizeNumber: vi
        .fn<NumberRecognizer['recognizeNumber']>()
        .mockResolvedValueOnce(12)
        .mockResolvedValueOnce(99),
    };
    let history: readonly CountingChainHistoryMessage[] = [];
    const historyProvider = vi.fn<() => Promise<readonly CountingChainHistoryMessage[]>>(
      async () => history,
    );
    const service = createService(state, recognizer, {
      config: { reviewEnabled: true, reviewRoleId: 'moderator-role' },
    });
    await service.initialize(historyProvider);

    const accepted = createMessage('user-1', '100');
    const pending = createMessage('user-2', '101');
    const existingPost = createHistoryMessage('user-3', '200');
    await service.handleMessage(accepted);
    await service.handleMessage(pending);

    history = [existingPost];
    expect(await service.setNextNumber('counting-channel', 16, 'moderator-1')).toBe(true);

    expect(existingPost.react).not.toHaveBeenCalled();
    expect(state.state).toMatchObject({
      countingChain: {
        expectedNumber: 16,
        lastProcessedMessageId: '200',
      },
    });
    expect(state.state.countingChain).not.toHaveProperty('pendingReview');
    expect(state.state.countingChain).not.toHaveProperty('lastGameEnding');
  });

  it('reopens the last game-ending image after a normal reset', async () => {
    const state = new MemoryStateStore();
    const recognizer = {
      recognizeNumber: vi
        .fn<NumberRecognizer['recognizeNumber']>()
        .mockResolvedValueOnce(1)
        .mockResolvedValueOnce(4),
    };
    const normalService = createService(state, recognizer);
    const first = createMessage('user-1', 'manual-review-message-1');
    const wrong = createMessage('user-2', 'manual-review-message-2');

    await normalService.handleMessage(first);
    await normalService.handleMessage(wrong);

    const reviewService = createService(
      state,
      { recognizeNumber: vi.fn<NumberRecognizer['recognizeNumber']>() },
      { config: { reviewEnabled: true, reviewRoleId: 'moderator-role' } },
    );

    expect(await reviewService.getReviewTargetMessageId()).toBe('manual-review-message-2');
    expect(await reviewService.requestReview(wrong)).toBe(true);
    expect(state.state).toMatchObject({
      countingChain: {
        pendingReview: {
          messageId: 'manual-review-message-2',
          expectedNumber: 2,
          proposedNumber: 4,
          reason: 'wrong-number',
        },
      },
    });

    expect(await reviewService.reviewMessage(wrong, 'approve', 'moderator-1')).toBe(true);
    expect(state.state).toMatchObject({
      countingChain: {
        expectedNumber: 5,
        lastMessageId: 'manual-review-message-2',
      },
    });
    expect(state.state.countingChain).not.toHaveProperty('lastGameEnding');
  });

  it('lets a moderator reject a pending review and reset the chain', async () => {
    const state = new MemoryStateStore();
    const recognizer = {
      recognizeNumber: vi.fn<NumberRecognizer['recognizeNumber']>().mockResolvedValue(9),
    };
    const service = createService(state, recognizer, {
      config: { reviewEnabled: true, reviewRoleId: 'moderator-role' },
    });
    const message = createMessage('user-1', 'review-rejected');

    await service.handleMessage(message);
    expect(await service.reviewMessage(message, 'reject', 'moderator-1')).toBe(true);

    expect(message.react).toHaveBeenCalledWith('❌');
    expect(message.clearReactions).toHaveBeenCalledOnce();
    expect(message.deleteMessage).toHaveBeenCalledWith('review-reply-message');
    expect(message.reply).toHaveBeenCalledWith(
      'The moderator checked it — this round starts again at 1. Give it another go!',
    );
    expect(state.state).toMatchObject({
      countingChain: {
        expectedNumber: 1,
        lastRoundReason: 'moderator-rejected',
      },
    });
    expect(state.state.countingChain).not.toHaveProperty('pendingReview');
  });

  it('requests review instead of changing state when an image cannot be read', async () => {
    const state = new MemoryStateStore();
    const recognizer = {
      recognizeNumber: vi.fn<NumberRecognizer['recognizeNumber']>().mockResolvedValue(null),
    };
    const service = createService(state, recognizer, {
      config: { reviewEnabled: true, reviewRoleId: 'moderator-role' },
    });
    const message = createMessage('user-1', 'review-unreadable');

    await service.handleMessage(message);

    expect(message.react).toHaveBeenCalledWith('🔎');
    expect(message.react).not.toHaveBeenCalledWith('⚠️');
    expect(state.state).toMatchObject({
      countingChain: {
        expectedNumber: 1,
        pendingReview: {
          messageId: 'review-unreadable',
          proposedNumber: null,
          reason: 'unreadable',
          reviewMessageId: 'review-reply-message',
        },
      },
    });
  });

  it('retains a pending review across service restart without replaying channel history', async () => {
    const state = new MemoryStateStore();
    const firstService = createService(
      state,
      { recognizeNumber: vi.fn<NumberRecognizer['recognizeNumber']>().mockResolvedValue(8) },
      { config: { reviewEnabled: true, reviewRoleId: 'moderator-role' } },
    );
    const pendingMessage = createMessage('user-1', 'review-restart');
    await firstService.handleMessage(pendingMessage);

    const historyProvider = vi.fn().mockResolvedValue([]);
    const restartedRecognizer = { recognizeNumber: vi.fn<NumberRecognizer['recognizeNumber']>() };
    await createService(state, restartedRecognizer, {
      config: { reviewEnabled: true, reviewRoleId: 'moderator-role' },
    }).initialize(historyProvider);

    expect(historyProvider).not.toHaveBeenCalled();
    expect(restartedRecognizer.recognizeNumber).not.toHaveBeenCalled();
    expect(state.state).toMatchObject({
      countingChain: {
        pendingReview: { messageId: 'review-restart', proposedNumber: 8 },
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

  it('waits for a GIF already being recognized before processing the next GIF', async () => {
    const state = new MemoryStateStore();
    let releaseFirst!: (number: number) => void;
    const firstRecognition = new Promise<number>((resolve) => {
      releaseFirst = resolve;
    });
    const recognizer = {
      recognizeNumber: vi
        .fn<NumberRecognizer['recognizeNumber']>()
        .mockReturnValueOnce(firstRecognition)
        .mockResolvedValueOnce(2),
    };
    const service = createService(state, recognizer);
    const first = createMessage('user-1', 'message-1');
    const second = createMessage('user-2', 'message-2');
    const firstProcessing = service.handleMessage(first);
    const secondProcessing = service.handleMessage(second);

    await vi.waitFor(() => {
      expect(recognizer.recognizeNumber).toHaveBeenCalledOnce();
    });
    expect(second.react).not.toHaveBeenCalled();

    releaseFirst(1);
    await Promise.all([firstProcessing, secondProcessing]);

    expect(first.react).toHaveBeenCalledWith('👍');
    expect(second.react).toHaveBeenCalledWith('👍');
    expect(state.state).toMatchObject({ countingChain: { expectedNumber: 3 } });
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
      [{ userId: 'user-1', score: 7 }],
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

  it('retries pending history recovery before processing a later post', async () => {
    const state = new MemoryStateStore();
    const firstService = createService(state, {
      recognizeNumber: vi.fn().mockResolvedValue(1),
    });
    await firstService.handleMessage(createMessage('user-1', '1562802766370447550'));

    const pendingImage = createHistoryMessage('user-2', '1562802766370447551');
    const laterImage = createHistoryMessage('user-3', '1562802766370447552');
    const historyProvider = vi
      .fn<() => Promise<readonly CountingChainHistoryMessage[]>>()
      .mockRejectedValueOnce(new Error('Discord history temporarily unavailable'))
      .mockResolvedValueOnce([laterImage, pendingImage]);
    const recognizer = {
      recognizeNumber: vi
        .fn<NumberRecognizer['recognizeNumber']>()
        .mockResolvedValueOnce(2)
        .mockResolvedValueOnce(3),
    };
    const service = createService(state, recognizer);
    await service.initialize(historyProvider);

    expect(state.state.countingChain).toHaveProperty('historyRecoveryPending', true);

    await service.handleMessage(createMessage('user-3', laterImage.id));

    expect(historyProvider).toHaveBeenCalledTimes(2);
    expect(pendingImage.react).toHaveBeenCalledWith('👍');
    expect(laterImage.react).toHaveBeenCalledWith('👍');
    expect(state.state).toMatchObject({
      countingChain: {
        expectedNumber: 4,
        lastMessageId: laterImage.id,
        lastProcessedMessageId: laterImage.id,
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
