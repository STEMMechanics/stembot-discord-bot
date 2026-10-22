import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';

import {
  formatWorkshopAnnouncement,
  PersistentWorkshopNotificationService,
  type WorkshopNotificationConfig,
} from '../src/services/workshop-notifications.js';
import type { DiscordChannelMessage } from '../src/discord/client.js';
import type { JsonState, StateStore } from '../src/state/state-store.js';
import type { WebsiteIntegration, WorkshopRecord } from '../src/integrations/website.js';

const logger = pino({ level: 'silent' });
const now = new Date('2026-10-22T00:00:00.000Z');
type SendChannelPayload = (
  channelId: string,
  message: string | DiscordChannelMessage,
) => Promise<string>;

const config: WorkshopNotificationConfig = {
  timeZone: 'Australia/Brisbane',
  announcementsEnabled: true,
  announcementWindowMs: 28 * 24 * 60 * 60 * 1000,
  announcementDelayMs: 0,
  remindersEnabled: true,
  reminder24HoursEnabled: true,
  reminder1HourEnabled: true,
  announceInitialSync: true,
  announcementChannelId: 'announcement-channel',
  reminderChannelId: 'reminder-channel',
};

class MemoryStateStore implements StateStore<JsonState> {
  public state: JsonState = {};

  public async load(): Promise<JsonState> {
    return this.state;
  }

  public async save(state: JsonState): Promise<void> {
    this.state = state;
  }
}

function workshop(overrides: Partial<WorkshopRecord> = {}): WorkshopRecord {
  return {
    externalId: 'redstone-1',
    title: 'Redstone Music Challenge',
    startsAt: new Date('2026-10-24T06:00:00.000Z'),
    endsAt: new Date('2026-10-24T07:00:00.000Z'),
    url: 'https://example.test/workshops/redstone',
    imageUrl: 'https://www.stemmechanics.com.au/media/download/redstone.png?md',
    location: 'STEMCraft',
    status: 'open',
    statusCode: 'open',
    ...overrides,
  };
}

function createService(
  website: WebsiteIntegration,
  state: MemoryStateStore,
  sendChannelMessage: SendChannelPayload,
  serviceConfig: WorkshopNotificationConfig = config,
  clock: () => Date = () => now,
): PersistentWorkshopNotificationService {
  return new PersistentWorkshopNotificationService({
    website,
    discord: { sendChannelMessage },
    state,
    logger,
    config: serviceConfig,
    clock,
  });
}

describe('persistent workshop notifications', () => {
  it('delays announcements and uses changes received during the delay window', async () => {
    let currentWorkshop = workshop();
    let currentTime = new Date(now);
    const website: WebsiteIntegration = {
      getWorkshops: vi.fn().mockImplementation(() => Promise.resolve([currentWorkshop])),
    };
    const state = new MemoryStateStore();
    const sendChannelMessage = vi.fn<SendChannelPayload>().mockResolvedValue('message-1');
    const delayedConfig = { ...config, announcementDelayMs: 30 * 60 * 1000 };
    const clock = () => new Date(currentTime);

    await createService(
      website,
      state,
      sendChannelMessage,
      delayedConfig,
      clock,
    ).synchronizeWorkshops();
    expect(sendChannelMessage).not.toHaveBeenCalled();

    currentWorkshop = workshop({ title: 'Updated Before Announcement' });
    await createService(
      website,
      state,
      sendChannelMessage,
      delayedConfig,
      clock,
    ).synchronizeWorkshops();
    expect(sendChannelMessage).not.toHaveBeenCalled();

    currentTime = new Date(now.getTime() + 30 * 60 * 1000);
    await createService(
      website,
      state,
      sendChannelMessage,
      delayedConfig,
      clock,
    ).synchronizeWorkshops();

    expect(sendChannelMessage).toHaveBeenCalledTimes(1);
    expect(sendChannelMessage.mock.calls[0]?.[1]).toMatchObject({
      content: expect.stringContaining('📣 New: **[Updated Before Announcement]'),
    });
    expect(state.state).toMatchObject({
      workshopNotifications: {
        workshops: {
          'redstone-1': {
            pendingAnnouncement: null,
            pendingAnnouncementAt: null,
          },
        },
      },
    });
  });

  it('waits to announce a workshop until it is within the configured future window', async () => {
    const day = 24 * 60 * 60 * 1000;
    const startsAt = new Date(now.getTime() + 29 * day);
    const workshopToAnnounce = workshop({ startsAt });
    const website: WebsiteIntegration = {
      getWorkshops: vi.fn().mockResolvedValue([workshopToAnnounce]),
    };
    const state = new MemoryStateStore();
    const sendChannelMessage = vi.fn<SendChannelPayload>().mockResolvedValue('message-1');
    let currentTime = new Date(now);
    const clock = () => new Date(currentTime);

    await createService(website, state, sendChannelMessage, config, clock).synchronizeWorkshops();

    expect(sendChannelMessage).not.toHaveBeenCalled();
    expect(state.state).toMatchObject({
      workshopNotifications: {
        workshops: {
          'redstone-1': {
            pendingAnnouncement: null,
            lastAnnouncedFingerprint: null,
          },
        },
      },
    });

    currentTime = new Date(now.getTime() + 2 * day);
    await createService(website, state, sendChannelMessage, config, clock).synchronizeWorkshops();

    expect(sendChannelMessage).toHaveBeenCalledOnce();
    expect(sendChannelMessage.mock.calls[0]?.[1]).toMatchObject({
      content: expect.stringContaining('📣 New: **[Redstone Music Challenge]'),
    });
  });

  it('announces new, updated, and cancelled workshops once across restarts', async () => {
    let currentWorkshop = workshop();
    const website: WebsiteIntegration = {
      getWorkshops: vi.fn().mockImplementation(() => Promise.resolve([currentWorkshop])),
    };
    const state = new MemoryStateStore();
    const sendChannelMessage = vi.fn<SendChannelPayload>().mockResolvedValue('message-1');

    await createService(website, state, sendChannelMessage).synchronizeWorkshops();
    await createService(website, state, sendChannelMessage).synchronizeWorkshops();
    expect(sendChannelMessage).toHaveBeenCalledTimes(1);
    expect(sendChannelMessage.mock.calls[0]?.[1]).toMatchObject({
      content: expect.stringContaining('📣 New: **[Redstone Music Challenge]'),
      heroImageUrl: 'https://www.stemmechanics.com.au/media/download/redstone.png',
    });

    currentWorkshop = workshop({ title: 'Updated Redstone Music Challenge' });
    await createService(website, state, sendChannelMessage).synchronizeWorkshops();
    expect(sendChannelMessage).toHaveBeenCalledTimes(2);
    expect(sendChannelMessage.mock.calls[1]?.[1]).toMatchObject({
      content: expect.stringContaining('✏️ Updated: **[Updated Redstone Music Challenge]'),
    });

    currentWorkshop = workshop({
      status: 'open',
      statusCode: 'cancelled',
      title: 'Updated Redstone Music Challenge',
    });
    await createService(website, state, sendChannelMessage).synchronizeWorkshops();
    expect(sendChannelMessage).toHaveBeenCalledTimes(3);
    expect(sendChannelMessage.mock.calls[2]?.[1]).toMatchObject({
      content: expect.stringContaining('❌ Cancelled: **[Updated Redstone Music Challenge]'),
    });

    await createService(website, state, sendChannelMessage).synchronizeWorkshops();
    expect(sendChannelMessage).toHaveBeenCalledTimes(3);
  });

  it('includes the registration call to action in announcement messages', () => {
    const message = formatWorkshopAnnouncement(
      workshop({
        description:
          '<p>Can you use redstone to turn Minecraft into a musical instrument?Throughout October, jump into the challenge.</p><p><strong>Try different designs.</strong></p><h2>Learning Outcomes</h2><ul><li>Build a redstone circuit.</li></ul>\n\nSat 24 Oct 2026 4:00pm · STEMCraft',
        registrationType: 'interest',
        registrationUrl: 'https://example.test/interest',
      }),
      'new',
      'Australia/Brisbane',
    );

    expect(message.content).toContain(
      '📣 New: **[Redstone Music Challenge](https://example.test/workshops/redstone)**',
    );
    expect(message.content).toContain(
      'Can you use redstone to turn Minecraft into a musical instrument? Throughout October, jump into the challenge.',
    );
    expect(message.content).toContain('**Try different designs.**');
    expect(message.content).toContain('**When:** 24 Oct 2026, 4:00 pm–5:00 pm');
    expect(message.content).toMatch(
      /\n\n(?:Want to be part of it\?|Keen to join us\?|Interested in taking part\?|Want to join in\?|Fancy taking part\?) - \[Register interest\]\(https:\/\/example\.test\/interest\)\n\n/,
    );
    expect(message.content).not.toContain('**Details:**');
    expect(message.content).not.toContain('[Details](');
    expect(message.content).not.toContain('Learning Outcomes');
    expect(message).not.toHaveProperty('embeds');
    expect(message.heroImageUrl).toBe(
      'https://www.stemmechanics.com.au/media/download/redstone.png',
    );
  });

  it('uses a separate booking prompt for ticket registration', () => {
    const message = formatWorkshopAnnouncement(
      workshop({
        registrationType: 'tickets',
        registrationUrl: 'https://example.test/tickets',
      }),
      'new',
      'Australia/Brisbane',
    );

    expect(message.content).toMatch(
      /(?:Don't miss out on this one!|Ready to book your spot\?|Save your spot!|Join us for this one!) - \[Book now\]\(https:\/\/example\.test\/tickets\)/,
    );
  });

  it('sends each due reminder once and persists the marker', async () => {
    const reminderWorkshop = workshop({
      startsAt: new Date('2026-10-22T23:00:00.000Z'),
      endsAt: new Date('2026-10-23T00:00:00.000Z'),
    });
    const website: WebsiteIntegration = {
      getWorkshops: vi.fn().mockResolvedValue([reminderWorkshop]),
    };
    const state = new MemoryStateStore();
    const sendChannelMessage = vi.fn<SendChannelPayload>().mockResolvedValue('message-1');
    const serviceConfig = { ...config, announceInitialSync: false };

    await createService(website, state, sendChannelMessage, serviceConfig).synchronizeWorkshops();
    await createService(website, state, sendChannelMessage, serviceConfig).synchronizeWorkshops();

    expect(
      sendChannelMessage.mock.calls.filter((call) => call[0] === 'reminder-channel'),
    ).toHaveLength(1);
    expect(state.state).toMatchObject({
      workshopNotifications: {
        reminders: { 'redstone-1:24-hours': expect.any(String) },
      },
    });
  });

  it('does not announce the initial feed when initial announcements are disabled', async () => {
    const website: WebsiteIntegration = {
      getWorkshops: vi.fn().mockResolvedValue([workshop()]),
    };
    const state = new MemoryStateStore();
    const sendChannelMessage = vi.fn<SendChannelPayload>().mockResolvedValue('message-1');

    await createService(website, state, sendChannelMessage, {
      ...config,
      announceInitialSync: false,
    }).synchronizeWorkshops();

    expect(sendChannelMessage).not.toHaveBeenCalled();
  });

  it('does not announce already-ended feed items during an initial sync', async () => {
    const website: WebsiteIntegration = {
      getWorkshops: vi.fn().mockResolvedValue([
        workshop({
          startsAt: new Date('2026-10-21T23:00:00.000Z'),
          endsAt: new Date('2026-10-22T00:00:00.000Z'),
        }),
      ]),
    };
    const state = new MemoryStateStore();
    const sendChannelMessage = vi.fn<SendChannelPayload>().mockResolvedValue('message-1');

    await createService(website, state, sendChannelMessage).synchronizeWorkshops();

    expect(sendChannelMessage).not.toHaveBeenCalled();
  });

  it('does not interpret a missing or removed item as a cancellation', async () => {
    let feed: readonly WorkshopRecord[] = [workshop()];
    const website: WebsiteIntegration = {
      getWorkshops: vi.fn().mockImplementation(() => Promise.resolve(feed)),
    };
    const state = new MemoryStateStore();
    const sendChannelMessage = vi.fn<SendChannelPayload>().mockResolvedValue('message-1');

    await createService(website, state, sendChannelMessage).synchronizeWorkshops();
    feed = [];
    await createService(website, state, sendChannelMessage).synchronizeWorkshops();

    expect(sendChannelMessage).toHaveBeenCalledTimes(1);
    expect(state.state).toMatchObject({
      workshopNotifications: {
        workshops: { 'redstone-1': { statusCode: 'open' } },
      },
    });
  });

  it('re-announces a workshop whose local record was removed after initial sync', async () => {
    const website: WebsiteIntegration = {
      getWorkshops: vi.fn().mockResolvedValue([workshop()]),
    };
    const state = new MemoryStateStore();
    const sendChannelMessage = vi.fn<SendChannelPayload>().mockResolvedValue('message-1');

    await createService(website, state, sendChannelMessage).synchronizeWorkshops();
    const notificationState = state.state.workshopNotifications as {
      workshops: Record<string, unknown>;
    };
    delete notificationState.workshops['redstone-1'];

    await createService(website, state, sendChannelMessage).synchronizeWorkshops();

    expect(sendChannelMessage).toHaveBeenCalledTimes(2);
    expect(sendChannelMessage.mock.calls[1]?.[1]).toMatchObject({
      content: expect.stringContaining('📣 New: **[Redstone Music Challenge]'),
    });
  });

  it('processes a cancellation retained after the workshop date', async () => {
    let currentWorkshop = workshop();
    const website: WebsiteIntegration = {
      getWorkshops: vi.fn().mockImplementation(() => Promise.resolve([currentWorkshop])),
    };
    const state = new MemoryStateStore();
    const sendChannelMessage = vi.fn<SendChannelPayload>().mockResolvedValue('message-1');

    await createService(website, state, sendChannelMessage).synchronizeWorkshops();
    currentWorkshop = workshop({
      startsAt: new Date('2026-10-01T06:00:00.000Z'),
      endsAt: new Date('2026-10-01T07:00:00.000Z'),
      status: 'open',
      statusCode: 'cancelled',
    });
    await createService(website, state, sendChannelMessage).synchronizeWorkshops();
    await createService(website, state, sendChannelMessage).synchronizeWorkshops();

    expect(sendChannelMessage).toHaveBeenCalledTimes(2);
    expect(sendChannelMessage.mock.calls[1]?.[1]).toMatchObject({
      content: expect.stringContaining('❌ Cancelled:'),
    });
  });

  it('announces a cancellation even when the original workshop was outside the window', async () => {
    let currentWorkshop = workshop({
      startsAt: new Date(now.getTime() + 60 * 24 * 60 * 60 * 1000),
    });
    const website: WebsiteIntegration = {
      getWorkshops: vi.fn().mockImplementation(() => Promise.resolve([currentWorkshop])),
    };
    const state = new MemoryStateStore();
    const sendChannelMessage = vi.fn<SendChannelPayload>().mockResolvedValue('message-1');

    await createService(website, state, sendChannelMessage).synchronizeWorkshops();
    expect(sendChannelMessage).not.toHaveBeenCalled();

    currentWorkshop = workshop({
      startsAt: new Date(now.getTime() + 60 * 24 * 60 * 60 * 1000),
      statusCode: 'cancelled',
    });
    await createService(website, state, sendChannelMessage).synchronizeWorkshops();

    expect(sendChannelMessage).toHaveBeenCalledOnce();
    expect(sendChannelMessage.mock.calls[0]?.[1]).toMatchObject({
      content: expect.stringContaining('❌ Cancelled:'),
    });
  });
});
