export interface BotBuildInfo {
  version: string;
  branch: string;
  commit: string;
  pullRequest: string;
  release: string;
}

export function getBotBuildInfo(env: NodeJS.ProcessEnv = process.env): BotBuildInfo {
  return {
    version: readBuildValue(env.STEMBOT_BUILD_VERSION, 'development'),
    branch: readBuildValue(env.STEMBOT_BUILD_BRANCH, 'unknown'),
    commit: readBuildValue(env.STEMBOT_BUILD_COMMIT, 'unknown'),
    pullRequest: readBuildValue(env.STEMBOT_BUILD_PR, 'unknown'),
    release: readBuildValue(env.STEMBOT_BUILD_RELEASE, 'unreleased'),
  };
}

function readBuildValue(value: string | undefined, fallback: string): string {
  const normalized = value?.trim();
  return normalized || fallback;
}
