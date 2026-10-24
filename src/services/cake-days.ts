import type { AppLogger } from '../logging/logger.js';
import type { JsonState, StateStore } from '../state/state-store.js';

export interface CakeDayConfig {
  enabled: boolean;
  announcementChannelId?: string;
  checkIntervalMs: number;
  hour: number;
}

export interface CakeDayMember {
  id: string;
  username: string;
  displayName: string;
  bot: boolean;
  joinedAt: Date | null;
  avatarUrl?: string;
}

export interface CakeDayAnnouncement {
  channelId: string;
  memberId: string;
  displayName: string;
  years: number;
  avatarUrl?: string;
  content: string;
  allowedUserIds: readonly string[];
}

export interface CakeDayMemberProvider {
  getMembers(): Promise<readonly CakeDayMember[]>;
}

export interface CakeDayAnnouncementPublisher {
  send(announcement: CakeDayAnnouncement): Promise<void>;
}

export interface CakeDayService {
  check(): Promise<void>;
}

interface CakeDayState {
  version: 1;
  date: string;
  announcedUserIds: string[];
}

export interface ZonedDateParts {
  year: number;
  month: number;
  day: number;
  hour: number;
}

const STATE_KEY = 'cakeDays';

export class PersistentCakeDayService implements CakeDayService {
  private eventQueue: Promise<void> = Promise.resolve();

  public constructor(
    private readonly dependencies: {
      config: CakeDayConfig;
      timeZone: string;
      state: StateStore<JsonState>;
      logger: AppLogger;
      memberProvider: CakeDayMemberProvider;
      publisher: CakeDayAnnouncementPublisher;
      clock?: () => Date;
    },
  ) {}

  public check(): Promise<void> {
    if (!this.dependencies.config.enabled || !this.dependencies.config.announcementChannelId) {
      return Promise.resolve();
    }

    return this.enqueue(() => this.checkAtCurrentTime());
  }

  private async checkAtCurrentTime(): Promise<void> {
    const channelId = this.dependencies.config.announcementChannelId;
    if (!channelId) {
      return;
    }

    const now = this.currentTime();
    const today = getZonedDateParts(now, this.dependencies.timeZone);
    if (today.hour !== this.dependencies.config.hour) {
      return;
    }

    const dateKey = formatDateKey(today);
    const rootState = await this.dependencies.state.load();
    const state = readCakeDayState(rootState[STATE_KEY], dateKey);
    const announcedUserIds = new Set(state.announcedUserIds);
    const members = await this.dependencies.memberProvider.getMembers();

    for (const member of members) {
      if (member.bot || !member.joinedAt || announcedUserIds.has(member.id)) {
        continue;
      }

      const years = getCakeDayYears(member.joinedAt, today, this.dependencies.timeZone);
      if (years === undefined) {
        continue;
      }

      const announcement: CakeDayAnnouncement = {
        channelId,
        memberId: member.id,
        displayName: member.displayName.trim() || member.username,
        years,
        ...(member.avatarUrl ? { avatarUrl: member.avatarUrl } : {}),
        content: getCakeDayMessage(member.id, years),
        allowedUserIds: [member.id],
      };

      try {
        await this.dependencies.publisher.send(announcement);
        announcedUserIds.add(member.id);
        state.announcedUserIds = [...announcedUserIds];
        writeCakeDayState(rootState, state);
        await this.dependencies.state.save(rootState);
        this.dependencies.logger.info(
          { date: dateKey, memberId: member.id, years },
          'Cake-day announcement sent',
        );
      } catch (error: unknown) {
        this.dependencies.logger.warn(
          { err: error, date: dateKey, memberId: member.id, years },
          'Cake-day announcement could not be sent',
        );
      }
    }
  }

  private currentTime(): Date {
    return this.dependencies.clock?.() ?? new Date();
  }

  private async enqueue(work: () => Promise<void>): Promise<void> {
    const next = this.eventQueue.catch(() => undefined).then(work);
    this.eventQueue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}

export function createCakeDayService(dependencies: {
  config: CakeDayConfig;
  timeZone: string;
  state: StateStore<JsonState>;
  logger: AppLogger;
  memberProvider: CakeDayMemberProvider;
  publisher: CakeDayAnnouncementPublisher;
  clock?: () => Date;
}): CakeDayService {
  return new PersistentCakeDayService(dependencies);
}

export function getCakeDayMessage(memberId: string, years: number): string {
  const duration = `${years} ${years === 1 ? 'year' : 'years'}`;
  return `🎂 Happy cake day <@${memberId}>! Thanks for being part of STEMMechanics for ${duration}.`;
}

export function getCakeDayYears(
  joinedAt: Date,
  today: ZonedDateParts,
  timeZone: string,
): number | undefined {
  if (Number.isNaN(joinedAt.getTime())) {
    return undefined;
  }

  const joined = getZonedDateParts(joinedAt, timeZone);
  const isLeapDay = joined.month === 2 && joined.day === 29;
  const isAnniversary =
    joined.month === today.month &&
    (joined.day === today.day ||
      (isLeapDay && today.month === 2 && today.day === 28 && !isLeapYear(today.year)));
  const years = today.year - joined.year;

  return isAnniversary && years >= 1 ? years : undefined;
}

export function getZonedDateParts(date: Date, timeZone: string): ZonedDateParts {
  const formatter = new Intl.DateTimeFormat('en-AU', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  });
  const values = Object.fromEntries(
    formatter
      .formatToParts(date)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, Number(part.value)]),
  ) as Record<string, number>;

  return {
    year: getRequiredDatePart(values, 'year'),
    month: getRequiredDatePart(values, 'month'),
    day: getRequiredDatePart(values, 'day'),
    hour: getRequiredDatePart(values, 'hour'),
  };
}

function getRequiredDatePart(values: Record<string, number>, name: string): number {
  const value = values[name];
  if (value === undefined) {
    throw new Error(`Timezone formatter did not return a ${name} part`);
  }

  return value;
}

function formatDateKey(date: Pick<ZonedDateParts, 'year' | 'month' | 'day'>): string {
  return [date.year, date.month, date.day]
    .map((value, index) => (index === 0 ? value : String(value).padStart(2, '0')))
    .join('-');
}

function readCakeDayState(value: unknown, date: string): CakeDayState {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    value.date !== date ||
    !Array.isArray(value.announcedUserIds)
  ) {
    return { version: 1, date, announcedUserIds: [] };
  }

  return {
    version: 1,
    date,
    announcedUserIds: value.announcedUserIds.filter(
      (userId): userId is string => typeof userId === 'string' && userId.length > 0,
    ),
  };
}

function writeCakeDayState(rootState: JsonState, state: CakeDayState): void {
  rootState[STATE_KEY] = state;
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
