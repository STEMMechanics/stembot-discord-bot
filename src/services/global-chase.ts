import { randomUUID } from 'node:crypto';
import type { APIEmbed } from 'discord.js';

import type { AppLogger } from '../logging/logger.js';
import { isDiscordMessageBefore } from './message-order.js';
import {
  readMinigameScores,
  toMinigameLeaderboard,
  type MinigameLeaderboardEntry,
} from './minigame-leaderboards.js';
import type { UserLevelService } from './user-levels.js';
import type { JsonState, StateStore } from '../state/state-store.js';

export interface GlobalChaseConfig {
  enabled: boolean;
  channelId?: string;
  retryIntervalMs: number;
  maxStrikes: number;
  idleTimeoutMs?: number;
}

export interface GlobalChaseMessage {
  id: string;
  channelId: string;
  authorId: string;
  authorIsBot: boolean;
  content: string;
  reply(content: string): Promise<void>;
}

export interface GlobalChasePublisherMessage {
  embeds: APIEmbed[];
}

export interface GlobalChasePublisher {
  send(channelId: string, message: GlobalChasePublisherMessage): Promise<string>;
  edit(
    channelId: string,
    messageId: string,
    message: GlobalChasePublisherMessage,
  ): Promise<boolean>;
}

export interface GlobalChaseService {
  initialize(): Promise<void>;
  ensureRound(): Promise<void>;
  checkInactivity(): Promise<void>;
  handleMessage(message: GlobalChaseMessage): Promise<void>;
  getLeaderboard(limit: number): Promise<readonly MinigameLeaderboardEntry[]>;
}

interface GlobalChaseLeg {
  clue: string;
  destination: string;
  options: readonly string[];
}

interface GlobalChaseCase {
  id: string;
  stolenItem: string;
  startLocation: string;
  legs: readonly GlobalChaseLeg[];
}

interface GlobalChaseRoundState {
  id: string;
  caseId: string;
  caseNumber: number;
  currentLeg: number;
  currentLocation: string;
  trail: string[];
  strikes: number;
  messageId: string;
  startedAt: string;
}

interface GlobalChaseState {
  version: 1;
  nextCaseNumber: number;
  round: GlobalChaseRoundState | null;
  solvedCases: Record<string, number>;
  recentCaseIds: string[];
  processedMessageIds: string[];
}

interface GlobalChaseServiceDependencies {
  config: GlobalChaseConfig;
  publisher: GlobalChasePublisher;
  state: StateStore<JsonState>;
  logger: AppLogger;
  userLevels?: UserLevelService;
  clock?: () => Date;
  idFactory?: () => string;
  random?: () => number;
  caseFactory?: () => GlobalChaseCase;
}

const STATE_KEY = 'globalChase';
const MAX_PROCESSED_MESSAGE_IDS = 500;
const MAX_RECENT_CASE_IDS = 10;
const DEFAULT_IDLE_TIMEOUT_MS = 259200000;
const GLOBAL_CHASE_BLUE = 0x3498db;
const CASEBOOK: readonly GlobalChaseCase[] = [
  {
    id: 'clockwork-compass',
    stolenItem: 'a clockwork compass',
    startLocation: 'London',
    legs: [
      {
        clue: 'The next stop is famous for canals, bicycles, and narrow houses.',
        destination: 'Amsterdam',
        options: ['Amsterdam', 'Cairo', 'Tokyo'],
      },
      {
        clue: 'The trail points to a city with a red-and-white Little Mermaid statue.',
        destination: 'Copenhagen',
        options: ['Nairobi', 'Copenhagen', 'Lima'],
      },
      {
        clue: 'The final trail leads to the city of the Eiffel Tower.',
        destination: 'Paris',
        options: ['Sydney', 'Mumbai', 'Paris'],
      },
    ],
  },
  {
    id: 'silver-film-reel',
    stolenItem: 'a silver film reel',
    startLocation: 'Sydney',
    legs: [
      {
        clue: 'The thief left for a city of gondolas and winding canals.',
        destination: 'Venice',
        options: ['Denver', 'Venice', 'Kyoto'],
      },
      {
        clue: 'The next clue mentions the Grand Bazaar and the Bosphorus.',
        destination: 'Istanbul',
        options: ['Toronto', 'Istanbul', 'Quito'],
      },
      {
        clue: 'The last sighting is beneath the world’s tallest building, the Burj Khalifa.',
        destination: 'Dubai',
        options: ['Dublin', 'Hanoi', 'Dubai'],
      },
    ],
  },
  {
    id: 'midnight-sapphire',
    stolenItem: 'a midnight sapphire',
    startLocation: 'New York',
    legs: [
      {
        clue: 'The thief crossed the Atlantic toward Big Ben and red double-decker buses.',
        destination: 'London',
        options: ['Oslo', 'Manila', 'London'],
      },
      {
        clue: 'The route continues to a city watched over by the Sagrada Família.',
        destination: 'Barcelona',
        options: ['Accra', 'Barcelona', 'Beijing'],
      },
      {
        clue: 'The final clue points to Christ the Redeemer above Guanabara Bay.',
        destination: 'Rio de Janeiro',
        options: ['Vienna', 'Singapore', 'Rio de Janeiro'],
      },
    ],
  },
  {
    id: 'rare-map',
    stolenItem: 'a rare explorer’s map',
    startLocation: 'Tokyo',
    legs: [
      {
        clue: 'The thief is heading to the city of the Eiffel Tower.',
        destination: 'Paris',
        options: ['Paris', 'Boston', 'Cape Town'],
      },
      {
        clue: 'The next clue describes the ancient Colosseum.',
        destination: 'Rome',
        options: ['Vancouver', 'Bangkok', 'Rome'],
      },
      {
        clue: 'The final destination is famous for gondolas and St Mark’s Square.',
        destination: 'Venice',
        options: ['Nairobi', 'Venice', 'Wellington'],
      },
    ],
  },
  {
    id: 'golden-camera',
    stolenItem: 'a golden camera',
    startLocation: 'Cape Town',
    legs: [
      {
        clue: 'The next stop has the Marina Bay Sands hotel and futuristic gardens.',
        destination: 'Singapore',
        options: ['Singapore', 'Lima', 'Prague'],
      },
      {
        clue: 'The trail turns north toward Red Square and the Kremlin.',
        destination: 'Moscow',
        options: ['Athens', 'Auckland', 'Moscow'],
      },
      {
        clue: 'The last clue points to the pyramids of Giza.',
        destination: 'Cairo',
        options: ['Cairo', 'Zurich', 'Seoul'],
      },
    ],
  },
] as const;

export class PersistentGlobalChaseService implements GlobalChaseService {
  private readonly currentTime: () => Date;
  private readonly idFactory: () => string;
  private readonly random: () => number;
  private readonly caseFactory: () => GlobalChaseCase;
  private eventQueue: Promise<void> = Promise.resolve();

  public constructor(private readonly dependencies: GlobalChaseServiceDependencies) {
    this.currentTime = dependencies.clock ?? (() => new Date());
    this.idFactory = dependencies.idFactory ?? randomUUID;
    this.random = dependencies.random ?? Math.random;
    this.caseFactory = dependencies.caseFactory ?? (() => chooseCase(this.random));
  }

  public async initialize(): Promise<void> {
    await this.ensureRound();
  }

  public async ensureRound(): Promise<void> {
    if (!this.isEnabled()) {
      return;
    }

    await this.enqueue(async () => {
      const rootState = await this.dependencies.state.load();
      const state = readGlobalChaseState(rootState[STATE_KEY]);
      if (state.round) {
        return;
      }

      await this.publishNextCase(rootState, state);
    });
  }

  public async checkInactivity(): Promise<void> {
    if (!this.isEnabled()) {
      return;
    }

    await this.enqueue(async () => {
      const rootState = await this.dependencies.state.load();
      const state = readGlobalChaseState(rootState[STATE_KEY]);
      const round = state.round;
      if (!round) {
        return;
      }

      const startedAt = Date.parse(round.startedAt);
      const idleTimeoutMs = this.dependencies.config.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
      if (!Number.isFinite(startedAt) || this.currentTime().getTime() - startedAt < idleTimeoutMs) {
        return;
      }

      const chaseCase = findCase(round.caseId);
      if (!chaseCase) {
        state.round = null;
        writeGlobalChaseState(rootState, state);
        await this.dependencies.state.save(rootState);
        return;
      }

      state.round = null;
      writeGlobalChaseState(rootState, state);
      await this.dependencies.state.save(rootState);
      await this.editBoardSafely(
        round,
        formatGlobalChaseEmbed(
          chaseCase,
          round,
          this.dependencies.config.maxStrikes,
          `⏰ The trail went cold. The thief’s next stop was **${currentLeg(chaseCase, round).destination}**.`,
        ),
      );
      await this.publishNextCase(rootState, state, '⏰ A fresh case is ready.');
    });
  }

  public async getLeaderboard(limit: number): Promise<readonly MinigameLeaderboardEntry[]> {
    if (!this.dependencies.config.enabled) {
      return [];
    }

    return this.enqueue(async () => {
      const rootState = await this.dependencies.state.load();
      const state = readGlobalChaseState(rootState[STATE_KEY]);
      return toMinigameLeaderboard(state.solvedCases, limit);
    });
  }

  public async handleMessage(message: GlobalChaseMessage): Promise<void> {
    if (
      !this.isEnabled() ||
      message.channelId !== this.dependencies.config.channelId ||
      message.authorIsBot ||
      message.content.trim().length === 0
    ) {
      return;
    }

    await this.enqueue(() => this.processMessage(message));
  }

  private async processMessage(message: GlobalChaseMessage): Promise<void> {
    const rootState = await this.dependencies.state.load();
    const state = readGlobalChaseState(rootState[STATE_KEY]);
    const round = state.round;
    if (!round || state.processedMessageIds.includes(message.id)) {
      return;
    }

    if (isDiscordMessageBefore(message.id, round.messageId)) {
      state.processedMessageIds = rememberMessageId(state.processedMessageIds, message.id);
      writeGlobalChaseState(rootState, state);
      await this.dependencies.state.save(rootState);
      return;
    }

    const chaseCase = findCase(round.caseId);
    if (!chaseCase) {
      return;
    }

    const leg = currentLeg(chaseCase, round);
    state.processedMessageIds = rememberMessageId(state.processedMessageIds, message.id);
    const choice = parseChoice(message.content, leg.options);
    if (choice === undefined) {
      writeGlobalChaseState(rootState, state);
      await this.dependencies.state.save(rootState);
      await this.replySafely(message, 'Reply with `1`, `2`, or `3`, or type one of the locations.');
      return;
    }

    if (choice !== leg.destination) {
      round.strikes += 1;
      if (round.strikes >= this.dependencies.config.maxStrikes) {
        state.round = null;
        writeGlobalChaseState(rootState, state);
        await this.dependencies.state.save(rootState);
        await this.postBoardSafely(
          round,
          formatGlobalChaseEmbed(
            chaseCase,
            round,
            this.dependencies.config.maxStrikes,
            `❌ The trail went cold. The correct location was **${leg.destination}**.`,
          ),
        );
        await this.publishNextCase(
          rootState,
          state,
          '💨 The thief escaped. A fresh case is ready.',
        );
        return;
      }

      const messageId = await this.postBoardSafely(
        round,
        formatGlobalChaseEmbed(
          chaseCase,
          round,
          this.dependencies.config.maxStrikes,
          `❌ **${choice}** was a decoy. Try another lead.`,
        ),
      );
      if (messageId) {
        round.messageId = messageId;
      }
      writeGlobalChaseState(rootState, state);
      await this.dependencies.state.save(rootState);
      return;
    }

    const nextRound = {
      ...round,
      currentLeg: round.currentLeg + 1,
      currentLocation: leg.destination,
      trail: [...round.trail, leg.destination],
    };
    if (nextRound.currentLeg >= chaseCase.legs.length) {
      state.round = null;
      state.solvedCases[message.authorId] = (state.solvedCases[message.authorId] ?? 0) + 1;
      writeGlobalChaseState(rootState, state);
      await this.dependencies.state.save(rootState);
      await this.recordGameParticipation(message.authorId, message);
      await this.postBoardSafely(
        round,
        formatGlobalChaseEmbed(
          chaseCase,
          nextRound,
          this.dependencies.config.maxStrikes,
          `🎉 You found the thief’s final location and recovered **${chaseCase.stolenItem}**!\n🏆 +1 solved case!`,
        ),
      );
      await this.publishNextCase(rootState, state, '🎉 A fresh case is ready.');
      return;
    }

    const messageId = await this.postBoardSafely(
      nextRound,
      formatGlobalChaseEmbed(
        chaseCase,
        nextRound,
        this.dependencies.config.maxStrikes,
        `✅ **${leg.destination}** was correct. Follow the next lead.`,
      ),
    );
    if (messageId) {
      nextRound.messageId = messageId;
    }
    writeGlobalChaseState(rootState, { ...state, round: nextRound });
    await this.dependencies.state.save(rootState);
  }

  private async publishNextCase(
    rootState: JsonState,
    state: GlobalChaseState,
    leadIn?: string,
  ): Promise<void> {
    const chaseCase = this.selectCase(state.recentCaseIds);
    const round: GlobalChaseRoundState = {
      id: this.idFactory(),
      caseId: chaseCase.id,
      caseNumber: state.nextCaseNumber,
      currentLeg: 0,
      currentLocation: chaseCase.startLocation,
      trail: [chaseCase.startLocation],
      strikes: 0,
      messageId: '',
      startedAt: this.currentTime().toISOString(),
    };
    const messageId = await this.dependencies.publisher.send(this.dependencies.config.channelId!, {
      embeds: [
        formatGlobalChaseEmbed(
          chaseCase,
          round,
          this.dependencies.config.maxStrikes,
          leadIn ?? `A thief has stolen **${chaseCase.stolenItem}**. Follow the trail.`,
        ),
      ],
    });
    round.messageId = messageId;
    state.round = round;
    state.nextCaseNumber += 1;
    state.recentCaseIds = [...state.recentCaseIds, chaseCase.id].slice(-MAX_RECENT_CASE_IDS);
    writeGlobalChaseState(rootState, state);
    await this.dependencies.state.save(rootState);
    this.dependencies.logger.info(
      { channelId: this.dependencies.config.channelId, caseNumber: round.caseNumber },
      'Global Chase case posted',
    );
  }

  private selectCase(recentCaseIds: readonly string[]): GlobalChaseCase {
    const preferred = this.caseFactory();
    if (!recentCaseIds.includes(preferred.id)) {
      return preferred;
    }

    const available = CASEBOOK.filter((chaseCase) => !recentCaseIds.includes(chaseCase.id));
    return available[0] ?? preferred;
  }

  private async postBoardSafely(
    round: GlobalChaseRoundState,
    embed: APIEmbed,
  ): Promise<string | undefined> {
    try {
      return await this.dependencies.publisher.send(this.dependencies.config.channelId!, {
        embeds: [embed],
      });
    } catch (error: unknown) {
      this.dependencies.logger.warn(
        { err: error, channelId: this.dependencies.config.channelId, caseNumber: round.caseNumber },
        'Global Chase board could not be posted',
      );
      return undefined;
    }
  }

  private async editBoardSafely(round: GlobalChaseRoundState, embed: APIEmbed): Promise<void> {
    try {
      const edited = await this.dependencies.publisher.edit(
        this.dependencies.config.channelId!,
        round.messageId,
        { embeds: [embed] },
      );
      if (!edited) {
        this.dependencies.logger.warn(
          { channelId: this.dependencies.config.channelId, messageId: round.messageId },
          'Global Chase board could not be found for editing',
        );
      }
    } catch (error: unknown) {
      this.dependencies.logger.warn(
        { err: error, channelId: this.dependencies.config.channelId, messageId: round.messageId },
        'Global Chase board could not be updated',
      );
    }
  }

  private async replySafely(message: GlobalChaseMessage, content: string): Promise<void> {
    try {
      await message.reply(content);
    } catch (error: unknown) {
      this.dependencies.logger.warn(
        { err: error, channelId: message.channelId, messageId: message.id },
        'Global Chase response could not be sent',
      );
    }
  }

  private async recordGameParticipation(
    userId: string,
    message: GlobalChaseMessage,
  ): Promise<void> {
    try {
      await this.dependencies.userLevels?.recordGameParticipation(userId);
    } catch (error: unknown) {
      this.dependencies.logger.warn(
        { err: error, channelId: message.channelId, messageId: message.id, userId },
        'Global Chase game XP could not be recorded',
      );
    }
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
    return next;
  }
}

export function createGlobalChaseService(
  dependencies: GlobalChaseServiceDependencies,
): GlobalChaseService {
  return new PersistentGlobalChaseService(dependencies);
}

export function formatGlobalChaseEmbed(
  chaseCase: GlobalChaseCase,
  round: GlobalChaseRoundState,
  maxStrikes: number,
  leadIn?: string,
): APIEmbed {
  const leg = currentLeg(chaseCase, round);
  const trail = [...round.trail, round.currentLeg < chaseCase.legs.length ? '?' : '✓'].join(' → ');
  const options = leg.options.map((option, index) => `${index + 1}️⃣ ${option}`).join('\n');
  const description = [`💡 **Clue**\n${leg.clue}`, leadIn]
    .filter((section): section is string => Boolean(section))
    .join('\n\n');
  return {
    title: `🕵️ The Global Chase · Case ${round.caseNumber}`,
    color: GLOBAL_CHASE_BLUE,
    description,
    fields: [
      { name: '📍 Current location', value: round.currentLocation, inline: true },
      {
        name: '⚠️ Strikes',
        value: `\`${round.strikes}/${Math.max(1, maxStrikes)}\``,
        inline: true,
      },
      { name: '🗺️ Trail', value: trail, inline: false },
      { name: '🌍 Where did the thief go next?', value: options, inline: false },
    ],
    footer: { text: 'Reply with the location or its number.' },
  };
}

function parseChoice(content: string, options: readonly string[]): string | undefined {
  const normalized = content.trim().toLocaleLowerCase();
  const numericChoice = /^[1-3]$/.test(normalized) ? Number(normalized) - 1 : undefined;
  if (numericChoice !== undefined) {
    return options[numericChoice];
  }

  return options.find((option) => option.toLocaleLowerCase() === normalized);
}

function currentLeg(chaseCase: GlobalChaseCase, round: GlobalChaseRoundState): GlobalChaseLeg {
  return (
    chaseCase.legs[Math.min(round.currentLeg, chaseCase.legs.length - 1)] ?? chaseCase.legs[0]!
  );
}

function chooseCase(random: () => number): GlobalChaseCase {
  const rawRandomValue = random();
  const randomValue = Number.isFinite(rawRandomValue)
    ? Math.max(0, Math.min(0.999999, rawRandomValue))
    : 0;
  return CASEBOOK[Math.floor(randomValue * CASEBOOK.length)] ?? CASEBOOK[0]!;
}

function rememberMessageId(messageIds: string[], messageId: string): string[] {
  return [...messageIds, messageId].slice(-MAX_PROCESSED_MESSAGE_IDS);
}

function createInitialGlobalChaseState(): GlobalChaseState {
  return {
    version: 1,
    nextCaseNumber: 1,
    round: null,
    solvedCases: {},
    recentCaseIds: [],
    processedMessageIds: [],
  };
}

function readGlobalChaseState(value: unknown): GlobalChaseState {
  if (!isRecord(value) || value.version !== 1) {
    return createInitialGlobalChaseState();
  }

  const round = isGlobalChaseRound(value.round) ? value.round : null;
  const nextCaseNumber =
    typeof value.nextCaseNumber === 'number' &&
    Number.isSafeInteger(value.nextCaseNumber) &&
    value.nextCaseNumber > 0
      ? value.nextCaseNumber
      : 1;
  const recentCaseIds = Array.isArray(value.recentCaseIds)
    ? value.recentCaseIds
        .filter((caseId): caseId is string => typeof caseId === 'string')
        .slice(-MAX_RECENT_CASE_IDS)
    : [];
  const processedMessageIds = Array.isArray(value.processedMessageIds)
    ? value.processedMessageIds
        .filter((messageId): messageId is string => typeof messageId === 'string')
        .slice(-MAX_PROCESSED_MESSAGE_IDS)
    : [];
  return {
    version: 1,
    nextCaseNumber,
    round,
    solvedCases: readMinigameScores(value.solvedCases),
    recentCaseIds,
    processedMessageIds,
  };
}

function isGlobalChaseRound(value: unknown): value is GlobalChaseRoundState {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    typeof value.caseId === 'string' &&
    value.caseId.length > 0 &&
    typeof value.caseNumber === 'number' &&
    Number.isSafeInteger(value.caseNumber) &&
    value.caseNumber > 0 &&
    typeof value.currentLeg === 'number' &&
    Number.isSafeInteger(value.currentLeg) &&
    value.currentLeg >= 0 &&
    typeof value.currentLocation === 'string' &&
    value.currentLocation.length > 0 &&
    Array.isArray(value.trail) &&
    value.trail.every((location) => typeof location === 'string' && location.length > 0) &&
    typeof value.strikes === 'number' &&
    Number.isSafeInteger(value.strikes) &&
    value.strikes >= 0 &&
    typeof value.messageId === 'string' &&
    value.messageId.length > 0 &&
    typeof value.startedAt === 'string'
  );
}

function findCase(caseId: string): GlobalChaseCase | undefined {
  return CASEBOOK.find((chaseCase) => chaseCase.id === caseId);
}

function writeGlobalChaseState(rootState: JsonState, state: GlobalChaseState): void {
  rootState[STATE_KEY] = state;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
