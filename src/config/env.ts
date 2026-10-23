import 'dotenv/config';

import { z } from 'zod';

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'] as const;
const ENVIRONMENTS = ['development', 'test', 'production'] as const;

const optionalDiscordId = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z.string().trim().regex(/^\d+$/, 'must be a Discord ID').optional(),
);

const optionalSecret = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z.string().trim().min(1).optional(),
);

function booleanFromEnvironment(defaultValue: boolean) {
  return z.preprocess((value) => {
    if (value === undefined || value === '') {
      return defaultValue;
    }

    if (typeof value === 'boolean') {
      return value;
    }

    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (['1', 'true', 'yes', 'on'].includes(normalized)) {
        return true;
      }

      if (['0', 'false', 'no', 'off'].includes(normalized)) {
        return false;
      }
    }

    return value;
  }, z.boolean());
}

function positiveMilliseconds(defaultValue: number, maximum: number) {
  return z.preprocess(
    (value) => (value === undefined || value === '' ? defaultValue : value),
    z.coerce.number().int().positive().max(maximum),
  );
}

function optionalPositiveMilliseconds(maximum: number) {
  return z.preprocess(
    (value) => (value === undefined || value === '' ? undefined : value),
    z.coerce.number().int().positive().max(maximum).optional(),
  );
}

function optionalNonNegativeInteger(maximum: number) {
  return z.preprocess(
    (value) => (value === undefined || value === '' ? undefined : value),
    z.coerce.number().int().min(0).max(maximum).optional(),
  );
}

function positiveInteger(defaultValue: number, maximum: number) {
  return z.preprocess(
    (value) => (value === undefined || value === '' ? defaultValue : value),
    z.coerce.number().int().positive().max(maximum),
  );
}

const environmentSchema = z.object({
  DISCORD_TOKEN: z.string().trim().min(1, 'is required'),
  DISCORD_CLIENT_ID: z.string().trim().regex(/^\d+$/, 'must be a Discord application ID'),
  DISCORD_GUILD_ID: z.string().trim().regex(/^\d+$/, 'must be a Discord guild ID'),
  NODE_ENV: z.enum(ENVIRONMENTS).default('production'),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
  STATE_PATH: z.string().trim().min(1).default('./data/state.json'),
  SHUTDOWN_TIMEOUT_MS: positiveMilliseconds(30000, 120000),
  WORKSHOP_FEED_URL: z
    .string()
    .trim()
    .url()
    .default('https://www.stemmechanics.com.au/workshops/feed'),
  WEBSITE_REQUEST_TIMEOUT_MS: positiveMilliseconds(15000, 120000),
  WORKSHOP_POLL_INTERVAL_MS: positiveMilliseconds(300000, 86400000),
  STEMCRAFT_STATUS_URL: z.string().trim().url().default('http://play.stemcraft.com.au:8950/status'),
  STEMCRAFT_STATUS_TOKEN: optionalSecret,
  STEMCRAFT_REQUEST_TIMEOUT_MS: positiveMilliseconds(5000, 120000),
  OPENAI_API_KEY: optionalSecret,
  OPENAI_MODEL: z.string().trim().min(1).default('gpt-6-luna'),
  OPENAI_REASONING_EFFORT: z.string().trim().min(1).default('low'),
  OPENAI_TIMEOUT: positiveInteger(180, 600),
  WORKSHOP_TIME_ZONE: z.string().trim().min(1).default('Australia/Brisbane'),
  WORKSHOP_ANNOUNCEMENTS_ENABLED: booleanFromEnvironment(true),
  WORKSHOP_ANNOUNCEMENT_WINDOW_DAYS: positiveInteger(28, 3650),
  WORKSHOP_ANNOUNCEMENT_DELAY_MINUTES: optionalNonNegativeInteger(1440),
  WORKSHOP_ANNOUNCEMENT_DELAY_MS: optionalPositiveMilliseconds(86400000),
  WORKSHOP_REMINDERS_ENABLED: booleanFromEnvironment(true),
  WORKSHOP_REMINDER_24H_ENABLED: booleanFromEnvironment(true),
  WORKSHOP_REMINDER_1H_ENABLED: booleanFromEnvironment(true),
  WORKSHOP_ANNOUNCE_INITIAL_SYNC: booleanFromEnvironment(false),
  STREAMING_NOTIFICATIONS_ENABLED: booleanFromEnvironment(false),
  DISCORD_WORKSHOP_ANNOUNCEMENT_CHANNEL_ID: optionalDiscordId,
  DISCORD_WORKSHOP_REMINDER_CHANNEL_ID: optionalDiscordId,
  DISCORD_STREAMING_NOTIFICATION_CHANNEL_ID: optionalDiscordId,
  COUNTING_CHAIN_ENABLED: booleanFromEnvironment(false),
  COUNTING_CHAIN_CHANNEL_ID: optionalDiscordId,
  COUNTING_CHAIN_INFO_CHANNEL_ID: optionalDiscordId,
  COUNTING_CHAIN_INFO_MESSAGE_ID: optionalDiscordId,
  COUNTING_CHAIN_REVIEW_ENABLED: booleanFromEnvironment(false),
  COUNTING_CHAIN_REVIEW_ROLE_ID: optionalDiscordId,
  COUNTING_CHAIN_MAX_ATTACHMENT_BYTES: positiveInteger(8 * 1024 * 1024, 20 * 1024 * 1024),
  STEM_QUIZ_ENABLED: booleanFromEnvironment(false),
  STEM_QUIZ_CHANNEL_ID: optionalDiscordId,
  STEM_QUIZ_MAX_WRONG_ANSWERS: positiveInteger(5, 50),
  STEM_QUIZ_TARGET_AGE_MIN: positiveInteger(8, 18),
  STEM_QUIZ_TARGET_AGE_MAX: positiveInteger(14, 18),
  STEM_QUIZ_OLDER_AGE_MAX: positiveInteger(18, 18),
  STEM_QUIZ_OLDER_PLAYER_RATE: z.preprocess(
    (value) => (value === undefined || value === '' ? 0.15 : value),
    z.coerce.number().min(0).max(1),
  ),
  STEM_QUIZ_TOPIC: z
    .string()
    .trim()
    .min(1)
    .default(
      'a balanced mix of science, technology, engineering, mathematics, space, nature, robotics and computing',
    ),
  STEM_QUIZ_RETRY_INTERVAL_MS: positiveMilliseconds(300000, 86400000),
  STEM_SCRAMBLE_ENABLED: booleanFromEnvironment(false),
  STEM_SCRAMBLE_CHANNEL_ID: optionalDiscordId,
  STEM_SCRAMBLE_RETRY_INTERVAL_MS: positiveMilliseconds(300000, 86400000),
  STEM_SCRAMBLE_TARGET_AGE_MIN: positiveInteger(8, 18),
  STEM_SCRAMBLE_TARGET_AGE_MAX: positiveInteger(14, 18),
  STEM_SCRAMBLE_TOPIC: z
    .string()
    .trim()
    .min(1)
    .default(
      'a balanced mix of science, technology, engineering, mathematics, space, nature, robotics and computing',
    ),
  STEM_LEVELS_ENABLED: booleanFromEnvironment(false),
  STEM_LEVELS_ANNOUNCEMENT_CHANNEL_ID: optionalDiscordId,
  STEM_LEVELS_MESSAGE_XP: positiveInteger(5, 100),
  STEM_LEVELS_REACTION_XP: positiveInteger(2, 100),
  STEM_LEVELS_GAME_XP: positiveInteger(15, 500),
  STEM_LEVELS_MESSAGE_COOLDOWN_SECONDS: positiveInteger(60, 86400),
  STEM_LEVELS_REACTION_COOLDOWN_SECONDS: positiveInteger(30, 86400),
});

export type AppEnvironment = (typeof ENVIRONMENTS)[number];
export type LogLevel = (typeof LOG_LEVELS)[number];

export interface AppConfig {
  environment: AppEnvironment;
  logLevel: LogLevel;
  discord: {
    token: string;
    clientId: string;
    guildId: string;
  };
  website: {
    feedUrl: string;
    requestTimeoutMs: number;
  };
  stemcraft: {
    statusUrl: string;
    requestTimeoutMs: number;
    token?: string;
  };
  openai: {
    apiKey?: string;
    model: string;
    reasoningEffort: string;
    timeoutMs: number;
  };
  countingChain: {
    enabled: boolean;
    channelId?: string;
    infoChannelId?: string;
    infoMessageId?: string;
    reviewEnabled: boolean;
    reviewRoleId?: string;
    maxAttachmentBytes: number;
  };
  quiz: {
    enabled: boolean;
    channelId?: string;
    maxWrongAnswers: number;
    targetAgeMin: number;
    targetAgeMax: number;
    olderAgeMax: number;
    olderPlayerRate: number;
    topic: string;
    retryIntervalMs: number;
  };
  scramble: {
    enabled: boolean;
    channelId?: string;
    retryIntervalMs: number;
    topic: string;
    targetAgeMin: number;
    targetAgeMax: number;
  };
  levels: {
    enabled: boolean;
    announcementChannelId?: string;
    messageXp: number;
    reactionXp: number;
    gameXp: number;
    messageCooldownMs: number;
    reactionCooldownMs: number;
  };
  workshops: {
    timeZone: string;
    pollIntervalMs: number;
    announcementsEnabled: boolean;
    announcementWindowMs: number;
    announcementDelayMs: number;
    remindersEnabled: boolean;
    reminder24HoursEnabled: boolean;
    reminder1HourEnabled: boolean;
    announceInitialSync: boolean;
    announcementChannelId?: string;
    reminderChannelId?: string;
  };
  streaming: {
    notificationsEnabled: boolean;
    channelId?: string;
  };
  statePath: string;
  shutdownTimeoutMs: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const result = environmentSchema.safeParse(env);

  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join('.') || 'configuration'} ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid environment configuration: ${details}`);
  }

  const values = result.data;
  const announcementWindowMs = values.WORKSHOP_ANNOUNCEMENT_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const announcementDelayMs =
    values.WORKSHOP_ANNOUNCEMENT_DELAY_MINUTES !== undefined
      ? values.WORKSHOP_ANNOUNCEMENT_DELAY_MINUTES * 60_000
      : (values.WORKSHOP_ANNOUNCEMENT_DELAY_MS ?? 1_800_000);

  if (values.COUNTING_CHAIN_ENABLED && !values.COUNTING_CHAIN_CHANNEL_ID) {
    throw new Error('COUNTING_CHAIN_CHANNEL_ID is required when COUNTING_CHAIN_ENABLED is true');
  }

  if (values.COUNTING_CHAIN_ENABLED && !values.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is required when COUNTING_CHAIN_ENABLED is true');
  }

  if (values.COUNTING_CHAIN_REVIEW_ENABLED && !values.COUNTING_CHAIN_REVIEW_ROLE_ID) {
    throw new Error(
      'COUNTING_CHAIN_REVIEW_ROLE_ID is required when COUNTING_CHAIN_REVIEW_ENABLED is true',
    );
  }

  if (values.COUNTING_CHAIN_INFO_MESSAGE_ID && !values.COUNTING_CHAIN_INFO_CHANNEL_ID) {
    throw new Error(
      'COUNTING_CHAIN_INFO_CHANNEL_ID is required when COUNTING_CHAIN_INFO_MESSAGE_ID is set',
    );
  }

  if (values.STEM_QUIZ_ENABLED && !values.STEM_QUIZ_CHANNEL_ID) {
    throw new Error('STEM_QUIZ_CHANNEL_ID is required when STEM_QUIZ_ENABLED is true');
  }

  if (values.STEM_QUIZ_ENABLED && !values.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is required when STEM_QUIZ_ENABLED is true');
  }

  if (values.STEM_QUIZ_TARGET_AGE_MIN > values.STEM_QUIZ_TARGET_AGE_MAX) {
    throw new Error('STEM_QUIZ_TARGET_AGE_MIN cannot be greater than STEM_QUIZ_TARGET_AGE_MAX');
  }

  if (values.STEM_QUIZ_TARGET_AGE_MAX > values.STEM_QUIZ_OLDER_AGE_MAX) {
    throw new Error('STEM_QUIZ_TARGET_AGE_MAX cannot be greater than STEM_QUIZ_OLDER_AGE_MAX');
  }

  if (values.STEM_SCRAMBLE_ENABLED && !values.STEM_SCRAMBLE_CHANNEL_ID) {
    throw new Error('STEM_SCRAMBLE_CHANNEL_ID is required when STEM_SCRAMBLE_ENABLED is true');
  }

  if (values.STEM_SCRAMBLE_ENABLED && !values.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is required when STEM_SCRAMBLE_ENABLED is true');
  }

  if (values.STEM_SCRAMBLE_TARGET_AGE_MIN > values.STEM_SCRAMBLE_TARGET_AGE_MAX) {
    throw new Error(
      'STEM_SCRAMBLE_TARGET_AGE_MIN cannot be greater than STEM_SCRAMBLE_TARGET_AGE_MAX',
    );
  }

  try {
    new Intl.DateTimeFormat('en-AU', { timeZone: values.WORKSHOP_TIME_ZONE }).format();
  } catch (error: unknown) {
    throw new Error(`Invalid WORKSHOP_TIME_ZONE: ${values.WORKSHOP_TIME_ZONE}`, {
      cause: error,
    });
  }

  return {
    environment: values.NODE_ENV,
    logLevel: values.LOG_LEVEL,
    discord: {
      token: values.DISCORD_TOKEN,
      clientId: values.DISCORD_CLIENT_ID,
      guildId: values.DISCORD_GUILD_ID,
    },
    website: {
      feedUrl: values.WORKSHOP_FEED_URL,
      requestTimeoutMs: values.WEBSITE_REQUEST_TIMEOUT_MS,
    },
    stemcraft: {
      statusUrl: values.STEMCRAFT_STATUS_URL,
      requestTimeoutMs: values.STEMCRAFT_REQUEST_TIMEOUT_MS,
      ...(values.STEMCRAFT_STATUS_TOKEN ? { token: values.STEMCRAFT_STATUS_TOKEN } : {}),
    },
    openai: {
      ...(values.OPENAI_API_KEY ? { apiKey: values.OPENAI_API_KEY } : {}),
      model: values.OPENAI_MODEL,
      reasoningEffort: values.OPENAI_REASONING_EFFORT,
      timeoutMs: values.OPENAI_TIMEOUT * 1000,
    },
    countingChain: {
      enabled: values.COUNTING_CHAIN_ENABLED,
      ...(values.COUNTING_CHAIN_CHANNEL_ID ? { channelId: values.COUNTING_CHAIN_CHANNEL_ID } : {}),
      ...(values.COUNTING_CHAIN_INFO_CHANNEL_ID
        ? { infoChannelId: values.COUNTING_CHAIN_INFO_CHANNEL_ID }
        : {}),
      ...(values.COUNTING_CHAIN_INFO_MESSAGE_ID
        ? { infoMessageId: values.COUNTING_CHAIN_INFO_MESSAGE_ID }
        : {}),
      reviewEnabled: values.COUNTING_CHAIN_REVIEW_ENABLED,
      ...(values.COUNTING_CHAIN_REVIEW_ROLE_ID
        ? { reviewRoleId: values.COUNTING_CHAIN_REVIEW_ROLE_ID }
        : {}),
      maxAttachmentBytes: values.COUNTING_CHAIN_MAX_ATTACHMENT_BYTES,
    },
    quiz: {
      enabled: values.STEM_QUIZ_ENABLED,
      ...(values.STEM_QUIZ_CHANNEL_ID ? { channelId: values.STEM_QUIZ_CHANNEL_ID } : {}),
      maxWrongAnswers: values.STEM_QUIZ_MAX_WRONG_ANSWERS,
      targetAgeMin: values.STEM_QUIZ_TARGET_AGE_MIN,
      targetAgeMax: values.STEM_QUIZ_TARGET_AGE_MAX,
      olderAgeMax: values.STEM_QUIZ_OLDER_AGE_MAX,
      olderPlayerRate: values.STEM_QUIZ_OLDER_PLAYER_RATE,
      topic: values.STEM_QUIZ_TOPIC,
      retryIntervalMs: values.STEM_QUIZ_RETRY_INTERVAL_MS,
    },
    scramble: {
      enabled: values.STEM_SCRAMBLE_ENABLED,
      ...(values.STEM_SCRAMBLE_CHANNEL_ID ? { channelId: values.STEM_SCRAMBLE_CHANNEL_ID } : {}),
      retryIntervalMs: values.STEM_SCRAMBLE_RETRY_INTERVAL_MS,
      topic: values.STEM_SCRAMBLE_TOPIC,
      targetAgeMin: values.STEM_SCRAMBLE_TARGET_AGE_MIN,
      targetAgeMax: values.STEM_SCRAMBLE_TARGET_AGE_MAX,
    },
    levels: {
      enabled: values.STEM_LEVELS_ENABLED,
      ...(values.STEM_LEVELS_ANNOUNCEMENT_CHANNEL_ID
        ? { announcementChannelId: values.STEM_LEVELS_ANNOUNCEMENT_CHANNEL_ID }
        : {}),
      messageXp: values.STEM_LEVELS_MESSAGE_XP,
      reactionXp: values.STEM_LEVELS_REACTION_XP,
      gameXp: values.STEM_LEVELS_GAME_XP,
      messageCooldownMs: values.STEM_LEVELS_MESSAGE_COOLDOWN_SECONDS * 1000,
      reactionCooldownMs: values.STEM_LEVELS_REACTION_COOLDOWN_SECONDS * 1000,
    },
    workshops: {
      timeZone: values.WORKSHOP_TIME_ZONE,
      pollIntervalMs: values.WORKSHOP_POLL_INTERVAL_MS,
      announcementsEnabled: values.WORKSHOP_ANNOUNCEMENTS_ENABLED,
      announcementWindowMs,
      announcementDelayMs,
      remindersEnabled: values.WORKSHOP_REMINDERS_ENABLED,
      reminder24HoursEnabled: values.WORKSHOP_REMINDER_24H_ENABLED,
      reminder1HourEnabled: values.WORKSHOP_REMINDER_1H_ENABLED,
      announceInitialSync: values.WORKSHOP_ANNOUNCE_INITIAL_SYNC,
      ...(values.DISCORD_WORKSHOP_ANNOUNCEMENT_CHANNEL_ID
        ? { announcementChannelId: values.DISCORD_WORKSHOP_ANNOUNCEMENT_CHANNEL_ID }
        : {}),
      ...(values.DISCORD_WORKSHOP_REMINDER_CHANNEL_ID
        ? { reminderChannelId: values.DISCORD_WORKSHOP_REMINDER_CHANNEL_ID }
        : {}),
    },
    streaming: {
      notificationsEnabled: values.STREAMING_NOTIFICATIONS_ENABLED,
      ...(values.DISCORD_STREAMING_NOTIFICATION_CHANNEL_ID
        ? { channelId: values.DISCORD_STREAMING_NOTIFICATION_CHANNEL_ID }
        : {}),
    },
    statePath: values.STATE_PATH,
    shutdownTimeoutMs: values.SHUTDOWN_TIMEOUT_MS,
  };
}
