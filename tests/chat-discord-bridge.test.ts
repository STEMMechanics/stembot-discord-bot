import { createServer } from 'node:http';

import pino from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createDiscordChatMessage,
  HttpChatDiscordBridge,
  type ChatDiscordBridgeConfig,
  type ChatDiscordBridgePublisher,
} from '../src/http/chat-discord-bridge.js';
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
  headers: Record<string, string> = {
    authorization: 'Bearer test-token',
    'content-type': 'application/json',
  },
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

    expect(first.status).toBe(200);
    expect(duplicate.status).toBe(200);
    expect(JSON.parse(duplicate.body)).toMatchObject({ accepted: true, duplicate: true });
    expect(publisher.send).toHaveBeenCalledOnce();
    expect(publisher.send).toHaveBeenCalledWith('discord-channel', 'Alex » Hello from Minecraft');
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
      compact?: { color: number; author: string };
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

      expect(response.status).toBe(200);
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
        expect(message).toEqual({
          embeds: [
            {
              color: testCase.compact.color,
              author: {
                name: testCase.compact.author,
                ...(testCase.event === 'minecraft.player_join' ||
                testCase.event === 'minecraft.player_quit'
                  ? { icon_url: 'https://mc-heads.net/avatar/Alex/64.png' }
                  : {}),
              },
            },
          ],
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
});
