import { XMLParser } from 'fast-xml-parser';

import type { AppLogger } from '../logging/logger.js';

export type WorkshopStatus =
  'scheduled' | 'open' | 'full' | 'closed' | 'cancelled' | 'private' | 'hidden' | 'unknown';

export type WorkshopStatusCode = WorkshopStatus;

export type WorkshopRegistrationType =
  | 'none'
  | 'tickets'
  | 'interest'
  | 'link'
  | 'external'
  | 'external-link'
  | 'email'
  | 'message'
  | 'unknown';

export interface WorkshopRecord {
  externalId: string;
  /** Previous GUID identity when a final `sm:id` supersedes it. */
  legacyExternalId?: string;
  title: string;
  startsAt: Date;
  endsAt?: Date;
  url: string;
  registrationUrl?: string;
  registrationType?: WorkshopRegistrationType;
  registrationData?: string;
  description?: string;
  location?: string;
  price?: string;
  ages?: string;
  imageUrl?: string;
  status: WorkshopStatus;
  /** Final RSS lifecycle code. Optional for compatibility with older callers. */
  statusCode?: WorkshopStatusCode;
  /** Final RSS workshop type, such as `stemcraft`. */
  type?: string;
  sourceUpdatedAt?: Date;
}

export interface WebsiteIntegration {
  getWorkshops(signal?: AbortSignal): Promise<readonly WorkshopRecord[]>;
}

export interface WebsiteRssIntegrationOptions {
  feedUrl: string;
  requestTimeoutMs: number;
  logger: AppLogger;
  fetchImplementation?: typeof fetch;
}

type XmlObject = Record<string, unknown>;

const XML_PARSER = new XMLParser({
  attributeNamePrefix: '@_',
  ignoreAttributes: false,
  isArray: (name) => name === 'item',
  parseTagValue: false,
  processEntities: true,
  trimValues: true,
});

const REGISTRATION_TYPE_FIELDS = [
  'sm:registrationType',
  'sm:registration_type',
  'registrationType',
  'registration_type',
  'registration',
] as const;

const REGISTRATION_URL_FIELDS = [
  'sm:registrationUrl',
  'sm:registrationURL',
  'sm:registrationLink',
  'sm:registration_url',
  'registrationUrl',
  'registrationURL',
  'registrationLink',
  'registration_url',
] as const;

const REGISTRATION_DATA_FIELDS = [
  'sm:registrationData',
  'sm:registration_data',
  'registrationData',
  'registration_data',
] as const;

const STATUS_CODE_FIELDS = ['sm:statusCode', 'statusCode', 'status_code'] as const;

const TYPE_FIELDS = ['sm:type', 'type'] as const;

/**
 * Reads the STEMMechanics workshop RSS contract. Legacy GUIDs, status labels,
 * and registration aliases remain supported for older feed responses.
 */
export class WebsiteRssIntegration implements WebsiteIntegration {
  private readonly fetchImplementation: typeof fetch;

  public constructor(private readonly options: WebsiteRssIntegrationOptions) {
    this.fetchImplementation = options.fetchImplementation ?? fetch;
  }

  public async getWorkshops(signal?: AbortSignal): Promise<readonly WorkshopRecord[]> {
    const body = await this.fetchFeed(signal);
    const normalized = normalizeLegacyXmlDeclaration(body);

    if (normalized.legacyDeclarationFixed) {
      this.options.logger.warn(
        { feedUrl: this.options.feedUrl },
        'Workshop RSS feed used a legacy escaped XML declaration',
      );
    }

    let parsed: unknown;
    try {
      parsed = XML_PARSER.parse(normalized.xml);
    } catch (error: unknown) {
      throw new Error('Workshop RSS feed could not be parsed as XML', { cause: error });
    }

    const channel = asObject(asObject(parsed)?.rss)?.channel;
    const channelObject = asObject(channel);
    const rawItems = channelObject?.item;

    if (rawItems === undefined) {
      throw new Error('Workshop RSS feed did not contain a channel item list');
    }

    const items = Array.isArray(rawItems) ? rawItems : [rawItems];
    const workshops: WorkshopRecord[] = [];

    for (const [index, rawItem] of items.entries()) {
      try {
        const workshop = parseWorkshopItem(rawItem);
        if (workshop) {
          workshops.push(workshop);
        }
      } catch (error: unknown) {
        this.options.logger.warn(
          { err: error, feedUrl: this.options.feedUrl, itemIndex: index },
          'Skipping malformed workshop RSS item',
        );
      }
    }

    return workshops.sort((left, right) => left.startsAt.getTime() - right.startsAt.getTime());
  }

  private async fetchFeed(signal?: AbortSignal): Promise<string> {
    const timeoutController = new AbortController();
    const timeout = setTimeout(() => timeoutController.abort(), this.options.requestTimeoutMs);
    const abortListener = (): void => timeoutController.abort(signal?.reason);

    if (signal) {
      if (signal.aborted) {
        timeoutController.abort(signal.reason);
      } else {
        signal.addEventListener('abort', abortListener, { once: true });
      }
    }

    try {
      const response = await this.fetchImplementation(this.options.feedUrl, {
        headers: {
          Accept: 'application/rss+xml, application/xml, text/xml',
        },
        signal: timeoutController.signal,
      });

      if (!response.ok) {
        throw new Error(`Workshop RSS request failed with HTTP ${response.status}`);
      }

      return await response.text();
    } catch (error: unknown) {
      if (timeoutController.signal.aborted && !signal?.aborted) {
        throw new Error('Workshop RSS request timed out', { cause: error });
      }

      throw error;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abortListener);
    }
  }
}

export function createWebsiteIntegration(
  options: WebsiteRssIntegrationOptions,
): WebsiteIntegration {
  return new WebsiteRssIntegration(options);
}

export class UnconfiguredWebsiteIntegration implements WebsiteIntegration {
  public async getWorkshops(): Promise<readonly WorkshopRecord[]> {
    throw new Error('The STEMMechanics website integration has not been configured');
  }
}

export function normalizeLegacyXmlDeclaration(xml: string): {
  xml: string;
  legacyDeclarationFixed: boolean;
} {
  const declaration = /^\uFEFF?<\?xml version=&quot;1\.0&quot; encoding=&quot;UTF-8&quot;\?>/;
  if (!declaration.test(xml)) {
    return { xml, legacyDeclarationFixed: false };
  }

  return {
    xml: xml.replace(declaration, '<?xml version="1.0" encoding="UTF-8"?>'),
    legacyDeclarationFixed: true,
  };
}

function parseWorkshopItem(value: unknown): WorkshopRecord | undefined {
  const item = asObject(value);
  if (!item) {
    throw new Error('RSS item was not an object');
  }

  const title = readText(item.title);
  const url = safeHttpUrl(readText(item.link));
  const feedId = readFirstText(item, ['sm:id', 'id']);
  const guid = readText(item.guid);
  const externalId = feedId ?? guid ?? url;
  const legacyExternalId = feedId && guid && feedId !== guid ? guid : undefined;
  const startsAt = parseDate(readFirstText(item, ['sm:startDate', 'startDate']));

  if (!title || !url || !externalId || !startsAt) {
    throw new Error('RSS item is missing a title, link, identity, or valid start date');
  }

  const endsAt = parseDate(readFirstText(item, ['sm:endDate', 'endDate']));
  const sourceUpdatedAt = parseDate(readFirstText(item, ['sm:updatedAt', 'updatedAt', 'pubDate']));
  const registrationType = normalizeRegistrationType(readFirstText(item, REGISTRATION_TYPE_FIELDS));
  const registrationValue = readFirstText(item, REGISTRATION_URL_FIELDS);
  const registrationData = readFirstText(item, REGISTRATION_DATA_FIELDS);
  const registrationUrl =
    safeRegistrationUrl(registrationValue) ??
    safeRegistrationDataUrl(registrationData, registrationType);
  const imageUrl = readEnclosureUrl(item);
  const description = readText(item['content:encoded']) ?? readText(item.description);
  const location = readFirstText(item, ['sm:location', 'location']);
  const price = readFirstText(item, ['sm:price', 'price']);
  const ages = readFirstText(item, ['sm:ages', 'ages']);
  const displayStatus = readFirstText(item, ['sm:status', 'status']);
  const rawStatusCode = readFirstText(item, STATUS_CODE_FIELDS);
  const statusCode = normalizeWorkshopStatusCode(rawStatusCode ?? displayStatus);
  const type = normalizeWorkshopType(readFirstText(item, TYPE_FIELDS));

  return {
    externalId,
    ...(legacyExternalId ? { legacyExternalId } : {}),
    title,
    startsAt,
    ...(endsAt ? { endsAt } : {}),
    url,
    ...(registrationUrl ? { registrationUrl } : {}),
    ...(registrationType ? { registrationType } : {}),
    ...(registrationData ? { registrationData } : {}),
    ...(description ? { description } : {}),
    ...(location ? { location } : {}),
    ...(price ? { price } : {}),
    ...(ages ? { ages } : {}),
    ...(imageUrl ? { imageUrl } : {}),
    status: normalizeWorkshopStatus(displayStatus ?? statusCode),
    statusCode,
    ...(type ? { type } : {}),
    ...(sourceUpdatedAt ? { sourceUpdatedAt } : {}),
  };
}

function normalizeWorkshopStatus(value: string | undefined): WorkshopStatus {
  const normalized = value?.trim().toLowerCase().replace(/\s+/g, '-');

  switch (normalized) {
    case 'scheduled':
    case 'opens-soon':
      return 'scheduled';
    case 'open':
      return 'open';
    case 'full':
      return 'full';
    case 'closed':
      return 'closed';
    case 'cancelled':
    case 'canceled':
      return 'cancelled';
    case 'private':
      return 'private';
    case 'hidden':
      return 'hidden';
    default:
      return 'unknown';
  }
}

export function normalizeWorkshopStatusCode(value: string | undefined): WorkshopStatusCode {
  const normalized = value?.trim().toLowerCase().replace(/\s+/g, '-');

  switch (normalized) {
    case 'scheduled':
    case 'opens-soon':
      return 'scheduled';
    case 'open':
      return 'open';
    case 'full':
      return 'full';
    case 'closed':
      return 'closed';
    case 'cancelled':
    case 'canceled':
      return 'cancelled';
    case 'private':
      return 'private';
    case 'hidden':
      return 'hidden';
    default:
      return 'unknown';
  }
}

export function getWorkshopStatusCode(workshop: WorkshopRecord): WorkshopStatusCode {
  return workshop.statusCode ?? normalizeWorkshopStatusCode(workshop.status);
}

export function isStemCraftWorkshop(workshop: WorkshopRecord): boolean {
  return workshop.type?.trim().toLowerCase() === 'stemcraft';
}

/**
 * Returns a safe registration CTA for Discord output. A missing URL falls back
 * to the workshop details page without inventing an endpoint.
 */
export function formatWorkshopRegistration(workshop: WorkshopRecord): string | undefined {
  const details = `[Details](${workshop.url})`;
  const registrationUrl = workshop.registrationUrl;

  switch (workshop.registrationType) {
    case 'none':
      return 'No registration required';
    case 'tickets':
      return registrationUrl ? `[Book now](${registrationUrl})` : `Book now via ${details}`;
    case 'external':
    case 'external-link':
    case 'link':
      return registrationUrl ? `[Register](${registrationUrl})` : `Register via ${details}`;
    case 'interest':
      return registrationUrl
        ? `[Register interest](${registrationUrl})`
        : `Register interest via ${details}`;
    case 'email':
      if (registrationUrl) {
        return `[Email to register](${registrationUrl})`;
      }

      if (workshop.registrationData) {
        return `Email ${workshop.registrationData} to register`;
      }

      return `Email to register via ${details}`;
    case 'message':
      return workshop.registrationData
        ? `Registration: ${workshop.registrationData}`
        : `Message to register via ${details}`;
    default:
      return registrationUrl ? `[Register](${registrationUrl})` : undefined;
  }
}

function normalizeWorkshopType(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized || undefined;
}

function normalizeRegistrationType(
  value: string | undefined,
): WorkshopRegistrationType | undefined {
  if (!value) {
    return undefined;
  }

  const normalized = value.trim().toLowerCase().replace(/\s+/g, '-');
  switch (normalized) {
    case 'none':
    case 'tickets':
    case 'interest':
    case 'email':
    case 'message':
      return normalized;
    case 'external':
    case 'external-link':
    case 'external-links':
    case 'link':
      return 'link';
    default:
      return 'unknown';
  }
}

function safeRegistrationUrl(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  try {
    const url = new URL(value);
    if (!['http:', 'https:', 'mailto:'].includes(url.protocol)) {
      return undefined;
    }

    return url.toString();
  } catch {
    return undefined;
  }
}

function safeRegistrationDataUrl(
  value: string | undefined,
  registrationType: WorkshopRegistrationType | undefined,
): string | undefined {
  if (!value) {
    return undefined;
  }

  const url = safeRegistrationUrl(value);
  if (url) {
    return url;
  }

  if (registrationType === 'email' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
    return `mailto:${value}`;
  }

  return undefined;
}

function readFirstText(object: XmlObject, fields: readonly string[]): string | undefined {
  for (const field of fields) {
    const value = readText(object[field]);
    if (value) {
      return value;
    }
  }

  return undefined;
}

function readEnclosureUrl(object: XmlObject): string | undefined {
  const enclosure = asObject(object.enclosure);
  const url = readText(enclosure?.['@_url']) ?? readText(enclosure?.url);
  return safeHttpUrl(url);
}

function readText(value: unknown): string | undefined {
  if (typeof value === 'string' || typeof value === 'number') {
    const result = String(value).trim();
    return result || undefined;
  }

  const object = asObject(value);
  if (!object) {
    return undefined;
  }

  return readText(object['#text']) ?? readText(object['@_value']);
}

function parseDate(value: string | undefined): Date | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function safeHttpUrl(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function asObject(value: unknown): XmlObject | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as XmlObject)
    : undefined;
}
