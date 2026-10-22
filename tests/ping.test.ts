import type { ChatInputCommandInteraction } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';

import { getPingResponse, pingCommand } from '../src/discord/commands.js';

describe('/ping', () => {
  it('formats the gateway latency', () => {
    expect(getPingResponse(42)).toBe('Pong! Gateway latency: 42ms');
  });

  it('defers and edits the Discord interaction', async () => {
    const deferReply = vi.fn().mockResolvedValue(undefined);
    const editReply = vi.fn().mockResolvedValue(undefined);
    const interaction = { deferReply, editReply } as unknown as ChatInputCommandInteraction;

    await pingCommand.execute(interaction, { getGatewayPing: () => 37 });

    expect(deferReply).toHaveBeenCalledOnce();
    expect(editReply).toHaveBeenCalledWith({ content: 'Pong! Gateway latency: 37ms' });
  });
});
