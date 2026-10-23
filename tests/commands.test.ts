import { describe, expect, it, vi } from 'vitest';
import type { ChatInputCommandInteraction } from 'discord.js';

import {
  formatMinecraftStatus,
  formatPlayers,
  formatWorkshopList,
  formatUserLeaderboard,
  formatUserLevel,
  getRandomRobotJoke,
  getCommandDefinitions,
  getUpcomingWorkshops,
  minecraftCommand,
  jokeCommand,
  pingCommand,
  playersCommand,
  reviewCommand,
  robotJokes,
} from '../src/discord/commands.js';
import type { MinecraftPlayer } from '../src/integrations/stemcraft.js';
import { formatWorkshopRegistration, type WorkshopRecord } from '../src/integrations/website.js';
import type { UserLevelProfile } from '../src/services/user-levels.js';

function workshop(overrides: Partial<WorkshopRecord> = {}): WorkshopRecord {
  return {
    externalId: 'workshop-1',
    title: 'Redstone Music Challenge',
    startsAt: new Date('2026-10-24T06:00:00.000Z'),
    endsAt: new Date('2026-10-24T07:00:00.000Z'),
    url: 'https://example.test/workshops/redstone',
    location: 'STEMCraft',
    status: 'open',
    ...overrides,
  };
}

describe('Discord commands', () => {
  it('registers the planned read-only commands', () => {
    const definitions = getCommandDefinitions();

    expect(definitions.map((definition) => definition.name)).toEqual([
      'ping',
      'workshops',
      'joke',
      'level',
      'leaderboard',
      'review',
      'minecraft',
      'players',
    ]);
    expect(
      definitions.find((definition) => definition.name === 'players')?.default_member_permissions,
    ).toBeUndefined();
    expect(definitions.find((definition) => definition.name === 'review')?.options).toEqual([]);
  });

  it('filters cancelled and past workshops and sorts by start time', () => {
    const workshops = getUpcomingWorkshops(
      [
        workshop({ externalId: 'later', startsAt: new Date('2026-10-25T00:00:00Z') }),
        workshop({ externalId: 'past', startsAt: new Date('2026-10-21T00:00:00Z') }),
        workshop({
          externalId: 'cancelled',
          startsAt: new Date('2026-10-23T00:00:00Z'),
          status: 'cancelled',
        }),
        workshop({ externalId: 'soon', startsAt: new Date('2026-10-23T00:00:00Z') }),
      ],
      new Date('2026-10-22T00:00:00Z'),
    );

    expect(workshops.map((candidate) => candidate.externalId)).toEqual(['soon', 'later']);
  });

  it('provides at least 100 unique robot jokes', () => {
    expect(robotJokes.length).toBeGreaterThanOrEqual(100);
    expect(new Set(robotJokes).size).toBe(robotJokes.length);
    expect(getRandomRobotJoke(() => 0)).toBe(robotJokes[0]);
    expect(getRandomRobotJoke(() => 0.999999)).toBe(robotJokes[robotJokes.length - 1]);
  });

  it('uses statusCode instead of display status for lifecycle filtering', () => {
    const workshops = getUpcomingWorkshops(
      [
        workshop({
          externalId: 'display-cancelled',
          status: 'cancelled',
          statusCode: 'open',
        }),
        workshop({
          externalId: 'code-cancelled',
          status: 'open',
          statusCode: 'cancelled',
        }),
      ],
      new Date('2026-10-22T00:00:00.000Z'),
    );

    expect(workshops.map((candidate) => candidate.externalId)).toEqual(['display-cancelled']);
  });

  it('uses one Details link for each workshop', () => {
    const content = formatWorkshopList(
      [
        workshop({ registrationUrl: 'https://example.test/register' }),
        workshop({
          externalId: 'second',
          title: 'Paper Speakers',
          url: 'https://example.test/workshops/paper-speakers',
        }),
      ],
      'Australia/Brisbane',
      'Upcoming workshops',
    );

    expect(content).not.toContain('https://example.test/register');
    expect(content).toContain('[Details](https://example.test/workshops/redstone)');
    expect(content).toContain('[Details](https://example.test/workshops/paper-speakers)');
    expect(content).toContain('STEMCraft');

    const noRegistration = formatWorkshopList(
      [workshop({ registrationType: 'none' })],
      'Australia/Brisbane',
      'Upcoming workshops',
    );
    expect(noRegistration).not.toContain('No registration required');
    expect(noRegistration).toContain('[Details](https://example.test/workshops/redstone)');
  });

  it('formats registration calls to action for the final registration types', () => {
    expect(
      formatWorkshopRegistration(
        workshop({ registrationType: 'tickets', registrationUrl: 'https://example.test/tickets' }),
      ),
    ).toBe('[Book now](https://example.test/tickets)');
    expect(
      formatWorkshopRegistration(
        workshop({
          registrationType: 'interest',
          registrationUrl: 'https://example.test/interest',
        }),
      ),
    ).toBe('[Register interest](https://example.test/interest)');
    expect(
      formatWorkshopRegistration(
        workshop({ registrationType: 'email', registrationData: 'bookings@example.test' }),
      ),
    ).toContain('Email bookings@example.test');
    expect(
      formatWorkshopRegistration(
        workshop({ registrationType: 'message', registrationData: 'Contact an organiser' }),
      ),
    ).toBe('Registration: Contact an organiser');
    expect(formatWorkshopRegistration(workshop({ registrationType: 'none' }))).toBe(
      'No registration required',
    );
  });

  it('formats status and usernames without player identity fields', () => {
    expect(
      formatMinecraftStatus({
        online: true,
        playerCount: 2,
        maxPlayers: 50,
        version: '26.3',
      }),
    ).toContain('2/50 players online');

    const players: readonly MinecraftPlayer[] = [{ username: 'Alex' }, { username: 'Builder' }];
    expect(formatPlayers(players)).toBe('Online Minecraft players:\n• Alex\n• Builder');
  });

  it('formats user levels and the leaderboard without pinging members', () => {
    const profile: UserLevelProfile = {
      userId: 'user-1',
      xp: 120,
      level: 2,
      messageCount: 10,
      reactionCount: 5,
      gameCount: 2,
      lastMessageXpAt: null,
      lastReactionXpAt: null,
    };

    expect(formatUserLevel(profile)).toContain('**Level 2** — 120 XP');
    expect(formatUserLevel(profile)).toContain('Messages: 10 · Reactions: 5 · Games: 2');
    expect(formatUserLeaderboard([profile])).toContain('1. <@user-1> — Level 2 (120 XP)');
  });

  it('makes /players available without a permission check', async () => {
    const deferReply = vi.fn().mockResolvedValue(undefined);
    const editReply = vi.fn().mockResolvedValue(undefined);
    const interaction = { deferReply, editReply } as unknown as ChatInputCommandInteraction;
    const getOnlinePlayers = vi.fn().mockResolvedValue([{ username: 'Alex' }]);

    await playersCommand.execute(interaction, {
      getGatewayPing: () => 0,
      stemcraft: {
        getServerStatus: vi.fn(),
        getOnlinePlayers,
      },
    });

    expect(deferReply).toHaveBeenCalledOnce();
    expect(editReply).toHaveBeenCalledWith({
      content: 'Online Minecraft players:\n• Alex',
      allowedMentions: { parse: [] },
    });
  });

  it('requests counting-chain review for the last game-ending post', async () => {
    const deferReply = vi.fn().mockResolvedValue(undefined);
    const editReply = vi.fn().mockResolvedValue(undefined);
    const requestCountingChainReview = vi.fn().mockResolvedValue(true);
    const interaction = {
      channelId: 'counting-channel',
      deferReply,
      editReply,
    } as unknown as ChatInputCommandInteraction;

    await reviewCommand.execute(interaction, {
      getGatewayPing: () => 0,
      requestCountingChainReview,
    });

    expect(requestCountingChainReview).toHaveBeenCalledWith('counting-channel');
    expect(deferReply).toHaveBeenCalledOnce();
    expect(editReply).toHaveBeenCalledWith({
      content: expect.stringContaining('Review requested'),
    });
  });

  it('defers external status work before editing the interaction response', async () => {
    const calls: string[] = [];
    const interaction = {
      deferReply: vi.fn().mockImplementation(async () => {
        calls.push('defer');
      }),
      editReply: vi.fn().mockImplementation(async () => {
        calls.push('edit');
      }),
    } as unknown as ChatInputCommandInteraction;

    const getServerStatus = vi.fn().mockImplementation(async () => {
      calls.push('fetch');
      return { online: true, playerCount: 0, maxPlayers: 50 };
    });

    await minecraftCommand.execute(interaction, {
      getGatewayPing: () => 0,
      stemcraft: {
        getServerStatus,
        getOnlinePlayers: vi.fn(),
      },
    });

    expect(calls).toEqual(['defer', 'fetch', 'edit']);
  });

  it('replies immediately to /ping', async () => {
    const reply = vi.fn().mockResolvedValue(undefined);
    const interaction = { reply } as unknown as ChatInputCommandInteraction;

    await pingCommand.execute(interaction, { getGatewayPing: () => 263 });

    expect(reply).toHaveBeenCalledWith({ content: 'Pong! Gateway latency: 263ms' });
  });

  it('replies immediately to /joke', async () => {
    const reply = vi.fn().mockResolvedValue(undefined);
    const interaction = { reply } as unknown as ChatInputCommandInteraction;

    await jokeCommand.execute(interaction, { getGatewayPing: () => 0 });

    expect(reply).toHaveBeenCalledTimes(1);
    expect(robotJokes).toContain(reply.mock.calls[0]?.[0]?.content);
  });
});
