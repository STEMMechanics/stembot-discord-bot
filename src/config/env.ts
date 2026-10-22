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

const environmentSchema = z.object({
  DISCORD_TOKEN: z.string().trim().min(1, 'is required'),
  DISCORD_CLIENT_ID: z.string().trim().regex(/^\d+$/, 'must be a Discord application ID'),
  DISCORD_GUILD_ID: optionalDiscordId,
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
  WORKSHOP_TIME_ZONE: z.string().trim().min(1).default('Australia/Brisbane'),
  WORKSHOP_ANNOUNCEMENTS_ENABLED: booleanFromEnvironment(true),
  WORKSHOP_REMINDERS_ENABLED: booleanFromEnvironment(true),
  WORKSHOP_REMINDER_24H_ENABLED: booleanFromEnvironment(true),
  WORKSHOP_REMINDER_1H_ENABLED: booleanFromEnvironment(true),
  WORKSHOP_ANNOUNCE_INITIAL_SYNC: booleanFromEnvironment(false),
  STREAMING_NOTIFICATIONS_ENABLED: booleanFromEnvironment(false),
  DISCORD_WORKSHOP_ANNOUNCEMENT_CHANNEL_ID: optionalDiscordId,
  DISCORD_WORKSHOP_REMINDER_CHANNEL_ID: optionalDiscordId,
  DISCORD_STREAMING_NOTIFICATION_CHANNEL_ID: optionalDiscordId,
});

export type AppEnvironment = (typeof ENVIRONMENTS)[number];
export type LogLevel = (typeof LOG_LEVELS)[number];

export interface AppConfig {
  environment: AppEnvironment;
  logLevel: LogLevel;
  discord: {
    token: string;
    clientId: string;
    guildId?: string;
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
  workshops: {
    timeZone: string;
    pollIntervalMs: number;
    announcementsEnabled: boolean;
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
      ...(values.DISCORD_GUILD_ID ? { guildId: values.DISCORD_GUILD_ID } : {}),
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
    workshops: {
      timeZone: values.WORKSHOP_TIME_ZONE,
      pollIntervalMs: values.WORKSHOP_POLL_INTERVAL_MS,
      announcementsEnabled: values.WORKSHOP_ANNOUNCEMENTS_ENABLED,
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
