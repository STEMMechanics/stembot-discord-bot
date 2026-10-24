import { createServer } from 'node:http';

import pino from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
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
    path: '/minecraft/chat',
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
): Promise<{ status: number; body: string }> {
  const response = await fetch(`http://127.0.0.1:${port}/minecraft/chat`, {
    method: 'POST',
    headers,
    body,
  });
  return { status: response.status, body: await response.text() };
}

describe('Minecraft chat Discord bridge', () => {
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

  it('routes player join and quit events with the online player count', async () => {
    const state = new MemoryStateStore();
    const publisher: ChatDiscordBridgePublisher = {
      send: vi.fn().mockResolvedValue('discord-message-2'),
    };
    const bridge = new HttpChatDiscordBridge({
      config: config(43129),
      publisher,
      state,
      logger,
    });
    activeBridges.push(bridge);
    await bridge.start();

    const join = await request(
      JSON.stringify({
        event: 'minecraft.player_join',
        event_id: 'join-1',
        occurred_at: '2026-10-24T01:02:03Z',
        server: 'survival',
        channel: 'global',
        player: { name: 'Alex', uuid: 'player-1' },
        data: { online_players: 12 },
      }),
      {
        authorization: 'Bearer test-token',
        'content-type': 'application/json',
        'x-stemcraft-event-id': 'join-1',
      },
      43129,
    );
    const quit = await request(
      JSON.stringify({
        event: 'minecraft.player_quit',
        event_id: 'quit-1',
        server: 'survival',
        channel: 'global',
        player: { name: 'Alex', uuid: 'player-1' },
        data: { online_players: 11 },
      }),
      {
        authorization: 'Bearer test-token',
        'content-type': 'application/json',
        'x-stemcraft-event-id': 'quit-1',
      },
      43129,
    );

    expect(join.status).toBe(200);
    expect(quit.status).toBe(200);
    expect(publisher.send).toHaveBeenNthCalledWith(1, 'discord-channel', {
      content: '',
      embeds: [
        {
          color: 0x00ff00,
          author: { name: 'Alex joined the server' },
          fields: [{ name: 'Online players', value: '12', inline: true }],
        },
      ],
    });
    expect(publisher.send).toHaveBeenNthCalledWith(2, 'discord-channel', {
      content: '',
      embeds: [
        {
          color: 0xff0000,
          author: { name: 'Alex left the server' },
          fields: [{ name: 'Online players', value: '11', inline: true }],
        },
      ],
    });
  });

  it('routes minigame start and end events with arena, roster, team and winner details', async () => {
    const state = new MemoryStateStore();
    const publisher: ChatDiscordBridgePublisher = {
      send: vi.fn().mockResolvedValue('discord-message-3'),
    };
    const bridge = new HttpChatDiscordBridge({
      config: config(43130),
      publisher,
      state,
      logger,
    });
    activeBridges.push(bridge);
    await bridge.start();

    const start = await request(
      JSON.stringify({
        event: 'minecraft.minigame_start',
        event_id: 'start-1',
        server: 'survival',
        channel: 'global',
        data: {
          minigame: 'bedwars',
          arena: { id: 'forest', name: 'Forest', world: 'bedwars_forest' },
          status: 'running',
          players: [{ name: 'Alex', uuid: 'player-1' }],
          spectators: [],
          teams: [
            {
              name: 'red',
              display_name: 'Red',
              score: 0,
              players: [{ name: 'Alex', uuid: 'player-1' }],
            },
          ],
        },
      }),
      {
        authorization: 'Bearer test-token',
        'content-type': 'application/json',
        'x-stemcraft-event-id': 'start-1',
      },
      43130,
    );
    const end = await request(
      JSON.stringify({
        event: 'minecraft.minigame_end',
        event_id: 'end-1',
        server: 'survival',
        channel: 'global',
        data: {
          minigame: 'bedwars',
          arena: { id: 'forest', name: 'Forest', world: 'bedwars_forest' },
          status: 'ending',
          players: [],
          spectators: [],
          teams: [],
          winner: null,
          winner_team: 'red',
          winner_players: [{ name: 'Alex', uuid: 'player-1' }],
        },
      }),
      {
        authorization: 'Bearer test-token',
        'content-type': 'application/json',
        'x-stemcraft-event-id': 'end-1',
      },
      43130,
    );
    const draw = await request(
      JSON.stringify({
        event: 'minecraft.minigame_end',
        event_id: 'draw-1',
        data: {
          minigame: 'bedwars',
          arena: { id: 'forest', name: 'Forest', world: 'bedwars_forest' },
          status: 'ending',
          players: [],
          spectators: [],
          teams: [],
          winner: null,
          winner_team: null,
          winner_players: [],
        },
      }),
      {
        authorization: 'Bearer test-token',
        'content-type': 'application/json',
        'x-stemcraft-event-id': 'draw-1',
      },
      43130,
    );

    expect(start.status).toBe(200);
    expect(end.status).toBe(200);
    expect(draw.status).toBe(200);
    expect(publisher.send).toHaveBeenNthCalledWith(1, 'discord-channel', {
      content: '',
      embeds: [
        {
          color: 0x3498db,
          author: { name: 'Bedwars started' },
          fields: [
            {
              name: 'Arena',
              value: '**Forest**\nID: `forest`\nWorld: `bedwars_forest`',
              inline: true,
            },
            { name: 'Status', value: '`running`', inline: true },
            { name: 'Players', value: '**Alex**' },
            { name: 'Spectators', value: 'none' },
            { name: 'Teams', value: '**Red** (0): **Alex**' },
          ],
        },
      ],
    });
    expect(publisher.send).toHaveBeenNthCalledWith(2, 'discord-channel', {
      content: '',
      embeds: [
        {
          color: 0x9b59b6,
          author: { name: 'Bedwars ended' },
          fields: [
            {
              name: 'Arena',
              value: '**Forest**\nID: `forest`\nWorld: `bedwars_forest`',
              inline: true,
            },
            { name: 'Status', value: '`ending`', inline: true },
            { name: 'Winner', value: '**Red** — **Alex**' },
            { name: 'Players', value: 'none' },
            { name: 'Spectators', value: 'none' },
            { name: 'Teams', value: 'none' },
          ],
        },
      ],
    });
    expect(publisher.send).toHaveBeenNthCalledWith(
      3,
      'discord-channel',
      expect.objectContaining({
        content: '',
        embeds: [
          expect.objectContaining({
            fields: expect.arrayContaining([{ name: 'Winner', value: 'none (draw)' }]),
          }),
        ],
      }),
    );
  });

  it('rejects a mismatched event-id header for every event type', async () => {
    const state = new MemoryStateStore();
    const publisher: ChatDiscordBridgePublisher = { send: vi.fn() };
    const bridge = new HttpChatDiscordBridge({
      config: config(43131),
      publisher,
      state,
      logger,
    });
    activeBridges.push(bridge);
    await bridge.start();

    const response = await request(
      JSON.stringify({
        event: 'minecraft.player_quit',
        event_id: 'quit-2',
        player: { name: 'Alex' },
        data: { online_players: 0 },
      }),
      {
        authorization: 'Bearer test-token',
        'content-type': 'application/json',
        'x-stemcraft-event-id': 'different-id',
      },
      43131,
    );

    expect(response.status).toBe(400);
    expect(JSON.parse(response.body)).toEqual({ error: 'event_id_mismatch' });
    expect(publisher.send).not.toHaveBeenCalled();
  });
});
