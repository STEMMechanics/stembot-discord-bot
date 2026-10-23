import { randomUUID } from 'node:crypto';

import type {
  StemQuizAnswerResult,
  StemQuizEngine,
  StemQuizQuestion,
  StemQuizQuestionHistory,
  StemQuizQuestionOptions,
} from '../integrations/openai-quiz.js';
import type { AppLogger } from '../logging/logger.js';
import type { JsonState, StateStore } from '../state/state-store.js';

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
}

export interface StemQuizMessage {
  id: string;
  channelId: string;
  authorId: string;
  authorIsBot: boolean;
  content: string;
  react(emoji: string): Promise<void>;
}

export interface StemQuizPublisher {
  send(channelId: string, content: string): Promise<string>;
}

export interface StemQuizService {
  initialize(): Promise<void>;
  ensureQuestion(): Promise<void>;
  handleMessage(message: StemQuizMessage): Promise<void>;
}

interface StemQuizQuestionState extends StemQuizQuestion {
  id: string;
  messageId: string;
  questionNumber: number;
  wrongAttempts: number;
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

export class PersistentStemQuizService implements StemQuizService {
  private readonly currentTime: () => Date;
  private readonly random: () => number;
  private readonly idFactory: () => string;
  private eventQueue: Promise<void> = Promise.resolve();

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

  private async handleIncorrectAnswer(
    rootState: JsonState,
    state: StemQuizState,
    question: StemQuizQuestionState,
    message: StemQuizMessage,
  ): Promise<void> {
    question.wrongAttempts += 1;
    await this.react(message, WRONG_REACTION);

    if (question.wrongAttempts < this.dependencies.config.maxWrongAnswers) {
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

  private isEnabled(): boolean {
    return this.dependencies.config.enabled && Boolean(this.dependencies.config.channelId);
  }

  private async enqueue(work: () => Promise<void>): Promise<void> {
    const next = this.eventQueue.catch(() => undefined).then(work);
    this.eventQueue = next.then(
      () => undefined,
      () => undefined,
    );
    await next;
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
  const sections = [leadIn, `🧠 **Question ${questionNumber}**`, question.prompt];
  return sections.filter((section): section is string => Boolean(section)).join('\n\n');
}

function readStemQuizState(value: unknown): StemQuizState {
  if (!isRecord(value) || value.version !== 1) {
    return createInitialState();
  }

  const question = readQuestionState(value.question);
  const scores: Record<string, number> = {};
  if (isRecord(value.scores)) {
    for (const [key, score] of Object.entries(value.scores)) {
      if (key.length > 0 && typeof score === 'number' && Number.isInteger(score) && score >= 0) {
        scores[key] = score;
      }
    }
  }
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
  };
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
