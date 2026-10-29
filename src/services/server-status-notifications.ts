import { buildMinecraftServerStatusEmbed } from '../http/chat-discord-bridge.js';
import type { DiscordChannelMessage, DiscordGateway } from '../discord/client.js';
import type { StemCraftIntegration } from '../integrations/stemcraft.js';
import type { AppLogger } from '../logging/logger.js';
import type { JsonState, StateStore } from '../state/state-store.js';

export interface ServerStatusNotificationConfig {
  enabled: boolean;
  channelId?: string;
  offlineThresholdMs: number;
}

export interface ServerStatusNotificationService {
  synchronize(): Promise<void>;
}

export interface ServerStatusNotificationServiceDependencies {
  stemcraft: StemCraftIntegration;
  discord: Pick<DiscordGateway, 'sendChannelMessage'>;
  state: StateStore<JsonState>;
  logger: AppLogger;
  config: ServerStatusNotificationConfig;
  clock?: () => Date;
}

interface ServerStatusNotificationState {
  version: 1;
  offlineSince: string | null;
  offlineAlertSent: boolean;
}

const STATE_KEY = 'serverStatusNotifications';

export class PersistentServerStatusNotificationService implements ServerStatusNotificationService {
  private running = false;

  public constructor(private readonly dependencies: ServerStatusNotificationServiceDependencies) {}

  public async synchronize(): Promise<void> {
    if (!this.dependencies.config.enabled || !this.dependencies.config.channelId) {
      return;
    }

    if (this.running) {
      this.dependencies.logger.warn('Skipping overlapping server status synchronization');
      return;
    }

    this.running = true;
    try {
      const rootState = await this.dependencies.state.load();
      const state = readServerStatusNotificationState(rootState[STATE_KEY]);
      const now = this.dependencies.clock?.() ?? new Date();
      const online = await this.readOnline();

      if (online) {
        await this.handleOnline(rootState, state);
      } else {
        await this.handleOffline(rootState, state, now);
      }
    } finally {
      this.running = false;
    }
  }

  private async handleOnline(
    rootState: JsonState,
    state: ServerStatusNotificationState,
  ): Promise<void> {
    if (state.offlineAlertSent) {
      await this.dependencies.discord.sendChannelMessage(
        this.dependencies.config.channelId!,
        createLifecycleMessage('online'),
      );
      this.dependencies.logger.info(
        { channelId: this.dependencies.config.channelId },
        'Minecraft server returned online after an extended offline period',
      );
    }

    if (state.offlineSince || state.offlineAlertSent) {
      state.offlineSince = null;
      state.offlineAlertSent = false;
      rootState[STATE_KEY] = state;
      await this.dependencies.state.save(rootState);
    }
  }

  private async handleOffline(
    rootState: JsonState,
    state: ServerStatusNotificationState,
    now: Date,
  ): Promise<void> {
    if (!state.offlineSince) {
      state.offlineSince = now.toISOString();
      rootState[STATE_KEY] = state;
      await this.dependencies.state.save(rootState);
      this.dependencies.logger.info(
        { channelId: this.dependencies.config.channelId, offlineSince: state.offlineSince },
        'Minecraft server offline timer started',
      );
      return;
    }

    const offlineSince = Date.parse(state.offlineSince);
    if (
      !Number.isFinite(offlineSince) ||
      now.getTime() - offlineSince < this.dependencies.config.offlineThresholdMs ||
      state.offlineAlertSent
    ) {
      return;
    }

    await this.dependencies.discord.sendChannelMessage(
      this.dependencies.config.channelId!,
      createLifecycleMessage('offline'),
    );
    state.offlineAlertSent = true;
    rootState[STATE_KEY] = state;
    await this.dependencies.state.save(rootState);
    this.dependencies.logger.info(
      {
        channelId: this.dependencies.config.channelId,
        offlineSince: state.offlineSince,
        thresholdMs: this.dependencies.config.offlineThresholdMs,
      },
      'Minecraft server extended offline notification published',
    );
  }

  private async readOnline(): Promise<boolean> {
    try {
      const status = await this.dependencies.stemcraft.getServerStatus();
      return status.online;
    } catch (error: unknown) {
      this.dependencies.logger.warn(
        { err: error },
        'Minecraft server status could not be read; treating the server as offline',
      );
      return false;
    }
  }
}

export function createServerStatusNotificationService(
  dependencies: ServerStatusNotificationServiceDependencies,
): ServerStatusNotificationService {
  return new PersistentServerStatusNotificationService(dependencies);
}

function createLifecycleMessage(kind: 'offline' | 'online'): DiscordChannelMessage {
  return {
    embeds: [buildMinecraftServerStatusEmbed(kind)],
    allowedMentions: { parse: [] },
  };
}

function readServerStatusNotificationState(value: unknown): ServerStatusNotificationState {
  if (!isRecord(value) || value.version !== 1) {
    return { version: 1, offlineSince: null, offlineAlertSent: false };
  }

  return {
    version: 1,
    offlineSince:
      typeof value.offlineSince === 'string' && value.offlineSince.trim()
        ? value.offlineSince
        : null,
    offlineAlertSent: value.offlineAlertSent === true,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
