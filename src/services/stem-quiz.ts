import { randomUUID } from 'node:crypto';

import type {
  StemQuizAnswerResult,
  StemQuizEngine,
  StemQuizQuestion,
  StemQuizQuestionHistory,
  StemQuizQuestionOptions,
  StemQuizQuestionType,
} from '../integrations/openai-quiz.js';
import type { AppLogger } from '../logging/logger.js';
import type { JsonState, StateStore } from '../state/state-store.js';
import {
  readMinigameScores,
  toMinigameLeaderboard,
  type MinigameLeaderboardEntry,
} from './minigame-leaderboards.js';
import type { UserLevelService } from './user-levels.js';
import { isDiscordMessageBefore } from './message-order.js';
import { isMinigameHintRequest } from './minigame-hints.js';

export interface StemQuizConfig {
  enabled: boolean;
  channelId?: string;
  maxWrongAnswers: number;
  targetAgeMin: number;
  targetAgeMax: number;
  olderAgeMax: number;
  olderPlayerRate: number;
  topic: string;
  retryIntervalMs: number;
  idleTimeoutMs?: number;
}

export interface StemQuizMessage {
  id: string;
  channelId: string;
  authorId: string;
  authorIsBot: boolean;
  content: string;
  hintRequest?: boolean;
  react(emoji: string): Promise<void>;
  reply?(content: string): Promise<void>;
}

export interface StemQuizPublisher {
  send(channelId: string, content: string): Promise<string>;
}

export interface StemQuizService {
  initialize(): Promise<void>;
  ensureQuestion(): Promise<void>;
  checkInactivity(): Promise<void>;
  handleMessage(message: StemQuizMessage): Promise<void>;
  getLeaderboard(limit: number): Promise<readonly MinigameLeaderboardEntry[]>;
}

interface StemQuizQuestionState extends StemQuizQuestion {
  id: string;
  messageId: string;
  questionNumber: number;
  wrongAttempts: number;
  wrongOptions: number[];
  hints: string[];
  askedAt: string;
}

interface StemQuizState {
  version: 1;
  nextQuestionNumber: number;
  question: StemQuizQuestionState | null;
  scores: Record<string, number>;
  processedMessageIds: string[];
  recentQuestions: StemQuizQuestionHistory[];
}

interface StemQuizServiceDependencies {
  config: StemQuizConfig;
  engine: StemQuizEngine;
  publisher: StemQuizPublisher;
  state: StateStore<JsonState>;
  logger: AppLogger;
  userLevels?: UserLevelService;
  clock?: () => Date;
  random?: () => number;
  idFactory?: () => string;
}

const STATE_KEY = 'stemQuiz';
const PASS_REACTION = '✅';
const WRONG_REACTION = '❌';
const UNCLEAR_REACTION = '🤔';
const EVALUATION_FAILURE_REACTION = '⚠️';
const MAX_PROCESSED_MESSAGE_IDS = 500;
const MAX_RECENT_QUESTIONS = 20;
const MAX_QUESTION_GENERATION_ATTEMPTS = 3;
const MAX_HINTS_PER_QUESTION = 5;
const QUIZ_HINT_USER_COOLDOWN_MS = 5_000;
const QUIZ_HINT_GLOBAL_WINDOW_MS = 60_000;
const QUIZ_HINT_GLOBAL_LIMIT = 30;
const DEFAULT_IDLE_TIMEOUT_MS = 259200000;

export class PersistentStemQuizService implements StemQuizService {
  private readonly currentTime: () => Date;
  private readonly random: () => number;
  private readonly idFactory: () => string;
  private eventQueue: Promise<void> = Promise.resolve();
  private readonly lastHintAt = new Map<string, number>();
  private hintWindowStartedAt = 0;
  private hintWindowRequestCount = 0;

  public constructor(private readonly dependencies: StemQuizServiceDependencies) {
    this.currentTime = dependencies.clock ?? (() => new Date());
    this.random = dependencies.random ?? Math.random;
    this.idFactory = dependencies.idFactory ?? randomUUID;
  }

  public async initialize(): Promise<void> {
    await this.ensureQuestion();
  }

  public async ensureQuestion(): Promise<void> {
    if (!this.isEnabled()) {
      return;
    }

    await this.enqueue(async () => {
      const rootState = await this.dependencies.state.load();
      const state = readStemQuizState(rootState[STATE_KEY]);
      if (state.question) {
        return;
      }

      await this.publishNextQuestion(rootState, state);
    });
  }

  public async checkInactivity(): Promise<void> {
    if (!this.isEnabled()) {
      return;
    }

    await this.enqueue(async () => {
      const rootState = await this.dependencies.state.load();
      const state = readStemQuizState(rootState[STATE_KEY]);
      const question = state.question;
      if (!question) {
        return;
      }

      const askedAt = Date.parse(question.askedAt);
      const now = this.currentTime();
      const idleTimeoutMs = this.dependencies.config.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
      if (!Number.isFinite(askedAt) || now.getTime() - askedAt < idleTimeoutMs) {
        return;
      }

      state.question = null;
      writeStemQuizState(rootState, state);
      await this.dependencies.state.save(rootState);
      const leadIn = [
        `💥 This one was too tough for everyone! The answer was **${question.answer}**. ${question.explanation}`,
        'A fresh question starts now.',
      ].join('\n\n');
      await this.publishNextQuestion(rootState, state, leadIn);
      this.dependencies.logger.info(
        {
          channelId: this.dependencies.config.channelId,
          questionId: question.id,
          questionNumber: question.questionNumber,
        },
        'STEM quiz inactivity timeout revealed the answer and advanced the question',
      );
    });
  }

  public async getLeaderboard(limit: number): Promise<readonly MinigameLeaderboardEntry[]> {
    if (!this.dependencies.config.enabled) {
      return [];
    }

    return this.enqueue(async () => {
      const rootState = await this.dependencies.state.load();
      const state = readStemQuizState(rootState[STATE_KEY]);
      return toMinigameLeaderboard(state.scores, limit);
    });
  }

  public async handleMessage(message: StemQuizMessage): Promise<void> {
    if (!this.isEnabled() || message.channelId !== this.dependencies.config.channelId) {
      return;
    }

    if (message.authorIsBot || message.content.trim().length === 0) {
      return;
    }

    await this.enqueue(() => this.processMessage(message));
  }

  private async processMessage(message: StemQuizMessage): Promise<void> {
    const rootState = await this.dependencies.state.load();
    const state = readStemQuizState(rootState[STATE_KEY]);
    const question = state.question;
    if (!question) {
      this.dependencies.logger.debug(
        { channelId: message.channelId, messageId: message.id },
        'STEM quiz message ignored because no question is active',
      );
      return;
    }

    if (state.processedMessageIds.includes(message.id)) {
      this.dependencies.logger.debug(
        { channelId: message.channelId, messageId: message.id, questionId: question.id },
        'STEM quiz message ignored because it was already processed',
      );
      return;
    }

    if (isDiscordMessageBefore(message.id, question.messageId)) {
      state.processedMessageIds = rememberMessageId(state.processedMessageIds, message.id);
      writeStemQuizState(rootState, state);
      await this.dependencies.state.save(rootState);
      this.dependencies.logger.info(
        {
          channelId: message.channelId,
          messageId: message.id,
          questionId: question.id,
          questionMessageId: question.messageId,
        },
        'STEM quiz answer skipped because it was sent before the active question',
      );
      return;
    }

    if (message.hintRequest === true || isMinigameHintRequest(message.content)) {
      await this.processHintRequest(rootState, state, question, message);
      return;
    }

    if (isStemQuizSkipRequest(message.content)) {
      await this.processSkipRequest(rootState, state, question, message);
      return;
    }

    let result: StemQuizAnswerResult;
    try {
      result = await this.evaluateAnswer(question, message.content);
    } catch (error: unknown) {
      await this.react(message, EVALUATION_FAILURE_REACTION);
      this.dependencies.logger.warn(
        {
          err: error,
          channelId: message.channelId,
          messageId: message.id,
          questionId: question.id,
        },
        'STEM quiz answer could not be evaluated; no attempt was counted',
      );
      return;
    }

    state.processedMessageIds = rememberMessageId(state.processedMessageIds, message.id);

    if (result === 'unclear') {
      writeStemQuizState(rootState, state);
      await this.dependencies.state.save(rootState);
      await this.react(message, UNCLEAR_REACTION);
      this.dependencies.logger.info(
        { channelId: message.channelId, messageId: message.id, questionId: question.id },
        'STEM quiz answer was unclear; question remains open',
      );
      return;
    }

    if (result === 'correct') {
      await this.handleCorrectAnswer(rootState, state, question, message);
      return;
    }

    await this.handleIncorrectAnswer(rootState, state, question, message);
  }

  private async evaluateAnswer(
    question: StemQuizQuestionState,
    answer: string,
  ): Promise<StemQuizAnswerResult> {
    const normalizedAnswer = normalizeQuizText(answer);
    const acceptedAnswers = [question.answer, ...question.acceptedAnswers].map(normalizeQuizText);
    if (normalizedAnswer.length > 0 && acceptedAnswers.includes(normalizedAnswer)) {
      return 'correct';
    }

    const localChoiceResult = evaluateChoiceAnswer(question, answer);
    if (localChoiceResult) {
      return localChoiceResult;
    }

    return this.dependencies.engine.evaluateAnswer(question, answer.slice(0, 500));
  }

  private async handleCorrectAnswer(
    rootState: JsonState,
    state: StemQuizState,
    question: StemQuizQuestionState,
    message: StemQuizMessage,
  ): Promise<void> {
    const currentScore = state.scores[message.authorId] ?? 0;
    state.scores[message.authorId] = currentScore + 1;
    state.question = null;
    writeStemQuizState(rootState, state);
    await this.dependencies.state.save(rootState);
    await this.react(message, PASS_REACTION);
    await this.recordGameParticipation(message);

    const leadIn = [
      `🎉 <@${message.authorId}> got it! **${question.answer}** was correct.`,
      question.explanation,
    ].join('\n');
    await this.publishNextQuestion(rootState, state, leadIn);
    const score = state.scores[message.authorId] ?? 0;
    this.dependencies.logger.info(
      {
        channelId: message.channelId,
        messageId: message.id,
        questionId: question.id,
        userId: message.authorId,
        score,
      },
      'STEM quiz answer accepted',
    );
  }

  private async processHintRequest(
    rootState: JsonState,
    state: StemQuizState,
    question: StemQuizQuestionState,
    message: StemQuizMessage,
  ): Promise<void> {
    state.processedMessageIds = rememberMessageId(state.processedMessageIds, message.id);
    writeStemQuizState(rootState, state);
    await this.dependencies.state.save(rootState);

    if (question.hints.length >= MAX_HINTS_PER_QUESTION) {
      await this.replySafely(
        message,
        '💡 I have given all the extra clues I have for this question. Have a go with the clues above!',
      );
      return;
    }

    if (!this.canRequestHint(message.authorId)) {
      await this.replySafely(
        message,
        '💡 Give me a moment to think before asking for another clue.',
      );
      return;
    }

    let hint: string | undefined;
    if (this.dependencies.engine.generateHint) {
      try {
        const generatedHint = (
          await this.dependencies.engine.generateHint(question, question.hints)
        ).trim();
        if (isUsableQuizHint(generatedHint, question, question.hints)) {
          hint = generatedHint;
        }
      } catch (error: unknown) {
        this.dependencies.logger.warn(
          { err: error, channelId: message.channelId, questionId: question.id },
          'STEM quiz hint could not be generated; using a local clue',
        );
      }
    }

    if (!hint) {
      hint = createFallbackQuizHint(question);
    }

    question.hints = [...question.hints, hint].slice(-MAX_HINTS_PER_QUESTION);
    writeStemQuizState(rootState, state);
    await this.dependencies.state.save(rootState);
    await this.replySafely(message, `💡 Hint: ${hint}`);
  }

  private async processSkipRequest(
    rootState: JsonState,
    state: StemQuizState,
    question: StemQuizQuestionState,
    message: StemQuizMessage,
  ): Promise<void> {
    state.processedMessageIds = rememberMessageId(state.processedMessageIds, message.id);
    state.question = null;
    writeStemQuizState(rootState, state);
    await this.dependencies.state.save(rootState);
    await this.publishNextQuestion(
      rootState,
      state,
      `⏭️ Question skipped. The answer was **${question.answer}**. ${question.explanation}`,
    );
    this.dependencies.logger.info(
      {
        channelId: message.channelId,
        messageId: message.id,
        questionId: question.id,
      },
      'STEM quiz question skipped by a player',
    );
  }

  private async handleIncorrectAnswer(
    rootState: JsonState,
    state: StemQuizState,
    question: StemQuizQuestionState,
    message: StemQuizMessage,
  ): Promise<void> {
    question.wrongAttempts += 1;
    const selectedOptionIndex = readSelectedChoiceIndex(question, message.content);
    if (selectedOptionIndex !== undefined) {
      question.wrongOptions = [...new Set([...question.wrongOptions, selectedOptionIndex])];
    }
    await this.react(message, WRONG_REACTION);

    const multipleChoiceLimitReached =
      question.type === 'multiple-choice' &&
      (question.wrongOptions.length >= Math.max(1, (question.options?.length ?? 0) - 1) ||
        question.wrongAttempts >= this.dependencies.config.maxWrongAnswers);
    const questionEnded =
      question.type === 'true-false' ||
      multipleChoiceLimitReached ||
      (question.type !== 'multiple-choice' &&
        question.wrongAttempts >= this.dependencies.config.maxWrongAnswers);

    if (!questionEnded) {
      writeStemQuizState(rootState, state);
      await this.dependencies.state.save(rootState);
      this.dependencies.logger.info(
        {
          channelId: message.channelId,
          messageId: message.id,
          questionId: question.id,
          wrongAttempts: question.wrongAttempts,
        },
        'STEM quiz answer was incorrect; question remains open',
      );
      return;
    }

    state.question = null;
    writeStemQuizState(rootState, state);
    await this.dependencies.state.save(rootState);
    const leadIn = [
      `The answer was **${question.answer}**. ${question.explanation}`,
      `No worries — the next question starts now.`,
    ].join('\n\n');
    await this.publishNextQuestion(rootState, state, leadIn);
    this.dependencies.logger.info(
      {
        channelId: message.channelId,
        messageId: message.id,
        questionId: question.id,
        wrongAttempts: question.wrongAttempts,
      },
      'STEM quiz answer limit reached; answer revealed and question advanced',
    );
  }

  private async publishNextQuestion(
    rootState: JsonState,
    state: StemQuizState,
    leadIn?: string,
  ): Promise<void> {
    const olderPlayerChallenge = this.random() < this.dependencies.config.olderPlayerRate;
    const questionOptions: StemQuizQuestionOptions = {
      topic: this.dependencies.config.topic,
      targetAgeMin: this.dependencies.config.targetAgeMin,
      targetAgeMax: this.dependencies.config.targetAgeMax,
      olderAgeMax: this.dependencies.config.olderAgeMax,
      olderPlayerChallenge,
      questionType: selectQuestionType(this.random()),
      ...(state.recentQuestions.length > 0 ? { avoidQuestions: state.recentQuestions } : {}),
    };
    const question = await this.generateQuestionAvoidingDuplicates(
      questionOptions,
      state.recentQuestions,
    );
    const questionNumber = state.nextQuestionNumber;
    const questionId = this.idFactory();
    const messageId = await this.dependencies.publisher.send(
      this.dependencies.config.channelId!,
      formatStemQuizQuestion(question, questionNumber, leadIn),
    );
    const now = this.currentTime().toISOString();
    state.question = {
      ...question,
      id: questionId,
      messageId,
      questionNumber,
      wrongAttempts: 0,
      wrongOptions: [],
      hints: [],
      askedAt: now,
    };
    state.recentQuestions = rememberQuestion(state.recentQuestions, question);
    state.nextQuestionNumber += 1;
    writeStemQuizState(rootState, state);
    await this.dependencies.state.save(rootState);
    this.dependencies.logger.info(
      {
        channelId: this.dependencies.config.channelId,
        questionId,
        questionNumber,
        olderPlayerChallenge,
      },
      'STEM quiz question posted',
    );
  }

  private canRequestHint(authorId: string): boolean {
    const now = Date.now();
    const lastRequestedAt = this.lastHintAt.get(authorId);
    if (lastRequestedAt && now - lastRequestedAt < QUIZ_HINT_USER_COOLDOWN_MS) {
      return false;
    }

    if (now - this.hintWindowStartedAt >= QUIZ_HINT_GLOBAL_WINDOW_MS) {
      this.hintWindowStartedAt = now;
      this.hintWindowRequestCount = 0;
    }

    if (this.hintWindowRequestCount >= QUIZ_HINT_GLOBAL_LIMIT) {
      return false;
    }

    this.lastHintAt.set(authorId, now);
    this.hintWindowRequestCount += 1;
    return true;
  }

  private async generateQuestionAvoidingDuplicates(
    options: StemQuizQuestionOptions,
    recentQuestions: readonly StemQuizQuestionHistory[],
  ): Promise<StemQuizQuestion> {
    for (let attempt = 1; attempt <= MAX_QUESTION_GENERATION_ATTEMPTS; attempt += 1) {
      const question = await this.dependencies.engine.generateQuestion(options);
      if (!isDuplicateQuestion(question, recentQuestions)) {
        return question;
      }

      this.dependencies.logger.warn(
        {
          attempt,
          maxAttempts: MAX_QUESTION_GENERATION_ATTEMPTS,
          questionPrompt: question.prompt,
        },
        'STEM quiz generated a recent question again; requesting a replacement',
      );
    }

    throw new Error(
      `STEM quiz generated a duplicate question ${MAX_QUESTION_GENERATION_ATTEMPTS} times`,
    );
  }

  private async react(message: StemQuizMessage, emoji: string): Promise<void> {
    try {
      await message.react(emoji);
    } catch (error: unknown) {
      this.dependencies.logger.warn(
        { err: error, channelId: message.channelId, messageId: message.id, emoji },
        'STEM quiz reaction could not be added',
      );
    }
  }

  private async replySafely(message: StemQuizMessage, content: string): Promise<void> {
    if (!message.reply) {
      this.dependencies.logger.warn(
        { channelId: message.channelId, messageId: message.id },
        'STEM quiz reply could not be sent because the message adapter has no reply method',
      );
      return;
    }

    try {
      await message.reply(content);
    } catch (error: unknown) {
      this.dependencies.logger.warn(
        { err: error, channelId: message.channelId, messageId: message.id },
        'STEM quiz reply could not be sent',
      );
    }
  }

  private async recordGameParticipation(message: StemQuizMessage): Promise<void> {
    try {
      await this.dependencies.userLevels?.recordGameParticipation(message.authorId);
    } catch (error: unknown) {
      this.dependencies.logger.warn(
        {
          err: error,
          channelId: message.channelId,
          messageId: message.id,
          userId: message.authorId,
        },
        'STEM quiz game XP could not be recorded',
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
    return await next;
  }
}

export function createStemQuizService(dependencies: StemQuizServiceDependencies): StemQuizService {
  return new PersistentStemQuizService(dependencies);
}

export function formatStemQuizQuestion(
  question: StemQuizQuestion,
  questionNumber: number,
  leadIn?: string,
): string {
  const type = question.type ?? 'short-answer';
  const answerPrompt =
    type === 'true-false'
      ? '**True or false?**'
      : type === 'multiple-choice'
        ? [
            '**Choose one:**',
            ...(question.options ?? []).map((option, index) => `${choiceLetter(index)}) ${option}`),
          ].join('\n')
        : undefined;
  const sections = [leadIn, `🧠 **Question ${questionNumber}**`, question.prompt, answerPrompt];
  sections.push('*You can ask for a hint or skip this question.*');
  return sections.filter((section): section is string => Boolean(section)).join('\n\n');
}

function readStemQuizState(value: unknown): StemQuizState {
  if (!isRecord(value) || value.version !== 1) {
    return createInitialState();
  }

  const question = readQuestionState(value.question);
  const scores = readMinigameScores(value.scores);
  const processedMessageIds = Array.isArray(value.processedMessageIds)
    ? value.processedMessageIds
        .filter((id): id is string => typeof id === 'string')
        .slice(-MAX_PROCESSED_MESSAGE_IDS)
    : [];
  let recentQuestions = readRecentQuestions(value.recentQuestions);
  if (question && !isDuplicateQuestion(question, recentQuestions)) {
    recentQuestions = [
      ...recentQuestions,
      { prompt: question.prompt, answer: question.answer },
    ].slice(-MAX_RECENT_QUESTIONS);
  }
  const nextQuestionNumber =
    typeof value.nextQuestionNumber === 'number' &&
    Number.isInteger(value.nextQuestionNumber) &&
    value.nextQuestionNumber > 0
      ? value.nextQuestionNumber
      : 1;

  return {
    version: 1,
    nextQuestionNumber,
    question,
    scores,
    processedMessageIds,
    recentQuestions,
  };
}

function readRecentQuestions(value: unknown): StemQuizQuestionHistory[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter(isQuestionHistory)
    .map((recentQuestion) => ({
      prompt: recentQuestion.prompt,
      answer: recentQuestion.answer,
    }))
    .slice(-MAX_RECENT_QUESTIONS);
}

function isQuestionHistory(value: unknown): value is StemQuizQuestionHistory {
  return (
    isRecord(value) &&
    typeof value.prompt === 'string' &&
    value.prompt.trim().length > 0 &&
    typeof value.answer === 'string' &&
    value.answer.trim().length > 0
  );
}

function readQuestionState(value: unknown): StemQuizQuestionState | null {
  if (!isRecord(value)) {
    return null;
  }

  if (
    typeof value.id !== 'string' ||
    typeof value.messageId !== 'string' ||
    typeof value.questionNumber !== 'number' ||
    !Number.isInteger(value.questionNumber) ||
    typeof value.wrongAttempts !== 'number' ||
    !Number.isInteger(value.wrongAttempts) ||
    typeof value.askedAt !== 'string' ||
    typeof value.prompt !== 'string' ||
    typeof value.answer !== 'string' ||
    !Array.isArray(value.acceptedAnswers) ||
    !value.acceptedAnswers.every((answer): answer is string => typeof answer === 'string') ||
    typeof value.explanation !== 'string'
  ) {
    return null;
  }

  const type = readQuestionType(value.type);
  const options = readQuestionOptions(value.options);
  if (value.type !== undefined && !type) {
    return null;
  }
  if (value.options !== undefined && !options) {
    return null;
  }
  if (type === 'multiple-choice' && (options?.length ?? 0) < 2) {
    return null;
  }
  if (type !== 'multiple-choice' && (options?.length ?? 0) > 0) {
    return null;
  }

  const wrongOptions = readWrongOptionIndexes(value.wrongOptions, options?.length ?? 0);
  const hints = readHintList(value.hints);

  return {
    id: value.id,
    messageId: value.messageId,
    questionNumber: value.questionNumber,
    wrongAttempts: value.wrongAttempts,
    askedAt: value.askedAt,
    prompt: value.prompt,
    answer: value.answer,
    acceptedAnswers: value.acceptedAnswers,
    explanation: value.explanation,
    wrongOptions,
    hints,
    ...(type ? { type } : {}),
    ...(options ? { options } : {}),
  };
}

function evaluateChoiceAnswer(
  question: StemQuizQuestion,
  answer: string,
): StemQuizAnswerResult | undefined {
  const type = question.type ?? 'short-answer';
  if (type === 'short-answer') {
    return undefined;
  }

  const normalizedAnswer = normalizeQuizText(answer);
  if (type === 'true-false') {
    if (['true', 't'].includes(normalizedAnswer)) {
      return normalizeQuizText(question.answer) === 'true' ? 'correct' : 'incorrect';
    }
    if (['false', 'f'].includes(normalizedAnswer)) {
      return normalizeQuizText(question.answer) === 'false' ? 'correct' : 'incorrect';
    }
    return undefined;
  }

  const options = question.options ?? [];
  const selectedIndex = readSelectedChoiceIndex(question, answer);
  if (selectedIndex === undefined) {
    return undefined;
  }

  const selectedOption = options[selectedIndex];
  if (!selectedOption) {
    return undefined;
  }

  const canonicalIndex = readChoiceIndex(question.answer, options.length);
  if (canonicalIndex !== undefined) {
    return canonicalIndex === selectedIndex ? 'correct' : 'incorrect';
  }

  const acceptedAnswers = [question.answer, ...question.acceptedAnswers].map(normalizeQuizText);
  return acceptedAnswers.includes(normalizeQuizText(selectedOption)) ? 'correct' : 'incorrect';
}

function readSelectedChoiceIndex(question: StemQuizQuestion, answer: string): number | undefined {
  if ((question.type ?? 'short-answer') !== 'multiple-choice') {
    return undefined;
  }

  const options = question.options ?? [];
  const normalizedAnswer = normalizeQuizText(answer);
  const optionIndex = readChoiceIndex(answer, options.length);
  const selectedTextIndex = options.findIndex(
    (option) => normalizeQuizText(option) === normalizedAnswer,
  );
  return optionIndex ?? (selectedTextIndex >= 0 ? selectedTextIndex : undefined);
}

function readChoiceIndex(answer: string, optionCount: number): number | undefined {
  const normalized = normalizeQuizText(answer);
  const letterMatch = normalized.match(/^([a-d])(?:\s+|\s*[.)])?$/);
  if (letterMatch?.[1]) {
    const index = letterMatch[1].charCodeAt(0) - 'a'.charCodeAt(0);
    return index >= 0 && index < optionCount ? index : undefined;
  }

  const numberMatch = normalized.match(/^([1-4])$/);
  if (numberMatch?.[1]) {
    const index = Number(numberMatch[1]) - 1;
    return index >= 0 && index < optionCount ? index : undefined;
  }

  return undefined;
}

function readQuestionType(value: unknown): StemQuizQuestion['type'] | undefined {
  return value === 'short-answer' || value === 'true-false' || value === 'multiple-choice'
    ? value
    : undefined;
}

function readQuestionOptions(value: unknown): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  return Array.isArray(value) && value.every((option) => typeof option === 'string')
    ? value
    : undefined;
}

function readWrongOptionIndexes(value: unknown, optionCount: number): number[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return [
    ...new Set(
      value.filter(
        (index): index is number =>
          typeof index === 'number' && Number.isInteger(index) && index >= 0 && index < optionCount,
      ),
    ),
  ];
}

function readHintList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((hint): hint is string => typeof hint === 'string' && hint.trim().length > 0)
    .map((hint) => hint.trim())
    .slice(-MAX_HINTS_PER_QUESTION);
}

function choiceLetter(index: number): string {
  return String.fromCharCode('A'.charCodeAt(0) + index);
}

function selectQuestionType(value: number): StemQuizQuestionType {
  const normalized = Math.max(0, Math.min(0.999999, value));
  if (normalized < 1 / 3) {
    return 'true-false';
  }
  if (normalized < 2 / 3) {
    return 'multiple-choice';
  }
  return 'short-answer';
}

function createInitialState(): StemQuizState {
  return {
    version: 1,
    nextQuestionNumber: 1,
    question: null,
    scores: {},
    processedMessageIds: [],
    recentQuestions: [],
  };
}

function writeStemQuizState(rootState: JsonState, state: StemQuizState): void {
  rootState[STATE_KEY] = state;
}

function rememberMessageId(messageIds: readonly string[], messageId: string): string[] {
  return [...messageIds.filter((id) => id !== messageId), messageId].slice(
    -MAX_PROCESSED_MESSAGE_IDS,
  );
}

function rememberQuestion(
  questions: readonly StemQuizQuestionHistory[],
  question: StemQuizQuestion,
): StemQuizQuestionHistory[] {
  return [...questions, { prompt: question.prompt, answer: question.answer }].slice(
    -MAX_RECENT_QUESTIONS,
  );
}

function isDuplicateQuestion(
  question: StemQuizQuestion,
  recentQuestions: readonly StemQuizQuestionHistory[],
): boolean {
  const normalizedPrompt = normalizeQuizText(question.prompt);
  return recentQuestions.some(
    (recentQuestion) => normalizeQuizText(recentQuestion.prompt) === normalizedPrompt,
  );
}

function normalizeQuizText(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export function isStemQuizSkipRequest(content: string): boolean {
  const normalized = normalizeQuizText(content);
  return /^(?:skip|skip question|skip this question)$/.test(normalized);
}

function isUsableQuizHint(
  hint: string,
  question: StemQuizQuestion,
  previousHints: readonly string[],
): boolean {
  if (
    !hint ||
    previousHints.some(
      (previousHint) => normalizeQuizText(previousHint) === normalizeQuizText(hint),
    )
  ) {
    return false;
  }

  const forbiddenAnswers = [
    question.answer,
    ...question.acceptedAnswers,
    ...(question.options ?? []),
  ].filter((answer) => answer.trim().length > 0);
  return !forbiddenAnswers.some((answer) => containsWholeWord(hint, answer));
}

function createFallbackQuizHint(question: StemQuizQuestion): string {
  switch (question.type) {
    case 'true-false':
      return 'Focus on the key scientific fact in the statement and recall whether it is accurate.';
    case 'multiple-choice':
      return 'Compare each option with the main STEM concept being tested and look for the best-supported choice.';
    default:
      return 'Break the question into its key STEM concept and recall the definition or principle it is asking about.';
  }
}

function containsWholeWord(value: string, word: string): boolean {
  const escapedWord = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escapedWord}\\b`, 'i').test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
