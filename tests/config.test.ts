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
      uptime: {
        enabled: false,
        pollIntervalMs: 60000,
        requestTimeoutMs: 10000,
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
        idleNudgeMs: 259200000,
      },
      quiz: {
        enabled: false,
        maxWrongAnswers: 5,
        targetAgeMin: 8,
        targetAgeMax: 14,
        olderAgeMax: 18,
        olderPlayerRate: 0.15,
        topic:
          'a balanced mix of science, technology, engineering, mathematics, space, nature, robotics and computing',
        retryIntervalMs: 300000,
        idleTimeoutMs: 259200000,
      },
      scramble: {
        enabled: false,
        retryIntervalMs: 300000,
        targetAgeMin: 8,
        targetAgeMax: 14,
        topic:
          'a balanced mix of science, technology, engineering, mathematics, space, nature, robotics and computing',
        idleTimeoutMs: 259200000,
      },
      wordChain: {
        enabled: false,
        retryIntervalMs: 300000,
        idleTimeoutMs: 259200000,
      },
      wordReveal: {
        enabled: false,
        retryIntervalMs: 300000,
        topic:
          'a varied mix of animals, nature, food, places, everyday objects, hobbies, stories, music, sport, inventions, science and technology',
        difficulty: 'challenging',
        targetAgeMin: 8,
        targetAgeMax: 14,
        maxWrongGuesses: 8,
        idleTimeoutMs: 259200000,
      },
      codeFix: {
        enabled: false,
        retryIntervalMs: 300000,
        difficulty: 'intermediate',
        topic: 'beginner programming, debugging, algorithms, robotics and simple STEM projects',
        targetAgeMin: 8,
        targetAgeMax: 14,
        maxWrongAnswers: 5,
        idleTimeoutMs: 259200000,
      },
      reminders: {
        enabled: false,
        checkIntervalMs: 60000,
      },
      ask: {
        enabled: false,
        maxQuestionLength: 500,
        userCooldownMs: 30000,
        userDailyLimit: 10,
        globalDailyLimit: 100,
      },
      chatDiscordBridge: {
        enabled: false,
        host: '0.0.0.0',
        port: 8080,
        path: '/minecraft/event',
        maxBodyBytes: 65536,
      },
      levels: {
        enabled: false,
        messageXp: 5,
        reactionXp: 2,
        gameXp: 15,
        messageCooldownMs: 60000,
        reactionCooldownMs: 30000,
      },
      workshops: {
        announcementsEnabled: true,
        announcementWindowMs: 2419200000,
        announcementDelayMs: 1800000,
        announceInitialSync: false,
        pollIntervalMs: 300000,
        reminder1HourEnabled: true,
        reminder24HoursEnabled: true,
        reminderLocations: ['STEMCraft'],
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

  it('normalises a trailing slash on the Minecraft event path', () => {
    const config = loadConfig({
      DISCORD_CLIENT_ID: '1234567890',
      DISCORD_GUILD_ID: '2234567890',
      DISCORD_TOKEN: 'test-token',
      NODE_ENV: 'test',
      CHAT_DISCORD_BRIDGE_PATH: '/minecraft/event/',
    });

    expect(config.chatDiscordBridge.path).toBe('/minecraft/event');
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
      WORKSHOP_REMINDER_LOCATIONS: 'stemcraft, Online',
      WORKSHOP_TIME_ZONE: 'UTC',
    });

    expect(config.workshops).toMatchObject({
      announcementsEnabled: false,
      announcementWindowMs: 1209600000,
      pollIntervalMs: 60000,
      reminder1HourEnabled: false,
      reminderLocations: ['stemcraft', 'Online'],
      timeZone: 'UTC',
      announcementChannelId: '123456789012345678',
      reminderChannelId: '223456789012345678',
    });
    expect(config.stemcraft.token).toBe('status-token');
  });

  it('requires the public status page and Discord channel when uptime status is enabled', () => {
    expect(() =>
      loadConfig({
        DISCORD_CLIENT_ID: '1234567890',
        DISCORD_GUILD_ID: '2234567890',
        DISCORD_TOKEN: 'test-token',
        UPTIME_KUMA_ENABLED: 'true',
      }),
    ).toThrow(/UPTIME_KUMA_STATUS_PAGE_URL/);

    expect(() =>
      loadConfig({
        DISCORD_CLIENT_ID: '1234567890',
        DISCORD_GUILD_ID: '2234567890',
        DISCORD_TOKEN: 'test-token',
        UPTIME_KUMA_ENABLED: 'true',
        UPTIME_KUMA_STATUS_PAGE_URL: 'https://uptime.example.test/status/stem',
      }),
    ).toThrow(/DISCORD_UPTIME_STATUS_CHANNEL_ID/);

    const config = loadConfig({
      DISCORD_CLIENT_ID: '1234567890',
      DISCORD_GUILD_ID: '2234567890',
      DISCORD_TOKEN: 'test-token',
      UPTIME_KUMA_ENABLED: 'true',
      UPTIME_KUMA_STATUS_PAGE_URL: 'https://uptime.example.test/status/stem',
      UPTIME_KUMA_POLL_INTERVAL_MS: '120000',
      UPTIME_KUMA_REQUEST_TIMEOUT_MS: '15000',
      DISCORD_UPTIME_STATUS_CHANNEL_ID: '3234567890',
    });

    expect(config.uptime).toEqual({
      enabled: true,
      statusPageUrl: 'https://uptime.example.test/status/stem',
      pollIntervalMs: 120000,
      requestTimeoutMs: 15000,
      statusChannelId: '3234567890',
    });
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
      COUNTING_CHAIN_IDLE_NUDGE_MS: '120000',
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
      idleNudgeMs: 120000,
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

  it('requires quiz credentials and parses the age and retry settings', () => {
    expect(() =>
      loadConfig({
        DISCORD_CLIENT_ID: '1234567890',
        DISCORD_GUILD_ID: '2234567890',
        DISCORD_TOKEN: 'test-token',
        STEM_QUIZ_ENABLED: 'true',
      }),
    ).toThrow(/STEM_QUIZ_CHANNEL_ID/);

    expect(() =>
      loadConfig({
        DISCORD_CLIENT_ID: '1234567890',
        DISCORD_GUILD_ID: '2234567890',
        DISCORD_TOKEN: 'test-token',
        STEM_QUIZ_ENABLED: 'true',
        STEM_QUIZ_CHANNEL_ID: '7234567890',
      }),
    ).toThrow(/OPENAI_API_KEY/);

    const config = loadConfig({
      DISCORD_CLIENT_ID: '1234567890',
      DISCORD_GUILD_ID: '2234567890',
      DISCORD_TOKEN: 'test-token',
      OPENAI_API_KEY: 'openai-test-key',
      STEM_QUIZ_ENABLED: 'true',
      STEM_QUIZ_CHANNEL_ID: '7234567890',
      STEM_QUIZ_MAX_WRONG_ANSWERS: '6',
      STEM_QUIZ_TARGET_AGE_MIN: '8',
      STEM_QUIZ_TARGET_AGE_MAX: '14',
      STEM_QUIZ_OLDER_AGE_MAX: '18',
      STEM_QUIZ_OLDER_PLAYER_RATE: '0.2',
      STEM_QUIZ_TOPIC: 'space science',
      STEM_QUIZ_RETRY_INTERVAL_MS: '60000',
      STEM_QUIZ_IDLE_TIMEOUT_MS: '120000',
    });

    expect(config.quiz).toEqual({
      enabled: true,
      channelId: '7234567890',
      maxWrongAnswers: 6,
      targetAgeMin: 8,
      targetAgeMax: 14,
      olderAgeMax: 18,
      olderPlayerRate: 0.2,
      topic: 'space science',
      retryIntervalMs: 60000,
      idleTimeoutMs: 120000,
    });
  });

  it('allows older-player quiz challenges beyond age 18', () => {
    const config = loadConfig({
      DISCORD_CLIENT_ID: '1234567890',
      DISCORD_GUILD_ID: '2234567890',
      DISCORD_TOKEN: 'test-token',
      OPENAI_API_KEY: 'openai-test-key',
      STEM_QUIZ_ENABLED: 'true',
      STEM_QUIZ_CHANNEL_ID: '7234567890',
      STEM_QUIZ_TARGET_AGE_MIN: '14',
      STEM_QUIZ_TARGET_AGE_MAX: '18',
      STEM_QUIZ_OLDER_AGE_MAX: '25',
    });

    expect(config.quiz).toMatchObject({
      targetAgeMin: 14,
      targetAgeMax: 18,
      olderAgeMax: 25,
    });
  });

  it('requires scramble credentials and parses level settings', () => {
    expect(() =>
      loadConfig({
        DISCORD_CLIENT_ID: '1234567890',
        DISCORD_GUILD_ID: '2234567890',
        DISCORD_TOKEN: 'test-token',
        STEM_SCRAMBLE_ENABLED: 'true',
      }),
    ).toThrow(/STEM_SCRAMBLE_CHANNEL_ID/);

    expect(() =>
      loadConfig({
        DISCORD_CLIENT_ID: '1234567890',
        DISCORD_GUILD_ID: '2234567890',
        DISCORD_TOKEN: 'test-token',
        STEM_SCRAMBLE_ENABLED: 'true',
        STEM_SCRAMBLE_CHANNEL_ID: '8234567890',
      }),
    ).toThrow(/OPENAI_API_KEY/);

    const config = loadConfig({
      DISCORD_CLIENT_ID: '1234567890',
      DISCORD_GUILD_ID: '2234567890',
      DISCORD_TOKEN: 'test-token',
      OPENAI_API_KEY: 'openai-test-key',
      STEM_SCRAMBLE_ENABLED: 'true',
      STEM_SCRAMBLE_CHANNEL_ID: '8234567890',
      STEM_SCRAMBLE_RETRY_INTERVAL_MS: '60000',
      STEM_SCRAMBLE_IDLE_TIMEOUT_MS: '120000',
      STEM_SCRAMBLE_TOPIC: 'space science',
      STEM_SCRAMBLE_TARGET_AGE_MIN: '8',
      STEM_SCRAMBLE_TARGET_AGE_MAX: '16',
      STEM_LEVELS_ENABLED: 'true',
      STEM_LEVELS_ANNOUNCEMENT_CHANNEL_ID: '9234567890',
      STEM_LEVELS_MESSAGE_XP: '7',
      STEM_LEVELS_REACTION_XP: '3',
      STEM_LEVELS_GAME_XP: '20',
      STEM_LEVELS_MESSAGE_COOLDOWN_SECONDS: '90',
      STEM_LEVELS_REACTION_COOLDOWN_SECONDS: '45',
    });

    expect(config.scramble).toEqual({
      enabled: true,
      channelId: '8234567890',
      retryIntervalMs: 60000,
      topic: 'space science',
      targetAgeMin: 8,
      targetAgeMax: 16,
      idleTimeoutMs: 120000,
    });
    expect(config.levels).toEqual({
      enabled: true,
      announcementChannelId: '9234567890',
      messageXp: 7,
      reactionXp: 3,
      gameXp: 20,
      messageCooldownMs: 90000,
      reactionCooldownMs: 45000,
    });
  });

  it('requires a word-chain channel and OpenAI credentials when the game is enabled', () => {
    expect(() =>
      loadConfig({
        DISCORD_CLIENT_ID: '1234567890',
        DISCORD_GUILD_ID: '2234567890',
        DISCORD_TOKEN: 'test-token',
        STEM_WORD_CHAIN_ENABLED: 'true',
      }),
    ).toThrow(/STEM_WORD_CHAIN_CHANNEL_ID/);

    expect(() =>
      loadConfig({
        DISCORD_CLIENT_ID: '1234567890',
        DISCORD_GUILD_ID: '2234567890',
        DISCORD_TOKEN: 'test-token',
        STEM_WORD_CHAIN_ENABLED: 'true',
        STEM_WORD_CHAIN_CHANNEL_ID: '8234567890',
      }),
    ).toThrow(/OPENAI_API_KEY/);

    const config = loadConfig({
      DISCORD_CLIENT_ID: '1234567890',
      DISCORD_GUILD_ID: '2234567890',
      DISCORD_TOKEN: 'test-token',
      OPENAI_API_KEY: 'openai-test-key',
      STEM_WORD_CHAIN_ENABLED: 'true',
      STEM_WORD_CHAIN_CHANNEL_ID: '8234567890',
      STEM_WORD_CHAIN_RETRY_INTERVAL_MS: '60000',
      STEM_WORD_CHAIN_IDLE_TIMEOUT_MS: '120000',
    });

    expect(config.wordChain).toEqual({
      enabled: true,
      channelId: '8234567890',
      retryIntervalMs: 60000,
      idleTimeoutMs: 120000,
    });
  });

  it('requires a moderator reminders channel when reminders are enabled', () => {
    expect(() =>
      loadConfig({
        DISCORD_CLIENT_ID: '1234567890',
        DISCORD_GUILD_ID: '2234567890',
        DISCORD_TOKEN: 'test-token',
        STEM_REMINDERS_ENABLED: 'true',
      }),
    ).toThrow(/STEM_REMINDERS_CHANNEL_ID/);

    const config = loadConfig({
      DISCORD_CLIENT_ID: '1234567890',
      DISCORD_GUILD_ID: '2234567890',
      DISCORD_TOKEN: 'test-token',
      STEM_REMINDERS_ENABLED: 'true',
      STEM_REMINDERS_CHANNEL_ID: '9234567890',
      STEM_REMINDERS_CHECK_INTERVAL_MS: '120000',
    });

    expect(config.reminders).toEqual({
      enabled: true,
      channelId: '9234567890',
      checkIntervalMs: 120000,
    });
  });

  it('requires ask credentials, permits any channel by default, and parses its abuse limits', () => {
    expect(() =>
      loadConfig({
        DISCORD_CLIENT_ID: '1234567890',
        DISCORD_GUILD_ID: '2234567890',
        DISCORD_TOKEN: 'test-token',
        STEM_ASK_ENABLED: 'true',
      }),
    ).toThrow(/OPENAI_API_KEY/);

    const unrestrictedConfig = loadConfig({
      DISCORD_CLIENT_ID: '1234567890',
      DISCORD_GUILD_ID: '2234567890',
      DISCORD_TOKEN: 'test-token',
      OPENAI_API_KEY: 'openai-test-key',
      STEM_ASK_ENABLED: 'true',
    });

    expect(unrestrictedConfig.ask).toEqual({
      enabled: true,
      maxQuestionLength: 500,
      userCooldownMs: 30000,
      userDailyLimit: 10,
      globalDailyLimit: 100,
    });

    const config = loadConfig({
      DISCORD_CLIENT_ID: '1234567890',
      DISCORD_GUILD_ID: '2234567890',
      DISCORD_TOKEN: 'test-token',
      OPENAI_API_KEY: 'openai-test-key',
      STEM_ASK_ENABLED: 'true',
      STEM_ASK_MAX_QUESTION_LENGTH: '800',
      STEM_ASK_USER_COOLDOWN_SECONDS: '45',
      STEM_ASK_USER_DAILY_LIMIT: '12',
      STEM_ASK_GLOBAL_DAILY_LIMIT: '250',
    });

    expect(config.ask).toEqual({
      enabled: true,
      maxQuestionLength: 800,
      userCooldownMs: 45000,
      userDailyLimit: 12,
      globalDailyLimit: 250,
    });
  });

  it('parses Word Reveal, Code Fix and the authenticated chat bridge settings', () => {
    const config = loadConfig({
      DISCORD_CLIENT_ID: '1234567890',
      DISCORD_GUILD_ID: '2234567890',
      DISCORD_TOKEN: 'test-token',
      OPENAI_API_KEY: 'openai-test-key',
      STEM_WORD_REVEAL_ENABLED: 'true',
      STEM_WORD_REVEAL_CHANNEL_ID: '3234567890',
      STEM_WORD_REVEAL_TOPIC: 'space science',
      STEM_WORD_REVEAL_DIFFICULTY: 'standard',
      STEM_WORD_REVEAL_TARGET_AGE_MIN: '10',
      STEM_WORD_REVEAL_TARGET_AGE_MAX: '16',
      STEM_WORD_REVEAL_MAX_WRONG_GUESSES: '6',
      STEM_WORD_REVEAL_RETRY_INTERVAL_MS: '60000',
      STEM_WORD_REVEAL_IDLE_TIMEOUT_MS: '120000',
      STEM_CODE_FIX_ENABLED: 'true',
      STEM_CODE_FIX_CHANNEL_ID: '4234567890',
      STEM_CODE_FIX_DIFFICULTY: 'advanced',
      STEM_CODE_FIX_TOPIC: 'robotics code',
      STEM_CODE_FIX_TARGET_AGE_MIN: '12',
      STEM_CODE_FIX_TARGET_AGE_MAX: '18',
      STEM_CODE_FIX_MAX_WRONG_ANSWERS: '4',
      STEM_CODE_FIX_RETRY_INTERVAL_MS: '90000',
      STEM_CODE_FIX_IDLE_TIMEOUT_MS: '180000',
      CHAT_DISCORD_BRIDGE_ENABLED: 'true',
      CHAT_DISCORD_BRIDGE_HOST: '127.0.0.1',
      CHAT_DISCORD_BRIDGE_PORT: '18080',
      CHAT_DISCORD_BRIDGE_PATH: '/bridge/minecraft',
      CHAT_DISCORD_BRIDGE_BEARER_TOKEN: 'bridge-token',
      CHAT_DISCORD_BRIDGE_CHANNEL_ID: '5234567890',
      CHAT_DISCORD_BRIDGE_MAX_BODY_BYTES: '100000',
    });

    expect(config.wordReveal).toEqual({
      enabled: true,
      channelId: '3234567890',
      retryIntervalMs: 60000,
      topic: 'space science',
      difficulty: 'standard',
      targetAgeMin: 10,
      targetAgeMax: 16,
      maxWrongGuesses: 6,
      idleTimeoutMs: 120000,
    });
    expect(config.codeFix).toEqual({
      enabled: true,
      channelId: '4234567890',
      retryIntervalMs: 90000,
      difficulty: 'advanced',
      topic: 'robotics code',
      targetAgeMin: 12,
      targetAgeMax: 18,
      maxWrongAnswers: 4,
      idleTimeoutMs: 180000,
    });
    expect(config.chatDiscordBridge).toEqual({
      enabled: true,
      host: '127.0.0.1',
      port: 18080,
      path: '/bridge/minecraft',
      bearerToken: 'bridge-token',
      channelId: '5234567890',
      maxBodyBytes: 100000,
    });
  });

  it('accepts the STEM Mystery Lab environment names', () => {
    const config = loadConfig({
      DISCORD_CLIENT_ID: '1234567890',
      DISCORD_GUILD_ID: '2234567890',
      DISCORD_TOKEN: 'test-token',
      OPENAI_API_KEY: 'openai-test-key',
      STEM_MYSTERY_LAB_ENABLED: 'true',
      STEM_MYSTERY_LAB_CHANNEL_ID: '3234567890',
      STEM_MYSTERY_LAB_TOPIC: 'space science',
      STEM_MYSTERY_LAB_DIFFICULTY: 'challenging',
      STEM_MYSTERY_LAB_TARGET_AGE_MIN: '10',
      STEM_MYSTERY_LAB_TARGET_AGE_MAX: '16',
      STEM_MYSTERY_LAB_MAX_WRONG_GUESSES: '6',
      STEM_MYSTERY_LAB_RETRY_INTERVAL_MS: '60000',
      STEM_MYSTERY_LAB_IDLE_TIMEOUT_MS: '120000',
    });

    expect(config.wordReveal).toEqual({
      enabled: true,
      channelId: '3234567890',
      retryIntervalMs: 60000,
      topic: 'space science',
      difficulty: 'challenging',
      targetAgeMin: 10,
      targetAgeMax: 16,
      maxWrongGuesses: 6,
      idleTimeoutMs: 120000,
    });
  });
});
