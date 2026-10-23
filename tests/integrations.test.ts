import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';

import {
  WebsiteRssIntegration,
  normalizeLegacyXmlDeclaration,
} from '../src/integrations/website.js';
import {
  PlayerListUnavailableError,
  StemCraftHttpIntegration,
} from '../src/integrations/stemcraft.js';

const logger = pino({ level: 'silent' });

describe('Website RSS integration', () => {
  it('parses offset-aware dates, stable identities, and optional registration metadata', async () => {
    const fetchImplementation = vi.fn().mockResolvedValue(
      new Response(
        `<?xml version=&quot;1.0&quot; encoding=&quot;UTF-8&quot;?>
        <rss xmlns:sm="https://stemmechanics.com/ns/rss/workshop">
          <channel>
            <item>
              <title>Redstone Music Challenge</title>
              <link>https://www.stemmechanics.com.au/workshops/redstone</link>
              <sm:id>redstone-final-id</sm:id>
              <guid>legacy-redstone-guid</guid>
              <pubDate>Wed, 30 Sep 2026 11:58:46 +1000</pubDate>
              <description>Build a redstone instrument.</description>
              <content:encoded><![CDATA[<p>Full redstone description.</p>]]></content:encoded>
              <sm:startDate>2026-10-24T16:00:00+10:00</sm:startDate>
              <sm:endDate>2026-10-24T17:00:00+10:00</sm:endDate>
              <sm:location>STEMCraft</sm:location>
              <sm:price>Free</sm:price>
              <sm:ages>8+</sm:ages>
              <sm:status>Open</sm:status>
              <sm:statusCode>open</sm:statusCode>
              <sm:type>STEMCraft</sm:type>
              <sm:registrationType>link</sm:registrationType>
              <sm:registrationUrl>https://example.test/register</sm:registrationUrl>
              <sm:registrationData>https://example.test/register</sm:registrationData>
            </item>
          </channel>
        </rss>`,
        { headers: { 'content-type': 'application/rss+xml' } },
      ),
    );

    const integration = new WebsiteRssIntegration({
      feedUrl: 'https://example.test/workshops/feed',
      requestTimeoutMs: 1000,
      logger,
      fetchImplementation,
    });

    const [workshop] = await integration.getWorkshops();

    expect(workshop).toMatchObject({
      externalId: 'redstone-final-id',
      legacyExternalId: 'legacy-redstone-guid',
      title: 'Redstone Music Challenge',
      registrationType: 'link',
      registrationUrl: 'https://example.test/register',
      registrationData: 'https://example.test/register',
      location: 'STEMCraft',
      status: 'open',
      statusCode: 'open',
      type: 'stemcraft',
    });
    expect(workshop?.startsAt.toISOString()).toBe('2026-10-24T06:00:00.000Z');
    expect(workshop?.endsAt?.toISOString()).toBe('2026-10-24T07:00:00.000Z');
    expect(workshop?.description).toBe('<p>Full redstone description.</p>');
    expect(fetchImplementation).toHaveBeenCalledWith(
      'https://example.test/workshops/feed',
      expect.objectContaining({
        headers: { Accept: 'application/rss+xml, application/xml, text/xml' },
      }),
    );
  });

  it('loads the full workshop body when the RSS description is truncated', async () => {
    const fetchImplementation = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          `<rss xmlns:sm="https://stemmechanics.com/ns/rss/workshop"><channel>
            <item>
              <title>Redstone Music Challenge</title>
              <link>https://example.test/workshops/redstone</link>
              <sm:id>redstone-id</sm:id>
              <sm:startDate>2026-10-24T16:00:00+10:00</sm:startDate>
              <description>Can you build a musical machine...\n\nSat 24 Oct 2026 4:00pm · STEMCraft</description>
            </item>
          </channel></rss>`,
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          `<html><body><article class="content my-4">
            <p>Can you build a musical machine?</p>
            <p>Use redstone and note blocks to create your own song.</p>
            <h3>Learning Outcomes</h3>
            <ul><li>Build a circuit.</li></ul>
          </article></body></html>`,
        ),
      );

    const integration = new WebsiteRssIntegration({
      feedUrl: 'https://example.test/workshops/feed',
      requestTimeoutMs: 1000,
      logger,
      fetchImplementation,
    });

    const [workshop] = await integration.getWorkshops();

    expect(workshop?.description).toContain('Use redstone and note blocks');
    expect(fetchImplementation).toHaveBeenNthCalledWith(
      2,
      'https://example.test/workshops/redstone',
      expect.objectContaining({
        headers: { Accept: 'text/html, application/xhtml+xml' },
      }),
    );
  });

  it('marks RSS descriptions as fallback content when the workshop page is unavailable', async () => {
    const fetchImplementation = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          `<rss xmlns:sm="https://stemmechanics.com/ns/rss/workshop"><channel>
            <item>
              <title>Redstone Music Challenge</title>
              <link>https://example.test/workshops/redstone</link>
              <sm:id>redstone-id</sm:id>
              <sm:startDate>2026-10-24T16:00:00+10:00</sm:startDate>
              <description>Can you build a musical machine...\n\nSat 24 Oct 2026 4:00pm · STEMCraft</description>
            </item>
          </channel></rss>`,
        ),
      )
      .mockResolvedValueOnce(new Response('maintenance', { status: 503 }));

    const integration = new WebsiteRssIntegration({
      feedUrl: 'https://example.test/workshops/feed',
      requestTimeoutMs: 1000,
      logger,
      fetchImplementation,
    });

    await expect(integration.getWorkshops()).resolves.toMatchObject([
      {
        description: expect.stringContaining('Can you build a musical machine'),
        descriptionFallback: true,
      },
    ]);
  });

  it('parses every final registration type, including duplicate titles and missing optional fields', async () => {
    const item = (id: string, registration: string, value = '') => `
      <item>
        <title>Workshop</title>
        <sm:id>${id}</sm:id>
        <link>https://example.test/workshops/${id}</link>
        <sm:startDate>2026-11-01T10:00:00+10:00</sm:startDate>
        <sm:statusCode>open</sm:statusCode>
        <sm:registrationType>${registration}</sm:registrationType>
        ${value.startsWith('http') ? `<sm:registrationUrl>${value}</sm:registrationUrl>` : value ? `<sm:registrationData>${value}</sm:registrationData>` : ''}
      </item>`;
    const fetchImplementation = vi.fn().mockResolvedValue(
      new Response(
        `<rss xmlns:sm="https://stemmechanics.com/ns/rss/workshop"><channel>
          ${item('tickets-id', 'tickets', 'https://example.test/tickets')}
          ${item('external-id', 'external', 'https://example.test/external')}
          ${item('interest-id', 'interest', 'https://example.test/interest')}
          ${item('email-id', 'email', 'bookings@example.test')}
          ${item('message-id', 'message', 'Contact the workshop organiser')}
          ${item('none-id', 'none')}
        </channel></rss>`,
      ),
    );

    const integration = new WebsiteRssIntegration({
      feedUrl: 'https://example.test/workshops/feed',
      requestTimeoutMs: 1000,
      logger,
      fetchImplementation,
    });

    const workshops = await integration.getWorkshops();
    const byId = new Map(workshops.map((workshop) => [workshop.externalId, workshop]));

    expect(workshops).toHaveLength(6);
    expect([...byId.values()].every((workshop) => workshop.title === 'Workshop')).toBe(true);
    expect(byId.get('tickets-id')).toMatchObject({
      registrationType: 'tickets',
      registrationUrl: 'https://example.test/tickets',
    });
    expect(byId.get('external-id')).toMatchObject({
      registrationType: 'link',
      registrationUrl: 'https://example.test/external',
    });
    expect(byId.get('interest-id')).toMatchObject({
      registrationType: 'interest',
      registrationUrl: 'https://example.test/interest',
    });
    expect(byId.get('email-id')).toMatchObject({
      registrationType: 'email',
      registrationUrl: 'mailto:bookings@example.test',
      registrationData: 'bookings@example.test',
    });
    expect(byId.get('message-id')).toMatchObject({
      registrationType: 'message',
      registrationData: 'Contact the workshop organiser',
    });
    expect(byId.get('none-id')).toMatchObject({ registrationType: 'none' });
  });

  it('skips malformed items while preserving valid items and duplicate titles', async () => {
    const fetchImplementation = vi.fn().mockResolvedValue(
      new Response(`
        <rss><channel>
          <item><title>Valid A</title><link>https://example.test/a</link><guid>legacy-a</guid><sm:startDate xmlns:sm="https://stemmechanics.com/ns/rss/workshop">2026-11-01T10:00:00+10:00</sm:startDate></item>
          <item><title>Broken</title><link>https://example.test/b</link><sm:startDate xmlns:sm="https://stemmechanics.com/ns/rss/workshop">not-a-date</sm:startDate></item>
          <item><title>Valid A</title><link>https://example.test/c</link><sm:startDate xmlns:sm="https://stemmechanics.com/ns/rss/workshop">2026-10-25T10:00:00+10:00</sm:startDate></item>
        </channel></rss>`),
    );

    const integration = new WebsiteRssIntegration({
      feedUrl: 'https://example.test/workshops/feed',
      requestTimeoutMs: 1000,
      logger,
      fetchImplementation,
    });

    const workshops = await integration.getWorkshops();

    expect(workshops).toHaveLength(2);
    expect(workshops.map((workshop) => workshop.externalId)).toEqual([
      'https://example.test/c',
      'legacy-a',
    ]);
    expect(workshops[0]).toMatchObject({ status: 'unknown', statusCode: 'unknown' });
    expect(workshops[0]).not.toHaveProperty('type');
  });

  it('only normalizes the known deployed escaped XML declaration', () => {
    const legacy = normalizeLegacyXmlDeclaration(
      '<?xml version=&quot;1.0&quot; encoding=&quot;UTF-8&quot;?>\n<rss />',
    );
    const valid = normalizeLegacyXmlDeclaration('<?xml version="1.0"?><rss />');

    expect(legacy.legacyDeclarationFixed).toBe(true);
    expect(legacy.xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(valid.legacyDeclarationFixed).toBe(false);
  });

  it('parses the deployed literal XML declaration', async () => {
    const fetchImplementation = vi.fn().mockResolvedValue(
      new Response(
        `<?xml version="1.0" encoding="UTF-8"?><rss xmlns:sm="https://stemmechanics.com/ns/rss/workshop">
          <channel>
            <item>
              <title>Paper Speakers</title>
              <link>https://www.stemmechanics.com.au/workshops/paper-speakers</link>
              <guid>https://www.stemmechanics.com.au/workshops/paper-speakers</guid>
              <sm:startDate>2026-10-25T10:00:00+10:00</sm:startDate>
              <sm:status>Open</sm:status>
            </item>
          </channel>
        </rss>`,
        { headers: { 'content-type': 'application/rss+xml' } },
      ),
    );

    const integration = new WebsiteRssIntegration({
      feedUrl: 'https://example.test/workshops/feed',
      requestTimeoutMs: 1000,
      logger,
      fetchImplementation,
    });

    await expect(integration.getWorkshops()).resolves.toMatchObject([
      {
        title: 'Paper Speakers',
        status: 'open',
        startsAt: new Date('2026-10-25T00:00:00.000Z'),
      },
    ]);
  });
});

describe('STEMCraft status integration', () => {
  it('supports the current aggregate response and reports player names as unavailable', async () => {
    const fetchImplementation = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            online: true,
            players_online: 0,
            max_players: 50,
            version: '26.3',
            maintenance: false,
            message: null,
            checked_at: '2026-10-22T09:18:48.798314004Z',
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
      ),
    );
    const integration = new StemCraftHttpIntegration({
      statusUrl: 'http://example.test/status',
      requestTimeoutMs: 1000,
      logger,
      fetchImplementation,
    });

    await expect(integration.getServerStatus()).resolves.toMatchObject({
      online: true,
      playerCount: 0,
      maxPlayers: 50,
      version: '26.3',
    });
    await expect(integration.getOnlinePlayers()).rejects.toBeInstanceOf(PlayerListUnavailableError);
  });

  it('reads usernames from an updated player array and never exposes identity fields', async () => {
    const fetchImplementation = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          status: 'online',
          players_online: 3,
          players: [
            { name: 'Alex', uuid: 'private-uuid' },
            { username: 'Builder' },
            { displayName: 'Alex' },
          ],
        }),
        { headers: { 'content-type': 'application/json' } },
      ),
    );
    const integration = new StemCraftHttpIntegration({
      statusUrl: 'https://example.test/status',
      requestTimeoutMs: 1000,
      logger,
      token: 'test-token',
      fetchImplementation,
    });

    await expect(integration.getOnlinePlayers()).resolves.toEqual([
      { username: 'Alex' },
      { username: 'Builder' },
    ]);
    expect(fetchImplementation).toHaveBeenCalledWith(
      'https://example.test/status',
      expect.objectContaining({
        headers: { Accept: 'application/json', Authorization: 'Bearer test-token' },
      }),
    );
  });

  it('reads the deployed username-only player array', async () => {
    const fetchImplementation = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            online: true,
            players_online: 1,
            max_players: 50,
            version: '26.3',
            maintenance: false,
            message: null,
            players: ['nomadjimbob'],
            checked_at: '2026-10-22T10:41:13.859892186Z',
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
      ),
    );
    const integration = new StemCraftHttpIntegration({
      statusUrl: 'http://play.stemcraft.com.au:8950/status',
      requestTimeoutMs: 1000,
      logger,
      fetchImplementation,
    });

    await expect(integration.getServerStatus()).resolves.toMatchObject({
      online: true,
      playerCount: 1,
      maxPlayers: 50,
      version: '26.3',
    });
    await expect(integration.getOnlinePlayers()).resolves.toEqual([{ username: 'nomadjimbob' }]);
  });
});
