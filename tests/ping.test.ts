import type { ChatInputCommandInteraction } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';

import { getPingResponse, pingCommand } from '../src/discord/commands.js';

describe('/ping', () => {
  it('formats the gateway latency', () => {
    expect(getPingResponse(42)).toBe('Pong! Gateway latency: 42ms');
  });

  it('replies immediately to the Discord interaction', async () => {
    const reply = vi.fn().mockResolvedValue(undefined);
    const interaction = { reply } as unknown as ChatInputCommandInteraction;

    await pingCommand.execute(interaction, { getGatewayPing: () => 37 });

    expect(reply).toHaveBeenCalledWith({ content: 'Pong! Gateway latency: 37ms' });
  });
});
