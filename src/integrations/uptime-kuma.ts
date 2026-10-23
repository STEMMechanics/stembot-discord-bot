export type UptimeMonitorState = 'up' | 'down' | 'pending' | 'maintenance';

export interface UptimeMonitorStatus {
  id: string;
  name: string;
  state: UptimeMonitorState;
  message?: string;
  checkedAt?: Date;
  uptime24h?: number;
}

export interface UptimeIncident {
  title: string;
  content?: string;
}

export interface UptimeKumaStatus {
  overall: 'up' | 'down';
  title: string;
  statusPageUrl: string;
  checkedAt: Date;
  monitors: readonly UptimeMonitorStatus[];
  incident?: UptimeIncident;
  sourceError?: string;
}

export interface UptimeKumaIntegration {
  getStatus(): Promise<UptimeKumaStatus>;
}

export interface UptimeKumaIntegrationOptions {
  statusPageUrl: string;
  requestTimeoutMs: number;
  fetchImplementation?: typeof fetch;
}

interface UptimeKumaEndpoints {
  statusPageUrl: string;
  statusPageDataUrl: URL;
  heartbeatUrl: URL;
}

interface JsonObject {
  [key: string]: unknown;
}

interface MonitorDefinition {
  id: string;
  name: string;
}

interface Heartbeat {
  status: UptimeMonitorState;
  time?: Date;
  message?: string;
}

export class PublicUptimeKumaIntegration implements UptimeKumaIntegration {
  private readonly endpoints: UptimeKumaEndpoints;

  private readonly fetchImplementation: typeof fetch;

  public constructor(private readonly options: UptimeKumaIntegrationOptions) {
    this.endpoints = resolveUptimeKumaEndpoints(options.statusPageUrl);
    this.fetchImplementation = options.fetchImplementation ?? fetch;
  }

  public async getStatus(): Promise<UptimeKumaStatus> {
    const [statusPagePayload, heartbeatPayload] = await Promise.all([
      this.fetchJson(this.endpoints.statusPageDataUrl),
      this.fetchJson(this.endpoints.heartbeatUrl),
    ]);

    const statusPage = requireObject(statusPagePayload, 'status page response');
    const heartbeatResponse = requireObject(heartbeatPayload, 'heartbeat response');
    const statusPageConfig = asObject(statusPage.config);
    const heartbeatList = asObject(heartbeatResponse.heartbeatList) ?? {};
    const uptimeList = asObject(heartbeatResponse.uptimeList) ?? {};
    const monitors = readMonitorDefinitions(statusPage.publicGroupList).map((monitor) => {
      const heartbeat = getLatestHeartbeat(heartbeatList[monitor.id]);
      const state = heartbeat?.status ?? 'down';
      const uptime24h = readFiniteNumber(uptimeList[`${monitor.id}_24`]);

      return {
        id: monitor.id,
        name: monitor.name,
        state,
        ...(heartbeat?.message ? { message: heartbeat.message } : {}),
        ...(heartbeat?.time ? { checkedAt: heartbeat.time } : {}),
        ...(uptime24h !== undefined ? { uptime24h } : {}),
      } satisfies UptimeMonitorStatus;
    });

    const incident = readIncident(statusPage.incident);
    const title = readNonEmptyString(statusPageConfig?.title) ?? 'STEMMechanics services';
    const overall =
      monitors.length > 0 && monitors.every((monitor) => monitor.state === 'up') ? 'up' : 'down';

    return {
      overall,
      title,
      statusPageUrl: this.endpoints.statusPageUrl,
      checkedAt: new Date(),
      monitors,
      ...(incident ? { incident } : {}),
    };
  }

  private async fetchJson(url: URL): Promise<unknown> {
    const response = await this.fetchImplementation(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(this.options.requestTimeoutMs),
    });
    if (!response.ok) {
      throw new Error(`Uptime Kuma request returned HTTP ${response.status}: ${url}`);
    }

    return response.json();
  }
}

export function createUptimeKumaIntegration(
  options: UptimeKumaIntegrationOptions,
): UptimeKumaIntegration {
  return new PublicUptimeKumaIntegration(options);
}

export function resolveUptimeKumaEndpoints(statusPageUrl: string): UptimeKumaEndpoints {
  const parsedUrl = new URL(statusPageUrl);
  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    throw new Error('UPTIME_KUMA_STATUS_PAGE_URL must use HTTP or HTTPS');
  }

  const pathSegments = parsedUrl.pathname.split('/').filter(Boolean);
  const statusSegmentIndex = pathSegments.lastIndexOf('status');
  if (statusSegmentIndex < 0 || statusSegmentIndex > pathSegments.length - 1) {
    throw new Error(
      'UPTIME_KUMA_STATUS_PAGE_URL must look like https://uptime.example.com/status/<slug>',
    );
  }

  const rawSlug = pathSegments[statusSegmentIndex + 1] ?? 'default';
  const slug = decodeURIComponent(rawSlug);
  const basePath = pathSegments.slice(0, statusSegmentIndex);
  const apiPrefix = [...basePath, 'api', 'status-page'];
  const apiPath = [...apiPrefix, encodeURIComponent(slug)].join('/');
  const heartbeatPath = [...apiPrefix, 'heartbeat', encodeURIComponent(slug)].join('/');

  return {
    statusPageUrl: parsedUrl.toString(),
    statusPageDataUrl: new URL(`/${apiPath}`, parsedUrl.origin),
    heartbeatUrl: new URL(`/${heartbeatPath}`, parsedUrl.origin),
  };
}

function readMonitorDefinitions(value: unknown): MonitorDefinition[] {
  if (!Array.isArray(value)) {
    throw new Error('Uptime Kuma status page response has no public monitor groups');
  }

  const monitors: MonitorDefinition[] = [];
  for (const groupValue of value) {
    const group = asObject(groupValue);
    const monitorList = group ? group.monitorList : undefined;
    if (!Array.isArray(monitorList)) {
      continue;
    }

    for (const monitorValue of monitorList) {
      const monitor = asObject(monitorValue);
      const id = monitor ? readId(monitor.id) : undefined;
      const name = monitor ? readNonEmptyString(monitor.name) : undefined;
      if (id && name) {
        monitors.push({ id, name });
      }
    }
  }

  return monitors;
}

function getLatestHeartbeat(value: unknown): Heartbeat | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  let latest: Heartbeat | undefined;
  for (const entryValue of value) {
    const entry = asObject(entryValue);
    const status = entry ? readHeartbeatState(entry.status) : undefined;
    if (!status) {
      continue;
    }

    const time = entry ? readDate(entry.time) : undefined;
    const message = entry ? readNonEmptyString(entry.msg) : undefined;
    if (!latest || (time && (!latest.time || time.getTime() >= latest.time.getTime()))) {
      latest = {
        status,
        ...(time ? { time } : {}),
        ...(message ? { message } : {}),
      };
    }
  }

  return latest;
}

function readHeartbeatState(value: unknown): UptimeMonitorState | undefined {
  switch (value) {
    case 0:
      return 'down';
    case 1:
      return 'up';
    case 2:
      return 'pending';
    case 3:
      return 'maintenance';
    default:
      return undefined;
  }
}

function readIncident(value: unknown): UptimeIncident | undefined {
  const incident = asObject(value);
  const title = incident ? readNonEmptyString(incident.title) : undefined;
  if (!title) {
    return undefined;
  }

  const content = incident ? readNonEmptyString(incident.content) : undefined;
  return content ? { title, content } : { title };
}

function readId(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }

  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return String(value);
  }

  return undefined;
}

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed || undefined;
}

function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readDate(value: unknown): Date | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function requireObject(value: unknown, label: string): JsonObject {
  const object = asObject(value);
  if (!object) {
    throw new Error(`Uptime Kuma ${label} was not an object`);
  }

  return object;
}

function asObject(value: unknown): JsonObject | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}
