import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import pino from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createDiscordChatMessage,
  HttpChatDiscordBridge,
  type ChatDiscordBridgeConfig,
  type ChatDiscordBridgePublisher,
} from '../src/http/chat-discord-bridge.js';
import { createPlayerNotificationService } from '../src/services/player-notifications.js';
import { createJsonFileStateStore } from '../src/state/json-file-state-store.js';
import type { JsonState, StateStore } from '../src/state/state-store.js';

const logger = pino({ level: 'silent' });
const activeBridges: HttpChatDiscordBridge[] = [];

class MemoryStateStore implements StateStore<JsonState> {
  public state: JsonState = {};

  public async load(): Promise<JsonState> {
    return this.state;
  }

  public async save(state: JsonState): Promise<void> {
    this.state = state;
  }
}

function recordedEventIds(state: JsonState): string[] {
  const bridgeState = state.chatDiscordBridge;
  if (
    typeof bridgeState !== 'object' ||
    bridgeState === null ||
    Array.isArray(bridgeState) ||
    !('processedEvents' in bridgeState) ||
    !Array.isArray(bridgeState.processedEvents)
  ) {
    return [];
  }

  return bridgeState.processedEvents.flatMap((record) => {
    if (
      typeof record === 'object' &&
      record !== null &&
      !Array.isArray(record) &&
      'eventId' in record &&
      typeof record.eventId === 'string'
    ) {
      return [record.eventId];
    }
    return [];
  });
}

afterEach(async () => {
  await Promise.all(activeBridges.splice(0).map((bridge) => bridge.stop()));
});

function config(port = 43127): ChatDiscordBridgeConfig {
  return {
    enabled: true,
    host: '127.0.0.1',
    port,
    path: '/minecraft/event',
    bearerToken: 'test-token',
    channelId: 'discord-channel',
    maxBodyBytes: 65536,
  };
}

async function request(
  body: string,
  headers: Record<string, string> = defaultRequestHeaders(body),
  port = 43127,
  path = '/minecraft/event',
): Promise<{ status: number; body: string }> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers,
    body,
  });
  return { status: response.status, body: await response.text() };
}

function defaultRequestHeaders(body: string): Record<string, string> {
  const headers: Record<string, string> = {
    authorization: 'Bearer test-token',
    'content-type': 'application/json',
  };

  try {
    const parsed: unknown = JSON.parse(body);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      'event_id' in parsed &&
      typeof parsed.event_id === 'string'
    ) {
      headers['x-stemcraft-event-id'] = parsed.event_id;
    }
  } catch {
    // Invalid JSON tests should exercise JSON validation, not header setup.
  }

  return headers;
}

describe('Minecraft chat Discord bridge', () => {
  it('forwards Discord text to STEMCraft with the shared bearer token', async () => {
    const fetchImplementation = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
    const bridge = new HttpChatDiscordBridge({
      config: { ...config(), minecraftUrl: 'https://minecraft.example.test/api/v1/chat/discord' },
      publisher: { send: vi.fn() },
      state: new MemoryStateStore(),
      logger,
      fetchImplementation,
    });

    await bridge.forwardDiscordMessage({
      messageId: 'discord-message-1',
      username: 'alex',
      displayName: 'Alex',
      message: 'Hello from Discord',
    });

    expect(fetchImplementation).toHaveBeenCalledWith(
      'https://minecraft.example.test/api/v1/chat/discord',
      expect.objectContaining({
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-token',
          'Content-Type': 'application/json; charset=utf-8',
          'X-Discord-Message-Id': 'discord-message-1',
        },
        body: JSON.stringify({
          event: 'discord.chat',
          event_id: 'discord-message-1',
          username: 'alex',
          displayname: 'Alex',
          message: 'Hello from Discord',
        }),
      }),
    );
  });

  it('ignores bot, webhook, and contentless Discord messages', () => {
    const base = {
      messageId: 'discord-message-1',
      username: 'alex',
      displayName: 'Alex',
      content: 'Hello',
    };

    expect(createDiscordChatMessage({ ...base, authorIsBot: true })).toBeUndefined();
    expect(createDiscordChatMessage({ ...base, isWebhook: true })).toBeUndefined();
    expect(createDiscordChatMessage({ ...base, content: '   ' })).toBeUndefined();
    expect(createDiscordChatMessage(base)).toEqual({
      messageId: 'discord-message-1',
      username: 'alex',
      displayName: 'Alex',
      message: 'Hello',
    });
  });

  it('accepts a trailing slash without changing the configured event endpoint', async () => {
    const state = new MemoryStateStore();
    const publisher: ChatDiscordBridgePublisher = { send: vi.fn() };
    const bridge = new HttpChatDiscordBridge({ config: config(43126), publisher, state, logger });
    activeBridges.push(bridge);
    await bridge.start();

    const response = await request('{}', undefined, 43126, '/minecraft/event/');

    expect(response.status).toBe(400);
    expect(JSON.parse(response.body)).toEqual({ error: 'invalid_minecraft_event' });
    expect(publisher.send).not.toHaveBeenCalled();
  });

  it('authenticates, publishes the message, ignores routing fields, and deduplicates events', async () => {
    const state = new MemoryStateStore();
    const publisher: ChatDiscordBridgePublisher = {
      send: vi.fn().mockResolvedValue('discord-message-1'),
    };
    const bridge = new HttpChatDiscordBridge({
      config: config(),
      publisher,
      state,
      logger,
      serverFactory: createServer,
    });
    activeBridges.push(bridge);
    await bridge.start();

    const payload = JSON.stringify({
      event: 'minecraft.chat',
      event_id: 'event-1',
      occurred_at: '2026-10-24T01:02:03Z',
      server: 'creative',
      channel: 'staff',
      player: { name: 'Alex', uuid: 'player-1' },
      message: 'Hello from Minecraft',
    });
    const first = await request(payload, {
      authorization: 'Bearer test-token',
      'content-type': 'application/json; charset=utf-8',
      'x-stemcraft-event-id': 'event-1',
    });
    const duplicate = await request(payload);

    expect(first.status).toBe(202);
    expect(duplicate.status).toBe(202);
    expect(JSON.parse(duplicate.body)).toMatchObject({ accepted: true, duplicate: true });
    expect(publisher.send).toHaveBeenCalledOnce();
    expect(publisher.send).toHaveBeenCalledWith('discord-channel', 'Alex » Hello from Minecraft');
  });

  it('deduplicates player quits by event ID, not player UUID', async () => {
    const state = new MemoryStateStore();
    const send = vi.fn().mockResolvedValue('discord-event-message');
    const bridge = new HttpChatDiscordBridge({
      config: config(43132),
      publisher: { send },
      state,
      logger,
      serverFactory: createServer,
    });
    activeBridges.push(bridge);
    await bridge.start();

    const quitPayload = (eventId: string, onlinePlayers: number): string =>
      JSON.stringify({
        event: 'minecraft.player_quit',
        event_id: eventId,
        player: { name: 'Alex', uuid: 'player-1' },
        data: { online_players: onlinePlayers },
      });
    const headersFor = (eventId: string): Record<string, string> => ({
      authorization: 'Bearer test-token',
      'content-type': 'application/json',
      'x-stemcraft-event-id': eventId,
    });

    const first = await request(quitPayload('quit-event-1', 10), headersFor('quit-event-1'), 43132);
    const retry = await request(quitPayload('quit-event-1', 10), headersFor('quit-event-1'), 43132);
    const laterQuit = await request(
      quitPayload('quit-event-2', 9),
      headersFor('quit-event-2'),
      43132,
    );
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(first.status).toBe(202);
    expect(JSON.parse(first.body)).toMatchObject({ accepted: true, duplicate: false });
    expect(retry.status).toBe(202);
    expect(JSON.parse(retry.body)).toMatchObject({ accepted: true, duplicate: true });
    expect(laterQuit.status).toBe(202);
    expect(JSON.parse(laterQuit.body)).toMatchObject({ accepted: true, duplicate: false });
    expect(send).toHaveBeenCalledTimes(2);
    expect(recordedEventIds(state.state)).toEqual(['quit-event-1', 'quit-event-2']);
  });

  it('acknowledges after recording an event without waiting for Discord', async () => {
    const state = new MemoryStateStore();
    let resolveSend: ((messageId: string) => void) | undefined;
    const send = vi.fn().mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          resolveSend = resolve;
        }),
    );
    const bridge = new HttpChatDiscordBridge({
      config: config(43133),
      publisher: { send },
      state,
      logger,
      serverFactory: createServer,
    });
    activeBridges.push(bridge);
    await bridge.start();

    const response = await request(
      JSON.stringify({
        event: 'minecraft.player_quit',
        event_id: 'async-quit-event',
        player: { name: 'Alex', uuid: 'player-1' },
      }),
      undefined,
      43133,
    );

    expect(response.status).toBe(202);
    expect(JSON.parse(response.body)).toMatchObject({ accepted: true, duplicate: false });
    expect(recordedEventIds(state.state)).toEqual(['async-quit-event']);

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(send).toHaveBeenCalledOnce();
    resolveSend?.('discord-event-message');
  });

  it('persists event ID deduplication across bridge restarts', async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'stembot-bridge-'));
    const statePath = join(temporaryDirectory, 'state.json');
    const bridges: HttpChatDiscordBridge[] = [];

    try {
      const firstSend = vi.fn().mockResolvedValue('first-discord-message');
      const firstBridge = new HttpChatDiscordBridge({
        config: config(43134),
        publisher: { send: firstSend },
        state: createJsonFileStateStore(statePath, logger),
        logger,
        serverFactory: createServer,
      });
      bridges.push(firstBridge);
      await firstBridge.start();

      const payload = JSON.stringify({
        event: 'minecraft.player_quit',
        event_id: 'persistent-quit-event',
        player: { name: 'Alex', uuid: 'player-1' },
      });
      const first = await request(payload, undefined, 43134);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(first.status).toBe(202);
      expect(firstSend).toHaveBeenCalledOnce();

      await firstBridge.stop();

      const secondSend = vi.fn().mockResolvedValue('second-discord-message');
      const secondBridge = new HttpChatDiscordBridge({
        config: config(43134),
        publisher: { send: secondSend },
        state: createJsonFileStateStore(statePath, logger),
        logger,
        serverFactory: createServer,
      });
      bridges.push(secondBridge);
      await secondBridge.start();

      const duplicate = await request(payload, undefined, 43134);
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(duplicate.status).toBe(202);
      expect(JSON.parse(duplicate.body)).toMatchObject({ accepted: true, duplicate: true });
      expect(secondSend).not.toHaveBeenCalled();
    } finally {
      await Promise.all(bridges.map((bridge) => bridge.stop()));
      await rm(temporaryDirectory, { force: true, recursive: true });
    }
  });

  it('claims concurrent duplicate deliveries only once', async () => {
    const state = new MemoryStateStore();
    let resolveSend: ((messageId: string) => void) | undefined;
    const send = vi.fn().mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          resolveSend = resolve;
        }),
    );
    const bridge = new HttpChatDiscordBridge({
      config: config(43135),
      publisher: { send },
      state,
      logger,
      serverFactory: createServer,
    });
    activeBridges.push(bridge);
    await bridge.start();

    const body = JSON.stringify({
      event: 'minecraft.server_message',
      event_id: 'concurrent-event',
      data: { message: 'Maintenance soon' },
    });
    const responses = await Promise.all(
      Array.from({ length: 8 }, () => request(body, undefined, 43135)),
    );

    expect(responses.every((response) => response.status === 202)).toBe(true);
    expect(
      responses.filter((response) => JSON.parse(response.body).duplicate === false),
    ).toHaveLength(1);
    expect(
      responses.filter((response) => JSON.parse(response.body).duplicate === true),
    ).toHaveLength(7);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(send).toHaveBeenCalledOnce();
    expect(recordedEventIds(state.state)).toEqual(['concurrent-event']);

    resolveSend?.('discord-event-message');
  });

  it('deduplicates every supported event type through the shared receiver', async () => {
    const state = new MemoryStateStore();
    const send = vi.fn().mockResolvedValue('discord-event-message');
    const bridge = new HttpChatDiscordBridge({
      config: config(43136),
      publisher: { send },
      state,
      logger,
      serverFactory: createServer,
    });
    activeBridges.push(bridge);
    await bridge.start();

    const events: Array<Record<string, unknown>> = [
      {
        event: 'minecraft.chat',
        player: { name: 'Alex', uuid: 'same-player' },
        message: 'Hello',
      },
      {
        event: 'minecraft.player_join',
        player: { name: 'Alex', uuid: 'same-player' },
      },
      {
        event: 'minecraft.player_quit',
        player: { name: 'Alex', uuid: 'same-player' },
      },
      {
        event: 'minecraft.player_death',
        player: { name: 'Alex', uuid: 'same-player' },
      },
      {
        event: 'minecraft.player_command',
        player: { name: 'Alex', uuid: 'same-player' },
        data: { command: '/spawn' },
      },
      { event: 'minecraft.server_start' },
      { event: 'minecraft.server_stop' },
      { event: 'minecraft.server_message', data: { message: 'Restarting' } },
      { event: 'minecraft.minigame_start', data: { minigame: 'bedwars' } },
      { event: 'minecraft.minigame_end', data: { minigame: 'bedwars' } },
    ];

    for (const [index, event] of events.entries()) {
      const eventId = `generic-event-${index}`;
      const body = JSON.stringify({ ...event, event_id: eventId });
      const first = await request(body, undefined, 43136);
      const retry = await request(body, undefined, 43136);

      expect(first.status).toBe(202);
      expect(JSON.parse(first.body)).toMatchObject({ accepted: true, duplicate: false });
      expect(retry.status).toBe(202);
      expect(JSON.parse(retry.body)).toMatchObject({ accepted: true, duplicate: true });
    }

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(send).toHaveBeenCalledTimes(events.length);
    expect(recordedEventIds(state.state)).toEqual(
      events.map((_event, index) => `generic-event-${index}`),
    );
  });

  it('expires old claims while retaining recent event IDs', async () => {
    const state = new MemoryStateStore();
    state.state = {
      chatDiscordBridge: {
        version: 2,
        processedEvents: [
          {
            eventId: 'expired-event',
            recordedAt: Date.now() - 8 * 24 * 60 * 60 * 1000,
          },
          {
            eventId: 'recent-event',
            recordedAt: Date.now(),
          },
        ],
      },
    };
    const send = vi.fn().mockResolvedValue('discord-event-message');
    const bridge = new HttpChatDiscordBridge({
      config: config(43137),
      publisher: { send },
      state,
      logger,
      serverFactory: createServer,
    });
    activeBridges.push(bridge);
    await bridge.start();

    const expiredAgain = await request(
      JSON.stringify({
        event: 'minecraft.player_quit',
        event_id: 'expired-event',
        player: { name: 'Alex', uuid: 'same-player' },
      }),
      undefined,
      43137,
    );
    const recentRetry = await request(
      JSON.stringify({
        event: 'minecraft.player_quit',
        event_id: 'recent-event',
        player: { name: 'Alex', uuid: 'same-player' },
      }),
      undefined,
      43137,
    );
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(JSON.parse(expiredAgain.body)).toMatchObject({ accepted: true, duplicate: false });
    expect(JSON.parse(recentRetry.body)).toMatchObject({ accepted: true, duplicate: true });
    expect(send).toHaveBeenCalledOnce();
    expect(recordedEventIds(state.state)).toEqual(['recent-event', 'expired-event']);
  });

  it('publishes structured Minecraft events as embeds with mentions disabled', async () => {
    const state = new MemoryStateStore();
    const send = vi.fn().mockResolvedValue('discord-event-message');
    const publisher: ChatDiscordBridgePublisher = { send };
    const bridge = new HttpChatDiscordBridge({
      config: config(43129),
      publisher,
      state,
      logger,
      serverFactory: createServer,
    });
    activeBridges.push(bridge);
    await bridge.start();

    const cases: Array<{
      event: string;
      payload: Record<string, unknown>;
      expectedText?: string;
      compact?: { color: number; author?: string; description?: string };
      title?: string;
      description?: string;
      fields: Array<[string, string]>;
    }> = [
      {
        event: 'minecraft.player_join',
        payload: {
          player: { name: 'Alex', uuid: 'player-1' },
          data: { online_players: 12 },
        },
        compact: { color: 0x00ff00, author: 'Alex joined the server' },
        fields: [['Online players', '12']],
      },
      {
        event: 'minecraft.player_quit',
        payload: {
          player: { name: 'Alex', uuid: 'player-1' },
          data: { online_players: 11 },
        },
        compact: { color: 0xff0000, author: 'Alex left the server' },
        fields: [['Online players', '11']],
      },
      {
        event: 'minecraft.player_death',
        payload: {
          player: { name: 'Alex', uuid: 'player-1' },
          data: {
            message: 'Alex hit the ground too hard',
            killer: null,
            cause: 'fall',
            world: 'survival',
          },
        },
        expectedText: '💀 Alex hit the ground too hard',
        fields: [],
      },
      {
        event: 'minecraft.player_command',
        payload: {
          player: { name: 'Alex', uuid: 'player-1' },
          data: { command: '/spawn home' },
        },
        expectedText: 'Alex » `/spawn home`',
        fields: [],
      },
      {
        event: 'minecraft.server_start',
        payload: { data: {} },
        compact: { color: 0x00ff00, author: 'Server started' },
        fields: [],
      },
      {
        event: 'minecraft.server_stop',
        payload: { data: {} },
        compact: { color: 0xff0000, author: 'Server stopped' },
        fields: [],
      },
      {
        event: 'minecraft.server_message',
        payload: { data: { message: 'Server restarting...' } },
        compact: { color: 0xf59e0b, description: '**Server restarting...**' },
        fields: [],
      },
      {
        event: 'minecraft.minigame_start',
        payload: {
          data: {
            minigame: 'mobarena',
            arena: { id: 'forest', name: 'Forest', world: 'bedwars_forest' },
            status: 'running',
            players: [{ name: 'Alex', uuid: 'player-1' }],
            spectators: [],
            teams: [],
          },
        },
        compact: { color: 0x00ff00, author: 'Mobarena - Forest started' },
        fields: [],
      },
      {
        event: 'minecraft.minigame_end',
        payload: {
          data: {
            minigame: 'bedwars',
            arena: { id: 'forest', name: 'Forest', world: 'bedwars_forest' },
            status: 'ending',
            players: [{ name: 'Alex', uuid: 'player-1' }],
            spectators: [],
            teams: [],
            winner: null,
            winner_team: 'red',
            winner_players: [{ name: 'Alex', uuid: 'player-1' }],
          },
        },
        title: 'Bedwars ended',
        description: 'A Bedwars match has ended.',
        fields: [
          ['Arena', 'Forest'],
          ['Status', 'ending'],
          ['Players', '1'],
          ['Spectators', '0'],
          ['Winner', 'red'],
          ['Winning players', '1'],
        ],
      },
    ];

    for (const [index, testCase] of cases.entries()) {
      const response = await request(
        JSON.stringify({
          event: testCase.event,
          event_id: `structured-event-${index}`,
          occurred_at: '2026-10-24T01:02:03Z',
          server: 'survival',
          channel: 'global',
          ...testCase.payload,
        }),
        undefined,
        43129,
      );

      expect(response.status).toBe(202);
      expect(JSON.parse(response.body)).toMatchObject({ accepted: true, duplicate: false });

      const call = send.mock.calls[index];
      expect(call?.[0]).toBe('discord-channel');
      const message = call?.[1];
      if (testCase.expectedText) {
        expect(message).toBe(testCase.expectedText);
        continue;
      }
      if (!message || typeof message === 'string') {
        throw new Error('Expected a structured Discord embed message');
      }

      if (testCase.compact) {
        const expectedEmbed = {
          color: testCase.compact.color,
          ...(testCase.compact.author
            ? {
                author: {
                  name: testCase.compact.author,
                  ...(testCase.event === 'minecraft.player_join' ||
                  testCase.event === 'minecraft.player_quit'
                    ? { icon_url: 'https://mc-heads.net/avatar/Alex/64.png' }
                    : {}),
                },
              }
            : {}),
          ...(testCase.compact.description ? { description: testCase.compact.description } : {}),
        };
        expect(message).toEqual({
          embeds: [expectedEmbed],
          allowedMentions: { parse: [] },
        });
        continue;
      }

      const embed = message.embeds[0];
      expect(embed).toMatchObject({
        title: testCase.title,
        description: testCase.description,
        timestamp: '2026-10-24T01:02:03.000Z',
      });
      expect(embed.footer).toBeUndefined();
      expect(message.allowedMentions).toEqual({ parse: [] });
      const expectedFields = testCase.fields;
      if (expectedFields.length === 0) {
        expect(embed.fields ?? []).toHaveLength(0);
      } else {
        expect(embed.fields).toEqual(
          expect.arrayContaining(
            expectedFields.map(([name, value]) => expect.objectContaining({ name, value })),
          ),
        );
      }
    }

    expect(send).toHaveBeenCalledTimes(cases.length);
  });

  it('routes server lifecycle and server-message events to their configured channels', async () => {
    const state = new MemoryStateStore();
    const send = vi.fn().mockResolvedValue('discord-event-message');
    const bridge = new HttpChatDiscordBridge({
      config: {
        ...config(43130),
        serverStartChannelId: 'startup-channel',
        serverStopChannelId: 'shutdown-channel',
        serverMessageChannelId: 'server-message-channel',
      },
      publisher: { send },
      state,
      logger,
      serverFactory: createServer,
    });
    activeBridges.push(bridge);
    await bridge.start();

    const events = [
      ['minecraft.server_start', 'startup-channel'],
      ['minecraft.server_stop', 'shutdown-channel'],
      ['minecraft.server_message', 'server-message-channel'],
    ] as const;
    for (const [index, [event, channelId]] of events.entries()) {
      const data = event === 'minecraft.server_message' ? { message: 'Maintenance soon' } : {};
      const response = await request(
        JSON.stringify({
          event,
          event_id: `routed-event-${index}`,
          data,
        }),
        undefined,
        43130,
      );

      expect(response.status).toBe(202);
      expect(send.mock.calls[index]?.[0]).toBe(channelId);
    }
  });

  it('suppresses only ignored join/leave announcements while processing other events', async () => {
    const state = new MemoryStateStore();
    const send = vi.fn().mockResolvedValue('discord-event-message');
    const playerNotifications = createPlayerNotificationService({ state, logger });
    await playerNotifications.addIgnoredPlayer({
      username: 'Alex',
      uuid: '0123456789abcdef0123456789abcdef',
    });
    const bridge = new HttpChatDiscordBridge({
      config: config(43131),
      publisher: { send },
      state,
      logger,
      playerNotifications,
      serverFactory: createServer,
    });
    activeBridges.push(bridge);
    await bridge.start();

    const join = await request(
      JSON.stringify({
        event: 'minecraft.player_join',
        event_id: 'ignored-join',
        player: { name: 'Alex', uuid: '01234567-89ab-cdef-0123-456789abcdef' },
      }),
      undefined,
      43131,
    );
    const quit = await request(
      JSON.stringify({
        event: 'minecraft.player_quit',
        event_id: 'ignored-quit',
        player: { name: 'Alex', uuid: '01234567-89ab-cdef-0123-456789abcdef' },
      }),
      undefined,
      43131,
    );
    const death = await request(
      JSON.stringify({
        event: 'minecraft.player_death',
        event_id: 'not-ignored-death',
        player: { name: 'Alex', uuid: '01234567-89ab-cdef-0123-456789abcdef' },
        data: { message: 'Alex fell' },
      }),
      undefined,
      43131,
    );

    expect(join.status).toBe(202);
    expect(quit.status).toBe(202);
    expect(death.status).toBe(202);
    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith('discord-channel', '💀 Alex fell');
    expect(recordedEventIds(state.state)).toEqual([
      'ignored-join',
      'ignored-quit',
      'not-ignored-death',
    ]);
  });

  it('rejects missing or invalid bearer tokens before reading the event', async () => {
    const state = new MemoryStateStore();
    const publisher: ChatDiscordBridgePublisher = { send: vi.fn() };
    const bridge = new HttpChatDiscordBridge({ config: config(43128), publisher, state, logger });
    activeBridges.push(bridge);
    await bridge.start();

    const response = await request(
      '{}',
      {
        authorization: 'Bearer wrong-token',
        'content-type': 'application/json',
      },
      43128,
    );

    expect(response.status).toBe(401);
    expect(publisher.send).not.toHaveBeenCalled();
  });

  it('rejects missing or mismatched STEMCraft event IDs', async () => {
    const state = new MemoryStateStore();
    const publisher: ChatDiscordBridgePublisher = { send: vi.fn() };
    const bridge = new HttpChatDiscordBridge({
      config: config(43138),
      publisher,
      state,
      logger,
      serverFactory: createServer,
    });
    activeBridges.push(bridge);
    await bridge.start();

    const body = JSON.stringify({
      event: 'minecraft.server_start',
      event_id: 'body-event-id',
    });
    const commonHeaders = {
      authorization: 'Bearer test-token',
      'content-type': 'application/json',
    };
    const missing = await request(body, commonHeaders, 43138);
    const mismatched = await request(
      body,
      { ...commonHeaders, 'x-stemcraft-event-id': 'header-event-id' },
      43138,
    );

    expect(missing.status).toBe(400);
    expect(JSON.parse(missing.body)).toEqual({ error: 'event_id_mismatch' });
    expect(mismatched.status).toBe(400);
    expect(JSON.parse(mismatched.body)).toEqual({ error: 'event_id_mismatch' });
    expect(publisher.send).not.toHaveBeenCalled();
  });
});
