import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { Server } from 'socket.io';
import { io as connect, type Socket as ClientSocket } from 'socket.io-client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { COACH_API_VERSION, COACH_SOCKET_PATH, type CoachActionEvent, type CoachClosedEvent, type CoachHello, type CoachLoginResult, type CoachProofsResponse, type CoachStateEvent } from '../../shared/coach';
import type { Ack, Avatar } from '../../shared/types';
import { DEFAULT_SETTINGS } from '../../shared/constants';
import { AccountService } from '../accounts/AccountService';
import type { Mailer } from '../accounts/Mailer';
import { createAccountHub } from '../accountSocket';
import { originAllowed } from '../limits';
import { CoachHub } from '../coach/CoachHub';
import { createPublicIds } from '../coach/publicId';
import { SessionManager } from '../SessionManager';
import type { Table, TablePlayer } from '../Table';
import { buyIn } from './helpers';

const PASSWORD = 'tajne-heslo-1';
const COACH_ORIGIN = 'http://localhost:5180';
const avatar: Avatar = { emoji: '🦊', color: '#e76f51' };

class SilentMailer implements Mailer {
  send(): void {}
}

let http: HttpServer;
let url: string;
let dataDir: string;
let accounts: AccountService;
let manager: SessionManager;
let hub: CoachHub;
let gameIo: Server;
const ids = createPublicIds(Buffer.alloc(32, 3));
const clients: ClientSocket[] = [];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor<T>(read: () => T | undefined | false, timeoutMs = 4000): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value) {
      return value;
    }
    if (Date.now() > until) {
      throw new Error('timeout');
    }
    await sleep(10);
  }
}

beforeEach(async () => {
  dataDir = mkdtempSync(path.join(os.tmpdir(), 'coach-hub-'));
  accounts = new AccountService({ dataDir, publicUrl: 'https://poker.test', mailer: new SilentMailer(), scryptN: 1024 });
  const pending = new Set<Table>();
  manager = new SessionManager(
    {
      onChange: (table) => {
        if (pending.has(table)) {
          return;
        }
        pending.add(table);
        setImmediate(() => {
          pending.delete(table);
          hub.tableChanged(table);
        });
      },
      onEvent: () => undefined,
      onRemoved: () => undefined,
    },
    { dataDir: null },
  );
  const app = express();
  http = createServer(app);
  // Rovnaké poradie a nastavenie ako v index.ts: herný socket s vlastnou kontrolou Origin, až potom coach server.
  gameIo = new Server(http, { allowRequest: (request, callback) => callback(null, originAllowed(request.headers.origin, request.headers.host, [])) });
  createAccountHub(gameIo, accounts, { onProfileChanged: () => undefined, onSessionsRevoked: () => undefined, onLogout: () => undefined }).httpRoutes(app);
  hub = new CoachHub({ httpServer: http, accounts, manager, ids, serverVersion: 'test', allowedOrigins: [COACH_ORIGIN], trustProxy: 'off' });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
});

afterEach(async () => {
  for (const client of clients.splice(0)) {
    client.disconnect();
  }
  hub.close();
  await gameIo.close();
  manager.dispose();
  await new Promise<void>((resolve) => http.close(() => resolve()));
  rmSync(dataDir, { recursive: true, force: true });
});

async function register(name: string): Promise<{ userId: string; token: string }> {
  const result = await accounts.register(`${name.toLowerCase()}@poker.test`, name, PASSWORD, PASSWORD, `ip-${name}`);
  if (!result.ok || !result.data) {
    throw new Error(`register failed: ${result.error}`);
  }
  return { userId: result.data.account.id, token: result.data.token };
}

function open(options: { origin?: string; token?: string; transports?: ('websocket' | 'polling')[] } = {}): ClientSocket {
  const socket = connect(url, {
    path: COACH_SOCKET_PATH,
    forceNew: true,
    reconnection: false,
    transports: options.transports ?? ['websocket'],
    extraHeaders: options.origin ? { Origin: options.origin } : undefined,
    auth: options.token ? { token: options.token } : {},
  });
  clients.push(socket);
  return socket;
}

function hello(socket: ClientSocket): Promise<CoachHello> {
  return new Promise((resolve, reject) => {
    socket.once('coach:hello', resolve);
    socket.once('connect_error', reject);
  });
}

function call<T>(socket: ClientSocket, event: string, payload: unknown = {}): Promise<Ack<T>> {
  return socket.timeout(4000).emitWithAck(event, payload) as Promise<Ack<T>>;
}

interface Collected {
  states: CoachStateEvent[];
  actions: CoachActionEvent[];
  closed: CoachClosedEvent[];
  revoked: number;
}

function collect(socket: ClientSocket): Collected {
  const collected: Collected = { states: [], actions: [], closed: [], revoked: 0 };
  socket.on('coach:state', (event: CoachStateEvent) => collected.states.push(event));
  socket.on('hand:action', (event: CoachActionEvent) => collected.actions.push(event));
  socket.on('coach:closed', (event: CoachClosedEvent) => collected.closed.push(event));
  socket.on('coach:revoked', () => (collected.revoked += 1));
  return collected;
}

async function loginCoach(name: string): Promise<CoachLoginResult> {
  const socket = open({ origin: COACH_ORIGIN });
  await hello(socket);
  const result = await call<CoachLoginResult>(socket, 'coach:login', { login: name, password: PASSWORD });
  expect(result.ok).toBe(true);
  socket.disconnect();
  return result.data!;
}

function seat(table: Table, name: string, userId: string): TablePlayer {
  const added = table.addPlayer(name, avatar, userId);
  if (!added.ok || !added.data) {
    throw new Error(`join ${name} failed`);
  }
  return added.data;
}

async function seatedTable(): Promise<{ table: Table; ana: TablePlayer; boris: TablePlayer; anaId: string; borisId: string }> {
  const ana = await register('Ana');
  const boris = await register('Boris');
  const table = manager.create({ ...DEFAULT_SETTINGS });
  const anaPlayer = seat(table, 'Ana', ana.userId);
  const borisPlayer = seat(table, 'Boris', boris.userId);
  table.attachSocket(anaPlayer, 'main-ana');
  table.attachSocket(borisPlayer, 'main-boris');
  buyIn(table, anaPlayer);
  buyIn(table, borisPlayer);
  return { table, ana: anaPlayer, boris: borisPlayer, anaId: ana.userId, borisId: boris.userId };
}

async function startHand(table: Table): Promise<void> {
  expect(table.hostStart().ok).toBe(true);
  expect(table.hostDealerChoice('random').ok).toBe(true);
  await waitFor(() => table.engine && !table.engine.isComplete, 6000);
}

describe('coach API: prístup', () => {
  it('cudzí Origin odmietne, povolený prejde a dostane CORS hlavičky', async () => {
    const bad = open({ origin: 'https://evil.example' });
    await expect(hello(bad)).rejects.toBeTruthy();

    const good = open({ origin: COACH_ORIGIN });
    const greeting = await hello(good);
    expect(greeting).toMatchObject({ apiVersion: COACH_API_VERSION, serverVersion: 'test', authenticated: false });

    const allowed = await fetch(`${url}${COACH_SOCKET_PATH}/?EIO=4&transport=polling`, { headers: { Origin: COACH_ORIGIN } });
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get('access-control-allow-origin')).toBe(COACH_ORIGIN);
    const denied = await fetch(`${url}${COACH_SOCKET_PATH}/?EIO=4&transport=polling`, { headers: { Origin: 'https://evil.example' } });
    expect(denied.status).toBe(403);
  });

  it('herný socket sa povolením coach adresy nerozšíril a obe cesty bežia vedľa seba', async () => {
    const game = connect(url, { forceNew: true, reconnection: false, transports: ['websocket'], extraHeaders: { Origin: COACH_ORIGIN } });
    clients.push(game);
    await expect(new Promise<void>((resolve, reject) => {
      game.once('connect', () => resolve());
      game.once('connect_error', reject);
    })).rejects.toBeTruthy();
    const response = await fetch(`${url}/socket.io/?EIO=4&transport=polling`, { headers: { Origin: COACH_ORIGIN } });
    expect(response.status).toBe(403);

    const sameOrigin = connect(url, { forceNew: true, reconnection: false, transports: ['websocket'] });
    clients.push(sameOrigin);
    await new Promise<void>((resolve, reject) => {
      sameOrigin.once('connect', () => resolve());
      sameOrigin.once('connect_error', reject);
    });
    const coach = open({ origin: COACH_ORIGIN });
    expect((await hello(coach)).apiVersion).toBe(COACH_API_VERSION);
  });

  it('bez prihlásenia nič nevydá', async () => {
    const socket = open({ origin: COACH_ORIGIN });
    await hello(socket);
    for (const [event, payload] of [['coach:tables', {}], ['coach:subscribe', { code: 'ABCDEF' }]] as const) {
      const result = await call(socket, event, payload);
      expect(result.ok).toBe(false);
    }
  });

  it('nesprávne heslo neprihlási a odpoveď neobsahuje e-mail', async () => {
    await register('Ana');
    const socket = open({ origin: COACH_ORIGIN });
    await hello(socket);
    const bad = await call(socket, 'coach:login', { login: 'Ana', password: 'zle-heslo-99' });
    expect(bad.ok).toBe(false);
    const good = await call<CoachLoginResult>(socket, 'coach:login', { login: 'ana@poker.test', password: PASSWORD });
    expect(good.ok).toBe(true);
    expect(JSON.stringify(good)).not.toContain('@');
    expect(good.data!.you).toBe(ids.ofUser((await accounts.coachLogin('Ana', PASSWORD)).data!.account.id));
  });

  it('bežný token nefunguje ako coach token a coach token nefunguje ako bežný', async () => {
    const ana = await register('Ana');
    const coach = await loginCoach('Ana');

    const withFull = open({ origin: COACH_ORIGIN, token: ana.token });
    expect((await hello(withFull)).authenticated).toBe(false);

    const withCoach = open({ origin: COACH_ORIGIN, token: coach.token });
    expect(await hello(withCoach)).toMatchObject({ authenticated: true, you: ids.ofUser(ana.userId) });

    expect(accounts.authenticate(ana.token)?.id).toBe(ana.userId);
    expect(accounts.authenticate(coach.token)).toBeUndefined();
    expect(accounts.authenticateCoach(ana.token)).toBeUndefined();
    expect(accounts.authenticateCoach(coach.token)?.id).toBe(ana.userId);
  });

  it('coach token neprejde ani cez HTTP s Bearer', async () => {
    const ana = await register('Ana');
    const coach = await loginCoach('Ana');
    const upload = (token: string) => fetch(`${url}/api/account/photo`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'image/jpeg' }, body: Buffer.alloc(40, 7) });
    expect((await upload(coach.token)).status).toBe(401);
    expect((await upload('0'.repeat(64))).status).toBe(401);
    expect((await upload(ana.token)).status).not.toBe(401);
  });
});

describe('coach API: odber stola', () => {
  it('nesediaci hráč stôl odoberať nemôže', async () => {
    const { table } = await seatedTable();
    await register('Cyril');
    const coach = await loginCoach('Cyril');
    const socket = open({ origin: COACH_ORIGIN, token: coach.token });
    await hello(socket);
    const result = await call(socket, 'coach:subscribe', { code: table.code });
    expect(result.ok).toBe(false);
    expect((await call<unknown[]>(socket, 'coach:tables')).data).toEqual([]);
  });

  it('pošle súvislé akcie, stav z pohľadu hráča a nikoho neodpojí od stola', async () => {
    const { table, ana, boris } = await seatedTable();
    const coach = await loginCoach('Ana');
    const socket = open({ origin: COACH_ORIGIN, token: coach.token });
    const collected = collect(socket);
    await hello(socket);
    const tables = await call<{ code: string }[]>(socket, 'coach:tables');
    expect(tables.data!.map((summary) => summary.code)).toEqual([table.code]);
    const subscribed = await call<{ you: string }>(socket, 'coach:subscribe', { code: table.code.toLowerCase() });
    expect(subscribed.ok).toBe(true);
    expect(subscribed.data!.you).toBe(coach.you);

    await startHand(table);
    const engine = table.engine!;
    let guard = 0;
    while (!engine.isComplete && guard++ < 100) {
      const actor = engine.toAct;
      if (!actor) {
        await sleep(50);
        continue;
      }
      const legal = engine.legalActions(actor.id)!;
      table.act(table.players.get(actor.id)!, legal.canCheck ? { type: 'check' } : { type: 'call' });
      await sleep(20);
    }
    expect(engine.isComplete).toBe(true);
    await waitFor(() => collected.states.at(-1)?.state.lastResult);
    await sleep(50);

    const hand = engine.handNumber;
    const mine = collected.actions.filter((action) => action.hand === hand);
    expect(mine.map((action) => action.seq)).toEqual(engine.actions.map((action) => action.seq));
    expect(mine.map((action) => action.type)).toEqual(engine.actions.map((action) => action.type));
    expect(new Set(mine.map((action) => action.pid))).toEqual(new Set([ids.ofUser(accountsUser(ana)), ids.ofUser(accountsUser(boris))]));

    const revs = collected.states.map((event) => event.rev);
    expect(revs).toEqual(revs.map((_, index) => index + 1));
    const duringHand = collected.states.filter((event) => event.state.hand && !event.state.lastResult).at(-1)!;
    const others = duringHand.state.players.filter((player) => !player.isYou);
    expect(others.length).toBe(1);
    expect(others[0].cards.every((card) => card === null)).toBe(true);
    expect(duringHand.state.players.find((player) => player.isYou)!.cards.every((card) => card !== null)).toBe(true);
    expect(JSON.stringify(collected.states)).not.toContain(ana.token);
    expect(JSON.stringify(collected.states)).not.toContain(boris.token);

    expect([...ana.sockets]).toEqual(['main-ana']);
    expect([...boris.sockets]).toEqual(['main-boris']);
  });

  it('pripojenie uprostred ruky prehrá celú doterajšiu ruku', async () => {
    const { table } = await seatedTable();
    await startHand(table);
    const engine = table.engine!;
    const actor = engine.toAct!;
    table.act(table.players.get(actor.id)!, { type: 'call' });

    const coach = await loginCoach('Boris');
    const socket = open({ origin: COACH_ORIGIN, token: coach.token });
    const collected = collect(socket);
    await hello(socket);
    await call(socket, 'coach:subscribe', { code: table.code });
    await waitFor(() => collected.states.length > 0);
    await sleep(30);
    expect(collected.actions.map((action) => action.seq)).toEqual(engine.actions.map((action) => action.seq));
  });

  it('po zmene hesla sa coach spojenie odpojí', async () => {
    const { table, anaId } = await seatedTable();
    const coach = await loginCoach('Ana');
    const socket = open({ origin: COACH_ORIGIN, token: coach.token });
    const collected = collect(socket);
    await hello(socket);
    await call(socket, 'coach:subscribe', { code: table.code });
    const bareToken = (await accounts.login('Ana', PASSWORD)).data!.token;
    const changed = await accounts.changePassword(anaId, bareToken, PASSWORD, 'nove-heslo-77', 'nove-heslo-77');
    expect(changed.ok).toBe(true);
    hub.revokeUser(anaId);
    await waitFor(() => collected.revoked > 0);
    await waitFor(() => !socket.connected);
    expect(accounts.authenticateCoach(coach.token)).toBeUndefined();
  });

  it('dôkazy miešania: bez semienka počas hry, s pid pre každé ID, len pre sediaceho', async () => {
    const { table } = await seatedTable();
    await startHand(table);
    const coach = await loginCoach('Ana');
    const socket = open({ origin: COACH_ORIGIN, token: coach.token });
    await hello(socket);
    const proofs = await call<CoachProofsResponse>(socket, 'coach:proofs', { code: table.code });
    expect(proofs.ok).toBe(true);
    expect(proofs.data!.revealed).toBe(false);
    expect(proofs.data!.proofs.length).toBeGreaterThan(0);
    for (const proof of proofs.data!.proofs) {
      expect(proof.serverSeed).toBeNull();
      for (const seat of proof.seats) {
        expect(proofs.data!.pids[seat.id]).toMatch(/^u_/);
      }
    }

    await register('Cyril');
    const other = await loginCoach('Cyril');
    const outsider = open({ origin: COACH_ORIGIN, token: other.token });
    await hello(outsider);
    expect((await call(outsider, 'coach:proofs', { code: table.code })).ok).toBe(false);
  });

  it('zmazaný stôl odber ukončí', async () => {
    const { table } = await seatedTable();
    const coach = await loginCoach('Ana');
    const socket = open({ origin: COACH_ORIGIN, token: coach.token });
    const collected = collect(socket);
    await hello(socket);
    await call(socket, 'coach:subscribe', { code: table.code });
    manager.remove(table.code);
    hub.tableRemoved(table.code);
    await waitFor(() => collected.closed.length > 0);
    expect(collected.closed[0]).toEqual({ code: table.code, reason: 'deleted' });
  });

  it('odhlásenie coach tokenu ho zruší', async () => {
    await register('Ana');
    const coach = await loginCoach('Ana');
    const socket = open({ origin: COACH_ORIGIN, token: coach.token });
    await hello(socket);
    expect((await call(socket, 'coach:logout')).ok).toBe(true);
    expect(accounts.authenticateCoach(coach.token)).toBeUndefined();
  });
});

function accountsUser(player: TablePlayer): string {
  return player.userId!;
}
