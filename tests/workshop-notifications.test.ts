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
    imageUrl: 'https://example.test/workshops/redstone.png',
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
): PersistentWorkshopNotificationService {
  return new PersistentWorkshopNotificationService({
    website,
    discord: { sendChannelMessage },
    state,
    logger,
    config: serviceConfig,
    clock: () => now,
  });
}

describe('persistent workshop notifications', () => {
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
      content: expect.stringContaining('New STEMMechanics workshop'),
      embeds: [
        expect.objectContaining({
          title: 'Redstone Music Challenge',
          url: 'https://example.test/workshops/redstone',
        }),
      ],
    });
    expect(sendChannelMessage.mock.calls[0]?.[1]).not.toMatchObject({
      embeds: [expect.objectContaining({ image: expect.anything() })],
    });

    currentWorkshop = workshop({ title: 'Updated Redstone Music Challenge' });
    await createService(website, state, sendChannelMessage).synchronizeWorkshops();
    expect(sendChannelMessage).toHaveBeenCalledTimes(2);
    expect(sendChannelMessage.mock.calls[1]?.[1]).toMatchObject({
      content: expect.stringContaining('workshop updated'),
    });

    currentWorkshop = workshop({
      status: 'open',
      statusCode: 'cancelled',
      title: 'Updated Redstone Music Challenge',
    });
    await createService(website, state, sendChannelMessage).synchronizeWorkshops();
    expect(sendChannelMessage).toHaveBeenCalledTimes(3);
    expect(sendChannelMessage.mock.calls[2]?.[1]).toMatchObject({
      content: expect.stringContaining('workshop cancelled'),
    });

    await createService(website, state, sendChannelMessage).synchronizeWorkshops();
    expect(sendChannelMessage).toHaveBeenCalledTimes(3);
  });

  it('includes the registration call to action in announcement messages', () => {
    const message = formatWorkshopAnnouncement(
      workshop({
        description:
          'Can you use redstone to turn Minecraft into a musical instrument?Throughout October, jump into the challenge.\n\nSat 24 Oct 2026 4:00pm · STEMCraft',
        registrationType: 'interest',
        registrationUrl: 'https://example.test/interest',
      }),
      'new',
      'Australia/Brisbane',
    );

    expect(message.content).toContain('New STEMMechanics workshop');
    expect(message.embeds?.[0]).toMatchObject({
      title: 'Redstone Music Challenge',
      fields: expect.arrayContaining([
        {
          name: 'Registration',
          value: '[Register interest](https://example.test/interest)',
          inline: false,
        },
      ]),
    });
    expect(message.embeds?.[0]).not.toHaveProperty('image');
    expect(message.embeds?.[0]?.fields).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'Status' })]),
    );
    expect(message.embeds?.[0]?.description).toBe(
      'Can you use redstone to turn Minecraft into a musical instrument? Throughout October, jump into the challenge.',
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
      content: expect.stringContaining('workshop cancelled'),
    });
  });
});
