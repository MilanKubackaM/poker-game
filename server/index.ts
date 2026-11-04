import { createHmac, randomBytes } from 'node:crypto';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { existsSync, readFileSync } from 'node:fs';
import { availableParallelism, loadavg, networkInterfaces } from 'node:os';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Server, type Socket } from 'socket.io';
import { generate } from 'selfsigned';
import type { Ack, Avatar, ClientConfig, JoinClosedPayload, JoinResult, NextHandOverride, PendingJoin, PendingResumeResult, PlayerAction, RtcPayload, TableDeletedPayload, TableEvent, TableMetaPayload, TableSettings, TableSummary } from '../shared/types';
import { ACCEPTED_AVATAR_EMOJIS, AVATAR_COLORS, DEFAULT_SETTINGS, MAX_CHAT_LENGTH, MAX_NAME_LENGTH, MAX_TABLE_NAME_LENGTH } from '../shared/constants';
import { resolveManifest } from '../shared/manifest';
import { NET_SAMPLE_MS, sanitizeNetSample, type NetStatsResponse } from '../shared/netstats';
import { LIMITS, TokenBucket, WINDOWS, WindowCounter, clientKey, originAllowed, trustProxyFromEnv } from './limits';
import { CloudflareIceFile } from './cloudflareTurn';
import { CloudflareUsageFile } from './cloudflareUsage';
import { NetStatsStore, statsAccess } from './NetStats';
import { SessionManager } from './SessionManager';
import type { JoinRequest, Table, TablePlayer } from './Table';

const HTTP_PORT = Number(process.env.PORT ?? 3000);
const HTTPS_PORT = process.env.HTTPS_PORT === '0' ? null : Number(process.env.HTTPS_PORT ?? 3443);
const here = path.dirname(fileURLToPath(import.meta.url));
const STATIC_DIR = process.env.STATIC_DIR ?? path.resolve(here, 'client');
const DATA_DIR = path.resolve(process.env.DATA_DIR || 'data');
const TRUST_PROXY = trustProxyFromEnv();
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? '').split(',').map((origin) => origin.trim()).filter(Boolean);
const RATE_LIMITED = 'Príliš veľa požiadaviek — chvíľu počkaj';
const JOIN_EXPIRED = 'Žiadosť o prístup už neplatí — požiadaj o prístup znova';
const STATS_TOKEN = process.env.STATS_TOKEN ?? '';
const PRODUCTION = process.env.NODE_ENV === 'production';

interface SocketData {
  code?: string;
  playerId?: string;
  lastChatAt?: number;
  /** Kľúč klienta pre limity (IP alebo IPv6 /64). */
  ip?: string;
  /** Čakajúca žiadosť o prístup — kým ju host neschváli, spojenie nie je v miestnosti stola a nedostáva nič zo stola. */
  pending?: { code: string; requestId: string };
}

type GameSocket = Socket<Record<string, (...args: any[]) => void>, Record<string, (...args: any[]) => void>, Record<string, never>, SocketData>;

const app = express();
app.disable('x-powered-by');
const httpServer = createHttpServer(app);
const io = new Server(httpServer, {
  maxHttpBufferSize: 64 * 1024,
  // Kompresia WebSocket správ: stav stola je JSON, po sebe idúce stavy sú takmer rovnaké → zmenší sa rádovo.
  // Okno 2^13 = 8 KB a memLevel 7 drží pamäť na spojenie okolo 100 KB (predvolené nastavenie ws má ~300 KB).
  perMessageDeflate: {
    threshold: 1024,
    zlibDeflateOptions: { level: 4, memLevel: 7 },
    serverMaxWindowBits: 13,
    concurrencyLimit: 4,
  },
  allowRequest: (request, callback) => callback(null, originAllowed(request.headers.origin, request.headers.host, ALLOWED_ORIGINS)),
});

const createPerIpHour = new WindowCounter(LIMITS.createPerIpHour, WINDOWS.HOUR);
const createPerIpDay = new WindowCounter(LIMITS.createPerIpDay, WINDOWS.DAY);
const createGlobalHour = new WindowCounter(LIMITS.createGlobalHour, WINDOWS.HOUR);
const createGlobalDay = new WindowCounter(LIMITS.createGlobalDay, WINDOWS.DAY);
const joinPerIp = new WindowCounter(LIMITS.joinPerIpHour, WINDOWS.HOUR);
const joinGlobal = new WindowCounter(LIMITS.joinGlobalHour, WINDOWS.HOUR);
const lookupsPerIp = new WindowCounter(LIMITS.lookupsPerIpMinute, WINDOWS.MINUTE);
const connectionsByIp = new Map<string, number>();
let connectionsTotal = 0;
const GLOBAL = '*';

/** Overí všetky limity zakladania stolov naraz a až potom ich započíta; vráti chybu pre hráča alebo null. */
function claimTableCreation(ip: string): string | null {
  if (manager.count() >= LIMITS.maxTables) {
    return 'Server je plný — nové stoly sa teraz nedajú založiť, skús to neskôr';
  }
  if (!createPerIpHour.allows(ip) || !createPerIpDay.allows(ip)) {
    return 'Z tvojej siete už vzniklo veľa stolov — skús to neskôr alebo pokračuj v existujúcom';
  }
  if (!createGlobalHour.allows(GLOBAL) || !createGlobalDay.allows(GLOBAL)) {
    return 'Server dočasne nezakladá ďalšie stoly (limit pre celý server) — skús to neskôr';
  }
  createPerIpHour.add(ip);
  createPerIpDay.add(ip);
  createGlobalHour.add(GLOBAL);
  createGlobalDay.add(GLOBAL);
  return null;
}

io.use((rawSocket, next) => {
  const socket = rawSocket as GameSocket;
  const ip = clientKey(socket.conn.remoteAddress, socket.handshake.headers, TRUST_PROXY);
  const fromIp = connectionsByIp.get(ip) ?? 0;
  if (connectionsTotal >= LIMITS.connectionsTotal || fromIp >= LIMITS.connectionsPerIp) {
    next(new Error('Server je preťažený — skús to o chvíľu'));
    return;
  }
  socket.data.ip = ip;
  connectionsByIp.set(ip, fromIp + 1);
  connectionsTotal += 1;
  socket.on('disconnect', () => {
    connectionsTotal = Math.max(0, connectionsTotal - 1);
    const left = (connectionsByIp.get(ip) ?? 1) - 1;
    if (left > 0) {
      connectionsByIp.set(ip, left);
    } else {
      connectionsByIp.delete(ip);
    }
  });
  next();
});

const pendingBroadcast = new Set<Table>();
/** Po zamietnutí žiadosti nesmie rovnaká sieť chvíľu žiadať o ten istý stôl znova (`kód|ip` → do kedy). */
const rejectedJoins = new Map<string, number>();

function rejectedUntil(code: string, ip: string): number {
  const key = `${code}|${ip}`;
  const until = rejectedJoins.get(key) ?? 0;
  if (until <= Date.now()) {
    rejectedJoins.delete(key);
    return 0;
  }
  return until;
}
const manager = new SessionManager({
  onChange(table) {
    if (pendingBroadcast.has(table)) {
      return;
    }
    pendingBroadcast.add(table);
    setImmediate(() => {
      pendingBroadcast.delete(table);
      broadcastState(table);
    });
  },
  onEvent(table, event: TableEvent) {
    io.to(room(table.code)).emit('table:event', event);
  },
  onJoinClosed(table, request, outcome, player, byName) {
    if (outcome === 'rejected') {
      rejectedJoins.set(`${table.code}|${request.ip}`, Date.now() + LIMITS.joinRejectCooldownMs);
    }
    for (const socketId of request.sockets) {
      const socket = io.sockets.sockets.get(socketId) as GameSocket | undefined;
      if (!socket || socket.data.pending?.requestId !== request.id) {
        continue;
      }
      socket.data.pending = undefined;
      if (outcome === 'approved' && player) {
        bind(socket, table, player);
        const approved: JoinResult = { code: table.code, playerId: player.id, token: player.token };
        socket.emit('table:approved', approved);
      } else if (outcome !== 'approved') {
        const closed: JoinClosedPayload = { code: table.code, requestId: request.id, outcome, byName };
        socket.emit('table:joinClosed', closed);
      }
    }
  },
  onRemoved(table, player, kicked) {
    for (const socketId of player.sockets) {
      const socket = io.sockets.sockets.get(socketId) as GameSocket | undefined;
      if (!socket) {
        continue;
      }
      socket.emit('table:left', { kicked });
      socket.leave(room(table.code));
      socket.data.code = undefined;
      socket.data.playerId = undefined;
    }
    player.sockets.clear();
  },
}, { dataDir: DATA_DIR });
console.log(`Dáta stolov: ${DATA_DIR} (načítaných stolov: ${manager.count()})`);

const netStats = new NetStatsStore(DATA_DIR);
netStats.prune();
setInterval(() => netStats.prune(), WINDOWS.HOUR).unref();

/** Koľko hráčov poslalo sieťovú vzorku od posledného merania servera. */
const netReporters = new Set<string>();
/** Kedy naposledy niekto poslal vzorku — server sa na disk zapisuje, kým sa hrá (bez dier pri nesúbehu časovačov). */
let lastNetReportAt = 0;
const loopDelay = monitorEventLoopDelay({ resolution: 20 });
loopDelay.enable();
let lastCpu = process.cpuUsage();
let lastCpuAt = performance.now();
setInterval(() => {
  const cpu = process.cpuUsage(lastCpu);
  const at = performance.now();
  const elapsedMs = Math.max(1, at - lastCpuAt);
  lastCpu = process.cpuUsage();
  lastCpuAt = at;
  const memory = process.memoryUsage();
  const reporters = netReporters.size;
  netReporters.clear();
  netStats.recordServer(
    {
      cpuPct: Math.round(((cpu.user + cpu.system) / 1000 / elapsedMs) * 1000) / 10,
      load1: Math.round(loadavg()[0] * 100) / 100,
      cores: availableParallelism(),
      loopP99Ms: Math.round(loopDelay.percentile(99) / 1e5) / 10,
      loopMaxMs: Math.round(loopDelay.max / 1e5) / 10,
      rssMb: Math.round(memory.rss / 1024 / 1024),
      heapMb: Math.round(memory.heapUsed / 1024 / 1024),
      sockets: connectionsTotal,
      reporters,
    },
    Date.now() - lastNetReportAt <= 3 * NET_SAMPLE_MS,
  );
  loopDelay.reset();
}, NET_SAMPLE_MS).unref();

function room(code: string): string {
  return `table:${code}`;
}

/** Čo z ledgeru, histórie a leaderboardu už dostali všetci v miestnosti stola (ďalej idú len novinky). */
const metaSent = new WeakMap<Table, { ledgerId: number; handNumber: number; leaderboard: string }>();

/** Celý ledger, história a leaderboard jednému spojeniu (pri pripojení ku stolu). */
function sendFullMeta(socket: GameSocket, table: Table): void {
  const leaderboard = table.leaderboard();
  if (!metaSent.has(table)) {
    metaSent.set(table, { ...table.metaCursor(), leaderboard: JSON.stringify(leaderboard) });
  }
  const payload: TableMetaPayload = { code: table.code, full: true, ...table.metaSince(), leaderboard };
  socket.emit('table:meta', payload);
}

/** Novinky v ledgeri/histórii a zmenený leaderboard celej miestnosti — raz, nie pri každom ťahu celé. */
function broadcastMeta(table: Table): void {
  const sent = metaSent.get(table);
  if (!sent) {
    return;
  }
  const leaderboard = table.leaderboard();
  const leaderboardJson = JSON.stringify(leaderboard);
  const cursor = table.metaCursor();
  const changed = leaderboardJson !== sent.leaderboard;
  if (!changed && cursor.ledgerId === sent.ledgerId && cursor.handNumber === sent.handNumber) {
    return;
  }
  const payload: TableMetaPayload = { code: table.code, full: false, ...table.metaSince(sent), ...(changed ? { leaderboard } : {}) };
  metaSent.set(table, { ...cursor, leaderboard: leaderboardJson });
  io.to(room(table.code)).emit('table:meta', payload);
}

function broadcastState(table: Table): void {
  broadcastMeta(table);
  for (const player of table.players.values()) {
    for (const socketId of player.sockets) {
      io.sockets.sockets.get(socketId)?.emit('table:state', table.liveView(player.id));
    }
  }
}

/** Zmaže stôl: všetci v miestnosti dostanú `table:deleted`, odpoja sa od nej a stôl zmizne z pamäte aj z disku. */
function deleteTable(table: Table, byName: string): void {
  table.closeAllJoins();
  const roomName = room(table.code);
  const payload: TableDeletedPayload = { code: table.code, byName };
  io.to(roomName).emit('table:deleted', payload);
  for (const socketId of io.sockets.adapter.rooms.get(roomName) ?? []) {
    const socket = io.sockets.sockets.get(socketId) as GameSocket | undefined;
    if (socket) {
      socket.data.code = undefined;
      socket.data.playerId = undefined;
    }
  }
  io.in(roomName).socketsLeave(roomName);
  for (const player of [...table.players.values(), ...table.departed.values()]) {
    player.sockets.clear();
  }
  pendingBroadcast.delete(table);
  manager.remove(table.code);
  console.log(`Stôl ${table.code} zmazal zakladateľ ${byName}`);
}

function iceServers(): ClientConfig['iceServers'] {
  if (process.env.ICE_SERVERS) {
    try {
      return JSON.parse(process.env.ICE_SERVERS);
    } catch {
      console.warn('ICE_SERVERS is not valid JSON, falling back to default STUN');
    }
  }
  // Viac STUN serverov = väčšia šanca na priame spojenie kamier (bez relay cez Funnel, ktorý pri TCP seká).
  return [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] }];
}

app.get('/api/health', (_request, response) => {
  response.json({ ok: true, tables: manager.count() });
});

app.get('/api/config', (_request, response) => {
  const publicHost = (process.env.PUBLIC_HOST ?? '').split(',').map((host) => host.trim()).find(Boolean) ?? null;
  const config: ClientConfig = { iceServers: iceServers(), httpsPort: HTTPS_PORT, publicHost };
  response.json(config);
});

const statsFailures = new WindowCounter(10, WINDOWS.MINUTE);

/**
 * Sieťové štatistiky pre stránku `/stats` — len s kľúčom `STATS_TOKEN` (hlavička `Authorization: Bearer …`), lebo
 * ukazujú mená hráčov a ich spojenia. `mode=live` (posledných 15 min z pamäte) alebo `mode=history&from&to` (z disku).
 */
app.get('/api/netstats', async (request, response) => {
  response.set('Cache-Control', 'no-store');
  const ip = clientKey(request.socket.remoteAddress, request.headers, TRUST_PROXY);
  if (!statsFailures.allows(ip)) {
    response.status(429).json({ ok: false, error: RATE_LIMITED } satisfies NetStatsResponse);
    return;
  }
  const header = request.headers.authorization;
  const provided = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : undefined;
  const access = statsAccess(STATS_TOKEN, provided, PRODUCTION);
  if (access === 'disabled') {
    response.status(404).json({ ok: false, error: 'Štatistiky nie sú zapnuté (chýba STATS_TOKEN)' } satisfies NetStatsResponse);
    return;
  }
  if (access === 'denied') {
    statsFailures.add(ip);
    response.status(401).json({ ok: false, error: 'Nesprávny kľúč' } satisfies NetStatsResponse);
    return;
  }
  const query = request.query as Record<string, unknown>;
  const code = typeof query.code === 'string' && /^[A-Z0-9]{4,8}$/.test(query.code) ? query.code : null;
  try {
    if (query.mode === 'history') {
      const to = Number(query.to);
      const from = Number(query.from);
      if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) {
        response.status(400).json({ ok: false, error: 'Neplatný rozsah' } satisfies NetStatsResponse);
        return;
      }
      response.json({ ok: true, series: await netStats.history(from, to, code), ...relayStatus() } satisfies NetStatsResponse);
      return;
    }
    response.json({ ok: true, series: netStats.live(code), ...relayStatus() } satisfies NetStatsResponse);
  } catch (error) {
    console.error('netstats failed', error);
    response.status(500).json({ ok: false, error: 'Chyba servera' } satisfies NetStatsResponse);
  }
});

if (existsSync(STATIC_DIR)) {
  const manifestPath = path.join(STATIC_DIR, 'manifest.webmanifest');
  const builtManifest = existsSync(manifestPath) ? readFileSync(manifestPath, 'utf8') : null;
  app.get('/manifest.webmanifest', (request, response, next) => {
    if (!builtManifest) {
      next();
      return;
    }
    const forwarded = (name: string) => (TRUST_PROXY !== 'off' ? request.get(name)?.split(',')[0]?.trim() : undefined);
    const protocol = forwarded('x-forwarded-proto') ?? request.protocol;
    const host = forwarded('x-forwarded-host') ?? request.get('host');
    try {
      const body = resolveManifest(builtManifest, `${protocol}://${host}`);
      response.set('Cache-Control', 'no-cache').type('application/manifest+json').send(body);
    } catch {
      next();
    }
  });
  const alwaysRevalidate = new Set(['sw.js', 'manifest.webmanifest']);
  app.use(
    express.static(STATIC_DIR, {
      index: false,
      maxAge: '1h',
      setHeaders: (response, filePath) => {
        if (alwaysRevalidate.has(path.basename(filePath))) {
          response.set('Cache-Control', 'no-cache');
        }
      },
    }),
  );
  app.get(/^(?!\/api|\/socket\.io).*/, (_request, response) => {
    response.sendFile(path.join(STATIC_DIR, 'index.html'));
  });
}

function cleanName(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const name = value.replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_LENGTH);
  return name.length ? name : null;
}

function cleanAvatar(value: unknown): Avatar | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const { emoji, color } = value as Record<string, unknown>;
  if (typeof emoji !== 'string' || typeof color !== 'string' || !ACCEPTED_AVATAR_EMOJIS.includes(emoji) || !AVATAR_COLORS.includes(color)) {
    return null;
  }
  return { emoji, color };
}

function reply<T>(ack: unknown, payload: Ack<T>): void {
  if (typeof ack === 'function') {
    ack(payload);
  }
}

/** Odpojí spojenie od stola, pri ktorom je, aj od čakajúcej žiadosti. */
function unbind(socket: GameSocket): void {
  if (socket.data.pending) {
    manager.get(socket.data.pending.code)?.detachJoinSocket(socket.data.pending.requestId, socket.id);
    socket.data.pending = undefined;
  }
  if (socket.data.code && socket.data.playerId) {
    const previous = manager.get(socket.data.code);
    const previousPlayer = previous?.players.get(socket.data.playerId);
    if (previous && previousPlayer) {
      previous.detachSocket(previousPlayer, socket.id);
    }
    socket.leave(room(socket.data.code));
  }
  socket.data.code = undefined;
  socket.data.playerId = undefined;
}

/** Spojenie čaká na schválenie žiadosti — mimo miestnosti stola, dostane len `table:approved` / `table:joinClosed`. */
function attachPending(socket: GameSocket, table: Table, request: JoinRequest): PendingJoin {
  unbind(socket);
  request.sockets.add(socket.id);
  socket.data.pending = { code: table.code, requestId: request.id };
  return { code: table.code, requestId: request.id, token: request.token };
}

function bind(socket: GameSocket, table: Table, player: TablePlayer): void {
  if (socket.data.pending) {
    manager.get(socket.data.pending.code)?.detachJoinSocket(socket.data.pending.requestId, socket.id);
    socket.data.pending = undefined;
  }
  if (socket.data.code && socket.data.playerId) {
    const previous = manager.get(socket.data.code);
    const previousPlayer = previous?.players.get(socket.data.playerId);
    if (previous && previousPlayer) {
      previous.detachSocket(previousPlayer, socket.id);
    }
    socket.leave(room(socket.data.code));
  }
  socket.data.code = table.code;
  socket.data.playerId = player.id;
  socket.join(room(table.code));
  sendFullMeta(socket, table);
  table.attachSocket(player, socket.id);
  socket.emit('table:history', table.events);
  netStats.recordEvent(table.code, table.settings.name, player.id, player.name, 'pripojený k serveru');
  const relay = relayIceServers();
  if (relay) {
    socket.emit('rtc:ice', { iceServers: relay });
  }
}

const cloudflareIce = new CloudflareIceFile(process.env.TURN_ICE_FILE ?? '');
const cloudflareUsage = new CloudflareUsageFile(process.env.TURN_USAGE_FILE ?? '');

/** Pre `/stats`: ktorý relay sa rozdáva a koľko z free tieru Cloudflare je minuté. */
function relayStatus(): Pick<NetStatsResponse, 'relay' | 'cloudflare'> {
  const relay = cloudflareIce.servers() ? 'cloudflare' : turnServer() ? 'coturn' : null;
  const usage = cloudflareUsage.read();
  return usage ? { relay, cloudflare: usage } : { relay };
}

/**
 * Relay pre hráča pri stole: Cloudflare TURN (UDP, prihlasovacie údaje zo sidecaru), inak vlastný coturn cez Funnel
 * (len TCP — pri strate paketu seká). Oba naraz nie, aby ICE nevybralo pomalší relay.
 */
function relayIceServers(): ClientConfig['iceServers'] | null {
  const cloudflare = cloudflareIce.servers();
  if (cloudflare) {
    return [...iceServers(), ...cloudflare];
  }
  const turn = turnServer();
  return turn ? [...iceServers(), turn] : null;
}

// Sidecar obnovuje údaje Cloudflare každú hodinu — hráči pri stole dostanú nové, aby ICE reštart po dlhej hre fungoval.
let cloudflareVersion = cloudflareIce.version();
setInterval(() => {
  const version = cloudflareIce.version();
  if (version === cloudflareVersion) {
    return;
  }
  cloudflareVersion = version;
  const relay = relayIceServers();
  if (!relay) {
    return;
  }
  for (const socket of io.sockets.sockets.values()) {
    if ((socket as GameSocket).data.code) {
      socket.emit('rtc:ice', { iceServers: relay });
    }
  }
}, WINDOWS.MINUTE).unref();

const TURN_URLS = (process.env.TURN_URLS ?? '').split(',').map((url) => url.trim()).filter(Boolean);
const TURN_SECRET = process.env.TURN_SECRET ?? '';
const TURN_TTL_SEC = 24 * 60 * 60;

/**
 * Dočasné prihlasovacie údaje k TURN relay (coturn `use-auth-secret`), keď priame spojenie kamier cez NAT zlyhá.
 * Dostanú ich len hráči pri stole, nie anonymný `/api/config` — inak by si relay mohol požičať ktokoľvek.
 */
function turnServer(): ClientConfig['iceServers'][number] | null {
  if (TURN_URLS.length === 0 || !TURN_SECRET) {
    return null;
  }
  const username = `${Math.floor(Date.now() / 1000) + TURN_TTL_SEC}:${randomBytes(6).toString('hex')}`;
  const credential = createHmac('sha1', TURN_SECRET).update(username).digest('base64');
  return { urls: TURN_URLS, username, credential };
}

function context(socket: GameSocket): { table: Table; player: TablePlayer } | null {
  const { code, playerId } = socket.data;
  if (!code || !playerId) {
    return null;
  }
  const table = manager.get(code);
  const player = table?.players.get(playerId);
  return table && player ? { table, player } : null;
}

io.on('connection', (rawSocket) => {
  const socket = rawSocket as GameSocket;

  const ip = socket.data.ip ?? 'unknown';
  const events = new TokenBucket(LIMITS.eventsPerSecond, LIMITS.eventsBurst);
  const rtcEvents = new TokenBucket(LIMITS.rtcPerSecond, LIMITS.rtcBurst);
  const rejections = new WindowCounter(LIMITS.rejectionsBeforeDisconnect, WINDOWS.MINUTE);

  const handle = <P>(event: string, handler: (payload: P, ack: unknown) => void) => {
    socket.on(event, ((payload: P, ack: unknown) => {
      const bucket = event === 'rtc:signal' ? rtcEvents : events;
      if (!bucket.take()) {
        if (!rejections.hit('socket')) {
          console.warn(`Odpájam ${ip}: príliš veľa požiadaviek`);
          socket.disconnect(true);
          return;
        }
        reply(ack, { ok: false, error: RATE_LIMITED });
        return;
      }
      try {
        handler(payload ?? ({} as P), ack);
      } catch (error) {
        console.error(`Handler ${event} failed`, error);
        reply(ack, { ok: false, error: 'Chyba servera' });
      }
    }) as (...args: unknown[]) => void);
  };

  const withPlayer = <P>(event: string, handler: (payload: P, table: Table, player: TablePlayer, ack: unknown) => void) => {
    handle<P>(event, (payload, ack) => {
      const current = context(socket);
      if (!current) {
        reply(ack, { ok: false, error: 'Nie si pri stole' });
        return;
      }
      handler(payload, current.table, current.player, ack);
    });
  };

  const withHost = <P>(event: string, handler: (payload: P, table: Table, player: TablePlayer, ack: unknown) => void) => {
    withPlayer<P>(event, (payload, table, player, ack) => {
      if (!table.isAdmin(player.id)) {
        reply(ack, { ok: false, error: 'Toto môže len host' });
        return;
      }
      handler(payload, table, player, ack);
    });
  };

  const withBanker = <P>(event: string, handler: (payload: P, table: Table, player: TablePlayer, ack: unknown) => void) => {
    withPlayer<P>(event, (payload, table, player, ack) => {
      if (!table.isBanker(player.id)) {
        reply(ack, { ok: false, error: 'Toto môže len bankár' });
        return;
      }
      handler(payload, table, player, ack);
    });
  };

  handle<{ name?: unknown; avatar?: unknown; settings?: Partial<TableSettings> }>('table:create', (payload, ack) => {
    const name = cleanName(payload.name);
    const avatar = cleanAvatar(payload.avatar);
    if (!name || !avatar) {
      reply(ack, { ok: false, error: 'Zadaj meno a vyber avatara' });
      return;
    }
    const refused = claimTableCreation(ip);
    if (refused) {
      console.warn(`Zakladanie stola odmietnuté pre ${ip}: ${refused}`);
      reply(ack, { ok: false, error: refused });
      return;
    }
    const table = manager.create({ ...DEFAULT_SETTINGS, name: `Stôl ${name}`.slice(0, MAX_TABLE_NAME_LENGTH) });
    if (payload.settings && typeof payload.settings === 'object') {
      const settings: Partial<TableSettings> = { ...payload.settings };
      delete settings.actionTimeoutSec;
      if (typeof settings.name === 'string' && !settings.name.trim()) {
        delete settings.name;
      }
      const outcome = table.hostSettings(settings);
      if (!outcome.ok) {
        manager.remove(table.code);
        reply(ack, outcome);
        return;
      }
    }
    const added = table.addPlayer(name, avatar);
    if (!added.ok || !added.data) {
      manager.remove(table.code);
      reply(ack, { ok: false, error: added.ok ? 'Chyba' : added.error });
      return;
    }
    bind(socket, table, added.data);
    reply<JoinResult>(ack, { ok: true, data: { code: table.code, playerId: added.data.id, token: added.data.token } });
  });

  handle<{ code?: unknown; name?: unknown; avatar?: unknown }>('table:join', (payload, ack) => {
    if (!lookupsPerIp.hit(ip)) {
      reply(ack, { ok: false, error: RATE_LIMITED });
      return;
    }
    const table = typeof payload.code === 'string' ? manager.get(payload.code) : undefined;
    if (!table) {
      reply(ack, { ok: false, error: 'Stôl neexistuje' });
      return;
    }
    const name = cleanName(payload.name);
    const avatar = cleanAvatar(payload.avatar);
    if (!name || !avatar) {
      reply(ack, { ok: false, error: 'Zadaj meno a vyber avatara' });
      return;
    }
    const existing = socket.data.pending?.code === table.code ? table.joinRequests.get(socket.data.pending.requestId) : undefined;
    if (existing) {
      reply<PendingJoin>(ack, { ok: true, data: { code: table.code, requestId: existing.id, token: existing.token } });
      return;
    }
    if (rejectedUntil(table.code, ip)) {
      reply(ack, { ok: false, error: 'Host tvoju žiadosť zamietol — o prístup môžeš požiadať znova o pár minút' });
      return;
    }
    if (!joinPerIp.allows(ip) || !joinGlobal.allows(GLOBAL)) {
      reply(ack, { ok: false, error: 'Príliš veľa nových hráčov naraz — skús to o chvíľu' });
      return;
    }
    const requested = table.requestJoin(name, avatar, ip);
    if (!requested.ok || !requested.data) {
      reply(ack, { ok: false, error: requested.ok ? 'Chyba' : requested.error });
      return;
    }
    joinPerIp.add(ip);
    joinGlobal.add(GLOBAL);
    reply<PendingJoin>(ack, { ok: true, data: attachPending(socket, table, requested.data) });
  });

  // Návrat k žiadosti o prístup po obnovení stránky / výpadku spojenia (alebo k už schválenej žiadosti).
  handle<{ code?: unknown; requestId?: unknown; token?: unknown }>('table:pendingResume', (payload, ack) => {
    if (!lookupsPerIp.hit(ip)) {
      reply(ack, { ok: false, error: RATE_LIMITED });
      return;
    }
    const table = typeof payload.code === 'string' ? manager.get(payload.code) : undefined;
    if (!table) {
      reply(ack, { ok: false, error: JOIN_EXPIRED });
      return;
    }
    const approved = table.approvedJoin(payload.requestId, payload.token);
    if (approved) {
      const resumed = table.resume(approved.id, approved.token);
      if (!resumed.ok || !resumed.data) {
        reply(ack, { ok: false, error: JOIN_EXPIRED });
        return;
      }
      bind(socket, table, resumed.data);
      reply<PendingResumeResult>(ack, { ok: true, data: { approved: { code: table.code, playerId: resumed.data.id, token: resumed.data.token } } });
      return;
    }
    const request = table.joinRequest(payload.requestId, payload.token);
    if (!request) {
      reply(ack, { ok: false, error: JOIN_EXPIRED });
      return;
    }
    reply<PendingResumeResult>(ack, { ok: true, data: { pending: attachPending(socket, table, request) } });
  });

  handle('table:cancelJoin', (_payload, ack) => {
    const pending = socket.data.pending;
    const table = pending ? manager.get(pending.code) : undefined;
    const request = pending && table ? table.joinRequests.get(pending.requestId) : undefined;
    if (!table || !request) {
      socket.data.pending = undefined;
      reply(ack, { ok: true });
      return;
    }
    reply(ack, table.cancelJoin(request.id, request.token));
  });

  handle<{ code?: unknown; playerId?: unknown; token?: unknown; standing?: unknown }>('table:resume', (payload, ack) => {
    if (!lookupsPerIp.hit(ip)) {
      reply(ack, { ok: false, error: RATE_LIMITED });
      return;
    }
    const table = typeof payload.code === 'string' ? manager.get(payload.code) : undefined;
    if (!table) {
      reply(ack, { ok: false, error: 'Relácia vypršala' });
      return;
    }
    const resumed = table.resume(payload.playerId, payload.token, payload.standing === true);
    if (!resumed.ok || !resumed.data) {
      reply(ack, { ok: false, error: resumed.ok ? 'Relácia vypršala' : resumed.error });
      return;
    }
    const player = resumed.data;
    bind(socket, table, player);
    reply<JoinResult>(ack, { ok: true, data: { code: table.code, playerId: player.id, token: player.token } });
  });

  handle<{ items?: unknown }>('table:summaries', (payload, ack) => {
    if (!lookupsPerIp.hit(ip)) {
      reply(ack, { ok: false, error: RATE_LIMITED });
      return;
    }
    reply<{ summaries: TableSummary[]; missing: string[] }>(ack, { ok: true, data: manager.summaries(payload.items) });
  });

  handle<{ code?: unknown }>('table:exists', (payload, ack) => {
    if (!lookupsPerIp.hit(ip)) {
      reply(ack, { ok: false, error: RATE_LIMITED });
      return;
    }
    const table = typeof payload.code === 'string' ? manager.get(payload.code) : undefined;
    reply(ack, table ? { ok: true, data: { players: table.players.size } } : { ok: false, error: 'Stôl neexistuje' });
  });

  withPlayer<{ seat?: unknown }>('seat:take', (payload, table, player, ack) => {
    reply(ack, table.changeSeat(player, Number(payload.seat)));
  });

  withPlayer<{ value?: unknown }>('player:sitout', (payload, table, player, ack) => {
    reply(ack, table.setSittingOut(player, payload.value === true));
  });

  withPlayer<{ value?: unknown }>('player:away', (payload, table, player, ack) => {
    if (typeof payload.value !== 'boolean') {
      reply(ack, { ok: false, error: 'Neplatná voľba' });
      return;
    }
    reply(ack, table.setAway(player, payload.value));
  });

  withPlayer<{ mode?: unknown }>('player:return', (payload, table, player, ack) => {
    if (payload.mode !== 'wait-bb' && payload.mode !== 'post') {
      reply(ack, { ok: false, error: 'Neplatná voľba' });
      return;
    }
    reply(ack, table.returnToGame(player, payload.mode));
  });

  withPlayer('player:leave', (_payload, table, player, ack) => {
    table.leave(player);
    reply(ack, { ok: true });
  });

  withPlayer<{ name?: unknown; avatar?: unknown; camera?: unknown; microphone?: unknown }>('player:update', (payload, table, player, ack) => {
    const patch: { name?: string; avatar?: Avatar; camera?: boolean; microphone?: boolean } = {};
    if (payload.name !== undefined) {
      const name = cleanName(payload.name);
      if (!name) {
        reply(ack, { ok: false, error: 'Neplatné meno' });
        return;
      }
      patch.name = name;
    }
    if (payload.avatar !== undefined) {
      const avatar = cleanAvatar(payload.avatar);
      if (!avatar) {
        reply(ack, { ok: false, error: 'Neplatný avatar' });
        return;
      }
      patch.avatar = avatar;
    }
    if (typeof payload.camera === 'boolean') {
      patch.camera = payload.camera;
    }
    if (typeof payload.microphone === 'boolean') {
      patch.microphone = payload.microphone;
    }
    table.updateProfile(player, patch);
    reply(ack, { ok: true });
  });

  withPlayer<PlayerAction>('game:action', (payload, table, player, ack) => {
    reply(ack, table.act(player, { type: payload.type, amount: payload.amount }));
  });

  withPlayer<{ cardIndex?: unknown }>('game:discard', (payload, table, player, ack) => {
    reply(ack, table.discard(player, Number(payload.cardIndex)));
  });

  withPlayer<{ text?: unknown }>('chat:send', (payload, table, player, ack) => {
    const text = typeof payload.text === 'string' ? payload.text.trim().slice(0, MAX_CHAT_LENGTH) : '';
    const now = Date.now();
    if (!text) {
      reply(ack, { ok: false, error: 'Prázdna správa' });
      return;
    }
    if (socket.data.lastChatAt && now - socket.data.lastChatAt < 400) {
      reply(ack, { ok: false, error: 'Pomalšie :)' });
      return;
    }
    socket.data.lastChatAt = now;
    table.chat(player, text);
    reply(ack, { ok: true });
  });

  withHost('host:start', (_payload, table, _player, ack) => reply(ack, table.hostStart()));
  withHost<{ mode?: unknown }>('host:dealerChoice', (payload, table, _player, ack) => {
    if (payload.mode !== 'random' && payload.mode !== 'draw') {
      reply(ack, { ok: false, error: 'Neplatná voľba' });
      return;
    }
    reply(ack, table.hostDealerChoice(payload.mode));
  });

  withPlayer('draw:ack', (_payload, table, player, ack) => reply(ack, table.drawAck(player)));

  withPlayer<{ index?: unknown }>('draw:pick', (payload, table, player, ack) => {
    const index = payload.index;
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index > 51) {
      reply(ack, { ok: false, error: 'Neplatná karta' });
      return;
    }
    reply(ack, table.drawPick(player, index));
  });

  withHost('host:pause', (_payload, table, _player, ack) => reply(ack, table.hostPause()));
  withHost<Partial<TableSettings>>('host:settings', (payload, table, _player, ack) => {
    // Základný čas na ťah je pevný (DEFAULT_SETTINGS.actionTimeoutSec); host mení len timebank.
    const { actionTimeoutSec: _fixed, ...settings } = payload ?? {};
    reply(ack, table.hostSettings(settings));
  });
  withHost<{ override?: NextHandOverride | null }>('host:nextHand', (payload, table, _player, ack) => reply(ack, table.hostNextHand(payload.override ?? null)));

  withBanker<{ playerId?: unknown; amount?: unknown; note?: unknown; settlement?: unknown }>('bank:chips', (payload, table, player, ack) => {
    const target = typeof payload.playerId === 'string' ? table.players.get(payload.playerId) : undefined;
    if (!target) {
      reply(ack, { ok: false, error: 'Hráč neexistuje' });
      return;
    }
    if (typeof payload.amount !== 'number') {
      reply(ack, { ok: false, error: 'Neplatná suma' });
      return;
    }
    reply(ack, table.bankChips(target, payload.amount, payload.note, player.name, payload.settlement));
  });

  withBanker<{ kind?: unknown; fromId?: unknown; toId?: unknown; amount?: unknown }>('bank:settle', (payload, table, player, ack) => {
    reply(ack, table.bankSettle(player, payload.kind, payload.fromId, payload.toId, payload.amount));
  });

  withBanker<{ entryId?: unknown }>('bank:undo', (payload, table, player, ack) => reply(ack, table.bankUndo(player, payload.entryId)));

  withHost<{ playerId?: unknown; moveCash?: unknown }>('host:setBanker', (payload, table, player, ack) => {
    const target = typeof payload.playerId === 'string' ? table.players.get(payload.playerId) : undefined;
    if (!target) {
      reply(ack, { ok: false, error: 'Hráč neexistuje' });
      return;
    }
    reply(ack, table.hostSetBanker(player, target, payload.moveCash));
  });

  withHost<{ requestId?: unknown; approve?: unknown }>('host:joinRequest', (payload, table, player, ack) => {
    if (typeof payload.approve !== 'boolean') {
      reply(ack, { ok: false, error: 'Neplatná voľba' });
      return;
    }
    const outcome = table.resolveJoin(player, payload.requestId, payload.approve);
    reply(ack, outcome.ok ? { ok: true } : outcome);
  });

  withHost<{ playerId?: unknown }>('host:kick', (payload, table, player, ack) => {
    const target = typeof payload.playerId === 'string' ? table.players.get(payload.playerId) : undefined;
    if (!target || target === player) {
      reply(ack, { ok: false, error: 'Neplatný hráč' });
      return;
    }
    if (table.isHost(target.id)) {
      reply(ack, { ok: false, error: 'Zakladateľa stola nemôžeš vyhodiť' });
      return;
    }
    table.leave(target, true, player.name);
    reply(ack, { ok: true });
  });

  withHost<{ playerId?: unknown }>('host:transfer', (payload, table, player, ack) => {
    const target = typeof payload.playerId === 'string' ? table.players.get(payload.playerId) : undefined;
    if (!target || target === player) {
      reply(ack, { ok: false, error: 'Neplatný hráč' });
      return;
    }
    if (!table.isHost(player.id)) {
      reply(ack, { ok: false, error: 'Vlastníctvo stola môže odovzdať len zakladateľ' });
      return;
    }
    reply(ack, table.hostTransfer(target));
  });

  withHost<{ playerId?: unknown; admin?: unknown }>('host:setAdmin', (payload, table, player, ack) => {
    const target = typeof payload.playerId === 'string' ? table.players.get(payload.playerId) : undefined;
    if (!target) {
      reply(ack, { ok: false, error: 'Hráč neexistuje' });
      return;
    }
    if (typeof payload.admin !== 'boolean') {
      reply(ack, { ok: false, error: 'Neplatná voľba' });
      return;
    }
    reply(ack, table.hostSetAdmin(player, target, payload.admin));
  });

  withPlayer<{ code?: unknown }>('host:deleteTable', (payload, table, player, ack) => {
    const allowed = table.canDelete(player, payload.code);
    if (!allowed.ok) {
      reply(ack, allowed);
      return;
    }
    deleteTable(table, player.name);
    reply(ack, { ok: true });
  });

  withHost('host:toLobby', (_payload, table, _player, ack) => reply(ack, table.hostToLobby()));

  withHost<{ action?: unknown }>('host:piggy', (payload, table, _player, ack) => {
    if (payload.action !== 'start' && payload.action !== 'cancel') {
      reply(ack, { ok: false, error: 'Neplatná voľba' });
      return;
    }
    reply(ack, table.hostPiggy(payload.action));
  });

  withPlayer('mode:ack', (_payload, table, player, ack) => reply(ack, table.modeAck(player)));
  withPlayer('hand:show', (_payload, table, player, ack) => reply(ack, table.showCards(player)));
  withPlayer('hand:rabbit', (_payload, table, player, ack) => reply(ack, table.rabbitHunt(player)));
  // Overiteľné miešanie: odtlačok semienka vopred, semienko po zmrazení kola, dôkazy rúk na overenie.
  withPlayer<{ commitment?: unknown }>('fair:commit', (payload, table, player, ack) => reply(ack, table.fairCommit(player, payload.commitment)));
  withPlayer<{ roundId?: unknown; seed?: unknown }>('fair:reveal', (payload, table, player, ack) => reply(ack, table.fairReveal(player, payload.roundId, payload.seed)));
  withPlayer('fair:proofs', (_payload, table, _player, ack) => reply(ack, { ok: true, data: table.fairProofs() }));
  withPlayer<{ runs?: unknown }>('hand:runs', (payload, table, player, ack) => reply(ack, table.chooseRuns(player, payload.runs)));

  // Sieťové štatistiky kamier: klient každých 5 s pošle vzorku za všetky spojenia — na stránku /stats a súhrn do logu.
  let netSamples = 0;
  withPlayer<unknown>('net:stats', (payload, table, player, ack) => {
    const sample = sanitizeNetSample(payload);
    if (!sample) {
      reply(ack, { ok: false, error: 'Neplatná vzorka' });
      return;
    }
    sample.links = sample.links.filter((link) => link.to !== player.id && !!table.member(link.to));
    for (const link of sample.links) {
      link.toName = table.member(link.to)!.name;
    }
    netReporters.add(player.id);
    lastNetReportAt = Date.now();
    netStats.recordPlayer(table.code, table.settings.name, player.id, player.name, sample);
    netSamples += 1;
    if (netSamples % 3 === 0) {
      for (const link of sample.links) {
        const lossPct = Math.max(link.audioLossPct ?? 0, link.videoLossPct ?? 0);
        console.log(`[rtc] ${table.code} ${player.name} ← ${link.toName}: ${link.path ?? '?'} rtt=${link.rttMs ?? '?'}ms loss=${lossPct}% conceal=${link.concealPct ?? 0}% freezes=${link.freezes ?? 0}`);
      }
    }
    reply(ack, { ok: true });
  });

  withPlayer<{ to?: unknown; data?: RtcPayload }>('rtc:signal', (payload, table, _player, ack) => {
    const target = typeof payload.to === 'string' ? (io.sockets.sockets.get(payload.to) as GameSocket | undefined) : undefined;
    if (!target || target.data.code !== table.code || !payload.data) {
      reply(ack, { ok: false, error: 'Peer nie je dostupný' });
      return;
    }
    target.emit('rtc:signal', { from: socket.id, data: payload.data });
    reply(ack, { ok: true });
  });

  socket.on('disconnect', (reason) => {
    if (socket.data.pending) {
      manager.get(socket.data.pending.code)?.detachJoinSocket(socket.data.pending.requestId, socket.id);
      socket.data.pending = undefined;
    }
    const current = context(socket);
    if (current) {
      current.table.detachSocket(current.player, socket.id);
      netStats.recordEvent(current.table.code, current.table.settings.name, current.player.id, current.player.name, `odpojený od servera (${reason})`);
    }
  });
});

function localAddresses(): string[] {
  return Object.values(networkInterfaces())
    .flat()
    .filter((entry): entry is NonNullable<typeof entry> => !!entry && entry.family === 'IPv4' && !entry.internal)
    .map((entry) => entry.address);
}

async function startHttps(): Promise<void> {
  if (HTTPS_PORT === null) {
    return;
  }
  let key: string;
  let cert: string;
  if (process.env.TLS_CERT_FILE && process.env.TLS_KEY_FILE) {
    cert = readFileSync(process.env.TLS_CERT_FILE, 'utf8');
    key = readFileSync(process.env.TLS_KEY_FILE, 'utf8');
  } else {
    const hosts = (process.env.PUBLIC_HOST ?? '').split(',').map((host) => host.trim()).filter(Boolean);
    const ips = ['127.0.0.1', ...localAddresses(), ...hosts.filter((host) => /^\d+\.\d+\.\d+\.\d+$/.test(host))];
    const dns = ['localhost', ...hosts.filter((host) => !/^\d+\.\d+\.\d+\.\d+$/.test(host))];
    const pems = await generate([{ name: 'commonName', value: 'poker-night.local' }], {
      keySize: 2048,
      algorithm: 'sha256',
      extensions: [
        { name: 'basicConstraints', cA: false },
        { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
        { name: 'extKeyUsage', serverAuth: true },
        { name: 'subjectAltName', altNames: [...dns.map((value) => ({ type: 2 as const, value })), ...ips.map((ip) => ({ type: 7 as const, ip }))] },
      ],
    });
    key = pems.private;
    cert = pems.cert;
  }
  const httpsServer = createHttpsServer({ key, cert }, app);
  io.attach(httpsServer);
  await new Promise<void>((resolve) => httpsServer.listen(HTTPS_PORT, '0.0.0.0', resolve));
  console.log(`HTTPS: https://localhost:${HTTPS_PORT}`);
}

httpServer.listen(HTTP_PORT, '0.0.0.0', () => {
  console.log(`Poker Night beží na http://localhost:${HTTP_PORT}`);
  for (const address of localAddresses()) {
    console.log(`  v sieti: http://${address}:${HTTP_PORT}${HTTPS_PORT ? `  |  https://${address}:${HTTPS_PORT} (kamera)` : ''}`);
  }
});

function shutdown(signal: string): void {
  console.log(`${signal}: ukladám stoly a končím`);
  manager.flush();
  process.exit(0);
}

process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));

startHttps().catch((error) => {
  console.error('HTTPS server sa nepodarilo spustiť', error);
});
