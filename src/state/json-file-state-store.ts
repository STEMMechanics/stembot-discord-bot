import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

import type { AppLogger } from '../logging/logger.js';
import type { JsonState, StateStore } from './state-store.js';

function isJsonState(value: unknown): value is JsonState {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function createJsonFileStateStore(
  filePath: string,
  logger: AppLogger,
): StateStore<JsonState> {
  let currentState: JsonState = {};

  return {
    async load(): Promise<JsonState> {
      await mkdir(dirname(filePath), { recursive: true });

      try {
        const content = await readFile(filePath, 'utf8');
        const parsed: unknown = JSON.parse(content);

        if (!isJsonState(parsed)) {
          throw new Error(`State file must contain a JSON object: ${filePath}`);
        }

        currentState = parsed;
        logger.info({ statePath: filePath }, 'Persistent state loaded');
        return currentState;
      } catch (error: unknown) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
          logger.info(
            { statePath: filePath },
            'No persistent state found; starting with empty state',
          );
          currentState = {};
          return currentState;
        }

        logger.error({ err: error, statePath: filePath }, 'Failed to load persistent state');
        throw error;
      }
    },

    async save(state: JsonState): Promise<void> {
      await mkdir(dirname(filePath), { recursive: true });

      const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
      const content = `${JSON.stringify(state, null, 2)}\n`;

      await writeFile(temporaryPath, content, { encoding: 'utf8', mode: 0o600 });
      await rename(temporaryPath, filePath);

      currentState = state;
      logger.debug({ statePath: filePath }, 'Persistent state saved');
    },
  };
}
