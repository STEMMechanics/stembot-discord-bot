import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import pino from 'pino';
import { describe, expect, it } from 'vitest';

import { createJsonFileStateStore } from '../src/state/json-file-state-store.js';

describe('JSON state store', () => {
  it('saves and reloads state', async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'stembot-state-'));
    const statePath = join(temporaryDirectory, 'state.json');
    const logger = pino({ level: 'silent' });

    try {
      const firstStore = createJsonFileStateStore(statePath, logger);
      await firstStore.save({ lastWorkshopSync: '2026-10-22T00:00:00.000Z' });

      const secondStore = createJsonFileStateStore(statePath, logger);
      await expect(secondStore.load()).resolves.toEqual({
        lastWorkshopSync: '2026-10-22T00:00:00.000Z',
      });
      await expect(readFile(statePath, 'utf8')).resolves.toContain('lastWorkshopSync');
    } finally {
      await rm(temporaryDirectory, { force: true, recursive: true });
    }
  });

  it('merges independent top-level updates from stale loads', async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'stembot-state-'));
    const statePath = join(temporaryDirectory, 'state.json');
    const logger = pino({ level: 'silent' });

    try {
      const firstStore = createJsonFileStateStore(statePath, logger);
      const secondStore = createJsonFileStateStore(statePath, logger);
      await firstStore.save({ base: true });

      const firstState = await firstStore.load();
      const secondState = await secondStore.load();
      firstState.userLevels = { version: 1 };
      secondState.workshops = { version: 2 };

      await firstStore.save(firstState);
      await secondStore.save(secondState);

      await expect(firstStore.load()).resolves.toEqual({
        base: true,
        userLevels: { version: 1 },
        workshops: { version: 2 },
      });
    } finally {
      await rm(temporaryDirectory, { force: true, recursive: true });
    }
  });
});
