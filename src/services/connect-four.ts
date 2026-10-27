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

type ConnectFourMark = 'X' | 'O';
type ConnectFourCell = ConnectFourMark | null;

export interface ConnectFourConfig {
  enabled: boolean;
  channelId?: string;
  retryIntervalMs: number;
  idleTimeoutMs?: number;
}

export interface ConnectFourPublisher {
  send(channelId: string, board: ButtonGameBoard): Promise<string>;
  edit(channelId: string, messageId: string, board: ButtonGameBoard): Promise<boolean>;
}

export interface ConnectFourService {
  initialize(): Promise<void>;
  ensureRound(): Promise<void>;
  checkInactivity(): Promise<void>;
  handleButton(interaction: ButtonGameInteraction): Promise<void>;
  getLeaderboard(limit: number): Promise<readonly MinigameLeaderboardEntry[]>;
}

interface ConnectFourGameState {
  id: string;
  channelId: string;
  playerId?: string;
  board: ConnectFourCell[];
  boardMessageId: string;
  roundNumber: number;
  startedAt: string;
}

interface ConnectFourState {
  version: 1;
  nextRoundNumber: number;
  game: ConnectFourGameState | null;
  wins: Record<string, number>;
}

interface ConnectFourServiceDependencies {
  config: ConnectFourConfig;
  publisher: ConnectFourPublisher;
  state: StateStore<JsonState>;
  logger: AppLogger;
  userLevels?: UserLevelService;
  clock?: () => Date;
  idFactory?: () => string;
}

const STATE_KEY = 'connectFour';
const ROWS = 6;
const COLUMNS = 7;
const BOARD_SIZE = ROWS * COLUMNS;
const DEFAULT_IDLE_TIMEOUT_MS = 259200000;
const PLAYER_TOKEN = '🔴';
const BOT_TOKEN = '🟡';
const EMPTY_TOKEN = '⚪';

export class PersistentConnectFourService implements ConnectFourService {
  private readonly currentTime: () => Date;
  private readonly idFactory: () => string;
  private eventQueue: Promise<void> = Promise.resolve();

  public constructor(private readonly dependencies: ConnectFourServiceDependencies) {
    this.currentTime = dependencies.clock ?? (() => new Date());
    this.idFactory = dependencies.idFactory ?? randomUUID;
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
      const state = readConnectFourState(rootState[STATE_KEY]);
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
      const state = readConnectFourState(rootState[STATE_KEY]);
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
      writeConnectFourState(rootState, state);
      await this.dependencies.state.save(rootState);
      await this.editSafely(game, formatConnectFourBoard(game, 'timeout'));
      await this.publishNextRound(
        rootState,
        state,
        '⏰ Connect 4 was quiet for too long, so the board has been reset.',
      );
    });
  }

  public async getLeaderboard(limit: number): Promise<readonly MinigameLeaderboardEntry[]> {
    if (!this.dependencies.config.enabled) {
      return [];
    }

    return this.enqueue(async () => {
      const rootState = await this.dependencies.state.load();
      const state = readConnectFourState(rootState[STATE_KEY]);
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

    await this.enqueue(() => this.processButton(interaction, parsed.gameId, parsed.column));
  }

  private async processButton(
    interaction: ButtonGameInteraction,
    gameId: string,
    column: number,
  ): Promise<void> {
    const rootState = await this.dependencies.state.load();
    const state = readConnectFourState(rootState[STATE_KEY]);
    const game = state.game;
    if (!game || game.id !== gameId || game.boardMessageId !== interaction.messageId) {
      await this.replySafely(interaction, 'That Connect 4 board is no longer active.');
      return;
    }
    if (game.playerId && game.playerId !== interaction.userId) {
      await this.replySafely(
        interaction,
        `This round is being played by <@${game.playerId}>. Wait for the next round.`,
      );
      return;
    }

    const nextGame: ConnectFourGameState = {
      ...game,
      playerId: game.playerId ?? interaction.userId,
      board: [...game.board],
    };
    if (dropToken(nextGame.board, column, 'X') === undefined) {
      await this.replySafely(interaction, 'That column is full. Choose another column.');
      return;
    }

    let winner = getWinner(nextGame.board);
    let draw = !winner && nextGame.board.every((cell) => cell !== null);
    let botColumn: number | undefined;
    if (!winner && !draw) {
      botColumn = chooseBotColumn(nextGame.board);
      if (botColumn !== undefined) {
        dropToken(nextGame.board, botColumn, 'O');
      }
      winner = getWinner(nextGame.board);
      draw = !winner && nextGame.board.every((cell) => cell !== null);
    }

    const board = formatConnectFourBoard(
      nextGame,
      winner ? 'winner' : draw ? 'draw' : 'turn',
      winner,
      botColumn,
    );
    if (winner || draw) {
      if (winner === 'X' && nextGame.playerId) {
        state.wins[nextGame.playerId] = (state.wins[nextGame.playerId] ?? 0) + 1;
        await this.recordGameParticipation(nextGame.playerId);
      }
      state.game = null;
      writeConnectFourState(rootState, state);
      await this.dependencies.state.save(rootState);
      await this.updateSafely(interaction, board);
      await this.publishNextRound(
        rootState,
        state,
        winner === 'X'
          ? `🎉 <@${nextGame.playerId}> won Connect 4. A new round is ready!`
          : winner === 'O'
            ? '🤖 STEMBot won Connect 4. A new round is ready!'
            : '🤝 Connect 4 ended in a draw. A new round is ready!',
      );
      return;
    }

    await this.updateSafely(interaction, board);
    state.game = nextGame;
    writeConnectFourState(rootState, state);
    await this.dependencies.state.save(rootState);
  }

  private async publishNextRound(
    rootState: JsonState,
    state: ConnectFourState,
    leadIn?: string,
  ): Promise<void> {
    const game: ConnectFourGameState = {
      id: this.idFactory(),
      channelId: this.dependencies.config.channelId!,
      board: Array.from({ length: BOARD_SIZE }, () => null),
      boardMessageId: '',
      roundNumber: state.nextRoundNumber,
      startedAt: this.currentTime().toISOString(),
    };
    const messageId = await this.dependencies.publisher.send(
      this.dependencies.config.channelId!,
      formatConnectFourBoard(game, 'start', undefined, undefined, leadIn),
    );
    game.boardMessageId = messageId;
    state.game = game;
    state.nextRoundNumber += 1;
    writeConnectFourState(rootState, state);
    await this.dependencies.state.save(rootState);
    this.dependencies.logger.info(
      { channelId: this.dependencies.config.channelId, roundNumber: game.roundNumber },
      'Connect 4 round posted',
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
        'Connect 4 board could not be updated',
      );
    }
  }

  private async editSafely(game: ConnectFourGameState, board: ButtonGameBoard): Promise<void> {
    try {
      await this.dependencies.publisher.edit(game.channelId, game.boardMessageId, board);
    } catch (error: unknown) {
      this.dependencies.logger.warn(
        { err: error, channelId: game.channelId, messageId: game.boardMessageId },
        'Connect 4 inactive board could not be edited',
      );
    }
  }

  private async replySafely(interaction: ButtonGameInteraction, content: string): Promise<void> {
    try {
      await interaction.reply(content);
    } catch (error: unknown) {
      this.dependencies.logger.warn(
        { err: error, channelId: interaction.channelId, messageId: interaction.messageId },
        'Connect 4 button response could not be sent',
      );
    }
  }

  private async recordGameParticipation(userId: string): Promise<void> {
    try {
      await this.dependencies.userLevels?.recordGameParticipation(userId);
    } catch (error: unknown) {
      this.dependencies.logger.warn(
        { err: error, userId },
        'Connect 4 game XP could not be recorded',
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

export function createConnectFourService(
  dependencies: ConnectFourServiceDependencies,
): ConnectFourService {
  return new PersistentConnectFourService(dependencies);
}

function formatConnectFourBoard(
  game: ConnectFourGameState,
  state: 'start' | 'turn' | 'winner' | 'draw' | 'timeout',
  winner?: ConnectFourMark,
  botColumn?: number,
  leadIn?: string,
): ButtonGameBoard {
  const board = Array.from({ length: ROWS }, (_, row) =>
    game.board
      .slice(row * COLUMNS, (row + 1) * COLUMNS)
      .map((cell) => (cell === 'X' ? PLAYER_TOKEN : cell === 'O' ? BOT_TOKEN : EMPTY_TOKEN))
      .join(''),
  ).join('\n');
  const header = '🔴 **Connect 4**';
  const players = game.playerId
    ? `<@${game.playerId}> is 🔴 · STEMBot is 🟡`
    : 'The next player to click will play 🔴 · STEMBot is 🟡';
  const botMoveNote =
    botColumn === undefined ? '' : `\n🤖 STEMBot played column **${botColumn + 1}**.`;
  let status = game.playerId
    ? 'Click a column to drop your counter.'
    : 'Click a column to claim this round.';
  if (state === 'winner') {
    status = winner === 'X' ? `🎉 <@${game.playerId}> wins!` : '🤖 STEMBot wins!';
  } else if (state === 'draw') {
    status = '🤝 It is a draw!';
  } else if (state === 'timeout') {
    status = '⏰ This round timed out and has been reset.';
  }

  return {
    content: [leadIn, header, players + botMoveNote, '', board, '', status]
      .filter((section): section is string => Boolean(section))
      .join('\n'),
    rows: [
      [0, 1, 2, 3],
      [4, 5, 6],
    ].map((columns) => ({
      buttons: columns.map((column) => ({
        customId: `connect4:${game.id}:${column}`,
        label: `Drop ${column + 1}`,
        style: 'primary',
        disabled:
          game.board[column] !== null ||
          state === 'winner' ||
          state === 'draw' ||
          state === 'timeout',
      })),
    })),
  };
}

function parseButtonId(customId: string): { gameId: string; column: number } | undefined {
  const [prefix, gameId, columnText] = customId.split(':');
  const column = Number(columnText);
  if (
    prefix !== 'connect4' ||
    !gameId ||
    !Number.isInteger(column) ||
    column < 0 ||
    column >= COLUMNS
  ) {
    return undefined;
  }
  return { gameId, column };
}

function dropToken(
  board: ConnectFourCell[],
  column: number,
  mark: ConnectFourMark,
): number | undefined {
  for (let row = ROWS - 1; row >= 0; row -= 1) {
    const index = row * COLUMNS + column;
    if (board[index] === null) {
      board[index] = mark;
      return index;
    }
  }
  return undefined;
}

function chooseBotColumn(board: ConnectFourCell[]): number | undefined {
  return (
    findWinningColumn(board, 'O') ??
    findWinningColumn(board, 'X') ??
    [3, 2, 4, 1, 5, 0, 6].find((column) => board[column] === null) ??
    undefined
  );
}

function findWinningColumn(board: ConnectFourCell[], mark: ConnectFourMark): number | undefined {
  for (let column = 0; column < COLUMNS; column += 1) {
    const candidate = [...board];
    if (dropToken(candidate, column, mark) !== undefined && getWinner(candidate) === mark) {
      return column;
    }
  }
  return undefined;
}

function getWinner(board: ConnectFourCell[]): ConnectFourMark | undefined {
  const directions: readonly (readonly [number, number])[] = [
    [0, 1],
    [1, 0],
    [1, 1],
    [1, -1],
  ];
  for (let row = 0; row < ROWS; row += 1) {
    for (let column = 0; column < COLUMNS; column += 1) {
      const mark = board[row * COLUMNS + column];
      if (!mark) {
        continue;
      }
      for (const [rowStep, columnStep] of directions) {
        const endRow = row + rowStep * 3;
        const endColumn = column + columnStep * 3;
        if (endRow < 0 || endRow >= ROWS || endColumn < 0 || endColumn >= COLUMNS) {
          continue;
        }
        let connected = true;
        for (let count = 1; count < 4; count += 1) {
          if (board[(row + rowStep * count) * COLUMNS + column + columnStep * count] !== mark) {
            connected = false;
            break;
          }
        }
        if (connected) {
          return mark;
        }
      }
    }
  }
  return undefined;
}

function createInitialConnectFourState(): ConnectFourState {
  return { version: 1, nextRoundNumber: 1, game: null, wins: {} };
}

function readConnectFourState(value: unknown): ConnectFourState {
  if (!isRecord(value) || value.version !== 1) {
    return createInitialConnectFourState();
  }

  const game = isConnectFourGame(value.game) ? value.game : null;
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

function isConnectFourGame(value: unknown): value is ConnectFourGameState {
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

function writeConnectFourState(rootState: JsonState, state: ConnectFourState): void {
  rootState[STATE_KEY] = state;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
