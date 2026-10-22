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
});
