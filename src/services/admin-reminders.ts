import { randomUUID } from 'node:crypto';

import type { AppLogger } from '../logging/logger.js';
import type { JsonState, StateStore } from '../state/state-store.js';

export interface AdminReminderConfig {
  enabled: boolean;
  channelId?: string;
  checkIntervalMs: number;
}

export interface AdminReminderPublisher {
  send(channelId: string, content: string, mentionUserId?: string): Promise<string>;
}

export interface AdminReminder {
  id: string;
  authorId: string;
  content: string;
  createdAt: string;
  dueAt: string;
}

export interface AdminReminderService {
  schedule(authorId: string, delayMs: number, content: string): Promise<AdminReminder>;
  deliverDueReminders(): Promise<void>;
}

interface AdminReminderState {
  version: 1;
  reminders: AdminReminder[];
}

interface AdminReminderServiceDependencies {
  config: AdminReminderConfig;
  publisher: AdminReminderPublisher;
  state: StateStore<JsonState>;
  logger: AppLogger;
  clock?: () => Date;
  idFactory?: () => string;
}

const STATE_KEY = 'adminReminders';
const MAX_REMINDER_DELAY_MS = 365 * 24 * 60 * 60 * 1000;
const MAX_PENDING_REMINDERS = 1000;
const MAX_REMINDER_LENGTH = 1800;

export function parseReminderDuration(value: string): number | undefined {
  const match = /^(\d+)([md])$/i.exec(value.trim());
  if (!match) {
    return undefined;
  }

  const amount = Number(match[1]);
  const unit = match[2]?.toLocaleLowerCase();
  const multiplier = unit === 'm' ? 60_000 : unit === 'd' ? 86_400_000 : undefined;
  if (!multiplier || !Number.isSafeInteger(amount) || amount <= 0) {
    return undefined;
  }

  const delayMs = amount * multiplier;
  return Number.isSafeInteger(delayMs) && delayMs <= MAX_REMINDER_DELAY_MS ? delayMs : undefined;
}

export class PersistentAdminReminderService implements AdminReminderService {
  private readonly currentTime: () => Date;
  private readonly idFactory: () => string;
  private eventQueue: Promise<void> = Promise.resolve();

  public constructor(private readonly dependencies: AdminReminderServiceDependencies) {
    this.currentTime = dependencies.clock ?? (() => new Date());
    this.idFactory = dependencies.idFactory ?? randomUUID;
  }

  public async schedule(
    authorId: string,
    delayMs: number,
    content: string,
  ): Promise<AdminReminder> {
    if (!this.isEnabled()) {
      throw new Error('Admin reminders are not enabled');
    }

    if (!Number.isSafeInteger(delayMs) || delayMs <= 0 || delayMs > MAX_REMINDER_DELAY_MS) {
      throw new Error('Reminder duration must be between 1 minute and 365 days');
    }

    const trimmedContent = content.trim();
    if (trimmedContent.length === 0 || trimmedContent.length > MAX_REMINDER_LENGTH) {
      throw new Error(`Reminder text must be between 1 and ${MAX_REMINDER_LENGTH} characters`);
    }

    return this.enqueue(async () => {
      const rootState = await this.dependencies.state.load();
      const state = readAdminReminderState(rootState[STATE_KEY]);
      if (state.reminders.length >= MAX_PENDING_REMINDERS) {
        throw new Error('There are too many pending reminders');
      }

      const now = this.currentTime();
      const reminder: AdminReminder = {
        id: this.idFactory(),
        authorId,
        content: trimmedContent,
        createdAt: now.toISOString(),
        dueAt: new Date(now.getTime() + delayMs).toISOString(),
      };
      state.reminders.push(reminder);
      writeAdminReminderState(rootState, state);
      await this.dependencies.state.save(rootState);
      this.dependencies.logger.info(
        { reminderId: reminder.id, authorId, dueAt: reminder.dueAt },
        'Admin reminder scheduled',
      );
      return reminder;
    });
  }

  public async deliverDueReminders(): Promise<void> {
    if (!this.isEnabled()) {
      return;
    }

    await this.enqueue(async () => {
      const rootState = await this.dependencies.state.load();
      const state = readAdminReminderState(rootState[STATE_KEY]);
      const now = this.currentTime().getTime();
      const due = state.reminders.filter((reminder) => Date.parse(reminder.dueAt) <= now);
      if (due.length === 0) {
        return;
      }

      for (const reminder of due) {
        try {
          await this.dependencies.publisher.send(
            this.dependencies.config.channelId!,
            `⏰ <@${reminder.authorId}> reminder: ${reminder.content}`,
            reminder.authorId,
          );
          state.reminders = state.reminders.filter((candidate) => candidate.id !== reminder.id);
          writeAdminReminderState(rootState, state);
          await this.dependencies.state.save(rootState);
          this.dependencies.logger.info(
            { reminderId: reminder.id, authorId: reminder.authorId },
            'Admin reminder delivered',
          );
        } catch (error: unknown) {
          this.dependencies.logger.warn(
            { err: error, reminderId: reminder.id, authorId: reminder.authorId },
            'Admin reminder could not be delivered; it will be retried',
          );
        }
      }
    });
  }

  private isEnabled(): boolean {
    return this.dependencies.config.enabled && Boolean(this.dependencies.config.channelId);
  }

  private async enqueue<T>(work: () => Promise<T>): Promise<T> {
    const next = this.eventQueue.catch(() => undefined).then(work);
    this.eventQueue = next.then(
      () => undefined,
      () => undefined,
    );
    return await next;
  }
}

export function createAdminReminderService(
  dependencies: AdminReminderServiceDependencies,
): AdminReminderService {
  return new PersistentAdminReminderService(dependencies);
}

function readAdminReminderState(value: unknown): AdminReminderState {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.reminders)) {
    return { version: 1, reminders: [] };
  }

  const reminders = value.reminders
    .filter(isAdminReminder)
    .sort((left, right) => Date.parse(left.dueAt) - Date.parse(right.dueAt))
    .slice(0, MAX_PENDING_REMINDERS);
  return { version: 1, reminders };
}

function isAdminReminder(value: unknown): value is AdminReminder {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.authorId === 'string' &&
    typeof value.content === 'string' &&
    value.content.trim().length > 0 &&
    typeof value.createdAt === 'string' &&
    typeof value.dueAt === 'string' &&
    Number.isFinite(Date.parse(value.createdAt)) &&
    Number.isFinite(Date.parse(value.dueAt))
  );
}

function writeAdminReminderState(rootState: JsonState, state: AdminReminderState): void {
  rootState[STATE_KEY] = state;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
