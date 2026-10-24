import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import type { AppLogger } from '../logging/logger.js';
import type { JsonState, StateStore } from './state-store.js';

function isJsonState(value: unknown): value is JsonState {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cloneState(state: JsonState): JsonState {
  return JSON.parse(JSON.stringify(state)) as JsonState;
}

function mergeStateChanges(
  latestState: JsonState,
  loadedState: JsonState | undefined,
  stateToSave: JsonState,
): JsonState {
  if (!loadedState) {
    return stateToSave;
  }

  const mergedState = cloneState(latestState);
  const keys = new Set([...Object.keys(loadedState), ...Object.keys(stateToSave)]);
  for (const key of keys) {
    const loadedHasKey = Object.prototype.hasOwnProperty.call(loadedState, key);
    const stateHasKey = Object.prototype.hasOwnProperty.call(stateToSave, key);
    const loadedValue = loadedState[key];
    const stateValue = stateToSave[key];

    if (loadedHasKey === stateHasKey && isDeepStrictEqual(loadedValue, stateValue)) {
      continue;
    }

    if (stateHasKey) {
      mergedState[key] = stateValue;
    } else {
      delete mergedState[key];
    }
  }

  return mergedState;
}

export function createJsonFileStateStore(
  filePath: string,
  logger: AppLogger,
): StateStore<JsonState> {
  let currentState: JsonState = {};
  let writeQueue: Promise<void> = Promise.resolve();
  const loadedSnapshots = new WeakMap<object, JsonState>();

  return {
    async load(): Promise<JsonState> {
      await writeQueue.catch(() => undefined);
      await mkdir(dirname(filePath), { recursive: true });

      try {
        const content = await readFile(filePath, 'utf8');
        const parsed: unknown = JSON.parse(content);

        if (!isJsonState(parsed)) {
          throw new Error(`State file must contain a JSON object: ${filePath}`);
        }

        currentState = parsed;
        loadedSnapshots.set(currentState, cloneState(currentState));
        logger.info({ statePath: filePath }, 'Persistent state loaded');
        return currentState;
      } catch (error: unknown) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
          logger.info(
            { statePath: filePath },
            'No persistent state found; starting with empty state',
          );
          currentState = {};
          loadedSnapshots.set(currentState, {});
          return currentState;
        }

        logger.error({ err: error, statePath: filePath }, 'Failed to load persistent state');
        throw error;
      }
    },

    async save(state: JsonState): Promise<void> {
      const loadedState = loadedSnapshots.get(state);
      const next = writeQueue
        .catch(() => undefined)
        .then(async () => {
          await mkdir(dirname(filePath), { recursive: true });

          let latestState = currentState;
          try {
            const content = await readFile(filePath, 'utf8');
            const parsed: unknown = JSON.parse(content);
            if (!isJsonState(parsed)) {
              throw new Error(`State file must contain a JSON object: ${filePath}`);
            }
            latestState = parsed;
          } catch (error: unknown) {
            if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
              throw error;
            }
          }

          const mergedState = mergeStateChanges(latestState, loadedState, state);
          const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
          const content = `${JSON.stringify(mergedState, null, 2)}\n`;

          await writeFile(temporaryPath, content, { encoding: 'utf8', mode: 0o600 });
          await rename(temporaryPath, filePath);

          currentState = mergedState;
          loadedSnapshots.set(state, cloneState(mergedState));
          loadedSnapshots.set(mergedState, cloneState(mergedState));
          logger.debug({ statePath: filePath }, 'Persistent state saved');
        });
      writeQueue = next.then(
        () => undefined,
        () => undefined,
      );
      await next;
    },
  };
}
