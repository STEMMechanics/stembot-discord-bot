import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';

import { buildCakeDayCard, buildCakeDayCardSvg } from '../src/discord/cake-day-card.js';
import {
  getCakeDayMessage,
  getCakeDayYears,
  getZonedDateParts,
  PersistentCakeDayService,
  type CakeDayConfig,
  type CakeDayMember,
} from '../src/services/cake-days.js';
import type { JsonState, StateStore } from '../src/state/state-store.js';

const logger = pino({ level: 'silent' });
const config: CakeDayConfig = {
  enabled: true,
  announcementChannelId: 'cake-day-channel',
  checkIntervalMs: 60_000,
  hour: 8,
};
const cakeDayMorning = new Date('2026-10-23T22:00:00.000Z');

class MemoryStateStore implements StateStore<JsonState> {
  public state: JsonState = {};

  public async load(): Promise<JsonState> {
    return this.state;
  }

  public async save(state: JsonState): Promise<void> {
    this.state = state;
  }
}

function member(overrides: Partial<CakeDayMember> = {}): CakeDayMember {
  return {
    id: 'user-1',
    username: 'alex',
    displayName: 'Alex',
    bot: false,
    joinedAt: new Date('2025-10-23T22:00:00.000Z'),
    ...overrides,
  };
}

describe('persistent cake-day announcements', () => {
  it('announces current human members once and persists the daily marker', async () => {
    const state = new MemoryStateStore();
    const send = vi.fn().mockResolvedValue(undefined);
    const service = new PersistentCakeDayService({
      config,
      timeZone: 'Australia/Brisbane',
      state,
      logger,
      clock: () => cakeDayMorning,
      memberProvider: {
        getMembers: vi
          .fn()
          .mockResolvedValue([
            member(),
            member({ id: 'bot-1', bot: true }),
            member({ id: 'not-today', joinedAt: new Date('2025-10-24T22:00:00.000Z') }),
          ]),
      },
      publisher: { send },
    });

    await service.check();
    await service.check();

    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith({
      channelId: 'cake-day-channel',
      memberId: 'user-1',
      displayName: 'Alex',
      years: 1,
      avatarUrl: undefined,
      content: getCakeDayMessage('user-1', 1),
      allowedUserIds: ['user-1'],
    });
    expect(state.state).toMatchObject({
      cakeDays: {
        version: 1,
        date: '2026-10-24',
        announcedUserIds: ['user-1'],
      },
    });
  });

  it('does not query members outside the configured local hour', async () => {
    const getMembers = vi.fn().mockResolvedValue([member()]);
    const service = new PersistentCakeDayService({
      config,
      timeZone: 'Australia/Brisbane',
      state: new MemoryStateStore(),
      logger,
      clock: () => new Date('2026-10-24T00:00:00.000Z'),
      memberProvider: { getMembers },
      publisher: { send: vi.fn().mockResolvedValue(undefined) },
    });

    await service.check();

    expect(getMembers).not.toHaveBeenCalled();
  });

  it('retries a member when Discord rejects the first announcement', async () => {
    const state = new MemoryStateStore();
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error('Discord unavailable'))
      .mockResolvedValueOnce(undefined);
    const service = new PersistentCakeDayService({
      config,
      timeZone: 'Australia/Brisbane',
      state,
      logger,
      clock: () => cakeDayMorning,
      memberProvider: { getMembers: vi.fn().mockResolvedValue([member()]) },
      publisher: { send },
    });

    await service.check();
    await service.check();

    expect(send).toHaveBeenCalledTimes(2);
    expect(state.state).toMatchObject({ cakeDays: { announcedUserIds: ['user-1'] } });
  });
});

describe('cake-day dates and cards', () => {
  it('treats February 28 as the anniversary for a February 29 join date in non-leap years', () => {
    const today = {
      year: 2025,
      month: 2,
      day: 28,
      hour: 8,
    };

    expect(getCakeDayYears(new Date('2024-02-28T14:00:00.000Z'), today, 'Australia/Brisbane')).toBe(
      1,
    );
  });

  it('renders the approved cake-day card with the bundled runtime font', async () => {
    const svg = buildCakeDayCardSvg({ displayName: 'Alex', years: 1 });
    const png = await buildCakeDayCard({ displayName: 'Alex', years: 1 });

    expect(svg).toContain('HAPPY CAKE DAY!');
    expect(svg).toContain('Alex');
    expect(svg).toContain('1 YEAR IN THE STEMMECHANICS COMMUNITY');
    expect(svg).toContain('DejaVu Sans, sans-serif');
    expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  });

  it('uses the configured timezone when deriving the local date', () => {
    expect(getZonedDateParts(cakeDayMorning, 'Australia/Brisbane')).toEqual({
      year: 2026,
      month: 10,
      day: 24,
      hour: 8,
    });
  });
});
