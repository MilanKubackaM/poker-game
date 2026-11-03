import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { NET_SAMPLE_MS, PROBLEM, diagnoseNet, lastFilledIndex, type CloudflareUsage, type NetPlayerSeries, type NetSeries, type NetStatsResponse, type Series } from '../../../shared/netstats';
import { fetchNetStats, initialStatsKey, saveStatsKey, type StatsQuery } from './api';
import { SERIES_COLORS, STATUS, formatBytes, formatDateTime, formatKbps, formatMs, formatNumber, formatPct, formatTime, fromLocalInput, toLocalInput } from './format';
import { LineChart, type ChartSeries } from './LineChart';
import { LinkMatrix } from './LinkMatrix';
import './stats.css';

type Range = '15m' | '1h' | '3h' | '12h' | '24h' | 'custom';

const RANGES: { id: Range; label: string; ms: number }[] = [
  { id: '15m', label: '15 min', ms: 15 * 60_000 },
  { id: '1h', label: '1 h', ms: 3600_000 },
  { id: '3h', label: '3 h', ms: 3 * 3600_000 },
  { id: '12h', label: '12 h', ms: 12 * 3600_000 },
  { id: '24h', label: '24 h', ms: 24 * 3600_000 },
];

const EVENT_LABEL = { ice: 'Spojenie', freeze: 'Obraz', audio: 'Zvuk', socket: 'Server' } as const;

function at(values: Series | undefined, index: number): number | null {
  return values ? (values[index] ?? null) : null;
}

function KeyForm({ error, onSubmit }: { error: string | null; onSubmit: (key: string) => void }) {
  const [value, setValue] = useState('');
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (value.trim()) {
      onSubmit(value.trim());
    }
  };
  return (
    <div className="netstats-login">
      <form className="panel netstats-login-form" onSubmit={submit}>
        <h1>Sieť a prenos</h1>
        <label className="field">
          <span>Kľúč k štatistikám</span>
          <input type="password" autoComplete="current-password" value={value} onChange={(event) => setValue(event.target.value)} autoFocus />
        </label>
        {error && <p className="field-error">{error}</p>}
        <button type="submit" className="btn btn-primary btn-block">
          Otvoriť
        </button>
      </form>
    </div>
  );
}

function Tile({ label, value, note, status, wide }: { label: string; value: string; note?: string; status?: 'warning' | 'critical' | null; wide?: boolean }) {
  return (
    <div className={`nettile${status ? ` nettile-${status}` : ''}${wide ? ' nettile-wide' : ''}`}>
      <span className="nettile-label">{label}</span>
      <strong className="nettile-value">{value}</strong>
      {note && <span className="nettile-note">{note}</span>}
      {status && <span className="nettile-flag">{status === 'critical' ? 'Kritické' : 'Pozor'}</span>}
    </div>
  );
}

/** Spotreba Cloudflare TURN v mesiaci voči free tieru (1 000 GB egressu, spoločné pre celý účet) + odhad na koniec mesiaca. */
function CloudflareTile({ usage, now = Date.now() }: { usage: CloudflareUsage | null; now?: number }) {
  if (!usage) {
    return <Tile wide label="Cloudflare tento mesiac" value="–" note="sidecar turn-creds zatiaľ nič nezapísal" />;
  }
  if (!usage.configured) {
    return <Tile wide label="Cloudflare tento mesiac" value="–" note="nesleduje sa — pridaj CF_ACCOUNT_ID a CF_ANALYTICS_TOKEN do .env na NAS" />;
  }
  const used = usage.accountEgressBytes;
  const pct = used === null ? null : (used / usage.freeBytes) * 100;
  const date = new Date(now);
  const monthStart = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
  const daysInMonth = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  const elapsedDays = (now - monthStart) / 86_400_000;
  const projected = used !== null && elapsedDays >= 1 ? (used / elapsedDays) * daysInMonth : null;
  const status = pct === null ? null : pct >= 90 ? 'critical' : pct >= 70 || (projected !== null && projected > usage.freeBytes) ? 'warning' : null;
  const parts =
    used === null
      ? []
      : [
          `${formatPct(pct)} z ${formatBytes(usage.freeBytes)} zadarmo`,
          `zostáva ${formatBytes(Math.max(0, usage.freeBytes - used))}`,
          `dnes hra ${formatBytes(usage.todayEgressBytes)}`,
          ...(projected !== null ? [`koniec mesiaca ~${formatBytes(projected)}`] : []),
          ...(usage.updatedAt ? [`stav ${formatTime(usage.updatedAt, false)}`] : []),
        ];
  return <Tile wide label="Cloudflare tento mesiac" value={formatBytes(used)} note={usage.error ?? parts.join(' · ')} status={usage.error ? 'warning' : status} />;
}

export function StatsPage() {
  const [key, setKey] = useState(initialStatsKey);
  const [keyError, setKeyError] = useState<string | null>(null);
  const [mode, setMode] = useState<'live' | 'history'>('live');
  const [range, setRange] = useState<Range>('1h');
  const [customFrom, setCustomFrom] = useState(() => toLocalInput(Date.now() - 3 * 3600_000));
  const [customTo, setCustomTo] = useState(() => toLocalInput(Date.now()));
  const [code, setCode] = useState<string | null>(null);
  const [series, setSeries] = useState<NetSeries | null>(null);
  const [relay, setRelay] = useState<{ provider: NetStatsResponse['relay'] | null; cloudflare: CloudflareUsage | null }>({ provider: null, cloudflare: null });
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [pinned, setPinned] = useState<number | null>(null);
  /** Pri histórii posunie prednastavený rozsah na „teraz“. */
  const [refreshes, setRefreshes] = useState(0);
  const requestRef = useRef<AbortController | null>(null);

  useEffect(() => {
    document.title = 'Sieť a prenos — Poker Night';
  }, []);

  const query = useMemo<StatsQuery | null>(() => {
    if (mode === 'live') {
      return { mode: 'live', code };
    }
    if (range === 'custom') {
      const from = fromLocalInput(customFrom);
      const to = fromLocalInput(customTo);
      return from !== null && to !== null && from < to ? { mode: 'history', code, from, to } : null;
    }
    const ms = RANGES.find((entry) => entry.id === range)!.ms;
    const to = Date.now();
    return { mode: 'history', code, from: to - ms, to };
  }, [mode, range, customFrom, customTo, code, refreshes]);

  const load = useCallback(
    async (current: StatsQuery | null, quiet = false) => {
      if (!key || !current) {
        return;
      }
      requestRef.current?.abort();
      const controller = new AbortController();
      requestRef.current = controller;
      if (!quiet) {
        setLoading(true);
      }
      try {
        const result = await fetchNetStats(current, key, controller.signal);
        if (!result.ok) {
          if (result.unauthorized) {
            saveStatsKey('');
            setKey('');
            setKeyError(result.error);
          } else {
            setError(result.error);
          }
          return;
        }
        setError(null);
        setSeries(result.series);
        setRelay({ provider: result.relay, cloudflare: result.cloudflare });
        setUpdatedAt(Date.now());
        if (!code && result.series.code) {
          setCode(result.series.code);
        }
      } catch {
        return;
      } finally {
        if (requestRef.current === controller) {
          setLoading(false);
        }
      }
    },
    [key, code],
  );

  useEffect(() => {
    void load(query);
    if (mode !== 'live') {
      return;
    }
    const timer = window.setInterval(() => void load(query, true), NET_SAMPLE_MS);
    return () => window.clearInterval(timer);
  }, [load, query, mode]);

  useEffect(() => setPinned(null), [mode, range, code]);

  if (!key) {
    return (
      <KeyForm
        error={keyError}
        onSubmit={(value) => {
          saveStatsKey(value);
          setKeyError(null);
          setKey(value);
        }}
      />
    );
  }

  const latest = series ? lastFilledIndex(series) : 0;
  const index = series ? Math.min(pinned ?? latest, series.times.length - 1) : 0;
  const hints = series ? diagnoseNet(series, index) : [];
  const colors = new Map(series?.players.map((player, position) => [player.id, SERIES_COLORS[position % SERIES_COLORS.length]]) ?? []);
  const playerSeries = (metric: keyof NetPlayerSeries): ChartSeries[] =>
    series
      ? series.players.filter((player) => series.player[player.id]).map((player) => ({ id: player.id, name: player.name, color: colors.get(player.id)!, values: series.player[player.id][metric] }))
      : [];
  const markers = new Set<number>();
  if (series) {
    const bucket = (t: number) => Math.min(series.times.length - 1, Math.max(0, Math.floor((t - series.from) / series.bucketMs)));
    for (const event of series.events) {
      if (event.kind === 'socket' || (event.kind === 'ice' && /pripojené|hľadá|nové/.test(event.text))) {
        continue;
      }
      for (let position = bucket(event.t); position <= bucket(event.end ?? event.t); position++) {
        markers.add(position);
      }
    }
  }
  const relayIn = series ? Object.values(series.links).reduce((sum, link) => sum + (at(link.relay, index) === 1 ? (at(link.up, index) ?? 0) : 0), 0) : 0;
  const relayOut = series ? Object.values(series.links).reduce((sum, link) => sum + (at(link.relay, index) === 1 ? (at(link.down, index) ?? 0) : 0), 0) : 0;
  const load1 = series ? at(series.server.load, index) : null;
  const cores = series ? at(series.server.cores, index) : null;
  const loop = series ? at(series.server.loop, index) : null;
  const chartProps = { times: series?.times ?? [], selected: pinned, onSelect: setPinned, markers };
  const events = series?.events ?? [];

  return (
    <div className="netstats">
      <header className="netstats-top">
        <h1>Sieť a prenos</h1>
        <div className="netstats-controls">
          <div className="segmented" role="tablist" aria-label="Pohľad">
            <button type="button" role="tab" aria-selected={mode === 'live'} className={`segment${mode === 'live' ? ' active' : ''}`} onClick={() => setMode('live')}>
              Živé
            </button>
            <button type="button" role="tab" aria-selected={mode === 'history'} className={`segment${mode === 'history' ? ' active' : ''}`} onClick={() => setMode('history')}>
              História
            </button>
          </div>
          {series && series.tables.length > 0 && (
            <label className="netstats-select">
              <span>Stôl</span>
              <select value={series.code ?? ''} onChange={(event) => setCode(event.target.value || null)}>
                {series.tables.map((table) => (
                  <option key={table.code} value={table.code}>
                    {table.name} ({table.code})
                  </option>
                ))}
              </select>
            </label>
          )}
          <button type="button" className="btn btn-ghost btn-small" onClick={() => (mode === 'live' ? void load(query) : setRefreshes((count) => count + 1))} disabled={loading}>
            Obnoviť
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-small"
            onClick={() => {
              saveStatsKey('');
              setKey('');
            }}
          >
            Odhlásiť
          </button>
        </div>
        {mode === 'history' && (
          <div className="netstats-range">
            {RANGES.map((entry) => (
              <button key={entry.id} type="button" className={`btn btn-chip${range === entry.id ? ' active' : ''}`} onClick={() => setRange(entry.id)}>
                {entry.label}
              </button>
            ))}
            <button type="button" className={`btn btn-chip${range === 'custom' ? ' active' : ''}`} onClick={() => setRange('custom')}>
              Vlastný
            </button>
            {range === 'custom' && (
              <span className="netstats-custom">
                <input type="datetime-local" value={customFrom} onChange={(event) => setCustomFrom(event.target.value)} aria-label="Od" />
                <span>–</span>
                <input type="datetime-local" value={customTo} onChange={(event) => setCustomTo(event.target.value)} aria-label="Do" />
              </span>
            )}
          </div>
        )}
        <p className="netstats-status">
          {error ? <span className="danger">{error}</span> : updatedAt ? `Aktualizované ${formatTime(updatedAt)}` : 'Načítavam…'}
          {series && ` · interval ${formatNumber(series.bucketMs / 1000, 0)} s`}
          {mode === 'live' && ' · posledných 15 min, každých 5 s'}
        </p>
      </header>

      {!series ? null : series.players.length === 0 ? (
        <>
          <p className="netstats-empty panel">{mode === 'live' ? 'Teraz nikto nehrá s kamerou ani mikrofónom.' : 'V tomto rozsahu nie sú žiadne dáta.'}</p>
          {(relay.provider === 'cloudflare' || relay.cloudflare) && (
            <section className="nettiles">
              <CloudflareTile usage={relay.cloudflare} />
            </section>
          )}
        </>
      ) : (
        <main className={`netstats-body${loading ? ' is-loading' : ''}`}>
          <section className="panel netstats-diagnosis">
            <div className="netstats-section-head">
              <h2>Diagnóza · {formatDateTime(series.times[index])}</h2>
              {pinned !== null && (
                <button type="button" className="btn btn-ghost btn-small" onClick={() => setPinned(null)}>
                  {mode === 'live' ? 'Späť na aktuálne' : 'Posledný interval'}
                </button>
              )}
            </div>
            {hints.length === 0 ? (
              <p className="nethint nethint-ok">
                <span className="nethint-flag">OK</span>Bez problémov — zvuk ani obraz v tomto intervale nesekal.
              </p>
            ) : (
              <ul className="nethints">
                {hints.map((hint) => (
                  <li key={`${hint.cause}-${hint.title}`} className={`nethint nethint-${hint.severity}`}>
                    <span className="nethint-flag">{hint.severity === 'critical' ? 'Kritické' : 'Pozor'}</span>
                    <div>
                      <strong>{hint.title}</strong>
                      <p>{hint.detail}</p>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            <p className="netstats-note">Klikni do grafu na čas, ktorý chceš rozobrať — diagnóza, hráči a matica sa prepnú naň.</p>
          </section>

          <section className="nettiles">
            <Tile label="Záťaž NAS" value={load1 === null ? '–' : formatNumber(load1)} note={cores ? `${cores} jadier` : undefined} status={load1 !== null && cores ? (load1 / cores >= PROBLEM.loadPerCore ? 'critical' : load1 / cores >= 1 ? 'warning' : null) : null} />
            <Tile label="CPU servera hry" value={formatPct(at(series.server.cpu, index))} note="% jedného jadra" />
            <Tile label="Zasekanie servera" value={formatMs(loop)} note="event loop, 99. percentil" status={loop !== null && loop >= PROBLEM.loopMs ? 'warning' : null} />
            <Tile label="Pamäť servera" value={at(series.server.rss, index) === null ? '–' : `${at(series.server.rss, index)} MB`} />
            <Tile label="Pripojení" value={at(series.server.sockets, index) === null ? '–' : String(at(series.server.sockets, index))} />
            <Tile
              label={relay.provider === 'cloudflare' ? 'Relay cez Cloudflare' : 'Relay cez NAS'}
              value={`${formatKbps(relayIn)} ↑`}
              note={`${formatKbps(relayOut)} ↓ · odhad z hlásení hráčov`}
            />
            {(relay.provider === 'cloudflare' || relay.cloudflare) && <CloudflareTile usage={relay.cloudflare} />}
          </section>

          <section className="netplayers">
            {series.players.map((player) => {
              const data = series.player[player.id];
              const serverRtt = at(data?.serverRtt, index);
              const hidden = at(data?.hidden, index) === 1;
              const relay = at(data?.relay, index);
              return (
                <article key={player.id} className="panel netplayer" style={{ borderTopColor: colors.get(player.id) }}>
                  <h3>{player.name}</h3>
                  {!data ? (
                    <p className="netstats-note">Nehlási dáta (bez kamery a mikrofónu alebo staršia verzia hry)</p>
                  ) : (
                    <dl>
                      <dt>Posiela</dt>
                      <dd>{formatKbps(at(data.up, index))}</dd>
                      <dt>Prijíma</dt>
                      <dd>{formatKbps(at(data.down, index))}</dd>
                      <dt>Odozva servera</dt>
                      <dd className={serverRtt !== null && serverRtt >= PROBLEM.serverRttMs ? 'netbad' : undefined}>{formatMs(serverRtt)}</dd>
                      <dt>Najhorší zvuk</dt>
                      <dd className={(at(data.conceal, index) ?? 0) >= PROBLEM.concealPct ? 'netbad' : undefined}>{formatPct(at(data.conceal, index))} doplnené</dd>
                      <dt>Spojení cez relay</dt>
                      <dd>{relay === null ? '–' : relay}</dd>
                      {hidden && (
                        <>
                          <dt>Stav</dt>
                          <dd className="netbad">hra na pozadí</dd>
                        </>
                      )}
                    </dl>
                  )}
                </article>
              );
            })}
          </section>

          <section className="panel">
            <div className="netstats-section-head">
              <h2>Spojenia · {formatTime(series.times[index])}</h2>
            </div>
            <LinkMatrix series={series} index={index} />
          </section>

          <section className="netcharts">
            <LineChart title="Posiela (upload)" hint="všetkým spolu" series={playerSeries('up')} format={formatKbps} {...chartProps} />
            <LineChart title="Prijíma (download)" hint="od všetkých spolu" series={playerSeries('down')} format={formatKbps} {...chartProps} />
            <LineChart title="Doplnený zvuk" hint="najhoršie prichádzajúce spojenie — sekanie" series={playerSeries('conceal')} format={formatPct} minMax={5} threshold={PROBLEM.concealPct} {...chartProps} />
            <LineChart title="Strata paketov" hint="najhoršie prichádzajúce spojenie" series={playerSeries('loss')} format={formatPct} minMax={5} threshold={PROBLEM.audioLossPct} {...chartProps} />
            <LineChart title="RTT medzi hráčmi" hint="najhoršie spojenie" series={playerSeries('rtt')} format={formatMs} minMax={100} threshold={PROBLEM.rttMs} {...chartProps} />
            <LineChart title="Odozva servera hry" hint="cez Funnel" series={playerSeries('serverRtt')} format={formatMs} minMax={100} threshold={PROBLEM.serverRttMs} {...chartProps} />
            <LineChart title="Zamrznutia obrazu" hint="počet za interval" series={playerSeries('freezes')} format={(value) => formatNumber(value, 0)} minMax={2} {...chartProps} />
            <LineChart title="Záťaž NAS" hint="load average 1 min" series={[{ id: 'load', name: 'NAS', color: SERIES_COLORS[0], values: series.server.load }]} format={(value) => formatNumber(value)} minMax={cores ?? 1} threshold={cores ?? undefined} {...chartProps} />
            <LineChart title="Zasekanie servera hry" hint="event loop, 99. percentil" series={[{ id: 'loop', name: 'Server', color: SERIES_COLORS[0], values: series.server.loop }]} format={formatMs} minMax={50} threshold={PROBLEM.loopMs} {...chartProps} />
          </section>

          <section className="panel">
            <div className="netstats-section-head">
              <h2>Udalosti</h2>
              <span className="netstats-note">{events.length ? `${events.length} najnovších` : 'žiadne'}</span>
            </div>
            {events.length > 0 && (
              <div className="table-scroll">
                <table className="netevents">
                  <thead>
                    <tr>
                      <th scope="col">Čas</th>
                      <th scope="col">Typ</th>
                      <th scope="col">Hráč</th>
                      <th scope="col">Od / s</th>
                      <th scope="col">Čo sa stalo</th>
                    </tr>
                  </thead>
                  <tbody>
                    {events.map((event, position) => (
                      <tr key={`${event.t}-${position}`} className={`netevent-${event.kind}`}>
                        <td>
                          {formatTime(event.t)}
                          {event.end && event.end > event.t ? `–${formatTime(event.end)}` : ''}
                        </td>
                        <td>
                          <span className="netevent-kind" style={{ borderColor: event.kind === 'socket' ? STATUS.warning : event.kind === 'ice' ? STATUS.warning : STATUS.critical }}>
                            {EVENT_LABEL[event.kind]}
                          </span>
                        </td>
                        <td>{event.player}</td>
                        <td>{event.peer ?? ''}</td>
                        <td>{event.text}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </main>
      )}
    </div>
  );
}
