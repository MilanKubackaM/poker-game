import type { Server as HttpServer } from 'node:http';
import { Server, type Socket } from 'socket.io';
import { COACH_API_VERSION, COACH_SOCKET_PATH, type CoachActionEvent, type CoachClosedEvent, type CoachHello, type CoachLoginResult, type CoachProofsResponse, type CoachStateEvent } from '../../shared/coach';
import type { Ack, TableSummary } from '../../shared/types';
import type { AccountService } from '../accounts/AccountService';
import type { SessionManager } from '../SessionManager';
import type { Table } from '../Table';
import type { EngineAction, HandEngine } from '../poker/HandEngine';
import { TokenBucket, WindowCounter, WINDOWS, clientKey, originAllowed, type TrustProxy } from '../limits';
import { projectCoachState } from './project';
import type { PublicIds } from './publicId';

const SWEEP_MS = 60 * 1000;
const MAX_SUBSCRIPTIONS = 5;
const MAX_CONNECTIONS_PER_IP = 10;
const MAX_CONNECTIONS_TOTAL = 200;
const EVENTS_PER_SECOND = 5;
const EVENTS_BURST = 20;
const REJECTIONS_BEFORE_DISCONNECT = 100;
const RATE_LIMITED = 'Príliš veľa požiadaviek — spomaľ';
const NOT_LOGGED_IN = 'Nie si prihlásený';
const NOT_SEATED = 'Pri tomto stole nesedíš';
const TOO_MANY_SUBSCRIPTIONS = 'Naraz sa dá sledovať najviac 5 stolov';

export interface CoachHubOptions {
  httpServer: HttpServer;
  accounts: AccountService;
  manager: SessionManager;
  ids: PublicIds;
  serverVersion: string;
  /** Povolené `Origin` prehliadačových klientov (okrem toho istého hostiteľa). Bez hlavičky Origin (nie prehliadač) spojenie prejde, no bez tokenu nič nevydá. */
  allowedOrigins: string[];
  trustProxy: TrustProxy;
}

interface Subscription {
  playerId: string;
  rev: number;
  lastState: string;
  engine: HandEngine | null;
  sentActions: number;
}

interface CoachSocketData {
  ip: string;
  userId?: string;
  token?: string;
  subscriptions: Map<string, Subscription>;
}

type CoachSocket = Socket<Record<string, (...args: any[]) => void>, Record<string, (...args: any[]) => void>, Record<string, never>, CoachSocketData>;

function reply<T>(ack: unknown, payload: Ack<T>): void {
  if (typeof ack === 'function') {
    ack(payload);
  }
}

function field(payload: unknown, key: string): unknown {
  return payload && typeof payload === 'object' ? (payload as Record<string, unknown>)[key] : undefined;
}

/**
 * Coach API: samostatný Socket.IO server na vlastnej ceste. Samostatný preto, že kontrolu `Origin` robí Socket.IO ešte pred
 * výberom namespace-u — povolenie pomocnej aplikácie by inak otvorilo aj herný socket.
 */
export class CoachHub {
  readonly io: Server;
  private readonly bySocketIp = new Map<string, number>();
  private connections = 0;
  private readonly tableSockets = new Map<string, Set<CoachSocket>>();
  private readonly sweepTimer: NodeJS.Timeout;

  constructor(private readonly options: CoachHubOptions) {
    this.io = new Server(options.httpServer, {
      path: COACH_SOCKET_PATH,
      serveClient: false,
      maxHttpBufferSize: 4 * 1024,
      cors: { origin: options.allowedOrigins },
      allowRequest: (request, callback) => callback(null, originAllowed(request.headers.origin, request.headers.host, options.allowedOrigins)),
    });
    this.io.use((rawSocket, next) => this.admit(rawSocket as CoachSocket, next));
    this.io.on('connection', (socket) => this.onConnection(socket as CoachSocket));
    this.sweepTimer = setInterval(() => this.sweep(), SWEEP_MS);
    this.sweepTimer.unref();
  }

  close(): void {
    clearInterval(this.sweepTimer);
    void this.io.close();
  }

  /** Stôl sa zmenil: každému odberateľovi pošle nové akcie ruky a jeho pohľad na stôl (len ak sa zmenil). */
  tableChanged(table: Table): void {
    const sockets = this.tableSockets.get(table.code);
    if (!sockets) {
      return;
    }
    for (const socket of [...sockets]) {
      this.deliver(socket, table);
    }
  }

  /** Stôl zmizol (zmazal ho zakladateľ). */
  tableRemoved(code: string, reason: CoachClosedEvent['reason'] = 'deleted'): void {
    for (const socket of [...(this.tableSockets.get(code) ?? [])]) {
      this.closeSubscription(socket, code, reason);
    }
  }

  /** Po zmene hesla alebo odhlásení: spojenia, ktorých coach token už neplatí, sa odpoja. */
  revokeUser(userId: string): void {
    for (const rawSocket of this.io.sockets.sockets.values()) {
      const socket = rawSocket as CoachSocket;
      if (socket.data.userId === userId) {
        this.checkToken(socket);
      }
    }
  }

  private admit(socket: CoachSocket, next: (error?: Error) => void): void {
    const ip = clientKey(socket.conn.remoteAddress, socket.handshake.headers, this.options.trustProxy);
    const fromIp = this.bySocketIp.get(ip) ?? 0;
    if (this.connections >= MAX_CONNECTIONS_TOTAL || fromIp >= MAX_CONNECTIONS_PER_IP) {
      next(new Error('Server je preťažený — skús to o chvíľu'));
      return;
    }
    socket.data.ip = ip;
    socket.data.subscriptions = new Map();
    this.connections += 1;
    this.bySocketIp.set(ip, fromIp + 1);
    socket.on('disconnect', () => {
      this.connections = Math.max(0, this.connections - 1);
      const left = (this.bySocketIp.get(ip) ?? 1) - 1;
      if (left > 0) {
        this.bySocketIp.set(ip, left);
      } else {
        this.bySocketIp.delete(ip);
      }
      for (const code of [...socket.data.subscriptions.keys()]) {
        this.dropSubscription(socket, code);
      }
    });
    const token = socket.handshake.auth?.token;
    if (typeof token === 'string' && token !== '') {
      const profile = this.options.accounts.authenticateCoach(token);
      if (profile) {
        socket.data.userId = profile.id;
        socket.data.token = token;
      }
    }
    next();
  }

  private onConnection(socket: CoachSocket): void {
    const hello: CoachHello = {
      apiVersion: COACH_API_VERSION,
      serverVersion: this.options.serverVersion,
      authenticated: socket.data.userId !== undefined,
      ...(socket.data.userId ? { you: this.options.ids.ofUser(socket.data.userId) } : {}),
    };
    socket.emit('coach:hello', hello);

    const events = new TokenBucket(EVENTS_PER_SECOND, EVENTS_BURST);
    const rejections = new WindowCounter(REJECTIONS_BEFORE_DISCONNECT, WINDOWS.MINUTE);
    const handle = <P>(event: string, handler: (payload: P, ack: unknown) => void | Promise<void>) => {
      socket.on(event, (async (payload: P, ack: unknown) => {
        if (!events.take()) {
          if (!rejections.hit('socket')) {
            socket.disconnect(true);
            return;
          }
          reply(ack, { ok: false, error: RATE_LIMITED });
          return;
        }
        try {
          await handler((payload ?? {}) as P, ack);
        } catch (error) {
          console.error(`Coach handler ${event} failed`, error);
          reply(ack, { ok: false, error: 'Chyba servera' });
        }
      }) as (...args: unknown[]) => void);
    };
    const requireUser = (ack: unknown): string | undefined => {
      if (!socket.data.userId || !this.checkToken(socket)) {
        reply(ack, { ok: false, error: NOT_LOGGED_IN });
        return undefined;
      }
      return socket.data.userId;
    };

    handle('coach:login', async (payload, ack) => {
      const result = await this.options.accounts.coachLogin(field(payload, 'login'), field(payload, 'password'), socket.data.ip);
      if (!result.ok || !result.data) {
        reply(ack, { ok: false, error: result.error ?? 'Prihlásenie zlyhalo' });
        return;
      }
      this.clearIdentity(socket);
      socket.data.userId = result.data.account.id;
      socket.data.token = result.data.token;
      const login: CoachLoginResult = { token: result.data.token, username: result.data.account.username, you: this.options.ids.ofUser(result.data.account.id) };
      reply<CoachLoginResult>(ack, { ok: true, data: login });
    });

    handle('coach:logout', (_payload, ack) => {
      if (socket.data.token) {
        this.options.accounts.logoutCoach(socket.data.token);
      }
      this.clearIdentity(socket);
      reply(ack, { ok: true });
    });

    handle('coach:tables', (_payload, ack) => {
      const userId = requireUser(ack);
      if (!userId) {
        return;
      }
      const tables: TableSummary[] = this.options.manager.accountTables(userId, undefined).active.filter((summary) => !summary.left);
      reply<TableSummary[]>(ack, { ok: true, data: tables });
    });

    handle('coach:subscribe', (payload, ack) => {
      const userId = requireUser(ack);
      if (!userId) {
        return;
      }
      const code = field(payload, 'code');
      const table = typeof code === 'string' ? this.options.manager.get(code) : undefined;
      const member = table?.memberByUser(userId);
      const player = member && table?.players.get(member.id);
      if (!table || !player) {
        reply(ack, { ok: false, error: NOT_SEATED });
        return;
      }
      const existing = socket.data.subscriptions.get(table.code);
      if (!existing && socket.data.subscriptions.size >= MAX_SUBSCRIPTIONS) {
        reply(ack, { ok: false, error: TOO_MANY_SUBSCRIPTIONS });
        return;
      }
      this.dropSubscription(socket, table.code);
      socket.data.subscriptions.set(table.code, { playerId: player.id, rev: 0, lastState: '', engine: table.engine, sentActions: 0 });
      this.sockets(table.code).add(socket);
      reply<{ you: string }>(ack, { ok: true, data: { you: this.pidOf(table, player.id) } });
      this.deliver(socket, table);
    });

    handle('coach:proofs', (payload, ack) => {
      const userId = requireUser(ack);
      if (!userId) {
        return;
      }
      const code = field(payload, 'code');
      const table = typeof code === 'string' ? this.options.manager.get(code) : undefined;
      const member = table?.memberByUser(userId);
      if (!table || !member) {
        reply(ack, { ok: false, error: NOT_SEATED });
        return;
      }
      const { proofs, revealed, revealAt } = table.fairProofs();
      const pids: Record<string, string> = {};
      for (const proof of proofs) {
        for (const id of [...Object.keys(proof.commitments), ...Object.keys(proof.seeds), ...proof.excluded, ...proof.seats.map((seat) => seat.id)]) {
          pids[id] ??= this.pidOf(table, id);
        }
      }
      reply<CoachProofsResponse>(ack, { ok: true, data: { proofs, revealed, revealAt, pids } });
    });

    handle('coach:unsubscribe', (payload, ack) => {
      const code = field(payload, 'code');
      if (typeof code === 'string') {
        this.dropSubscription(socket, code.toUpperCase());
      }
      reply(ack, { ok: true });
    });
  }

  private deliver(socket: CoachSocket, table: Table): void {
    const subscription = socket.data.subscriptions.get(table.code);
    if (!subscription) {
      return;
    }
    const player = table.players.get(subscription.playerId);
    if (this.options.manager.get(table.code) !== table) {
      this.closeSubscription(socket, table.code, 'deleted');
      return;
    }
    if (!player || player.userId !== socket.data.userId) {
      this.closeSubscription(socket, table.code, 'left');
      return;
    }
    if (subscription.engine !== table.engine) {
      if (subscription.engine) {
        this.sendActions(socket, table, subscription.engine, subscription);
      }
      subscription.engine = table.engine;
      subscription.sentActions = 0;
    }
    if (table.engine) {
      this.sendActions(socket, table, table.engine, subscription);
    }
    const state = projectCoachState(table.liveView(subscription.playerId), (playerId) => this.pidOf(table, playerId));
    const key = JSON.stringify({ ...state, serverTime: 0 });
    if (key === subscription.lastState) {
      return;
    }
    subscription.lastState = key;
    subscription.rev += 1;
    const event: CoachStateEvent = { code: table.code, rev: subscription.rev, state };
    socket.emit('coach:state', event);
  }

  private sendActions(socket: CoachSocket, table: Table, engine: HandEngine, subscription: Subscription): void {
    const pending: EngineAction[] = engine.actions.slice(subscription.sentActions);
    for (const action of pending) {
      const event: CoachActionEvent = {
        code: table.code,
        hand: engine.handNumber,
        seq: action.seq,
        street: action.street,
        pid: this.pidOf(table, action.playerId),
        type: action.type,
        amount: action.amount,
        toAmount: action.toAmount,
        potBefore: action.potBefore,
        allin: action.allin,
        auto: action.auto,
      };
      socket.emit('hand:action', event);
    }
    subscription.sentActions += pending.length;
  }

  private pidOf(table: Table, playerId: string): string {
    const member = table.players.get(playerId) ?? table.departed.get(playerId);
    return member?.userId ? this.options.ids.ofUser(member.userId) : this.options.ids.ofSeat(table.code, playerId);
  }

  private sockets(code: string): Set<CoachSocket> {
    let set = this.tableSockets.get(code);
    if (!set) {
      set = new Set();
      this.tableSockets.set(code, set);
    }
    return set;
  }

  private dropSubscription(socket: CoachSocket, code: string): void {
    socket.data.subscriptions.delete(code);
    const set = this.tableSockets.get(code);
    set?.delete(socket);
    if (set?.size === 0) {
      this.tableSockets.delete(code);
    }
  }

  private closeSubscription(socket: CoachSocket, code: string, reason: CoachClosedEvent['reason']): void {
    this.dropSubscription(socket, code);
    const event: CoachClosedEvent = { code, reason };
    socket.emit('coach:closed', event);
  }

  private clearIdentity(socket: CoachSocket): void {
    for (const code of [...socket.data.subscriptions.keys()]) {
      this.dropSubscription(socket, code);
    }
    socket.data.userId = undefined;
    socket.data.token = undefined;
  }

  /** Neplatný token odpojí spojenie; vráti, či platí. */
  private checkToken(socket: CoachSocket): boolean {
    if (socket.data.token && this.options.accounts.authenticateCoach(socket.data.token)) {
      return true;
    }
    socket.emit('coach:revoked', {});
    this.clearIdentity(socket);
    socket.disconnect(true);
    return false;
  }

  /** Raz za minútu: neplatné tokeny, zmazané stoly a hráči, ktorí od stola odišli (aj keď sa stôl dlho nezmenil). */
  private sweep(): void {
    for (const rawSocket of this.io.sockets.sockets.values()) {
      const socket = rawSocket as CoachSocket;
      if (socket.data.token && !this.checkToken(socket)) {
        continue;
      }
      for (const code of [...socket.data.subscriptions.keys()]) {
        const table = this.options.manager.get(code);
        if (!table) {
          this.closeSubscription(socket, code, 'deleted');
        } else {
          this.deliver(socket, table);
        }
      }
    }
  }
}
