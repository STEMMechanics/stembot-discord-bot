import { lookup as dnsLookup } from 'node:dns/promises';
import { BlockList } from 'node:net';

import type { NumberImage, NumberRecognizer } from '../integrations/openai.js';
import type { AppLogger } from '../logging/logger.js';
import type { JsonState, StateStore } from '../state/state-store.js';

export interface CountingChainConfig {
  enabled: boolean;
  channelId?: string;
  maxAttachmentBytes: number;
  reviewEnabled?: boolean;
  reviewRoleId?: string;
}

export interface CountingChainAttachment {
  url: string;
  name?: string;
  contentType?: string;
  size?: number;
}

export interface CountingChainMessage {
  id: string;
  channelId: string;
  authorId: string;
  authorIsBot: boolean;
  content: string;
  attachments: readonly CountingChainAttachment[];
  imageUrls?: readonly string[];
  botReactionEmojis?: readonly string[];
  react(emoji: string): Promise<void>;
  reply(content: string, options?: CountingChainReplyOptions): Promise<void>;
}

export interface CountingChainReplyOptions {
  mentionRoleId?: string;
}

export interface CountingChainHistoryMessage extends CountingChainMessage {
  content: string;
  botReactionEmojis: readonly string[];
}

export type CountingChainHistoryProvider = () => Promise<readonly CountingChainHistoryMessage[]>;

export interface CountingChainGameStatus {
  expectedNumber: number;
  lastAuthorId: string | null;
  lastMessageId: string | null;
  updatedAt: string;
  highScore: number;
  highScoreAt: string | null;
  lastRound: number;
  lastRoundAt: string | null;
  lastRoundReason: string | null;
}

export interface CountingChainInfoPublisher {
  update(status: CountingChainGameStatus, messageId?: string): Promise<string | undefined>;
}

export interface CountingChainRemoteAddress {
  address: string;
  family: 4 | 6;
}

export type CountingChainRemoteAddressLookup = (
  hostname: string,
) => Promise<readonly CountingChainRemoteAddress[]>;

export interface CountingChainService {
  handleMessage(message: CountingChainMessage): Promise<void>;
  getReviewTargetMessageId(): Promise<string | undefined>;
  requestReview(message: CountingChainMessage): Promise<boolean>;
  reviewMessage(
    message: CountingChainMessage,
    decision: 'approve' | 'reject',
    reviewerId: string,
  ): Promise<boolean>;
  initialize(
    historyProvider: CountingChainHistoryProvider,
    infoPublisher?: CountingChainInfoPublisher,
  ): Promise<void>;
}

export interface CountingChainServiceDependencies {
  config: CountingChainConfig;
  recognizer: NumberRecognizer;
  state: StateStore<JsonState>;
  logger: AppLogger;
  fetchImplementation?: typeof fetch;
  lookupImplementation?: CountingChainRemoteAddressLookup;
  clock?: () => Date;
}

type CountingChainGameState = CountingChainGameStatus & {
  lastProcessedMessageId: string | null;
};

type CountingChainReviewReason = 'unreadable' | 'wrong-number' | 'same-user' | 'manual';

interface CountingChainGameEnding {
  messageId: string;
  authorId: string;
  expectedNumber: number;
  proposedNumber: number | null;
  reason: CountingChainReviewReason;
  endedAt: string;
}

interface CountingChainPendingReview extends CountingChainGameEnding {
  requestedAt: string;
}

interface CountingChainState {
  version: 1;
  game: CountingChainGameState | null;
  infoMessageId: string | null;
  historyRecoveryPending: boolean;
  lastGameEnding: CountingChainGameEnding | null;
  pendingReview: CountingChainPendingReview | null;
}

interface ProcessMessageOptions {
  fromHistory?: boolean;
}

const STATE_KEY = 'countingChain';
const PASS_REACTION = '👍';
const RULE_FAILURE_REACTION = '❌';
const RECOGNITION_FAILURE_REACTION = '⚠️';
const REVIEW_REQUEST_REACTION = '🔎';
const REVIEW_APPROVE_REACTION = '✅';
const REVIEW_REJECT_REACTION = '❌';
const IMAGE_TYPES = new Set(['image/gif', 'image/jpeg', 'image/png', 'image/webp']);
const MAX_IMAGE_REDIRECTS = 3;
const BLOCKED_REMOTE_NETWORKS = new BlockList();

for (const [address, prefixLength] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  BLOCKED_REMOTE_NETWORKS.addSubnet(address, prefixLength, 'ipv4');
}

for (const [address, prefixLength] of [
  ['::', 128],
  ['::1', 128],
  ['100::', 64],
  ['2001:2::', 48],
  ['2001:10::', 28],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  BLOCKED_REMOTE_NETWORKS.addSubnet(address, prefixLength, 'ipv6');
}

export class PersistentCountingChainService implements CountingChainService {
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly fetchImplementation: typeof fetch;
  private readonly lookupImplementation: CountingChainRemoteAddressLookup;
  private initializationPromise: Promise<void> | undefined;
  private infoPublisher: CountingChainInfoPublisher | undefined;

  public constructor(private readonly dependencies: CountingChainServiceDependencies) {
    this.fetchImplementation = dependencies.fetchImplementation ?? fetch;
    this.lookupImplementation = dependencies.lookupImplementation ?? lookupRemoteAddresses;
  }

  public initialize(
    historyProvider: CountingChainHistoryProvider,
    infoPublisher?: CountingChainInfoPublisher,
  ): Promise<void> {
    if (infoPublisher) {
      this.infoPublisher = infoPublisher;
    }

    if (!this.initializationPromise) {
      this.initializationPromise = (async (): Promise<void> => {
        try {
          await this.recoverMissingState(historyProvider);
        } catch (error: unknown) {
          this.dependencies.logger.warn(
            { err: error, channelId: this.dependencies.config.channelId },
            'Counting chain startup reconciliation failed; retrying on next startup',
          );
        }

        await this.publishInfo();
      })();
    }

    return this.initializationPromise;
  }

  public handleMessage(message: CountingChainMessage): Promise<void> {
    if (
      !this.dependencies.config.enabled ||
      !this.dependencies.config.channelId ||
      message.channelId !== this.dependencies.config.channelId ||
      message.authorIsBot
    ) {
      return Promise.resolve();
    }

    return this.enqueue(message.channelId, async () => {
      try {
        await this.processMessage(message);
      } catch (error: unknown) {
        this.dependencies.logger.error(
          { err: error, channelId: message.channelId, messageId: message.id },
          'Counting chain message processing failed',
        );
      }
    });
  }

  public getReviewTargetMessageId(): Promise<string | undefined> {
    if (
      !this.dependencies.config.enabled ||
      !this.dependencies.config.reviewEnabled ||
      !this.dependencies.config.channelId
    ) {
      return Promise.resolve(undefined);
    }

    return this.dependencies.state.load().then((rootState) => {
      const state = readCountingChainState(
        rootState[STATE_KEY],
        this.dependencies.config.channelId,
      );
      return state.pendingReview?.messageId ?? state.lastGameEnding?.messageId;
    });
  }

  public requestReview(message: CountingChainMessage): Promise<boolean> {
    if (
      !this.dependencies.config.enabled ||
      !this.dependencies.config.reviewEnabled ||
      !this.dependencies.config.channelId ||
      message.channelId !== this.dependencies.config.channelId ||
      message.authorIsBot
    ) {
      return Promise.resolve(false);
    }

    return this.enqueue(message.channelId, () =>
      this.createReviewRequest(message, undefined, 'manual'),
    );
  }

  public reviewMessage(
    message: CountingChainMessage,
    decision: 'approve' | 'reject',
    reviewerId: string,
  ): Promise<boolean> {
    if (
      !this.dependencies.config.enabled ||
      !this.dependencies.config.reviewEnabled ||
      !this.dependencies.config.channelId ||
      message.channelId !== this.dependencies.config.channelId ||
      message.authorIsBot
    ) {
      return Promise.resolve(false);
    }

    return this.enqueue(message.channelId, () =>
      this.applyReviewDecision(message, decision, reviewerId),
    );
  }

  private enqueue<T>(channelId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(channelId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => this.initializationPromise)
      .then(task);
    const tracked = next.then(
      () => undefined,
      () => undefined,
    );
    this.queues.set(channelId, tracked);

    return next.finally(() => {
      if (this.queues.get(channelId) === tracked) {
        this.queues.delete(channelId);
      }
    });
  }

  private async recoverMissingState(historyProvider: CountingChainHistoryProvider): Promise<void> {
    const channelId = this.dependencies.config.channelId;
    if (!this.dependencies.config.enabled || !channelId) {
      return;
    }

    const rootState = await this.dependencies.state.load();
    const rawCountingChainState = rootState[STATE_KEY];
    const state = readCountingChainState(rawCountingChainState, channelId);

    this.dependencies.logger.info(
      {
        channelId,
        hasPersistedGame: state.game !== null,
        pendingReviewMessageId: state.pendingReview?.messageId,
        historyRecoveryPending: state.historyRecoveryPending,
      },
      'Counting chain startup reconciliation checking Discord history',
    );

    if (state.pendingReview) {
      this.dependencies.logger.info(
        {
          channelId,
          messageId: state.pendingReview.messageId,
          expectedNumber: state.pendingReview.expectedNumber,
          proposedNumber: state.pendingReview.proposedNumber,
        },
        'Counting chain startup reconciliation retaining pending moderator review',
      );
      return;
    }

    let history: readonly CountingChainHistoryMessage[];
    try {
      history = await historyProvider();
    } catch (error: unknown) {
      this.dependencies.logger.warn(
        { err: error, channelId },
        'Counting chain Discord history could not be read; retaining state for retry',
      );
      await saveHistoryRecoveryPending(
        rootState,
        state,
        this.currentTime(),
        this.dependencies.state,
      );
      return;
    }

    this.dependencies.logger.info(
      { channelId, historyCount: history.length },
      'Counting chain Discord history fetched for startup recovery',
    );
    const orderedHistory = sortHistoryNewestFirst(history);
    const newestMessage = orderedHistory[0];
    this.dependencies.logger.info(
      {
        channelId,
        newestMessageId: newestMessage?.id,
        newestMessageAuthorIsBot: newestMessage?.authorIsBot,
        newestMessageAttachmentCount: newestMessage?.attachments.length,
        newestMessageImageUrlCount: newestMessage?.imageUrls?.length,
      },
      'Counting chain history newest message identified',
    );

    const checkpointMessageId = state.game?.lastProcessedMessageId ?? state.game?.lastMessageId;
    if (checkpointMessageId && isDiscordSnowflake(checkpointMessageId)) {
      await this.reconcileHistoryAfterCheckpoint(orderedHistory, checkpointMessageId);
      return;
    }

    const latestMessage = findLatestRelevantHistoryMessage(orderedHistory);
    this.dependencies.logger.info(
      { channelId, selectedMessageId: latestMessage?.id },
      'Counting chain history candidate selected for initial recovery',
    );
    if (!latestMessage || isCountingChainFailureMessage(latestMessage)) {
      this.dependencies.logger.info(
        {
          channelId,
          historyCount: history.length,
          relevantMessageId: latestMessage?.id,
          historyOutcome: latestMessage ? 'failure-marker' : 'no-relevant-image',
        },
        'Counting chain history did not contain an accepted image; starting at one',
      );
      await saveInitialState(
        rootState,
        state,
        this.currentTime(),
        this.dependencies.state,
        false,
        newestMessage?.id,
      );
      return;
    }

    const imageSource = selectImageSource(latestMessage);
    if (!imageSource) {
      await saveInitialState(
        rootState,
        state,
        this.currentTime(),
        this.dependencies.state,
        false,
        newestMessage?.id,
      );
      return;
    }

    try {
      const image = await this.downloadImage(imageSource);
      const recognizedNumber = await this.dependencies.recognizer.recognizeNumber(image);
      if (recognizedNumber === null) {
        throw new Error('Counting chain history image could not be read');
      }

      state.game = {
        expectedNumber: recognizedNumber + 1,
        lastAuthorId: latestMessage.authorId,
        lastMessageId: latestMessage.id,
        updatedAt: this.currentTime().toISOString(),
        highScore: recognizedNumber,
        highScoreAt: this.currentTime().toISOString(),
        lastRound: recognizedNumber,
        lastRoundAt: this.currentTime().toISOString(),
        lastRoundReason: null,
        lastProcessedMessageId: newestMessage?.id ?? latestMessage.id,
      };
      state.historyRecoveryPending = false;
      writeCountingChainState(rootState, state);
      await this.dependencies.state.save(rootState);
      this.dependencies.logger.info(
        {
          channelId,
          messageId: latestMessage.id,
          authorId: latestMessage.authorId,
          recognizedNumber,
          expectedNumber: recognizedNumber + 1,
        },
        'Counting chain state recovered from Discord history',
      );
    } catch (error: unknown) {
      this.dependencies.logger.warn(
        { err: error, channelId, messageId: latestMessage.id },
        'Counting chain history image could not be read; silently resetting',
      );
      await saveInitialState(
        rootState,
        state,
        this.currentTime(),
        this.dependencies.state,
        false,
        newestMessage?.id,
      );
    }
  }

  private async reconcileHistoryAfterCheckpoint(
    history: readonly CountingChainHistoryMessage[],
    checkpointMessageId: string,
  ): Promise<void> {
    const pendingMessages = sortHistoryOldestFirst(history).filter(
      (message) =>
        !message.authorIsBot &&
        isDiscordMessageAfter(message.id, checkpointMessageId) &&
        selectImageSource(message) !== undefined,
    );

    this.dependencies.logger.info(
      {
        channelId: this.dependencies.config.channelId,
        checkpointMessageId,
        pendingImageCount: pendingMessages.length,
        newestPendingMessageId: pendingMessages.at(-1)?.id,
      },
      'Counting chain startup reconciliation found pending images',
    );

    try {
      let pausedForReview = false;
      for (const message of pendingMessages) {
        await this.processMessage(message, { fromHistory: true });
        const currentRootState = await this.dependencies.state.load();
        const currentState = readCountingChainState(
          currentRootState[STATE_KEY],
          this.dependencies.config.channelId,
        );
        if (currentState.pendingReview) {
          pausedForReview = true;
          break;
        }
      }

      const latestRootState = await this.dependencies.state.load();
      const latestState = readCountingChainState(
        latestRootState[STATE_KEY],
        this.dependencies.config.channelId,
      );
      const newestMessageId = history[0]?.id;
      if (
        !pausedForReview &&
        newestMessageId &&
        isDiscordMessageAfter(newestMessageId, checkpointMessageId)
      ) {
        const game = latestState.game ?? createInitialGameState(this.currentTime());
        game.lastProcessedMessageId = newestMessageId;
        game.updatedAt = this.currentTime().toISOString();
        latestState.game = game;
      }
      latestState.historyRecoveryPending = false;
      writeCountingChainState(latestRootState, latestState);
      await this.dependencies.state.save(latestRootState);
      this.dependencies.logger.info(
        {
          channelId: this.dependencies.config.channelId,
          checkpointMessageId,
          processedImageCount: pendingMessages.length,
          newestMessageId,
          pausedForReview,
        },
        'Counting chain startup reconciliation completed',
      );
    } catch (error: unknown) {
      const latestRootState = await this.dependencies.state.load();
      const latestState = readCountingChainState(
        latestRootState[STATE_KEY],
        this.dependencies.config.channelId,
      );
      latestState.historyRecoveryPending = true;
      writeCountingChainState(latestRootState, latestState);
      await this.dependencies.state.save(latestRootState);
      throw error;
    }
  }

  private async processMessage(
    message: CountingChainMessage,
    options: ProcessMessageOptions = {},
  ): Promise<void> {
    const imageSource = selectImageSource(message);
    if (!imageSource) {
      const contentUrlCount = extractImageUrls(message.content).length;
      const embedImageUrlCount = message.imageUrls?.length ?? 0;
      const logContext = {
        channelId: message.channelId,
        messageId: message.id,
        contentUrlCount,
        embedImageUrlCount,
      };
      if (contentUrlCount > 0 || embedImageUrlCount > 0) {
        this.dependencies.logger.info(
          logContext,
          'Counting chain message had no usable image source',
        );
      } else {
        this.dependencies.logger.debug(
          logContext,
          'Counting chain message had no supported image source',
        );
      }
      return;
    }

    const rootState = await this.dependencies.state.load();
    const state = readCountingChainState(rootState[STATE_KEY], message.channelId);
    if (state.pendingReview) {
      this.dependencies.logger.debug(
        {
          channelId: message.channelId,
          messageId: message.id,
          pendingReviewMessageId: state.pendingReview.messageId,
        },
        'Counting chain is paused for moderator review; skipping message',
      );
      return;
    }

    if (!options.fromHistory) {
      const game = state.game;
      const checkpointMessageId = game?.lastProcessedMessageId ?? game?.lastMessageId;
      const alreadyCheckpointed =
        checkpointMessageId !== undefined && checkpointMessageId !== null
          ? message.id === checkpointMessageId ||
            isDiscordMessageAtOrBefore(message.id, checkpointMessageId)
          : false;
      const alreadyAccepted = game?.lastMessageId === message.id;
      const alreadyMarked = game?.lastProcessedMessageId === message.id;
      const alreadyFeedback = hasCountingChainFeedbackReaction(message.botReactionEmojis);
      if (alreadyAccepted || alreadyCheckpointed || (alreadyMarked && alreadyFeedback)) {
        this.dependencies.logger.debug(
          { channelId: message.channelId, messageId: message.id, checkpointMessageId },
          'Counting chain message already processed; skipping duplicate or out-of-order event',
        );
        return;
      }
    }

    this.dependencies.logger.info(
      {
        channelId: message.channelId,
        messageId: message.id,
        imageSourceHost: getUrlHostname(imageSource.url),
        contentType: imageSource.contentType,
        size: imageSource.size,
      },
      'Counting chain image received',
    );

    let recognizedNumber: number | null;
    try {
      const image = await this.downloadImage(imageSource);
      recognizedNumber = await this.dependencies.recognizer.recognizeNumber(image);
    } catch (error: unknown) {
      this.dependencies.logger.warn(
        { err: error, channelId: message.channelId, messageId: message.id },
        'Counting chain image could not be read; game state unchanged',
      );
      if (this.isReviewEnabled()) {
        await this.createReviewRequest(message, undefined, 'unreadable');
        return;
      }
      await this.giveFeedback(
        message,
        RECOGNITION_FAILURE_REACTION,
        'I could not read that image. Please try again.',
      );
      await this.markMessageProcessed(message);
      return;
    }

    if (recognizedNumber === null) {
      if (this.isReviewEnabled()) {
        await this.createReviewRequest(message, undefined, 'unreadable');
        return;
      }
      await this.giveFeedback(
        message,
        RECOGNITION_FAILURE_REACTION,
        'I could not read that image. Please try again.',
      );
      await this.markMessageProcessed(message);
      return;
    }

    this.dependencies.logger.info(
      {
        channelId: message.channelId,
        messageId: message.id,
        authorId: message.authorId,
        recognizedNumber,
      },
      'Counting chain number recognized',
    );

    const game = state.game ?? createInitialGameState(this.currentTime());
    const passes =
      recognizedNumber === game.expectedNumber && message.authorId !== game.lastAuthorId;

    if (passes) {
      const now = this.currentTime();
      const highScore = Math.max(game.highScore, recognizedNumber);
      state.game = {
        expectedNumber: recognizedNumber + 1,
        lastAuthorId: message.authorId,
        lastMessageId: message.id,
        updatedAt: now.toISOString(),
        highScore,
        highScoreAt: recognizedNumber > game.highScore ? now.toISOString() : game.highScoreAt,
        lastRound: game.lastRound,
        lastRoundAt: game.lastRoundAt,
        lastRoundReason: game.lastRoundReason,
        lastProcessedMessageId: message.id,
      };
      state.lastGameEnding = null;
      writeCountingChainState(rootState, state);
      await this.dependencies.state.save(rootState);
      await this.publishInfo();
      await this.react(message, PASS_REACTION);
      return;
    }

    const reviewReason: CountingChainReviewReason =
      message.authorId === game.lastAuthorId ? 'same-user' : 'wrong-number';
    if (this.isReviewEnabled()) {
      await this.createReviewRequest(message, recognizedNumber, reviewReason);
      return;
    }

    const now = this.currentTime();
    const roundScore = Math.max(0, game.expectedNumber - 1);
    const highScore = Math.max(game.highScore, roundScore);
    state.lastGameEnding = {
      messageId: message.id,
      authorId: message.authorId,
      expectedNumber: game.expectedNumber,
      proposedNumber: normalizeReviewNumber(recognizedNumber),
      reason: reviewReason,
      endedAt: now.toISOString(),
    };
    state.game = createInitialGameState(now, {
      highScore,
      highScoreAt: roundScore > game.highScore ? now.toISOString() : game.highScoreAt,
      lastRound: roundScore,
      lastRoundAt: now.toISOString(),
      lastRoundReason: message.authorId === game.lastAuthorId ? 'same-user' : 'wrong-number',
      lastProcessedMessageId: message.id,
    });
    writeCountingChainState(rootState, state);
    await this.dependencies.state.save(rootState);
    await this.publishInfo();
    await this.react(message, RULE_FAILURE_REACTION);
    await this.reply(
      message,
      'Counting chain over — the next number was not accepted. Starting again at 1.',
    );
  }

  private async createReviewRequest(
    message: CountingChainMessage,
    proposedNumber: number | undefined,
    reason: CountingChainReviewReason,
  ): Promise<boolean> {
    if (!this.isReviewEnabled() || !selectImageSource(message)) {
      return false;
    }

    const rootState = await this.dependencies.state.load();
    const state = readCountingChainState(rootState[STATE_KEY], message.channelId);
    if (state.pendingReview) {
      if (state.pendingReview.messageId !== message.id) {
        this.dependencies.logger.warn(
          {
            channelId: message.channelId,
            messageId: message.id,
            pendingReviewMessageId: state.pendingReview.messageId,
          },
          'Counting chain review request ignored because another review is pending',
        );
        return false;
      }

      const normalizedProposedNumber = normalizeReviewNumber(proposedNumber);
      if (
        proposedNumber !== undefined &&
        normalizedProposedNumber !== state.pendingReview.proposedNumber
      ) {
        state.pendingReview = {
          ...state.pendingReview,
          proposedNumber: normalizedProposedNumber,
        };
        state.lastGameEnding = {
          messageId: state.pendingReview.messageId,
          authorId: state.pendingReview.authorId,
          expectedNumber: state.pendingReview.expectedNumber,
          proposedNumber: normalizedProposedNumber,
          reason: state.pendingReview.reason,
          endedAt: state.lastGameEnding?.endedAt ?? state.pendingReview.requestedAt,
        };
        writeCountingChainState(rootState, state);
        await this.dependencies.state.save(rootState);
        this.dependencies.logger.info(
          {
            channelId: message.channelId,
            messageId: message.id,
            proposedNumber,
          },
          'Counting chain pending review number updated',
        );
      }
      return true;
    }

    const now = this.currentTime();
    const game = state.game ?? createInitialGameState(now);
    const previousEnding =
      state.lastGameEnding?.messageId === message.id ? state.lastGameEnding : undefined;
    const expectedNumber = previousEnding?.expectedNumber ?? game.expectedNumber;
    const normalizedProposedNumber =
      previousEnding?.proposedNumber ?? normalizeReviewNumber(proposedNumber);
    const effectiveReason = previousEnding?.reason ?? reason;
    state.lastGameEnding = {
      messageId: message.id,
      authorId: message.authorId,
      expectedNumber,
      proposedNumber: normalizedProposedNumber,
      reason: effectiveReason,
      endedAt: previousEnding?.endedAt ?? now.toISOString(),
    };
    state.pendingReview = {
      messageId: message.id,
      authorId: message.authorId,
      expectedNumber,
      proposedNumber: normalizedProposedNumber,
      reason: effectiveReason,
      endedAt: previousEnding?.endedAt ?? now.toISOString(),
      requestedAt: now.toISOString(),
    };
    game.lastProcessedMessageId = message.id;
    game.updatedAt = now.toISOString();
    state.game = game;
    writeCountingChainState(rootState, state);
    await this.dependencies.state.save(rootState);

    await this.react(message, REVIEW_REQUEST_REACTION);
    const roleId = this.dependencies.config.reviewRoleId;
    const roleMention = roleId ? `<@&${roleId}> ` : '';
    const proposedText =
      normalizedProposedNumber === null ? 'not determined' : String(normalizedProposedNumber);
    await this.reply(
      message,
      `${roleMention}Counting chain review requested. Expected **${expectedNumber}**; proposed number **${proposedText}**. React with ${REVIEW_APPROVE_REACTION} to approve this post or ${REVIEW_REJECT_REACTION} to reset the chain.`,
      roleId ? { mentionRoleId: roleId } : undefined,
    );
    this.dependencies.logger.info(
      {
        channelId: message.channelId,
        messageId: message.id,
        authorId: message.authorId,
        expectedNumber,
        proposedNumber: normalizedProposedNumber,
        reason: effectiveReason,
      },
      'Counting chain moderator review requested',
    );
    return true;
  }

  private async applyReviewDecision(
    message: CountingChainMessage,
    decision: 'approve' | 'reject',
    reviewerId: string,
  ): Promise<boolean> {
    const rootState = await this.dependencies.state.load();
    const state = readCountingChainState(rootState[STATE_KEY], message.channelId);
    const pendingReview = state.pendingReview;
    if (!pendingReview || pendingReview.messageId !== message.id) {
      this.dependencies.logger.debug(
        {
          channelId: message.channelId,
          messageId: message.id,
          decision,
          reviewerId,
        },
        'Counting chain review reaction did not match a pending review',
      );
      return false;
    }

    const now = this.currentTime();
    const game = state.game ?? createInitialGameState(now);
    if (decision === 'approve') {
      const approvedNumber = pendingReview.proposedNumber ?? pendingReview.expectedNumber;
      const highScore = Math.max(game.highScore, approvedNumber);
      state.game = {
        expectedNumber: approvedNumber + 1,
        lastAuthorId: message.authorId,
        lastMessageId: message.id,
        updatedAt: now.toISOString(),
        highScore,
        highScoreAt: approvedNumber > game.highScore ? now.toISOString() : game.highScoreAt,
        lastRound: game.lastRound,
        lastRoundAt: game.lastRoundAt,
        lastRoundReason: game.lastRoundReason,
        lastProcessedMessageId: message.id,
      };
      state.lastGameEnding = null;
      state.pendingReview = null;
      writeCountingChainState(rootState, state);
      await this.dependencies.state.save(rootState);
      await this.publishInfo();
      await this.react(message, PASS_REACTION);
      this.dependencies.logger.info(
        {
          channelId: message.channelId,
          messageId: message.id,
          reviewerId,
          approvedNumber,
          expectedNumber: approvedNumber + 1,
        },
        'Counting chain moderator approved a post',
      );
      return true;
    }

    const roundScore = Math.max(0, pendingReview.expectedNumber - 1);
    const highScore = Math.max(game.highScore, roundScore);
    state.game = createInitialGameState(now, {
      highScore,
      highScoreAt: roundScore > game.highScore ? now.toISOString() : game.highScoreAt,
      lastRound: roundScore,
      lastRoundAt: now.toISOString(),
      lastRoundReason: 'moderator-rejected',
      lastProcessedMessageId: message.id,
    });
    state.lastGameEnding = null;
    state.pendingReview = null;
    writeCountingChainState(rootState, state);
    await this.dependencies.state.save(rootState);
    await this.publishInfo();
    await this.react(message, RULE_FAILURE_REACTION);
    await this.reply(message, 'Counting chain review rejected — the chain is starting again at 1.');
    this.dependencies.logger.info(
      {
        channelId: message.channelId,
        messageId: message.id,
        reviewerId,
        roundScore,
      },
      'Counting chain moderator rejected a post',
    );
    return true;
  }

  private isReviewEnabled(): boolean {
    return this.dependencies.config.reviewEnabled === true;
  }

  private async downloadImage(source: CountingChainAttachment): Promise<NumberImage> {
    if (source.size && source.size > this.dependencies.config.maxAttachmentBytes) {
      throw new Error('Counting chain image exceeds the configured attachment limit');
    }

    let requestUrl = source.url;
    let response: Response | undefined;
    let finalUrl: URL | undefined;
    for (let redirectCount = 0; redirectCount <= MAX_IMAGE_REDIRECTS; redirectCount += 1) {
      const validatedUrl = await validateRemoteImageUrl(requestUrl, this.lookupImplementation);
      response = await this.fetchImplementation(validatedUrl.toString(), {
        headers: { Accept: 'image/gif, image/jpeg, image/png, image/webp' },
        redirect: 'manual',
        signal: AbortSignal.timeout(15_000),
      });

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        await response.body?.cancel();
        if (!location) {
          throw new Error('Counting chain image redirect did not include a location');
        }
        if (redirectCount === MAX_IMAGE_REDIRECTS) {
          throw new Error('Counting chain image exceeded the redirect limit');
        }
        requestUrl = new URL(location, validatedUrl).toString();
        continue;
      }

      finalUrl = validatedUrl;
      break;
    }

    if (!response || !finalUrl) {
      throw new Error('Counting chain image request did not produce a response');
    }

    if (!response.ok) {
      throw new Error(`Counting chain image request failed with HTTP ${response.status}`);
    }

    if (response.url) {
      await validateRemoteImageUrl(response.url, this.lookupImplementation);
    }

    const responseContentType = normalizeContentType(response.headers.get('content-type'));
    const sourceContentType = normalizeContentType(source.contentType);
    const contentType =
      (responseContentType && IMAGE_TYPES.has(responseContentType)
        ? responseContentType
        : undefined) ??
      (sourceContentType && IMAGE_TYPES.has(sourceContentType) ? sourceContentType : undefined) ??
      contentTypeFromName(source.name);
    if (!contentType || !IMAGE_TYPES.has(contentType)) {
      throw new Error('Counting chain source is not a supported image');
    }

    const data = await readResponseBody(response, this.dependencies.config.maxAttachmentBytes);
    return { data, contentType };
  }

  private async react(message: CountingChainMessage, emoji: string): Promise<void> {
    if (message.botReactionEmojis?.includes(emoji)) {
      return;
    }

    try {
      await message.react(emoji);
    } catch (error: unknown) {
      this.dependencies.logger.warn(
        { err: error, channelId: message.channelId, messageId: message.id, emoji },
        'Counting chain reaction could not be added',
      );
    }
  }

  private async markMessageProcessed(message: CountingChainMessage): Promise<void> {
    const rootState = await this.dependencies.state.load();
    const state = readCountingChainState(rootState[STATE_KEY], message.channelId);
    const game = state.game ?? createInitialGameState(this.currentTime());
    game.lastProcessedMessageId = message.id;
    game.updatedAt = this.currentTime().toISOString();
    state.game = game;
    writeCountingChainState(rootState, state);
    await this.dependencies.state.save(rootState);
  }

  private async publishInfo(): Promise<void> {
    const channelId = this.dependencies.config.channelId;
    if (!this.infoPublisher || !channelId) {
      return;
    }

    try {
      const rootState = await this.dependencies.state.load();
      const state = readCountingChainState(rootState[STATE_KEY], channelId);
      const game = state.game ?? createInitialGameState(this.currentTime());
      const infoMessageId = await this.infoPublisher.update(game, state.infoMessageId ?? undefined);
      if (infoMessageId && infoMessageId !== state.infoMessageId) {
        state.infoMessageId = infoMessageId;
        writeCountingChainState(rootState, state);
        await this.dependencies.state.save(rootState);
      }
    } catch (error: unknown) {
      this.dependencies.logger.warn(
        { err: error, channelId },
        'Counting chain information message could not be updated',
      );
    }
  }

  private async giveFeedback(
    message: CountingChainMessage,
    emoji: string,
    content: string,
  ): Promise<void> {
    await this.react(message, emoji);
    await this.reply(message, content);
  }

  private async reply(
    message: CountingChainMessage,
    content: string,
    options?: CountingChainReplyOptions,
  ): Promise<void> {
    try {
      if (options) {
        await message.reply(content, options);
      } else {
        await message.reply(content);
      }
    } catch (error: unknown) {
      this.dependencies.logger.warn(
        { err: error, channelId: message.channelId, messageId: message.id },
        'Counting chain feedback message could not be sent',
      );
    }
  }

  private currentTime(): Date {
    return this.dependencies.clock?.() ?? new Date();
  }
}

export function createCountingChainService(
  dependencies: CountingChainServiceDependencies,
): CountingChainService {
  return new PersistentCountingChainService(dependencies);
}

async function saveInitialState(
  rootState: JsonState,
  state: CountingChainState,
  now: Date,
  stateStore: StateStore<JsonState>,
  historyRecoveryPending = false,
  lastProcessedMessageId: string | undefined = undefined,
): Promise<void> {
  state.game = createInitialGameState(now, {
    ...(lastProcessedMessageId ? { lastProcessedMessageId } : {}),
  });
  state.historyRecoveryPending = historyRecoveryPending;
  writeCountingChainState(rootState, state);
  await stateStore.save(rootState);
}

async function saveHistoryRecoveryPending(
  rootState: JsonState,
  state: CountingChainState,
  now: Date,
  stateStore: StateStore<JsonState>,
): Promise<void> {
  if (!state.game) {
    state.game = createInitialGameState(now);
  }
  state.historyRecoveryPending = true;
  writeCountingChainState(rootState, state);
  await stateStore.save(rootState);
}

function writeCountingChainState(rootState: JsonState, state: CountingChainState): void {
  rootState[STATE_KEY] = {
    version: state.version,
    infoMessageId: state.infoMessageId,
    ...(state.historyRecoveryPending ? { historyRecoveryPending: true } : {}),
    ...(state.lastGameEnding ? { lastGameEnding: state.lastGameEnding } : {}),
    ...(state.pendingReview ? { pendingReview: state.pendingReview } : {}),
    ...(state.game ?? {}),
  };
}

function findLatestRelevantHistoryMessage(
  history: readonly CountingChainHistoryMessage[],
): CountingChainHistoryMessage | undefined {
  for (const message of history) {
    if (isCountingChainFailureMessage(message)) {
      return message;
    }

    if (message.authorIsBot) {
      continue;
    }

    if (selectImageSource(message)) {
      return message;
    }
  }

  return undefined;
}

function sortHistoryNewestFirst(
  history: readonly CountingChainHistoryMessage[],
): CountingChainHistoryMessage[] {
  return [...history].sort(compareDiscordMessageIdsNewestFirst);
}

function sortHistoryOldestFirst(
  history: readonly CountingChainHistoryMessage[],
): CountingChainHistoryMessage[] {
  return sortHistoryNewestFirst(history).reverse();
}

function compareDiscordMessageIdsNewestFirst(
  left: CountingChainMessage,
  right: CountingChainMessage,
): number {
  return compareSnowflakeIdsNewestFirst(left.id, right.id);
}

function compareSnowflakeIdsNewestFirst(left: string, right: string): number {
  const leftIsSnowflake = /^\d+$/.test(left);
  const rightIsSnowflake = /^\d+$/.test(right);
  if (leftIsSnowflake && rightIsSnowflake) {
    const leftValue = BigInt(left);
    const rightValue = BigInt(right);
    return leftValue === rightValue ? 0 : leftValue > rightValue ? -1 : 1;
  }

  return 0;
}

function isDiscordSnowflake(value: string): boolean {
  return /^\d+$/.test(value);
}

function isDiscordMessageAfter(messageId: string, checkpointMessageId: string): boolean {
  if (!isDiscordSnowflake(messageId) || !isDiscordSnowflake(checkpointMessageId)) {
    return false;
  }

  return BigInt(messageId) > BigInt(checkpointMessageId);
}

function isDiscordMessageAtOrBefore(messageId: string, checkpointMessageId: string): boolean {
  if (!isDiscordSnowflake(messageId) || !isDiscordSnowflake(checkpointMessageId)) {
    return false;
  }

  return BigInt(messageId) <= BigInt(checkpointMessageId);
}

function isCountingChainFailureMessage(message: CountingChainHistoryMessage): boolean {
  if (
    message.content.startsWith('Counting chain over —') ||
    message.content.startsWith('I could not read that image.') ||
    message.content.startsWith('Counting chain review requested.') ||
    message.content.includes('Counting chain review requested.')
  ) {
    return true;
  }

  return message.botReactionEmojis.some(
    (emoji) =>
      emoji === RULE_FAILURE_REACTION ||
      emoji === RECOGNITION_FAILURE_REACTION ||
      emoji === REVIEW_REQUEST_REACTION,
  );
}

function hasCountingChainFeedbackReaction(emojis: readonly string[] | undefined): boolean {
  return Boolean(
    emojis?.some(
      (emoji) =>
        emoji === PASS_REACTION ||
        emoji === RULE_FAILURE_REACTION ||
        emoji === RECOGNITION_FAILURE_REACTION ||
        emoji === REVIEW_REQUEST_REACTION ||
        emoji === REVIEW_APPROVE_REACTION,
    ),
  );
}

function readCountingChainState(value: unknown, channelId?: string): CountingChainState {
  if (!isRecord(value) || value.version !== 1) {
    return {
      version: 1,
      game: null,
      infoMessageId: null,
      historyRecoveryPending: false,
      lastGameEnding: null,
      pendingReview: null,
    };
  }

  const currentGame = readGameState(value);
  const nestedGame = !currentGame ? readGameState(value.game) : undefined;
  const legacyGame =
    !currentGame && !nestedGame && isRecord(value.games)
      ? readGameState(
          channelId
            ? value.games[channelId]
            : Object.values(value.games).find((candidate) => isRecord(candidate)),
        )
      : undefined;

  return {
    version: 1,
    game: currentGame ?? nestedGame ?? legacyGame ?? null,
    infoMessageId: readNullableString(value.infoMessageId),
    historyRecoveryPending: value.historyRecoveryPending === true,
    lastGameEnding: readGameEnding(value.lastGameEnding),
    pendingReview: readPendingReview(value.pendingReview),
  };
}

function readGameEnding(value: unknown, fallbackEndedAt?: string): CountingChainGameEnding | null {
  if (!isRecord(value)) {
    return null;
  }

  const messageId = value.messageId;
  const authorId = value.authorId;
  const expectedNumber = value.expectedNumber;
  const proposedNumber = value.proposedNumber;
  const reason = value.reason;
  const endedAt = value.endedAt ?? fallbackEndedAt;
  if (
    typeof messageId !== 'string' ||
    typeof authorId !== 'string' ||
    typeof expectedNumber !== 'number' ||
    !Number.isSafeInteger(expectedNumber) ||
    expectedNumber <= 0 ||
    (typeof proposedNumber !== 'number' && proposedNumber !== null) ||
    (typeof proposedNumber === 'number' &&
      (!Number.isSafeInteger(proposedNumber) || proposedNumber <= 0)) ||
    !isCountingChainReviewReason(reason) ||
    typeof endedAt !== 'string'
  ) {
    return null;
  }

  return {
    messageId,
    authorId,
    expectedNumber,
    proposedNumber,
    reason,
    endedAt,
  };
}

function readPendingReview(value: unknown): CountingChainPendingReview | null {
  if (!isRecord(value)) {
    return null;
  }

  const requestedAt = value.requestedAt;
  if (typeof requestedAt !== 'string') {
    return null;
  }

  const ending = readGameEnding(value, requestedAt);
  if (!ending) {
    return null;
  }

  return {
    ...ending,
    requestedAt,
  };
}

function isCountingChainReviewReason(value: unknown): value is CountingChainReviewReason {
  return (
    value === 'unreadable' ||
    value === 'wrong-number' ||
    value === 'same-user' ||
    value === 'manual'
  );
}

function normalizeReviewNumber(value: number | undefined): number | null {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function readGameState(value: unknown): CountingChainGameState | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const expectedNumber = value.expectedNumber;
  const lastAuthorId = value.lastAuthorId;
  const lastMessageId = value.lastMessageId;
  const updatedAt = value.updatedAt;
  const lastProcessedMessageId = Object.prototype.hasOwnProperty.call(
    value,
    'lastProcessedMessageId',
  )
    ? readNullableString(value.lastProcessedMessageId)
    : readNullableString(lastMessageId);
  const legacyScore =
    typeof expectedNumber === 'number' && Number.isSafeInteger(expectedNumber)
      ? Math.max(0, expectedNumber - 1)
      : undefined;
  const highScore = readNonNegativeInteger(value.highScore, legacyScore);
  const lastRound = readNonNegativeInteger(value.lastRound, highScore);
  const highScoreAt = readNullableString(value.highScoreAt);
  const lastRoundAt = readNullableString(value.lastRoundAt);
  const lastRoundReason = readNullableString(value.lastRoundReason);
  if (
    typeof expectedNumber !== 'number' ||
    !Number.isSafeInteger(expectedNumber) ||
    expectedNumber <= 0 ||
    (typeof lastAuthorId !== 'string' && lastAuthorId !== null) ||
    (typeof lastMessageId !== 'string' && lastMessageId !== null) ||
    typeof updatedAt !== 'string'
  ) {
    return undefined;
  }

  return {
    expectedNumber,
    lastAuthorId,
    lastMessageId,
    updatedAt,
    highScore,
    highScoreAt,
    lastRound,
    lastRoundAt,
    lastRoundReason,
    lastProcessedMessageId,
  };
}

function createInitialGameState(
  now: Date,
  overrides: Partial<CountingChainGameState> = {},
): CountingChainGameState {
  return {
    expectedNumber: 1,
    lastAuthorId: null,
    lastMessageId: null,
    updatedAt: now.toISOString(),
    highScore: 0,
    highScoreAt: null,
    lastRound: 0,
    lastRoundAt: null,
    lastRoundReason: null,
    lastProcessedMessageId: null,
    ...overrides,
  };
}

function readNonNegativeInteger(value: unknown, fallback: number | undefined): number {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return value;
  }

  return fallback !== undefined && Number.isSafeInteger(fallback) && fallback >= 0 ? fallback : 0;
}

function readNullableString(value: unknown): string | null {
  return typeof value === 'string' || value === null ? value : null;
}

function selectImageAttachment(
  attachments: readonly CountingChainAttachment[],
): CountingChainAttachment | undefined {
  return attachments.find((attachment) => {
    const contentType = normalizeContentType(attachment.contentType);
    return (
      (contentType && IMAGE_TYPES.has(contentType)) || Boolean(contentTypeFromName(attachment.name))
    );
  });
}

function selectImageSource(message: CountingChainMessage): CountingChainAttachment | undefined {
  const attachment = selectImageAttachment(message.attachments);
  if (attachment) {
    return attachment;
  }

  for (const url of extractImageUrls(message.content)) {
    const source = createImageUrlSource(url, true);
    if (source) {
      return source;
    }
  }

  for (const url of message.imageUrls ?? []) {
    const source = createImageUrlSource(url, false);
    if (source) {
      return source;
    }
  }

  return undefined;
}

function extractImageUrls(content: string): string[] {
  const urls = content.match(/https?:\/\/[^\s<>"']+/gi) ?? [];
  return urls.map((url) => url.replace(/[),.!?;:'\]]+$/g, ''));
}

function createImageUrlSource(
  urlValue: string,
  requireImagePath: boolean,
): CountingChainAttachment | undefined {
  let url: URL;
  try {
    url = new URL(urlValue);
  } catch {
    return undefined;
  }

  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    (url.port && url.port !== '443') ||
    (requireImagePath && !isLikelyImageUrl(url))
  ) {
    return undefined;
  }

  const name = url.pathname.split('/').pop() || undefined;
  return {
    url: url.toString(),
    ...(name ? { name } : {}),
  };
}

function isLikelyImageUrl(url: URL): boolean {
  return Boolean(contentTypeFromName(url.pathname.split('/').pop()));
}

function getUrlHostname(value: string): string | undefined {
  try {
    return new URL(value).hostname;
  } catch {
    return undefined;
  }
}

async function lookupRemoteAddresses(
  hostname: string,
): Promise<readonly CountingChainRemoteAddress[]> {
  const addresses = await dnsLookup(hostname.replace(/^\[|\]$/g, ''), {
    all: true,
    verbatim: true,
  });
  return addresses.map(({ address, family }) => {
    if (family !== 4 && family !== 6) {
      throw new Error('Counting chain image hostname returned an unsupported address family');
    }
    return { address, family };
  });
}

async function validateRemoteImageUrl(
  value: string,
  lookupImplementation: CountingChainRemoteAddressLookup,
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error: unknown) {
    throw new Error('Counting chain image URL is invalid', { cause: error });
  }

  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    (url.port && url.port !== '443')
  ) {
    throw new Error('Counting chain image URL must use HTTPS on the default port');
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  let addresses: readonly CountingChainRemoteAddress[];
  try {
    addresses = await lookupImplementation(hostname);
  } catch (error: unknown) {
    throw new Error('Counting chain image hostname could not be resolved', { cause: error });
  }

  if (
    addresses.length === 0 ||
    addresses.some(({ address, family }) => isBlockedRemoteAddress(address, family))
  ) {
    throw new Error('Counting chain image hostname resolves to a private or reserved address');
  }

  return url;
}

function isBlockedRemoteAddress(address: string, family: 4 | 6): boolean {
  if (family === 6 && isIPv4MappedAddress(address)) {
    return true;
  }

  return BLOCKED_REMOTE_NETWORKS.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

function isIPv4MappedAddress(address: string): boolean {
  const normalizedAddress = address.toLowerCase();
  return normalizedAddress.startsWith('::ffff:') || normalizedAddress.startsWith('0:0:0:0:0:ffff:');
}

function normalizeContentType(value: string | null | undefined): string | undefined {
  const contentType = value?.split(';', 1)[0]?.trim().toLowerCase();
  return contentType || undefined;
}

function contentTypeFromName(name: string | undefined): string | undefined {
  const extension = name?.split('.').pop()?.toLowerCase();
  return {
    gif: 'image/gif',
    jpeg: 'image/jpeg',
    jpg: 'image/jpeg',
    png: 'image/png',
    webp: 'image/webp',
  }[extension ?? ''];
}

async function readResponseBody(response: Response, maximumBytes: number): Promise<Buffer> {
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maximumBytes) {
    throw new Error('Counting chain image exceeds the configured attachment limit');
  }

  if (!response.body) {
    const data = Buffer.from(await response.arrayBuffer());
    if (data.byteLength > maximumBytes) {
      throw new Error('Counting chain image exceeds the configured attachment limit');
    }
    return data;
  }

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) {
      break;
    }

    totalBytes += result.value.byteLength;
    if (totalBytes > maximumBytes) {
      await reader.cancel();
      throw new Error('Counting chain image exceeds the configured attachment limit');
    }
    chunks.push(Buffer.from(result.value));
  }

  return Buffer.concat(chunks, totalBytes);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
