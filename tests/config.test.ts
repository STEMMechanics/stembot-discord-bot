import { describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config/env.js';

describe('loadConfig', () => {
  it('loads defaults and the required target guild configuration', () => {
    const config = loadConfig({
      DISCORD_CLIENT_ID: '1234567890',
      DISCORD_GUILD_ID: '2234567890',
      DISCORD_TOKEN: 'test-token',
      NODE_ENV: 'test',
    });

    expect(config).toEqual({
      discord: {
        clientId: '1234567890',
        guildId: '2234567890',
        token: 'test-token',
      },
      environment: 'test',
      logLevel: 'info',
      website: {
        feedUrl: 'https://www.stemmechanics.com.au/workshops/feed',
        requestTimeoutMs: 15000,
      },
      stemcraft: {
        requestTimeoutMs: 5000,
        statusUrl: 'http://play.stemcraft.com.au:8950/status',
      },
      openai: {
        model: 'gpt-6-luna',
        reasoningEffort: 'low',
        timeoutMs: 180000,
      },
      countingChain: {
        enabled: false,
        reviewEnabled: false,
        maxAttachmentBytes: 8388608,
      },
      workshops: {
        announcementsEnabled: true,
        announcementWindowMs: 2419200000,
        announcementDelayMs: 1800000,
        announceInitialSync: false,
        pollIntervalMs: 300000,
        reminder1HourEnabled: true,
        reminder24HoursEnabled: true,
        remindersEnabled: true,
        timeZone: 'Australia/Brisbane',
      },
      streaming: {
        notificationsEnabled: false,
      },
      shutdownTimeoutMs: 30000,
      statePath: './data/state.json',
    });
  });

  it('rejects missing credentials', () => {
    expect(() => loadConfig({})).toThrow(/DISCORD_TOKEN/);
  });

  it('rejects a missing target guild', () => {
    expect(() =>
      loadConfig({
        DISCORD_CLIENT_ID: '1234567890',
        DISCORD_TOKEN: 'test-token',
      }),
    ).toThrow(/DISCORD_GUILD_ID/);
  });

  it('parses notification settings and optional external credentials', () => {
    const config = loadConfig({
      DISCORD_CLIENT_ID: '1234567890',
      DISCORD_GUILD_ID: '2234567890',
      DISCORD_TOKEN: 'test-token',
      DISCORD_WORKSHOP_ANNOUNCEMENT_CHANNEL_ID: '123456789012345678',
      DISCORD_WORKSHOP_REMINDER_CHANNEL_ID: '223456789012345678',
      STEMCRAFT_STATUS_TOKEN: 'status-token',
      WORKSHOP_ANNOUNCEMENTS_ENABLED: 'false',
      WORKSHOP_ANNOUNCEMENT_WINDOW_DAYS: '14',
      WORKSHOP_POLL_INTERVAL_MS: '60000',
      WORKSHOP_REMINDER_1H_ENABLED: '0',
      WORKSHOP_TIME_ZONE: 'UTC',
    });

    expect(config.workshops).toMatchObject({
      announcementsEnabled: false,
      announcementWindowMs: 1209600000,
      pollIntervalMs: 60000,
      reminder1HourEnabled: false,
      timeZone: 'UTC',
      announcementChannelId: '123456789012345678',
      reminderChannelId: '223456789012345678',
    });
    expect(config.stemcraft.token).toBe('status-token');
  });

  it('uses announcement delay minutes, including zero for immediate testing', () => {
    const config = loadConfig({
      DISCORD_CLIENT_ID: '1234567890',
      DISCORD_GUILD_ID: '2234567890',
      DISCORD_TOKEN: 'test-token',
      WORKSHOP_ANNOUNCEMENT_DELAY_MINUTES: '0',
      WORKSHOP_ANNOUNCEMENT_DELAY_MS: '1800000',
    });

    expect(config.workshops.announcementDelayMs).toBe(0);
  });

  it('keeps accepting the legacy announcement delay milliseconds setting', () => {
    const config = loadConfig({
      DISCORD_CLIENT_ID: '1234567890',
      DISCORD_GUILD_ID: '2234567890',
      DISCORD_TOKEN: 'test-token',
      WORKSHOP_ANNOUNCEMENT_DELAY_MS: '60000',
    });

    expect(config.workshops.announcementDelayMs).toBe(60000);
  });

  it('rejects an invalid workshop timezone', () => {
    expect(() =>
      loadConfig({
        DISCORD_CLIENT_ID: '1234567890',
        DISCORD_GUILD_ID: '2234567890',
        DISCORD_TOKEN: 'test-token',
        WORKSHOP_TIME_ZONE: 'not-a-time-zone',
      }),
    ).toThrow(/WORKSHOP_TIME_ZONE/);
  });

  it('requires counting-chain credentials and a channel when enabled', () => {
    expect(() =>
      loadConfig({
        DISCORD_CLIENT_ID: '1234567890',
        DISCORD_GUILD_ID: '2234567890',
        DISCORD_TOKEN: 'test-token',
        COUNTING_CHAIN_ENABLED: 'true',
      }),
    ).toThrow(/COUNTING_CHAIN_CHANNEL_ID/);

    expect(() =>
      loadConfig({
        DISCORD_CLIENT_ID: '1234567890',
        DISCORD_GUILD_ID: '2234567890',
        DISCORD_TOKEN: 'test-token',
        COUNTING_CHAIN_ENABLED: 'true',
        COUNTING_CHAIN_CHANNEL_ID: '3234567890',
      }),
    ).toThrow(/OPENAI_API_KEY/);

    const config = loadConfig({
      DISCORD_CLIENT_ID: '1234567890',
      DISCORD_GUILD_ID: '2234567890',
      DISCORD_TOKEN: 'test-token',
      COUNTING_CHAIN_ENABLED: 'true',
      COUNTING_CHAIN_CHANNEL_ID: '3234567890',
      COUNTING_CHAIN_INFO_CHANNEL_ID: '4234567890',
      COUNTING_CHAIN_INFO_MESSAGE_ID: '5234567890',
      OPENAI_API_KEY: 'openai-test-key',
      OPENAI_MODEL: 'test-model',
      OPENAI_REASONING_EFFORT: 'low',
      OPENAI_TIMEOUT: '42',
    });

    expect(config.openai).toEqual({
      apiKey: 'openai-test-key',
      model: 'test-model',
      reasoningEffort: 'low',
      timeoutMs: 42000,
    });
    expect(config.countingChain).toEqual({
      enabled: true,
      channelId: '3234567890',
      infoChannelId: '4234567890',
      infoMessageId: '5234567890',
      reviewEnabled: false,
      maxAttachmentBytes: 8388608,
    });
  });

  it('requires a moderator role when counting-chain review is enabled', () => {
    expect(() =>
      loadConfig({
        DISCORD_CLIENT_ID: '1234567890',
        DISCORD_GUILD_ID: '2234567890',
        DISCORD_TOKEN: 'test-token',
        COUNTING_CHAIN_REVIEW_ENABLED: 'true',
      }),
    ).toThrow(/COUNTING_CHAIN_REVIEW_ROLE_ID/);

    const config = loadConfig({
      DISCORD_CLIENT_ID: '1234567890',
      DISCORD_GUILD_ID: '2234567890',
      DISCORD_TOKEN: 'test-token',
      COUNTING_CHAIN_REVIEW_ENABLED: 'true',
      COUNTING_CHAIN_REVIEW_ROLE_ID: '6234567890',
    });

    expect(config.countingChain).toMatchObject({
      reviewEnabled: true,
      reviewRoleId: '6234567890',
    });
  });
});
