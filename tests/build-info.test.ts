import { describe, expect, it } from 'vitest';

import { getBotBuildInfo } from '../src/build-info.js';

describe('bot build info', () => {
  it('reads build metadata from the runtime environment', () => {
    expect(
      getBotBuildInfo({
        STEMBOT_BUILD_VERSION: '0.5.2',
        STEMBOT_BUILD_BRANCH: 'main',
        STEMBOT_BUILD_COMMIT: 'commit-123',
        STEMBOT_BUILD_PR: '19',
        STEMBOT_BUILD_RELEASE: 'v0.5.2',
      }),
    ).toEqual({
      version: '0.5.2',
      branch: 'main',
      commit: 'commit-123',
      pullRequest: '19',
      release: 'v0.5.2',
    });
  });

  it('provides safe values when build metadata is unavailable', () => {
    expect(getBotBuildInfo({})).toEqual({
      version: 'development',
      branch: 'unknown',
      commit: 'unknown',
      pullRequest: 'unknown',
      release: 'unreleased',
    });
  });
});
