import { describe, expect, it } from 'vitest';
import { CLOUDFLARE_FREE_BYTES } from '../../shared/netstats';
import { parseCloudflareUsage } from '../cloudflareUsage';

const NOW = Date.UTC(2026, 10, 3, 12);

describe('spotreba Cloudflare TURN', () => {
  it('sčíta mesiac za celý účet, za kľúč hry a dnešok', () => {
    const usage = parseCloudflareUsage(
      {
        configured: true,
        month: '2026-11',
        response: {
          data: {
            viewer: {
              accounts: [
                {
                  monthAll: [{ sum: { egressBytes: 41_500_000_000, ingressBytes: 9 } }],
                  monthKey: [{ sum: { egressBytes: 40_000_000_000, ingressBytes: 38_000_000_000 } }],
                  todayKey: [],
                },
              ],
            },
          },
          errors: null,
        },
      },
      NOW - 60_000,
      NOW,
    );
    expect(usage).toMatchObject({
      configured: true,
      month: '2026-11',
      accountEgressBytes: 41_500_000_000,
      keyEgressBytes: 40_000_000_000,
      keyIngressBytes: 38_000_000_000,
      todayEgressBytes: 0,
      freeBytes: CLOUDFLARE_FREE_BYTES,
      error: null,
    });
  });

  it('ukáže chybu z Cloudflare (zlý token, chýbajúce oprávnenie) aj staré čísla', () => {
    expect(parseCloudflareUsage({ configured: true, month: '2026-11', response: { data: null, errors: [{ message: 'not authorized for that account' }] } }, NOW, NOW).error).toBe('not authorized for that account');
    expect(parseCloudflareUsage({ configured: false }, NOW, NOW)).toMatchObject({ configured: false, error: null });
    const stale = parseCloudflareUsage({ configured: true, month: '2026-11', response: { data: { viewer: { accounts: [{ monthAll: [], monthKey: [], todayKey: [] }] } } } }, NOW - 3 * 3600_000, NOW);
    expect(stale.accountEgressBytes).toBe(0);
    expect(stale.error).toMatch(/staršie ako 2 h/);
  });
});
