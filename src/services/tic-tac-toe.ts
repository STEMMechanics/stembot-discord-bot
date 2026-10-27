import { randomUUID } from 'node:crypto';

import type { AppLogger } from '../logging/logger.js';
import type { ButtonGameBoard, ButtonGameInteraction } from './button-games.js';
import {
  readMinigameScores,
  toMinigameLeaderboard,
  type MinigameLeaderboardEntry,
} from './minigame-leaderboards.js';
import type { UserLevelService } from './user-levels.js';
import type { JsonState, StateStore } from '../state/state-store.js';

type TicTacToeMark = 'X' | 'O';
type TicTacToeCell = TicTacToeMark | null;

export interface TicTacToeConfig {
  enabled: boolean;
  channelId?: string;
  retryIntervalMs: number;
  idleTimeoutMs?: number;
}

export interface TicTacToePublisher {
  send(channelId: string, board: ButtonGameBoard): Promise<string>;
  edit(channelId: string, messageId: string, board: ButtonGameBoard): Promise<boolean>;
}

export interface TicTacToeService {
  initialize(): Promise<void>;
  ensureRound(): Promise<void>;
  checkInactivity(): Promise<void>;
  handleButton(interaction: ButtonGameInteraction): Promise<void>;
  getLeaderboard(limit: number): Promise<readonly MinigameLeaderboardEntry[]>;
}

interface TicTacToeGameState {
  id: string;
  channelId: string;
  playerId?: string;
  board: TicTacToeCell[];
  boardMessageId: string;
  roundNumber: number;
  startedAt: string;
}

interface TicTacToeState {
  version: 1;
  nextRoundNumber: number;
  game: TicTacToeGameState | null;
  wins: Record<string, number>;
}

interface TicTacToeServiceDependencies {
  config: TicTacToeConfig;
  publisher: TicTacToePublisher;
  state: StateStore<JsonState>;
  logger: AppLogger;
  userLevels?: UserLevelService;
  clock?: () => Date;
  idFactory?: () => string;
  random?: () => number;
}

const STATE_KEY = 'ticTacToe';
const BOARD_SIZE = 9;
const DEFAULT_IDLE_TIMEOUT_MS = 259200000;

export class PersistentTicTacToeService implements TicTacToeService {
  private readonly currentTime: () => Date;
  private readonly idFactory: () => string;
  private readonly random: () => number;
  private eventQueue: Promise<void> = Promise.resolve();

  public constructor(private readonly dependencies: TicTacToeServiceDependencies) {
    this.currentTime = dependencies.clock ?? (() => new Date());
    this.idFactory = dependencies.idFactory ?? randomUUID;
    this.random = dependencies.random ?? Math.random;
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
      const state = readTicTacToeState(rootState[STATE_KEY]);
      if (state.game) {
        return;
      }

      await this.publishNextRound(rootState, state);
    });
  }

  public async checkInactivity(): Promise<void> {
    if (!this.isEnabled()) {
      return;
    }

    await this.enqueue(async () => {
      const rootState = await this.dependencies.state.load();
      const state = readTicTacToeState(rootState[STATE_KEY]);
      const game = state.game;
      if (!game) {
        return;
      }

      const startedAt = Date.parse(game.startedAt);
      const idleTimeoutMs = this.dependencies.config.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
      if (!Number.isFinite(startedAt) || this.currentTime().getTime() - startedAt < idleTimeoutMs) {
        return;
      }

      state.game = null;
      writeTicTacToeState(rootState, state);
      await this.dependencies.state.save(rootState);
      await this.editSafely(game, formatTicTacToeBoard(game, 'timeout'));
      await this.publishNextRound(
        rootState,
        state,
        '⏰ Tic Tac Toe was quiet for too long, so the board has been reset.',
      );
    });
  }

  public async getLeaderboard(limit: number): Promise<readonly MinigameLeaderboardEntry[]> {
    if (!this.dependencies.config.enabled) {
      return [];
    }

    return this.enqueue(async () => {
      const rootState = await this.dependencies.state.load();
      const state = readTicTacToeState(rootState[STATE_KEY]);
      return toMinigameLeaderboard(state.wins, limit);
    });
  }

  public async handleButton(interaction: ButtonGameInteraction): Promise<void> {
    if (!this.isEnabled() || interaction.channelId !== this.dependencies.config.channelId) {
      return;
    }

    const parsed = parseButtonId(interaction.customId);
    if (!parsed) {
      return;
    }

    await this.enqueue(() => this.processButton(interaction, parsed.gameId, parsed.square));
  }

  private async processButton(
    interaction: ButtonGameInteraction,
    gameId: string,
    square: number,
  ): Promise<void> {
    const rootState = await this.dependencies.state.load();
    const state = readTicTacToeState(rootState[STATE_KEY]);
    const game = state.game;
    if (!game || game.id !== gameId || game.boardMessageId !== interaction.messageId) {
      await this.replySafely(interaction, 'That Tic Tac Toe board is no longer active.');
      return;
    }
    if (game.playerId && game.playerId !== interaction.userId) {
      await this.replySafely(
        interaction,
        `This round is being played by <@${game.playerId}>. Wait for the next round.`,
      );
      return;
    }
    if (game.board[square] !== null) {
      await this.replySafely(interaction, 'That square is already taken. Choose an empty square.');
      return;
    }

    const nextGame: TicTacToeGameState = {
      ...game,
      playerId: game.playerId ?? interaction.userId,
      board: [...game.board],
    };
    nextGame.board[square] = 'X';

    let winner = getWinner(nextGame.board);
    let draw = !winner && nextGame.board.every((cell) => cell !== null);
    let botMove: number | undefined;
    if (!winner && !draw) {
      botMove = chooseBotMove(nextGame.board, this.random);
      if (botMove !== undefined) {
        nextGame.board[botMove] = 'O';
      }
      winner = getWinner(nextGame.board);
      draw = !winner && nextGame.board.every((cell) => cell !== null);
    }

    const board = formatTicTacToeBoard(
      nextGame,
      winner ? 'winner' : draw ? 'draw' : 'turn',
      winner,
      botMove,
    );
    if (winner || draw) {
      if (winner === 'X' && nextGame.playerId) {
        state.wins[nextGame.playerId] = (state.wins[nextGame.playerId] ?? 0) + 1;
        await this.recordGameParticipation(nextGame.playerId);
      }
      state.game = null;
      writeTicTacToeState(rootState, state);
      await this.dependencies.state.save(rootState);
      await this.updateSafely(interaction, board);
      await this.publishNextRound(
        rootState,
        state,
        winner === 'X'
          ? `🎉 <@${nextGame.playerId}> won Tic Tac Toe. A new round is ready!`
          : winner === 'O'
            ? '🤖 STEMBot won Tic Tac Toe. A new round is ready!'
            : '🤝 Tic Tac Toe ended in a draw. A new round is ready!',
      );
      return;
    }

    await this.updateSafely(interaction, board);
    state.game = nextGame;
    writeTicTacToeState(rootState, state);
    await this.dependencies.state.save(rootState);
  }

  private async publishNextRound(
    rootState: JsonState,
    state: TicTacToeState,
    leadIn?: string,
  ): Promise<void> {
    const game: TicTacToeGameState = {
      id: this.idFactory(),
      channelId: this.dependencies.config.channelId!,
      board: Array.from({ length: BOARD_SIZE }, () => null),
      boardMessageId: '',
      roundNumber: state.nextRoundNumber,
      startedAt: this.currentTime().toISOString(),
    };
    const messageId = await this.dependencies.publisher.send(
      this.dependencies.config.channelId!,
      formatTicTacToeBoard(game, 'start', undefined, undefined, leadIn),
    );
    game.boardMessageId = messageId;
    state.game = game;
    state.nextRoundNumber += 1;
    writeTicTacToeState(rootState, state);
    await this.dependencies.state.save(rootState);
    this.dependencies.logger.info(
      {
        channelId: this.dependencies.config.channelId,
        roundNumber: game.roundNumber,
      },
      'Tic Tac Toe round posted',
    );
  }

  private async updateSafely(
    interaction: ButtonGameInteraction,
    board: ButtonGameBoard,
  ): Promise<void> {
    try {
      await interaction.update(board);
    } catch (error: unknown) {
      this.dependencies.logger.warn(
        { err: error, channelId: interaction.channelId, messageId: interaction.messageId },
        'Tic Tac Toe board could not be updated',
      );
    }
  }

  private async editSafely(game: TicTacToeGameState, board: ButtonGameBoard): Promise<void> {
    try {
      await this.dependencies.publisher.edit(game.channelId, game.boardMessageId, board);
    } catch (error: unknown) {
      this.dependencies.logger.warn(
        { err: error, channelId: game.channelId, messageId: game.boardMessageId },
        'Tic Tac Toe inactive board could not be edited',
      );
    }
  }

  private async replySafely(interaction: ButtonGameInteraction, content: string): Promise<void> {
    try {
      await interaction.reply(content);
    } catch (error: unknown) {
      this.dependencies.logger.warn(
        { err: error, channelId: interaction.channelId, messageId: interaction.messageId },
        'Tic Tac Toe button response could not be sent',
      );
    }
  }

  private async recordGameParticipation(userId: string): Promise<void> {
    try {
      await this.dependencies.userLevels?.recordGameParticipation(userId);
    } catch (error: unknown) {
      this.dependencies.logger.warn(
        { err: error, userId },
        'Tic Tac Toe game XP could not be recorded',
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

export function createTicTacToeService(
  dependencies: TicTacToeServiceDependencies,
): TicTacToeService {
  return new PersistentTicTacToeService(dependencies);
}

function formatTicTacToeBoard(
  game: TicTacToeGameState,
  state: 'start' | 'turn' | 'winner' | 'draw' | 'timeout',
  winner?: TicTacToeMark,
  botMove?: number,
  leadIn?: string,
): ButtonGameBoard {
  const header = '🎮 **Tic Tac Toe**';
  const players = game.playerId
    ? `<@${game.playerId}> is **X** · STEMBot is **O**`
    : 'The next player to click will play **X** · STEMBot is **O**';
  const botMoveNote = botMove === undefined ? '' : `\n🤖 STEMBot played square **${botMove + 1}**.`;
  let status = game.playerId
    ? 'Click an empty square to make your move.'
    : 'Click an empty square to claim this round.';
  if (state === 'winner') {
    status = winner === 'X' ? `🎉 <@${game.playerId}> wins!` : '🤖 STEMBot wins!';
  } else if (state === 'draw') {
    status = '🤝 It is a draw!';
  } else if (state === 'timeout') {
    status = '⏰ This round timed out and has been reset.';
  }

  return {
    content: [leadIn, header, players + botMoveNote, '', status]
      .filter((section): section is string => Boolean(section))
      .join('\n'),
    rows: [0, 1, 2].map((row) => ({
      buttons: [0, 1, 2].map((column) => {
        const square = row * 3 + column;
        const cell = game.board[square];
        return {
          customId: `ttt:${game.id}:${square}`,
          label: cell ?? `${square + 1}`,
          style: cell === 'X' ? 'success' : cell === 'O' ? 'danger' : 'primary',
          disabled: cell !== null || state === 'winner' || state === 'draw' || state === 'timeout',
        };
      }),
    })),
  };
}

function parseButtonId(customId: string): { gameId: string; square: number } | undefined {
  const [prefix, gameId, squareText] = customId.split(':');
  const square = Number(squareText);
  if (
    prefix !== 'ttt' ||
    !gameId ||
    !Number.isInteger(square) ||
    square < 0 ||
    square >= BOARD_SIZE
  ) {
    return undefined;
  }
  return { gameId, square };
}

function chooseBotMove(board: TicTacToeCell[], random: () => number): number | undefined {
  const candidates: number[] = [];
  let bestScore = Number.NEGATIVE_INFINITY;
  const memo = new Map<string, number>();

  for (let index = 0; index < board.length; index += 1) {
    if (board[index] !== null) {
      continue;
    }

    const candidate = [...board];
    candidate[index] = 'O';
    const score = minimaxTicTacToe(candidate, false, memo);
    if (score > bestScore) {
      bestScore = score;
      candidates.length = 0;
    }
    if (score === bestScore) {
      candidates.push(index);
    }
  }

  if (candidates.length === 0) {
    return undefined;
  }

  const rawRandomValue = random();
  const randomValue = Number.isFinite(rawRandomValue)
    ? Math.max(0, Math.min(0.999999, rawRandomValue))
    : 0;
  return candidates[Math.floor(randomValue * candidates.length)];
}

function minimaxTicTacToe(
  board: TicTacToeCell[],
  botTurn: boolean,
  memo: Map<string, number>,
  depth = 0,
): number {
  const winner = getWinner(board);
  if (winner === 'O') {
    return 10 - depth;
  }
  if (winner === 'X') {
    return depth - 10;
  }
  if (board.every((cell) => cell !== null)) {
    return 0;
  }

  const key = `${board.map((cell) => cell ?? '-').join('')}:${botTurn ? 'O' : 'X'}`;
  const cached = memo.get(key);
  if (cached !== undefined) {
    return cached;
  }

  const scores: number[] = [];
  for (let index = 0; index < board.length; index += 1) {
    if (board[index] !== null) {
      continue;
    }
    const candidate = [...board];
    candidate[index] = botTurn ? 'O' : 'X';
    scores.push(minimaxTicTacToe(candidate, !botTurn, memo, depth + 1));
  }

  const score = botTurn ? Math.max(...scores) : Math.min(...scores);
  memo.set(key, score);
  return score;
}

function getWinner(board: TicTacToeCell[]): TicTacToeMark | undefined {
  const lines = [
    [0, 1, 2],
    [3, 4, 5],
    [6, 7, 8],
    [0, 3, 6],
    [1, 4, 7],
    [2, 5, 8],
    [0, 4, 8],
    [2, 4, 6],
  ];
  for (const [first, second, third] of lines) {
    const mark = board[first ?? -1];
    if (mark && mark === board[second ?? -1] && mark === board[third ?? -1]) {
      return mark;
    }
  }
  return undefined;
}

function createInitialTicTacToeState(): TicTacToeState {
  return { version: 1, nextRoundNumber: 1, game: null, wins: {} };
}

function readTicTacToeState(value: unknown): TicTacToeState {
  if (!isRecord(value) || value.version !== 1) {
    return createInitialTicTacToeState();
  }

  const game = isTicTacToeGame(value.game) ? value.game : null;
  const nextRoundNumber =
    typeof value.nextRoundNumber === 'number' &&
    Number.isInteger(value.nextRoundNumber) &&
    value.nextRoundNumber > 0
      ? value.nextRoundNumber
      : 1;
  return {
    version: 1,
    nextRoundNumber,
    game,
    wins: readMinigameScores(value.wins),
  };
}

function isTicTacToeGame(value: unknown): value is TicTacToeGameState {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    typeof value.channelId === 'string' &&
    value.channelId.length > 0 &&
    (value.playerId === undefined || typeof value.playerId === 'string') &&
    Array.isArray(value.board) &&
    value.board.length === BOARD_SIZE &&
    value.board.every((cell) => cell === null || cell === 'X' || cell === 'O') &&
    typeof value.boardMessageId === 'string' &&
    typeof value.roundNumber === 'number' &&
    Number.isInteger(value.roundNumber) &&
    value.roundNumber > 0 &&
    typeof value.startedAt === 'string'
  );
}

function writeTicTacToeState(rootState: JsonState, state: TicTacToeState): void {
  rootState[STATE_KEY] = state;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
