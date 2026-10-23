import type { DiscordChannelMessage, DiscordGateway } from '../discord/client.js';
import { buildUptimeStatusEmbed } from '../discord/commands.js';
import type { UptimeKumaIntegration, UptimeKumaStatus } from '../integrations/uptime-kuma.js';
import type { AppLogger } from '../logging/logger.js';
import type { JsonState, StateStore } from '../state/state-store.js';

export interface UptimeStatusConfig {
  statusPageUrl: string;
  statusChannelId: string;
}

export interface UptimeStatusService {
  synchronize(): Promise<void>;
}

export interface UptimeStatusServiceDependencies {
  uptime: UptimeKumaIntegration;
  discord: Pick<DiscordGateway, 'sendChannelMessage' | 'editChannelMessage'>;
  state: StateStore<JsonState>;
  logger: AppLogger;
  config: UptimeStatusConfig;
  clock?: () => Date;
}

interface UptimeStatusState {
  version: 1;
  messageId: string | null;
}

const STATE_KEY = 'uptimeStatus';

export class PersistentUptimeStatusService implements UptimeStatusService {
  private running = false;

  public constructor(private readonly dependencies: UptimeStatusServiceDependencies) {}

  public async synchronize(): Promise<void> {
    if (this.running) {
      this.dependencies.logger.warn('Skipping overlapping uptime status synchronization');
      return;
    }

    this.running = true;
    try {
      const rootState = await this.dependencies.state.load();
      const state = readUptimeStatusState(rootState[STATE_KEY]);
      const status = await this.readStatus();
      const message: DiscordChannelMessage = {
        embeds: [buildUptimeStatusEmbed(status)],
        allowedMentions: { parse: [] },
      };

      let messageId = state.messageId ?? undefined;
      if (messageId) {
        const edited = await this.dependencies.discord.editChannelMessage(
          this.dependencies.config.statusChannelId,
          messageId,
          message,
        );
        if (!edited) {
          messageId = undefined;
        }
      }

      if (!messageId) {
        messageId = await this.dependencies.discord.sendChannelMessage(
          this.dependencies.config.statusChannelId,
          message,
        );
        state.messageId = messageId;
        rootState[STATE_KEY] = state;
        await this.dependencies.state.save(rootState);
        this.dependencies.logger.info(
          { channelId: this.dependencies.config.statusChannelId, messageId },
          'Uptime status message created and persisted',
        );
      } else {
        this.dependencies.logger.debug(
          { channelId: this.dependencies.config.statusChannelId, messageId },
          'Uptime status message updated',
        );
      }
    } finally {
      this.running = false;
    }
  }

  private async readStatus(): Promise<UptimeKumaStatus> {
    try {
      return await this.dependencies.uptime.getStatus();
    } catch (error: unknown) {
      this.dependencies.logger.warn(
        { err: error },
        'Uptime Kuma status could not be read; publishing a red status card',
      );
      return {
        overall: 'down',
        title: 'STEMMechanics services',
        statusPageUrl: this.dependencies.config.statusPageUrl,
        checkedAt: this.dependencies.clock?.() ?? new Date(),
        monitors: [],
        sourceError: 'Uptime Kuma could not be reached or returned invalid data.',
      };
    }
  }
}

export function createUptimeStatusService(
  dependencies: UptimeStatusServiceDependencies,
): UptimeStatusService {
  return new PersistentUptimeStatusService(dependencies);
}

function readUptimeStatusState(value: unknown): UptimeStatusState {
  if (!isRecord(value) || value.version !== 1) {
    return { version: 1, messageId: null };
  }

  return {
    version: 1,
    messageId:
      typeof value.messageId === 'string' && value.messageId.trim() ? value.messageId : null,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
