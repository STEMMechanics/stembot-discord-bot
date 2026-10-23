import { describe, expect, it, vi } from 'vitest';

import {
  createUptimeKumaIntegration,
  resolveUptimeKumaEndpoints,
} from '../src/integrations/uptime-kuma.js';

describe('Uptime Kuma integration', () => {
  it('resolves the published status page URL to public JSON endpoints', () => {
    const endpoints = resolveUptimeKumaEndpoints(
      'https://uptime.example.test/status/stem?view=public',
    );

    expect(endpoints.statusPageDataUrl.toString()).toBe(
      'https://uptime.example.test/api/status-page/stem',
    );
    expect(endpoints.heartbeatUrl.toString()).toBe(
      'https://uptime.example.test/api/status-page/heartbeat/stem',
    );
  });

  it('maps the latest public heartbeats into monitor and overall status', async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/api/status-page/stem')) {
        return new Response(
          JSON.stringify({
            config: { title: 'STEMMechanics Status' },
            publicGroupList: [
              {
                monitorList: [
                  { id: 1, name: 'Website' },
                  { id: 2, name: 'STEMCraft' },
                ],
              },
            ],
            incident: { title: 'Minecraft maintenance', content: 'The server is being updated.' },
          }),
          { headers: { 'content-type': 'application/json' } },
        );
      }

      return new Response(
        JSON.stringify({
          heartbeatList: {
            '1': [
              { status: 1, time: '2026-10-23T00:00:00.000Z', msg: 'OK' },
              { status: 1, time: '2026-10-23T00:01:00.000Z', msg: 'OK' },
            ],
            '2': [{ status: 0, time: '2026-10-23T00:01:00.000Z', msg: 'Connection refused' }],
          },
          uptimeList: { '1_24': 0.9998, '2_24': 0.95 },
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    });

    const integration = createUptimeKumaIntegration({
      statusPageUrl: 'https://uptime.example.test/status/stem',
      requestTimeoutMs: 1000,
      fetchImplementation,
    });
    const status = await integration.getStatus();

    expect(status).toMatchObject({
      overall: 'down',
      title: 'STEMMechanics Status',
      incident: {
        title: 'Minecraft maintenance',
      },
      monitors: [
        { id: '1', name: 'Website', state: 'up', uptime24h: 0.9998 },
        {
          id: '2',
          name: 'STEMCraft',
          state: 'down',
          message: 'Connection refused',
          uptime24h: 0.95,
        },
      ],
    });
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
  });
});
