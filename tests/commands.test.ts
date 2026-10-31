import { describe, expect, it, vi } from 'vitest';
import type { ChatInputCommandInteraction } from 'discord.js';

import {
  formatMinecraftStatus,
  formatPlayers,
  buildUptimeStatusEmbed,
  countingChainCommand,
  connectFourCommand,
  formatWorkshopList,
  formatUserLeaderboard,
  formatUserLevel,
  getUserLevelProgress,
  getRandomRobotJoke,
  getCommandDefinitions,
  getUpcomingWorkshops,
  minecraftCommand,
  playerInfoCommand,
  playerNotificationsCommand,
  jokeCommand,
  levelCommand,
  numberCommand,
  pingCommand,
  reviewCommand,
  robotJokes,
  scrambleCommand,
  statusCommand,
} from '../src/discord/commands.js';
import { PlayerListUnavailableError, type MinecraftPlayer } from '../src/integrations/stemcraft.js';
import { MinecraftProfileLookupError } from '../src/integrations/minecraft-profile.js';
import { formatWorkshopRegistration, type WorkshopRecord } from '../src/integrations/website.js';
import type { AppLogger } from '../src/logging/logger.js';
import type { StemScrambleService } from '../src/services/scramble.js';
import type { ConnectFourService } from '../src/services/connect-four.js';
import type { CountingChainService } from '../src/services/counting-chain.js';
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
      'number',
      'level',
      'status',
      'scramble',
      'mystery-lab',
      'code-fix',
      'tictactoe',
      'connect4',
      'leaderboard',
      'review',
      'counting-chain',
      'remind',
      'minecraft',
      'playerinfo',
      'playernotifications',
    ]);
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
    expect(getUserLevelProgress(profile)).toEqual({
      currentXp: 20,
      requiredXp: 300,
      percent: 6,
    });
  });

  it('shows a public level card for the requested user', async () => {
    const deferReply = vi.fn().mockResolvedValue(undefined);
    const editReply = vi.fn().mockResolvedValue(undefined);
    const targetUser = {
      id: 'user-2',
      username: 'Builder',
      globalName: 'Builder',
      displayAvatarURL: vi.fn().mockReturnValue('https://cdn.example.test/builder.png'),
    };
    const interaction = {
      user: targetUser,
      options: { getUser: vi.fn().mockReturnValue(targetUser) },
      deferReply,
      editReply,
    } as unknown as ChatInputCommandInteraction;
    const getProfile = vi.fn().mockResolvedValue({
      userId: 'user-2',
      xp: 120,
      level: 2,
      messageCount: 10,
      reactionCount: 5,
      gameCount: 2,
      lastMessageXpAt: null,
      lastReactionXpAt: null,
    });

    await levelCommand.execute(interaction, {
      getGatewayPing: () => 0,
      userLevels: {
        getProfile,
        getRank: vi.fn().mockResolvedValue(4),
        getLeaderboard: vi.fn(),
        recordMessage: vi.fn(),
        recordReaction: vi.fn(),
        recordGameParticipation: vi.fn(),
      },
    });

    expect(getProfile).toHaveBeenCalledWith('user-2');
    expect(deferReply).toHaveBeenCalledWith();
    expect(editReply).toHaveBeenCalledWith({
      files: [expect.objectContaining({ name: 'stembot-level-card.png' })],
      allowedMentions: { parse: [] },
    });
  });

  it('shows a public uptime status embed', async () => {
    const deferReply = vi.fn().mockResolvedValue(undefined);
    const editReply = vi.fn().mockResolvedValue(undefined);
    const interaction = { deferReply, editReply } as unknown as ChatInputCommandInteraction;
    const getStatus = vi.fn().mockResolvedValue({
      overall: 'up',
      title: 'STEMMechanics Status',
      statusPageUrl: 'https://uptime.example.test/status/stem',
      checkedAt: new Date('2026-10-23T00:00:00.000Z'),
      monitors: [{ id: '1', name: 'Website', state: 'up' }],
    });

    await statusCommand.execute(interaction, {
      getGatewayPing: () => 0,
      uptime: { getStatus },
    });

    expect(deferReply).toHaveBeenCalledWith();
    expect(editReply).toHaveBeenCalledWith({
      embeds: [expect.objectContaining({ color: 0x2ecc71 })],
      allowedMentions: { parse: [] },
    });
  });

  it('keeps the public uptime card concise', () => {
    const embed = buildUptimeStatusEmbed({
      overall: 'up',
      title: 'STEMMechanics Status',
      statusPageUrl: 'https://uptime.example.test/status/stem',
      checkedAt: new Date('2026-10-23T00:00:00.000Z'),
      monitors: [{ id: '1', name: 'Website', state: 'up', uptime24h: 0.9998 }],
    });

    expect(embed.description).toBe('All monitored services are online.');
    expect(embed.footer).toEqual({ text: 'Last checked' });
    expect(embed.fields?.[0]?.value).toContain('🟢 **Website** — Online');
    expect(embed.fields?.[0]?.value).not.toContain('Operational');
    expect(embed.fields?.[0]?.value).not.toContain('24h');
  });

  it('uses a softer orange card when a monitor is pending or under maintenance', () => {
    const embed = buildUptimeStatusEmbed({
      overall: 'down',
      title: 'STEMMechanics Status',
      statusPageUrl: 'https://uptime.example.test/status/stem',
      checkedAt: new Date('2026-10-23T00:00:00.000Z'),
      monitors: [{ id: '1', name: 'Website', state: 'pending' }],
    });

    expect(embed.title).toBe('🟠 STEMMechanics Status');
    expect(embed.color).toBe(0xf39c12);
    expect(embed.description).toBe(
      'One or more monitored services are interrupted or under maintenance.',
    );
    expect(embed.fields?.[0]?.value).toContain('🟠 **Website** — Issue');
  });

  it('lets members with Manage Messages reset the scramble', async () => {
    const deferReply = vi.fn().mockResolvedValue(undefined);
    const editReply = vi.fn().mockResolvedValue(undefined);
    const resetRound = vi.fn().mockResolvedValue('magnet');
    const interaction = {
      memberPermissions: { has: vi.fn().mockReturnValue(true) },
      deferReply,
      editReply,
    } as unknown as ChatInputCommandInteraction;

    await scrambleCommand.execute(interaction, {
      getGatewayPing: () => 0,
      scramble: { resetRound } as unknown as StemScrambleService,
    });

    expect(resetRound).toHaveBeenCalledOnce();
    expect(deferReply).toHaveBeenCalledWith({ flags: 64 });
    expect(editReply).toHaveBeenCalledWith({
      content: 'Scramble reset. The previous answer was **magnet**.',
    });
  });

  it('lets members with Manage Messages reset Connect 4', async () => {
    const deferReply = vi.fn().mockResolvedValue(undefined);
    const editReply = vi.fn().mockResolvedValue(undefined);
    const resetRound = vi.fn().mockResolvedValue(true);
    const interaction = {
      memberPermissions: { has: vi.fn().mockReturnValue(true) },
      deferReply,
      editReply,
    } as unknown as ChatInputCommandInteraction;

    await connectFourCommand.execute(interaction, {
      getGatewayPing: () => 0,
      connectFour: { resetRound } as unknown as ConnectFourService,
    });

    expect(resetRound).toHaveBeenCalledOnce();
    expect(deferReply).toHaveBeenCalledWith({ flags: 64 });
    expect(editReply).toHaveBeenCalledWith({
      content: 'Connect 4 reset. A fresh round has been started.',
    });
  });

  it('includes online usernames in /minecraft without a permission check', async () => {
    const deferReply = vi.fn().mockResolvedValue(undefined);
    const editReply = vi.fn().mockResolvedValue(undefined);
    const interaction = { deferReply, editReply } as unknown as ChatInputCommandInteraction;
    const getServerStatus = vi.fn().mockResolvedValue({
      online: true,
      playerCount: 1,
      maxPlayers: 50,
      version: '26.3',
    });
    const getOnlinePlayers = vi.fn().mockResolvedValue([{ username: 'Alex' }]);

    await minecraftCommand.execute(interaction, {
      getGatewayPing: () => 0,
      stemcraft: {
        getServerStatus,
        getOnlinePlayers,
      },
    });

    expect(deferReply).toHaveBeenCalledOnce();
    expect(editReply).toHaveBeenCalledWith({
      content:
        'STEMCraft is **online** — 1/50 players online · version 26.3.\n\nOnline Minecraft players:\n• Alex',
      allowedMentions: { parse: [] },
    });
  });

  it('keeps /minecraft status available when usernames are unavailable', async () => {
    const deferReply = vi.fn().mockResolvedValue(undefined);
    const editReply = vi.fn().mockResolvedValue(undefined);
    const interaction = { deferReply, editReply } as unknown as ChatInputCommandInteraction;

    await minecraftCommand.execute(interaction, {
      getGatewayPing: () => 0,
      stemcraft: {
        getServerStatus: vi.fn().mockResolvedValue({ online: false, playerCount: 0 }),
        getOnlinePlayers: vi.fn().mockRejectedValue(new PlayerListUnavailableError()),
      },
    });

    expect(editReply).toHaveBeenCalledWith({
      content: expect.stringContaining(
        'Online Minecraft usernames are not available from STEMCraft right now.',
      ),
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

  it('lets a moderator set the next counting-chain number', async () => {
    const deferReply = vi.fn().mockResolvedValue(undefined);
    const editReply = vi.fn().mockResolvedValue(undefined);
    const setNextNumber = vi.fn().mockResolvedValue(true);
    const interaction = {
      channelId: 'counting-channel',
      user: { id: 'moderator-1' },
      memberPermissions: {
        has: vi.fn().mockReturnValue(true),
      },
      options: {
        getInteger: vi.fn().mockReturnValue(16),
      },
      deferReply,
      editReply,
    } as unknown as ChatInputCommandInteraction;

    await countingChainCommand.execute(interaction, {
      getGatewayPing: () => 0,
      countingChain: { setNextNumber } as unknown as CountingChainService,
    });

    expect(setNextNumber).toHaveBeenCalledWith('counting-channel', 16, 'moderator-1');
    expect(deferReply).toHaveBeenCalledWith({ flags: 64 });
    expect(editReply).toHaveBeenCalledWith({
      content: 'Counting chain updated. The next accepted number is **16**.',
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
    const getOnlinePlayers = vi.fn().mockImplementation(async () => {
      calls.push('players');
      return [];
    });

    await minecraftCommand.execute(interaction, {
      getGatewayPing: () => 0,
      stemcraft: {
        getServerStatus,
        getOnlinePlayers,
      },
    });

    expect(calls).toEqual(['defer', 'fetch', 'players', 'edit']);
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

  it('starts /number and activates the reply-bound challenge', async () => {
    const reply = vi.fn().mockResolvedValue({ id: 'number-prompt-1' });
    const startChallenge = vi.fn().mockResolvedValue({
      challengeId: 'number-challenge-1',
      content: 'number prompt',
    });
    const activateChallenge = vi.fn().mockResolvedValue(undefined);
    const interaction = {
      user: { id: 'user-1' },
      channelId: 'channel-1',
      reply,
    } as unknown as ChatInputCommandInteraction;

    await numberCommand.execute(interaction, {
      getGatewayPing: () => 0,
      numberGame: {
        startChallenge,
        activateChallenge,
        handleMessage: vi.fn().mockResolvedValue(undefined),
        getLeaderboard: vi.fn().mockResolvedValue([]),
      },
    });

    expect(startChallenge).toHaveBeenCalledWith('user-1', 'channel-1');
    expect(reply).toHaveBeenCalledWith({
      content: 'number prompt',
      fetchReply: true,
      allowedMentions: { parse: [] },
    });
    expect(activateChallenge).toHaveBeenCalledWith('number-challenge-1', 'number-prompt-1');
  });

  it('lets anyone look up a Minecraft UUID with /playerinfo', async () => {
    const deferReply = vi.fn().mockResolvedValue(undefined);
    const editReply = vi.fn().mockResolvedValue(undefined);
    const interaction = {
      deferReply,
      editReply,
      options: { getString: vi.fn().mockReturnValue('Alex') },
    } as unknown as ChatInputCommandInteraction;

    await playerInfoCommand.execute(interaction, {
      getGatewayPing: () => 0,
      minecraftProfiles: {
        findByUsername: vi.fn().mockResolvedValue({
          username: 'Alex',
          uuid: '0123456789abcdef0123456789abcdef',
        }),
      },
      stemcraft: {
        getServerStatus: vi.fn(),
        getOnlinePlayers: vi.fn().mockResolvedValue([{ username: 'Alex' }]),
      },
    });

    expect(deferReply).toHaveBeenCalledWith();
    expect(editReply).toHaveBeenCalledWith({
      embeds: [
        {
          color: 0x2ecc71,
          author: {
            name: "Alex's Minecraft profile",
            icon_url: 'https://mc-heads.net/avatar/Alex/128.png',
          },
          thumbnail: { url: 'https://mc-heads.net/avatar/Alex/128.png' },
          fields: [
            { name: 'UUID', value: '`0123456789abcdef0123456789abcdef`' },
            { name: 'Player status', value: 'Online', inline: true },
            { name: 'Server', value: '1 players online', inline: true },
          ],
          footer: { text: 'Minecraft profile' },
        },
      ],
      allowedMentions: { parse: [] },
    });
  });

  it('logs Minecraft profile lookup failures before returning the generic playerinfo response', async () => {
    const deferReply = vi.fn().mockResolvedValue(undefined);
    const editReply = vi.fn().mockResolvedValue(undefined);
    const lookupError = new MinecraftProfileLookupError('Minecraft profile lookup request failed', {
      cause: new Error('connect timeout'),
    });
    const warn = vi.fn();
    const interaction = {
      deferReply,
      editReply,
      options: { getString: vi.fn().mockReturnValue('MCList') },
    } as unknown as ChatInputCommandInteraction;

    await playerInfoCommand.execute(interaction, {
      getGatewayPing: () => 0,
      logger: { warn } as unknown as AppLogger,
      minecraftProfiles: {
        findByUsername: vi.fn().mockRejectedValue(lookupError),
      },
    });

    expect(editReply).toHaveBeenCalledWith({
      content: 'Minecraft profile lookup is temporarily unavailable. Please try again later.',
    });
    expect(warn).toHaveBeenCalledWith(
      {
        err: lookupError,
        identifier: 'MCList',
        lookupType: 'username',
      },
      'Minecraft profile lookup failed; returning a temporary-unavailable response',
    );
  });

  it('shows STEMCraft statistics for a username and supports a selected period', async () => {
    const deferReply = vi.fn().mockResolvedValue(undefined);
    const editReply = vi.fn().mockResolvedValue(undefined);
    const findByUuid = vi.fn().mockResolvedValue({
      profile: {
        username: 'Alex',
        uuid: '0123456789abcdef0123456789abcdef',
      },
      online: true,
      stats: {
        available: true,
        period: '28d',
        items: [
          { key: 'deaths', title: 'Deaths', value: 3 },
          { key: 'play_time', title: 'Play Time', value: 12.5 },
        ],
      },
    });
    const interaction = {
      deferReply,
      editReply,
      options: {
        getString: vi.fn((name: string) => (name === 'username' ? 'Alex' : '28d')),
      },
    } as unknown as ChatInputCommandInteraction;

    await playerInfoCommand.execute(interaction, {
      getGatewayPing: () => 0,
      minecraftProfiles: {
        findByUsername: vi.fn().mockResolvedValue({
          username: 'Alex',
          uuid: '0123456789abcdef0123456789abcdef',
        }),
      },
      minecraftPlayerProfiles: { findByUuid },
      stemcraft: {
        getServerStatus: vi.fn(),
        getOnlinePlayers: vi.fn().mockResolvedValue([{ username: 'Alex' }]),
      },
    });

    expect(findByUuid).toHaveBeenCalledWith('0123456789abcdef0123456789abcdef', {
      include: ['stats'],
      period: '28d',
    });
    expect(editReply).toHaveBeenCalledWith({
      embeds: [
        expect.objectContaining({
          thumbnail: { url: 'https://mc-heads.net/avatar/Alex/128.png' },
          fields: expect.arrayContaining([
            { name: 'Statistics (last 28 days)', value: '**Deaths**: 3\n**Play Time**: 12.5' },
          ]),
        }),
      ],
      allowedMentions: { parse: [] },
    });
  });

  it('accepts a UUID and uses the STEMCraft profile identity', async () => {
    const deferReply = vi.fn().mockResolvedValue(undefined);
    const editReply = vi.fn().mockResolvedValue(undefined);
    const interaction = {
      deferReply,
      editReply,
      options: {
        getString: vi.fn((name: string) =>
          name === 'username' ? '01234567-89ab-cdef-0123-456789abcdef' : null,
        ),
      },
    } as unknown as ChatInputCommandInteraction;

    await playerInfoCommand.execute(interaction, {
      getGatewayPing: () => 0,
      minecraftProfiles: {
        findByUsername: vi.fn(),
        findByUuid: vi.fn(),
      },
      minecraftPlayerProfiles: {
        findByUuid: vi.fn().mockResolvedValue({
          profile: {
            username: 'Alex',
            uuid: '0123456789abcdef0123456789abcdef',
          },
          online: false,
          stats: {
            available: true,
            period: 'all',
            items: [],
          },
        }),
      },
      stemcraft: {
        getServerStatus: vi.fn(),
        getOnlinePlayers: vi.fn().mockResolvedValue([]),
      },
    });

    expect(editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        embeds: [
          expect.objectContaining({
            author: expect.objectContaining({ name: "Alex's Minecraft profile" }),
          }),
        ],
      }),
    );
  });

  it('restricts player notification changes to moderators and stores UUIDs', async () => {
    const deferReply = vi.fn().mockResolvedValue(undefined);
    const editReply = vi.fn().mockResolvedValue(undefined);
    const addIgnoredPlayer = vi.fn().mockResolvedValue({
      alreadyIgnored: false,
      player: { username: 'Alex', uuid: '0123456789abcdef0123456789abcdef' },
    });
    const interaction = {
      memberPermissions: { has: vi.fn().mockReturnValue(true) },
      deferReply,
      editReply,
      options: {
        getSubcommand: vi.fn().mockReturnValue('add'),
        getString: vi.fn().mockReturnValue('Alex'),
      },
    } as unknown as ChatInputCommandInteraction;

    await playerNotificationsCommand.execute(interaction, {
      getGatewayPing: () => 0,
      minecraftProfiles: {
        findByUsername: vi.fn().mockResolvedValue({
          username: 'Alex',
          uuid: '0123456789abcdef0123456789abcdef',
        }),
      },
      playerNotifications: {
        addIgnoredPlayer,
        findIgnoredPlayerByUsername: vi.fn(),
        removeIgnoredPlayer: vi.fn(),
        listIgnoredPlayers: vi.fn(),
        isIgnored: vi.fn(),
      },
    });

    expect(addIgnoredPlayer).toHaveBeenCalledWith({
      username: 'Alex',
      uuid: '0123456789abcdef0123456789abcdef',
    });
    expect(deferReply).toHaveBeenCalledWith({ flags: 64 });
    expect(editReply).toHaveBeenCalledWith({
      content: 'Join/leave announcements will now be suppressed for **Alex**.',
    });
  });

  it('logs profile lookup failures when adding a player to the notification ignore list', async () => {
    const deferReply = vi.fn().mockResolvedValue(undefined);
    const editReply = vi.fn().mockResolvedValue(undefined);
    const lookupError = new MinecraftProfileLookupError('Minecraft profile lookup request failed');
    const warn = vi.fn();
    const interaction = {
      memberPermissions: { has: vi.fn().mockReturnValue(true) },
      deferReply,
      editReply,
      options: {
        getSubcommand: vi.fn().mockReturnValue('add'),
        getString: vi.fn().mockReturnValue('MCList'),
      },
    } as unknown as ChatInputCommandInteraction;

    await playerNotificationsCommand.execute(interaction, {
      getGatewayPing: () => 0,
      logger: { warn } as unknown as AppLogger,
      minecraftProfiles: {
        findByUsername: vi.fn().mockRejectedValue(lookupError),
      },
      playerNotifications: {
        addIgnoredPlayer: vi.fn(),
        findIgnoredPlayerByUsername: vi.fn(),
        removeIgnoredPlayer: vi.fn(),
        listIgnoredPlayers: vi.fn(),
        isIgnored: vi.fn(),
      },
    });

    expect(editReply).toHaveBeenCalledWith({
      content: 'Minecraft profile lookup is temporarily unavailable. Please try again later.',
    });
    expect(warn).toHaveBeenCalledWith(
      { err: lookupError, username: 'MCList' },
      'Minecraft profile lookup failed; returning a temporary-unavailable response',
    );
  });
});
