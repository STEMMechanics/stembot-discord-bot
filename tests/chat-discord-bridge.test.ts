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
    expect(publisher.send).toHaveBeenCalledWith(
      'discord-channel',
      '⛏️ **Alex**: Hello from Minecraft',
    );
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
