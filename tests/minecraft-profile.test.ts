import { describe, expect, it, vi } from 'vitest';

import {
  createMinecraftProfileLookup,
  InvalidMinecraftUsernameError,
} from '../src/integrations/minecraft-profile.js';

describe('Minecraft profile lookup', () => {
  it('looks up a username and returns its UUID and current name', async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ id: '0123456789abcdef0123456789abcdef', name: 'Alex' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const lookup = createMinecraftProfileLookup({
      requestTimeoutMs: 1000,
      fetchImplementation,
    });

    await expect(lookup.findByUsername(' Alex ')).resolves.toEqual({
      uuid: '0123456789abcdef0123456789abcdef',
      username: 'Alex',
    });
    expect(fetchImplementation).toHaveBeenCalledWith(
      'https://api.mojang.com/users/profiles/minecraft/Alex',
      expect.objectContaining({
        headers: { Accept: 'application/json' },
      }),
    );
  });

  it('returns no profile for an unknown username', async () => {
    const lookup = createMinecraftProfileLookup({
      requestTimeoutMs: 1000,
      fetchImplementation: vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(null, { status: 404 })),
    });

    await expect(lookup.findByUsername('UnknownPlayer')).resolves.toBeUndefined();
  });

  it('looks up a UUID and returns the current username', async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: '0123456789abcdef0123456789abcdef',
          name: 'Alex',
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      ),
    );
    const lookup = createMinecraftProfileLookup({
      requestTimeoutMs: 1000,
      fetchImplementation,
    });

    await expect(lookup.findByUuid?.('01234567-89ab-cdef-0123-456789abcdef')).resolves.toEqual({
      uuid: '0123456789abcdef0123456789abcdef',
      username: 'Alex',
    });
    expect(fetchImplementation).toHaveBeenCalledWith(
      'https://sessionserver.mojang.com/session/minecraft/profile/0123456789abcdef0123456789abcdef',
      expect.objectContaining({
        headers: { Accept: 'application/json' },
      }),
    );
  });

  it('rejects invalid Minecraft usernames before making a request', async () => {
    const fetchImplementation = vi.fn<typeof fetch>();
    const lookup = createMinecraftProfileLookup({
      requestTimeoutMs: 1000,
      fetchImplementation,
    });

    await expect(lookup.findByUsername('not a username')).rejects.toBeInstanceOf(
      InvalidMinecraftUsernameError,
    );
    expect(fetchImplementation).not.toHaveBeenCalled();
  });
});
