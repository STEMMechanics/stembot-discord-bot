import { createHash } from 'node:crypto';

import type { DiscordChannelMessage, DiscordGateway } from '../discord/client.js';
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
  announcementWindowMs: number;
  announcementDelayMs: number;
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
  pendingAnnouncementAt: string | null;
  lastAnnouncementMessageId: string | null;
}

interface WorkshopNotificationState {
  version: 1;
  initialSyncComplete: boolean;
  workshops: Record<string, StoredWorkshop>;
  reminders: Record<string, string>;
}

const STATE_KEY = 'workshopNotifications';

const INTEREST_REGISTRATION_PROMPTS = [
  'Want to be part of it?',
  'Keen to join us?',
  'Interested in taking part?',
  'Want to join in?',
  'Fancy taking part?',
] as const;

const BOOKING_REGISTRATION_PROMPTS = [
  "Don't miss out on this one!",
  'Ready to book your spot?',
  'Save your spot!',
  'Join us for this one!',
] as const;

const EMAIL_REGISTRATION_PROMPTS = [
  'Want to join us?',
  'Ready to take part?',
  'Interested in joining?',
] as const;

const MESSAGE_REGISTRATION_PROMPTS = [
  'Want to join in?',
  'Ready to take part?',
  'Send us a message!',
] as const;

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
    const now = this.currentTime();

    if (existing && existing.fingerprint === legacyWorkshopFingerprint(workshop)) {
      const wasAnnounced = existing.lastAnnouncedFingerprint === existing.fingerprint;
      updateStoredWorkshop(existing, workshop, fingerprint);
      if (wasAnnounced) {
        existing.lastAnnouncedFingerprint = fingerprint;
      }
      await this.saveState(rootState, state);
    }

    const publicWorkshop = isAnnouncementEligible(
      workshop,
      existing,
      now.getTime(),
      this.dependencies.config.announcementWindowMs,
    );
    const waitingForAnnouncementWindow = shouldWaitForAnnouncementWindow(
      workshop,
      now.getTime(),
      this.dependencies.config.announcementWindowMs,
    );

    if (
      existing &&
      waitingForAnnouncementWindow &&
      existing.pendingAnnouncement === null &&
      existing.lastAnnouncementMessageId === null &&
      existing.lastAnnouncedFingerprint === existing.fingerprint
    ) {
      existing.lastAnnouncedFingerprint = null;
      await this.saveState(rootState, state);
    }

    if (!existing) {
      const pendingAnnouncement =
        publicWorkshop &&
        statusCode !== 'cancelled' &&
        (!initialSync || this.dependencies.config.announceInitialSync)
          ? 'new'
          : null;
      const stored = toStoredWorkshop(
        workshop,
        fingerprint,
        pendingAnnouncement,
        pendingAnnouncement ? now.toISOString() : null,
      );
      if ((!publicWorkshop || pendingAnnouncement === null) && !waitingForAnnouncementWindow) {
        stored.lastAnnouncedFingerprint = fingerprint;
      }
      state.workshops[workshop.externalId] = stored;
      await this.saveState(rootState, state);
      if (pendingAnnouncement) {
        this.dependencies.logger.info(
          {
            workshopId: workshop.externalId,
            kind: pendingAnnouncement,
            pendingAnnouncementAt: stored.pendingAnnouncementAt,
            announcementDueAt: new Date(
              now.getTime() + this.dependencies.config.announcementDelayMs,
            ).toISOString(),
          },
          'Workshop announcement queued',
        );
      }
    } else if (existing.fingerprint !== fingerprint) {
      if (!publicWorkshop) {
        updateStoredWorkshop(existing, workshop, fingerprint);
        if (!waitingForAnnouncementWindow) {
          existing.lastAnnouncedFingerprint = fingerprint;
        }
        existing.pendingAnnouncement = null;
        existing.pendingAnnouncementAt = null;
        await this.saveState(rootState, state);
        return;
      }

      const kind: WorkshopAnnouncementKind =
        statusCode === 'cancelled' && existing.statusCode !== 'cancelled'
          ? 'cancelled'
          : existing.pendingAnnouncement === 'new'
            ? 'new'
            : 'updated';
      const updated = toStoredWorkshop(
        workshop,
        fingerprint,
        kind,
        existing.pendingAnnouncementAt ?? now.toISOString(),
      );
      updated.lastAnnouncedFingerprint = existing.lastAnnouncedFingerprint;
      updated.lastAnnouncementMessageId = existing.lastAnnouncementMessageId;
      state.workshops[workshop.externalId] = updated;
      await this.saveState(rootState, state);
    } else if (
      publicWorkshop &&
      existing.lastAnnouncedFingerprint !== existing.fingerprint &&
      !existing.pendingAnnouncement &&
      statusCode !== 'cancelled'
    ) {
      const kind: WorkshopAnnouncementKind =
        existing.lastAnnouncementMessageId === null ? 'new' : 'updated';
      existing.pendingAnnouncement = kind;
      existing.pendingAnnouncementAt = now.toISOString();
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
      this.dependencies.config.announcementChannelId &&
      isAnnouncementDue(stored, now.getTime(), this.dependencies.config.announcementDelayMs)
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
        stored.pendingAnnouncementAt = null;
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
): DiscordChannelMessage {
  const heading = {
    new: '📣 New:',
    updated: '✏️ Updated:',
    cancelled: '❌ Cancelled:',
  }[kind];

  return formatWorkshopMessage(workshop, heading, timeZone);
}

export function formatWorkshopReminder(
  workshop: WorkshopRecord,
  reminder: WorkshopReminder,
  timeZone: string,
): DiscordChannelMessage {
  const lead = reminder === '24-hours' ? '24 hours' : '1 hour';
  return formatWorkshopMessage(workshop, `⏰ Starts in ${lead}:`, timeZone);
}

function formatWorkshopMessage(
  workshop: WorkshopRecord,
  heading: string,
  timeZone: string,
): DiscordChannelMessage {
  const description = formatWorkshopDescription(workshop.description);
  const details = formatWorkshopDetails(workshop, timeZone);
  const title = `${heading} **[${escapeDiscordLinkText(workshop.title)}](${workshop.url})**`;
  const content = formatWorkshopContent(title, description, details);
  const imageUrl = formatWorkshopImageUrl(workshop.imageUrl);

  return {
    content,
    ...(imageUrl ? { heroImageUrl: imageUrl } : {}),
  };
}

function formatWorkshopContent(title: string, description: string, details: string): string {
  const fixedContent = `${title}\n\n${details}`;
  if (!description) {
    return fixedContent;
  }

  const availableDescriptionLength = MAX_DISCORD_MESSAGE_LENGTH - fixedContent.length - 2;
  if (availableDescriptionLength <= 0) {
    return truncateText(fixedContent, MAX_DISCORD_MESSAGE_LENGTH);
  }

  return `${title}\n\n${truncateText(description, availableDescriptionLength)}\n\n${details}`;
}

function formatWorkshopDetails(workshop: WorkshopRecord, timeZone: string): string {
  const registrationCallToAction = formatWorkshopRegistrationCallToAction(workshop);
  return (
    [
      `**When:** ${formatWorkshopDateRange(workshop, timeZone)}`,
      ...(workshop.location ? [`**Where:** ${formatInlineValue(workshop.location)}`] : []),
      ...(workshop.price ? [`**Price:** ${formatInlineValue(workshop.price)}`] : []),
      ...(workshop.ages ? [`**Ages:** ${formatInlineValue(workshop.ages)}`] : []),
    ].join('\n') + (registrationCallToAction ? `\n\n${registrationCallToAction}\n\n` : '')
  );
}

function formatWorkshopRegistrationCallToAction(workshop: WorkshopRecord): string | undefined {
  const registration = formatWorkshopRegistration(workshop);
  if (!registration || registration === 'No registration required') {
    return undefined;
  }

  const prompts =
    workshop.registrationType === 'interest'
      ? INTEREST_REGISTRATION_PROMPTS
      : workshop.registrationType === 'email'
        ? EMAIL_REGISTRATION_PROMPTS
        : workshop.registrationType === 'message'
          ? MESSAGE_REGISTRATION_PROMPTS
          : BOOKING_REGISTRATION_PROMPTS;

  return `${randomChoice(prompts)} - ${registration}`;
}

function randomChoice(values: readonly string[]): string {
  return values[Math.floor(Math.random() * values.length)] ?? values[0]!;
}

function formatWorkshopDescription(description: string | undefined): string {
  if (!description) {
    return '';
  }

  const formatted = convertDescriptionMarkup(description)
    .trim()
    .replace(
      /\s+(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\d{1,2}\s+[A-Za-z]{3}\s+\d{4}\s+\d{1,2}:\d{2}\s*(?:am|pm)\s+·\s+[^\r\n]+$/i,
      '',
    )
    .replace(/\bLearning\s+Outcomes\b[\s\S]*$/i, '')
    .replace(/([.!?,;:])(?=[A-Z])/g, '$1 ')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return formatted;
}

function convertDescriptionMarkup(description: string): string {
  return decodeHtmlEntities(
    description
      .replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<li\b[^>]*>/gi, '\n- ')
      .replace(/<\/(?:li|p|div|section|h[1-6]|ul|ol|blockquote|tr)>/gi, '\n\n')
      .replace(/<(?:p|div|section|h[1-6]|ul|ol|blockquote|tr)\b[^>]*>/gi, '')
      .replace(/<(?:strong|b)\b[^>]*>/gi, '**')
      .replace(/<\/(?:strong|b)>/gi, '**')
      .replace(/<(?:em|i)\b[^>]*>/gi, '*')
      .replace(/<\/(?:em|i)>/gi, '*')
      .replace(/<[^>]+>/g, ''),
  );
}

function decodeHtmlEntities(value: string): string {
  const namedEntities: Record<string, string> = {
    amp: '&',
    apos: "'",
    gt: '>',
    lt: '<',
    nbsp: ' ',
    quot: '"',
  };

  return value.replace(/&(#x?[0-9a-f]+|amp|apos|gt|lt|nbsp|quot);/gi, (entity, key: string) => {
    const normalizedKey = key.toLowerCase();
    if (normalizedKey in namedEntities) {
      return namedEntities[normalizedKey] ?? entity;
    }

    const codePoint = normalizedKey.startsWith('#x')
      ? Number.parseInt(normalizedKey.slice(2), 16)
      : Number.parseInt(normalizedKey.slice(1), 10);
    return Number.isNaN(codePoint) || codePoint < 0 || codePoint > 0x10ffff
      ? entity
      : String.fromCodePoint(codePoint);
  });
}

function formatInlineValue(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function escapeDiscordLinkText(value: string): string {
  return value.replace(/[\\[\]]/g, '\\$&');
}

function formatWorkshopImageUrl(imageUrl: string | undefined): string | undefined {
  if (!imageUrl?.startsWith('https://')) {
    return undefined;
  }

  try {
    const parsed = new URL(imageUrl);
    if (parsed.search === '?md') {
      parsed.search = '';
    }
    return parsed.toString();
  } catch {
    return undefined;
  }
}

function formatWorkshopDateRange(workshop: WorkshopRecord, timeZone: string): string {
  const formatter = new Intl.DateTimeFormat('en-AU', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone,
  });
  const start = formatter.format(workshop.startsAt);
  if (!workshop.endsAt) {
    return start;
  }

  return `${start}–${new Intl.DateTimeFormat('en-AU', {
    timeStyle: 'short',
    timeZone,
  }).format(workshop.endsAt)}`;
}

const MAX_DISCORD_MESSAGE_LENGTH = 2000;

function truncateText(value: string, maximumLength: number): string {
  return value.length <= maximumLength ? value : `${value.slice(0, maximumLength - 1).trimEnd()}…`;
}

function toStoredWorkshop(
  workshop: WorkshopRecord,
  fingerprint: string,
  pendingAnnouncement: WorkshopAnnouncementKind | null,
  pendingAnnouncementAt: string | null = null,
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
    pendingAnnouncementAt,
    lastAnnouncementMessageId: null,
  };
}

function isAnnouncementEligible(
  workshop: WorkshopRecord,
  existing: StoredWorkshop | undefined,
  now: number,
  announcementWindowMs: number,
): boolean {
  const statusCode = getWorkshopStatusCode(workshop);
  if (statusCode === 'private' || statusCode === 'hidden') {
    return false;
  }

  const futureWorkshop = workshop.startsAt.getTime() > now;
  const cancellationTransition =
    statusCode === 'cancelled' && existing !== undefined && existing.statusCode !== 'cancelled';
  return (
    cancellationTransition ||
    (futureWorkshop && workshop.startsAt.getTime() - now <= announcementWindowMs)
  );
}

function shouldWaitForAnnouncementWindow(
  workshop: WorkshopRecord,
  now: number,
  announcementWindowMs: number,
): boolean {
  const statusCode = getWorkshopStatusCode(workshop);
  return (
    statusCode !== 'cancelled' &&
    statusCode !== 'private' &&
    statusCode !== 'hidden' &&
    workshop.startsAt.getTime() > now &&
    workshop.startsAt.getTime() - now > announcementWindowMs
  );
}

function isAnnouncementDue(stored: StoredWorkshop, now: number, delayMs: number): boolean {
  if (!stored.pendingAnnouncementAt) {
    return true;
  }

  const pendingAt = Date.parse(stored.pendingAnnouncementAt);
  return Number.isNaN(pendingAt) || now - pendingAt >= delayMs;
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
    pendingAnnouncementAt:
      typeof value.pendingAnnouncementAt === 'string' ? value.pendingAnnouncementAt : null,
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
