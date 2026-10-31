import { describe, expect, it, vi } from 'vitest';

import {
  createMinecraftPlayerProfileLookup,
  MinecraftPlayerProfileLookupError,
} from '../src/integrations/minecraft-player-profile.js';

describe('STEMCraft player profile lookup', () => {
  it('requests the stats section for a UUID and parses the profile response', async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          api_version: 1,
          player: {
            uuid: '01234567-89ab-cdef-0123-456789abcdef',
            name: 'Alex',
            platform: 'java',
            online: true,
          },
          generated_at: '2026-10-31T00:00:00Z',
          sections: {
            stats: {
              available: true,
              title: 'Statistics',
              period: '28d',
              updated_at: '2026-10-31T00:00:00Z',
              items: [
                {
                  key: 'deaths',
                  title: 'Deaths',
                  description: 'Number of deaths.',
                  value: 3,
                },
              ],
            },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const lookup = createMinecraftPlayerProfileLookup({
      apiUrl: 'https://play.example.test/api/v1',
      token: 'player-api-secret',
      requestTimeoutMs: 1000,
      fetchImplementation,
    });

    await expect(
      lookup.findByUuid('0123456789abcdef0123456789abcdef', {
        include: ['stats'],
        period: '28d',
      }),
    ).resolves.toEqual({
      profile: {
        uuid: '0123456789abcdef0123456789abcdef',
        username: 'Alex',
      },
      platform: 'java',
      online: true,
      generatedAt: '2026-10-31T00:00:00Z',
      stats: {
        available: true,
        period: '28d',
        updatedAt: '2026-10-31T00:00:00Z',
        items: [
          {
            key: 'deaths',
            title: 'Deaths',
            description: 'Number of deaths.',
            value: 3,
          },
        ],
      },
    });

    const [request, init] = fetchImplementation.mock.calls[0] ?? [];
    const url = new URL(String(request));
    expect(url.pathname).toBe('/api/v1/players/01234567-89ab-cdef-0123-456789abcdef/profile');
    expect(url.searchParams.get('include')).toBe('stats');
    expect(url.searchParams.get('period')).toBe('28d');
    expect(init).toEqual(
      expect.objectContaining({
        headers: {
          Accept: 'application/json',
          Authorization: 'Bearer player-api-secret',
        },
      }),
    );
  });

  it('returns undefined when STEMCraft does not know the player', async () => {
    const lookup = createMinecraftPlayerProfileLookup({
      apiUrl: 'https://play.example.test/api/v1',
      token: 'player-api-secret',
      requestTimeoutMs: 1000,
      fetchImplementation: vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(null, { status: 404 })),
    });

    await expect(lookup.findByUuid('0123456789abcdef0123456789abcdef')).resolves.toBeUndefined();
  });

  it('rejects an invalid UUID before making a request', async () => {
    const fetchImplementation = vi.fn<typeof fetch>();
    const lookup = createMinecraftPlayerProfileLookup({
      apiUrl: 'https://play.example.test/api/v1',
      token: 'player-api-secret',
      requestTimeoutMs: 1000,
      fetchImplementation,
    });

    await expect(lookup.findByUuid('not-a-uuid')).rejects.toBeInstanceOf(
      MinecraftPlayerProfileLookupError,
    );
    expect(fetchImplementation).not.toHaveBeenCalled();
  });
});
