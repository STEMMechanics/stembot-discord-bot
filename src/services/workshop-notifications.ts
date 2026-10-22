import { createHash } from 'node:crypto';

import type { DiscordGateway } from '../discord/client.js';
import type { AppLogger } from '../logging/logger.js';
import type { JsonState, StateStore } from '../state/state-store.js';
import {
  formatWorkshopRegistration,
  getWorkshopStatusCode,
  normalizeWorkshopStatusCode,
  type WebsiteIntegration,
  type WorkshopRecord,
  type WorkshopStatusCode,
} from '../integrations/website.js';

export type WorkshopReminder = '24-hours' | '1-hour';
export type WorkshopAnnouncementKind = 'new' | 'updated' | 'cancelled';

export interface WorkshopNotificationConfig {
  timeZone: string;
  announcementsEnabled: boolean;
  remindersEnabled: boolean;
  reminder24HoursEnabled: boolean;
  reminder1HourEnabled: boolean;
  announceInitialSync: boolean;
  announcementChannelId?: string;
  reminderChannelId?: string;
}

export interface WorkshopNotificationService {
  synchronizeWorkshops(): Promise<void>;
  sendReminder(workshopId: string, reminder: WorkshopReminder): Promise<void>;
}

export interface WorkshopNotificationServiceDependencies {
  website: WebsiteIntegration;
  discord: Pick<DiscordGateway, 'sendChannelMessage'>;
  state: StateStore<JsonState>;
  logger: AppLogger;
  config: WorkshopNotificationConfig;
  clock?: () => Date;
}

interface StoredWorkshop {
  externalId: string;
  title: string;
  startsAt: string;
  endsAt: string | null;
  url: string;
  status: WorkshopRecord['status'];
  statusCode: WorkshopStatusCode;
  type: string | null;
  fingerprint: string;
  lastAnnouncedFingerprint: string | null;
  pendingAnnouncement: WorkshopAnnouncementKind | null;
  lastAnnouncementMessageId: string | null;
}

interface WorkshopNotificationState {
  version: 1;
  initialSyncComplete: boolean;
  workshops: Record<string, StoredWorkshop>;
  reminders: Record<string, string>;
}

const STATE_KEY = 'workshopNotifications';

export class PersistentWorkshopNotificationService implements WorkshopNotificationService {
  private running = false;

  public constructor(private readonly dependencies: WorkshopNotificationServiceDependencies) {}

  public async synchronizeWorkshops(): Promise<void> {
    if (this.running) {
      this.dependencies.logger.warn('Skipping overlapping workshop synchronization');
      return;
    }

    this.running = true;
    try {
      const rootState = await this.dependencies.state.load();
      const state = readNotificationState(rootState[STATE_KEY]);
      const workshops = await this.dependencies.website.getWorkshops();
      const initialSync = !state.initialSyncComplete;

      for (const workshop of workshops) {
        await this.processWorkshop(rootState, state, workshop, initialSync);
        await this.processDueReminders(rootState, state, workshop);
      }

      state.initialSyncComplete = true;
      rootState[STATE_KEY] = state;
      await this.dependencies.state.save(rootState);
      this.dependencies.logger.info(
        { workshopCount: workshops.length, initialSync },
        'Workshop synchronization completed',
      );
    } finally {
      this.running = false;
    }
  }

  public async sendReminder(workshopId: string, reminder: WorkshopReminder): Promise<void> {
    const workshops = await this.dependencies.website.getWorkshops();
    const workshop = workshops.find((candidate) => candidate.externalId === workshopId);
    if (!workshop) {
      throw new Error(`Workshop was not found for reminder: ${workshopId}`);
    }

    if (!this.dependencies.config.remindersEnabled || !this.dependencies.config.reminderChannelId) {
      throw new Error('Workshop reminders are enabled without a configured Discord channel');
    }

    const rootState = await this.dependencies.state.load();
    const state = readNotificationState(rootState[STATE_KEY]);
    await this.deliverReminder(rootState, state, workshop, reminder);
  }

  private async processWorkshop(
    rootState: JsonState,
    state: WorkshopNotificationState,
    workshop: WorkshopRecord,
    initialSync: boolean,
  ): Promise<void> {
    const fingerprint = workshopFingerprint(workshop);
    let existing = state.workshops[workshop.externalId];

    if (!existing && workshop.legacyExternalId) {
      const legacyEntry = Object.entries(state.workshops).find(
        ([key, stored]) =>
          key === workshop.legacyExternalId || stored.externalId === workshop.legacyExternalId,
      );
      if (legacyEntry) {
        delete state.workshops[legacyEntry[0]];
        existing = legacyEntry[1];
        state.workshops[workshop.externalId] = existing;
        existing.externalId = workshop.externalId;
      }
    }

    const statusCode = getWorkshopStatusCode(workshop);

    if (existing && existing.fingerprint === legacyWorkshopFingerprint(workshop)) {
      const wasAnnounced = existing.lastAnnouncedFingerprint === existing.fingerprint;
      updateStoredWorkshop(existing, workshop, fingerprint);
      if (wasAnnounced) {
        existing.lastAnnouncedFingerprint = fingerprint;
      }
      await this.saveState(rootState, state);
    }

    const publicWorkshop = isAnnouncementEligible(workshop, existing, this.currentTime().getTime());

    if (!existing) {
      const pendingAnnouncement =
        publicWorkshop &&
        statusCode !== 'cancelled' &&
        (!initialSync || this.dependencies.config.announceInitialSync)
          ? 'new'
          : null;
      const stored = toStoredWorkshop(workshop, fingerprint, pendingAnnouncement);
      if (!publicWorkshop || pendingAnnouncement === null) {
        stored.lastAnnouncedFingerprint = fingerprint;
      }
      state.workshops[workshop.externalId] = stored;
      await this.saveState(rootState, state);
    } else if (existing.fingerprint !== fingerprint) {
      if (!publicWorkshop) {
        updateStoredWorkshop(existing, workshop, fingerprint);
        existing.lastAnnouncedFingerprint = fingerprint;
        existing.pendingAnnouncement = null;
        await this.saveState(rootState, state);
        return;
      }

      const kind: WorkshopAnnouncementKind =
        statusCode === 'cancelled' && existing.statusCode !== 'cancelled'
          ? 'cancelled'
          : existing.pendingAnnouncement === 'new'
            ? 'new'
            : 'updated';
      const updated = toStoredWorkshop(workshop, fingerprint, kind);
      updated.lastAnnouncedFingerprint = existing.lastAnnouncedFingerprint;
      updated.lastAnnouncementMessageId = existing.lastAnnouncementMessageId;
      state.workshops[workshop.externalId] = updated;
      await this.saveState(rootState, state);
    }

    const stored = state.workshops[workshop.externalId];
    if (!stored) {
      return;
    }

    if (
      publicWorkshop &&
      stored.pendingAnnouncement &&
      stored.lastAnnouncedFingerprint !== stored.fingerprint &&
      this.dependencies.config.announcementsEnabled &&
      this.dependencies.config.announcementChannelId
    ) {
      try {
        const messageId = await this.dependencies.discord.sendChannelMessage(
          this.dependencies.config.announcementChannelId,
          formatWorkshopAnnouncement(
            workshop,
            stored.pendingAnnouncement,
            this.dependencies.config.timeZone,
          ),
        );
        stored.lastAnnouncedFingerprint = stored.fingerprint;
        stored.pendingAnnouncement = null;
        stored.lastAnnouncementMessageId = messageId;
        await this.saveState(rootState, state);
      } catch (error: unknown) {
        this.dependencies.logger.error(
          { err: error, workshopId: workshop.externalId },
          'Failed to send workshop announcement; it will be retried',
        );
      }
    }
  }

  private async processDueReminders(
    rootState: JsonState,
    state: WorkshopNotificationState,
    workshop: WorkshopRecord,
  ): Promise<void> {
    if (['cancelled', 'private', 'hidden'].includes(getWorkshopStatusCode(workshop))) {
      return;
    }

    const now = this.currentTime().getTime();
    const startsAt = workshop.startsAt.getTime();
    if (startsAt <= now) {
      return;
    }

    const reminders: Array<[WorkshopReminder, number, boolean]> = [
      ['24-hours', 24 * 60 * 60 * 1000, this.dependencies.config.reminder24HoursEnabled],
      ['1-hour', 60 * 60 * 1000, this.dependencies.config.reminder1HourEnabled],
    ];

    for (const [reminder, offset, enabled] of reminders) {
      if (!enabled || now < startsAt - offset) {
        continue;
      }

      const reminderKey = `${workshop.externalId}:${reminder}`;
      if (state.reminders[reminderKey]) {
        continue;
      }

      if (
        !this.dependencies.config.remindersEnabled ||
        !this.dependencies.config.reminderChannelId
      ) {
        continue;
      }

      await this.deliverReminder(rootState, state, workshop, reminder);
    }
  }

  private async deliverReminder(
    rootState: JsonState,
    state: WorkshopNotificationState,
    workshop: WorkshopRecord,
    reminder: WorkshopReminder,
  ): Promise<void> {
    const channelId = this.dependencies.config.reminderChannelId;
    if (!channelId) {
      throw new Error('No Discord reminder channel is configured');
    }

    const reminderKey = `${workshop.externalId}:${reminder}`;
    if (state.reminders[reminderKey]) {
      return;
    }

    try {
      await this.dependencies.discord.sendChannelMessage(
        channelId,
        formatWorkshopReminder(workshop, reminder, this.dependencies.config.timeZone),
      );
      state.reminders[reminderKey] = this.currentTime().toISOString();
      await this.saveState(rootState, state);
    } catch (error: unknown) {
      this.dependencies.logger.error(
        { err: error, reminder, workshopId: workshop.externalId },
        'Failed to send workshop reminder; it will be retried',
      );
    }
  }

  private async saveState(rootState: JsonState, state: WorkshopNotificationState): Promise<void> {
    rootState[STATE_KEY] = state;
    await this.dependencies.state.save(rootState);
  }

  private currentTime(): Date {
    return this.dependencies.clock?.() ?? new Date();
  }
}

export function createWorkshopNotificationService(
  dependencies: WorkshopNotificationServiceDependencies,
): WorkshopNotificationService {
  return new PersistentWorkshopNotificationService(dependencies);
}

export class UnconfiguredWorkshopNotificationService implements WorkshopNotificationService {
  public async synchronizeWorkshops(): Promise<void> {
    throw new Error('Workshop notification service has not been configured');
  }

  public async sendReminder(workshopId: string, reminder: WorkshopReminder): Promise<void> {
    throw new Error(
      `Workshop reminder service has not been configured for ${workshopId} (${reminder})`,
    );
  }
}

export function workshopFingerprint(workshop: WorkshopRecord): string {
  const canonical = JSON.stringify({
    ages: workshop.ages ?? null,
    description: workshop.description ?? null,
    endsAt: workshop.endsAt?.toISOString() ?? null,
    externalId: workshop.externalId,
    imageUrl: workshop.imageUrl ?? null,
    location: workshop.location ?? null,
    price: workshop.price ?? null,
    registrationData: workshop.registrationData ?? null,
    registrationType: workshop.registrationType ?? null,
    registrationUrl: workshop.registrationUrl ?? null,
    startsAt: workshop.startsAt.toISOString(),
    status: workshop.status,
    statusCode: getWorkshopStatusCode(workshop),
    title: workshop.title,
    type: workshop.type ?? null,
    url: workshop.url,
  });

  return createHash('sha256').update(canonical).digest('hex');
}

export function formatWorkshopAnnouncement(
  workshop: WorkshopRecord,
  kind: WorkshopAnnouncementKind,
  timeZone: string,
): string {
  const heading = {
    new: '📣 New STEMMechanics workshop',
    updated: '✏️ STEMMechanics workshop updated',
    cancelled: '❌ STEMMechanics workshop cancelled',
  }[kind];
  const details = formatWorkshopDetails(workshop, timeZone);
  return `${heading}: **${workshop.title}**\n${details}`;
}

export function formatWorkshopReminder(
  workshop: WorkshopRecord,
  reminder: WorkshopReminder,
  timeZone: string,
): string {
  const lead = reminder === '24-hours' ? '24 hours' : '1 hour';
  return `⏰ Workshop reminder: **${workshop.title}** starts in ${lead}.\n${formatWorkshopDetails(workshop, timeZone)}`;
}

function formatWorkshopDetails(workshop: WorkshopRecord, timeZone: string): string {
  const date = new Intl.DateTimeFormat('en-AU', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone,
  }).format(workshop.startsAt);
  const location = workshop.location ? ` · ${workshop.location}` : '';
  const statusCode = getWorkshopStatusCode(workshop);
  const status = statusCode === 'unknown' ? '' : ` · ${statusCode}`;
  const registration = formatWorkshopRegistration(workshop);
  return `${date}${location}${status}\nDetails: ${workshop.url}${registration ? `\n${registration}` : ''}`;
}

function toStoredWorkshop(
  workshop: WorkshopRecord,
  fingerprint: string,
  pendingAnnouncement: WorkshopAnnouncementKind | null,
): StoredWorkshop {
  return {
    externalId: workshop.externalId,
    title: workshop.title,
    startsAt: workshop.startsAt.toISOString(),
    endsAt: workshop.endsAt?.toISOString() ?? null,
    url: workshop.url,
    status: workshop.status,
    statusCode: getWorkshopStatusCode(workshop),
    type: workshop.type ?? null,
    fingerprint,
    lastAnnouncedFingerprint: null,
    pendingAnnouncement,
    lastAnnouncementMessageId: null,
  };
}

function isAnnouncementEligible(
  workshop: WorkshopRecord,
  existing: StoredWorkshop | undefined,
  now: number,
): boolean {
  const statusCode = getWorkshopStatusCode(workshop);
  if (statusCode === 'private' || statusCode === 'hidden') {
    return false;
  }

  const futureWorkshop = workshop.startsAt.getTime() > now;
  const cancellationTransition =
    statusCode === 'cancelled' && existing !== undefined && existing.statusCode !== 'cancelled';
  return futureWorkshop || cancellationTransition;
}

function updateStoredWorkshop(
  stored: StoredWorkshop,
  workshop: WorkshopRecord,
  fingerprint: string,
): void {
  stored.externalId = workshop.externalId;
  stored.title = workshop.title;
  stored.startsAt = workshop.startsAt.toISOString();
  stored.endsAt = workshop.endsAt?.toISOString() ?? null;
  stored.url = workshop.url;
  stored.status = workshop.status;
  stored.statusCode = getWorkshopStatusCode(workshop);
  stored.type = workshop.type ?? null;
  stored.fingerprint = fingerprint;
}

function legacyWorkshopFingerprint(workshop: WorkshopRecord): string {
  const canonical = JSON.stringify({
    ages: workshop.ages ?? null,
    description: workshop.description ?? null,
    endsAt: workshop.endsAt?.toISOString() ?? null,
    externalId: workshop.legacyExternalId ?? workshop.externalId,
    imageUrl: workshop.imageUrl ?? null,
    location: workshop.location ?? null,
    price: workshop.price ?? null,
    registrationData: workshop.registrationData ?? null,
    registrationType: workshop.registrationType ?? null,
    registrationUrl: workshop.registrationUrl ?? null,
    startsAt: workshop.startsAt.toISOString(),
    status: workshop.status,
    title: workshop.title,
    url: workshop.url,
  });

  return createHash('sha256').update(canonical).digest('hex');
}

function readNotificationState(value: unknown): WorkshopNotificationState {
  const object = asObject(value);
  if (!object || object.version !== 1) {
    return emptyNotificationState();
  }

  const workshopsObject = asObject(object.workshops);
  const remindersObject = asObject(object.reminders);
  const workshops: Record<string, StoredWorkshop> = {};

  for (const [key, valueForKey] of Object.entries(workshopsObject ?? {})) {
    const workshop = asObject(valueForKey);
    if (!workshop) {
      continue;
    }

    const stored = readStoredWorkshop(workshop);
    if (stored) {
      workshops[key] = stored;
    }
  }

  const reminders: Record<string, string> = {};
  for (const [key, reminder] of Object.entries(remindersObject ?? {})) {
    if (typeof reminder === 'string' && reminder) {
      reminders[key] = reminder;
    }
  }

  return {
    version: 1,
    initialSyncComplete: object.initialSyncComplete === true,
    workshops,
    reminders,
  };
}

function readStoredWorkshop(value: Record<string, unknown>): StoredWorkshop | undefined {
  const requiredStrings = [
    value.externalId,
    value.title,
    value.startsAt,
    value.fingerprint,
    value.status,
  ];
  if (!requiredStrings.every((candidate) => typeof candidate === 'string' && candidate)) {
    return undefined;
  }

  const pending = value.pendingAnnouncement;
  const pendingAnnouncement =
    pending === 'new' || pending === 'updated' || pending === 'cancelled' ? pending : null;

  return {
    externalId: String(value.externalId),
    title: String(value.title),
    startsAt: String(value.startsAt),
    endsAt: typeof value.endsAt === 'string' ? value.endsAt : null,
    url: typeof value.url === 'string' ? value.url : '',
    status: value.status as WorkshopRecord['status'],
    statusCode: normalizeWorkshopStatusCode(
      typeof value.statusCode === 'string' ? value.statusCode : String(value.status),
    ),
    type: typeof value.type === 'string' ? value.type : null,
    fingerprint: String(value.fingerprint),
    lastAnnouncedFingerprint:
      typeof value.lastAnnouncedFingerprint === 'string' ? value.lastAnnouncedFingerprint : null,
    pendingAnnouncement,
    lastAnnouncementMessageId:
      typeof value.lastAnnouncementMessageId === 'string' ? value.lastAnnouncementMessageId : null,
  };
}

function emptyNotificationState(): WorkshopNotificationState {
  return {
    version: 1,
    initialSyncComplete: false,
    workshops: {},
    reminders: {},
  };
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
