import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';

import {
  createAdminReminderService,
  parseReminderDuration,
} from '../src/services/admin-reminders.js';
import type { JsonState, StateStore } from '../src/state/state-store.js';

const logger = pino({ level: 'silent' });

class MemoryStateStore implements StateStore<JsonState> {
  public state: JsonState = {};

  public async load(): Promise<JsonState> {
    return this.state;
  }

  public async save(state: JsonState): Promise<void> {
    this.state = state;
  }
}

describe('admin reminders', () => {
  it('parses minute and day durations and rejects unsupported values', () => {
    expect(parseReminderDuration('30m')).toBe(1_800_000);
    expect(parseReminderDuration('5d')).toBe(432_000_000);
    expect(parseReminderDuration('5h')).toBeUndefined();
    expect(parseReminderDuration('0m')).toBeUndefined();
    expect(parseReminderDuration('366d')).toBeUndefined();
  });

  it('persists a reminder and mentions its creator when it becomes due', async () => {
    const state = new MemoryStateStore();
    const publisher = { send: vi.fn().mockResolvedValue('reminder-message-1') };
    let now = new Date('2026-10-24T00:00:00.000Z');
    const service = createAdminReminderService({
      config: {
        enabled: true,
        channelId: 'reminders-channel',
        checkIntervalMs: 60000,
      },
      publisher,
      state,
      logger,
      clock: () => now,
      idFactory: () => 'reminder-1',
    });

    const reminder = await service.schedule('moderator-1', 300000, 'post the next challenge');
    expect(reminder.dueAt).toBe('2026-10-24T00:05:00.000Z');
    expect(state.state).toMatchObject({
      adminReminders: { reminders: [{ id: 'reminder-1', authorId: 'moderator-1' }] },
    });

    now = new Date('2026-10-24T00:05:00.000Z');
    await service.deliverDueReminders();

    expect(publisher.send).toHaveBeenCalledWith(
      'reminders-channel',
      '⏰ <@moderator-1> reminder: post the next challenge',
      'moderator-1',
    );
    expect(state.state).toMatchObject({ adminReminders: { reminders: [] } });
  });

  it('keeps a due reminder when the channel send fails', async () => {
    const state = new MemoryStateStore();
    const publisher = { send: vi.fn().mockRejectedValue(new Error('Discord unavailable')) };
    const service = createAdminReminderService({
      config: { enabled: true, channelId: 'reminders-channel', checkIntervalMs: 60000 },
      publisher,
      state,
      logger,
      clock: () => new Date('2026-10-24T00:01:00.000Z'),
      idFactory: () => 'reminder-1',
    });

    await service.schedule('moderator-1', 60_000, 'try again');
    await service.deliverDueReminders();

    expect(state.state).toMatchObject({
      adminReminders: { reminders: [{ id: 'reminder-1', content: 'try again' }] },
    });
  });
});
