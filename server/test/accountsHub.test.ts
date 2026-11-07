import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { Server } from 'socket.io';
import { io as connect, type Socket as ClientSocket } from 'socket.io-client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AccountView, AuthSession } from '../../shared/account';
import type { Ack } from '../../shared/types';
import { createAccountHub, type AccountHandle } from '../accountSocket';
import { AccountService } from '../accounts/AccountService';
import type { Mailer } from '../accounts/Mailer';

const PASSWORD = 'tajne-heslo-1';
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40, 7)]);

class FakeMailer implements Mailer {
  readonly sent: { to: string; text: string }[] = [];
  send(to: string, _subject: string, text: string): void {
    this.sent.push({ to, text });
  }
  token(kind: 'verify' | 'reset'): string {
    const text = this.sent[this.sent.length - 1]?.text ?? '';
    return text.match(new RegExp(`/${kind}\\?token=([0-9a-f]{64})`))?.[1] ?? '';
  }
}

let http: HttpServer;
let io: Server;
let url: string;
let dataDir: string;
let accounts: AccountService;
let mailer: FakeMailer;
let calls: { profileChanged: string[]; revoked: [string, string | null][]; logout: string[] };
const clients: ClientSocket[] = [];

beforeEach(async () => {
  dataDir = mkdtempSync(path.join(os.tmpdir(), 'accounts-hub-'));
  mailer = new FakeMailer();
  accounts = new AccountService({ dataDir, publicUrl: 'https://poker.test', mailer, scryptN: 1024 });
  calls = { profileChanged: [], revoked: [], logout: [] };
  const app = express();
  http = createServer(app);
  io = new Server(http);
  const hub = createAccountHub(io, accounts, {
    onProfileChanged: (userId) => calls.profileChanged.push(userId),
    onSessionsRevoked: (userId, except) => calls.revoked.push([userId, except]),
    onLogout: (socketId) => calls.logout.push(socketId),
  });
  hub.httpRoutes(app);
  io.use(hub.middleware);
  io.on('connection', (socket) => {
    const handle: AccountHandle = (event, handler) => {
      socket.on(event, (payload: unknown, ack: unknown) => handler((payload ?? {}) as never, ack));
    };
    hub.register(socket, handle, 'test-ip');
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
});

afterEach(async () => {
  for (const client of clients.splice(0)) {
    client.disconnect();
  }
  await new Promise<void>((resolve) => io.close(() => resolve()));
  rmSync(dataDir, { recursive: true, force: true });
});

/** Klient; udalosti zo servera sa zbierajú od prvej chvíle (aj tie hneď po pripojení). */
async function client(token?: string) {
  const socket = connect(url, { auth: token ? { token } : {}, transports: ['websocket'], forceNew: true });
  const events: { event: string; payload: unknown }[] = [];
  socket.onAny((event: string, payload: unknown) => events.push({ event, payload }));
  clients.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('connect_error', reject);
  });
  return { socket, events };
}

function call<T>(socket: ClientSocket, event: string, payload: unknown = {}): Promise<Ack<T>> {
  return new Promise((resolve) => socket.emit(event, payload, resolve));
}

async function until(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100 && !check(); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(check()).toBe(true);
}

async function registerVia(socket: ClientSocket, email = 'fero@example.com', username = 'Fero') {
  const result = await call<AuthSession>(socket, 'auth:register', { email, username, password: PASSWORD, passwordConfirm: PASSWORD });
  expect(result.ok).toBe(true);
  return result.data!;
}

describe('account hub (socket.io)', () => {
  it('registrácia prihlási spojenie; nové spojenie s tokenom dostane account:updated, s neplatným auth:invalid', async () => {
    const first = await client();
    const session = await registerVia(first.socket);
    const me = await call<AccountView>(first.socket, 'auth:me');
    expect(me.data?.username).toBe('Fero');

    const second = await client(session.token);
    await until(() => second.events.some((item) => item.event === 'account:updated'));
    expect((second.events.find((item) => item.event === 'account:updated')?.payload as AccountView).id).toBe(session.account.id);

    const stale = await client('a'.repeat(64));
    await until(() => stale.events.some((item) => item.event === 'auth:invalid'));
    expect((await call(stale.socket, 'auth:me')).error).toBe('Nie si prihlásený');
  });

  it('overenie e-mailu funguje bez prihlásenia a rozošle account:updated zariadeniam účtu', async () => {
    const first = await client();
    const session = await registerVia(first.socket);
    expect((await call(first.socket, 'account:stats')).error).toBe('Najprv over svoj e-mail');
    const anonymous = await client();
    const verified = await call<AccountView>(anonymous.socket, 'auth:verifyEmail', { token: mailer.token('verify') });
    expect(verified.data?.emailVerified).toBe(true);
    await until(() => first.events.some((item) => item.event === 'account:updated' && (item.payload as AccountView).emailVerified));
    expect(anonymous.events.some((item) => item.event === 'account:updated')).toBe(false);
    expect(calls.profileChanged).toEqual([session.account.id]);
    expect((await call(first.socket, 'account:stats')).ok).toBe(true);
  });

  it('zmena hesla odhlási ostatné zariadenia (auth:invalid), aktuálne ostane', async () => {
    const first = await client();
    const session = await registerVia(first.socket);
    const login = await call<AuthSession>((await client()).socket, 'auth:login', { login: 'FERO', password: PASSWORD });
    const other = await client(login.data!.token);
    const changed = await call(first.socket, 'account:changePassword', { currentPassword: PASSWORD, password: 'nove-heslo-9', passwordConfirm: 'nove-heslo-9' });
    expect(changed).toEqual({ ok: true });
    await until(() => other.events.some((item) => item.event === 'auth:invalid'));
    expect(first.events.some((item) => item.event === 'auth:invalid')).toBe(false);
    expect(calls.revoked).toEqual([[session.account.id, first.socket.id]]);
    expect(calls.logout).toContain(other.socket.id);
    expect((await call(other.socket, 'auth:me')).ok).toBe(false);
    expect((await call(first.socket, 'auth:me')).ok).toBe(true);
  });

  it('reset hesla z odkazu prihlási nové zariadenie a odhlási všetky ostatné', async () => {
    const first = await client();
    await registerVia(first.socket);
    await call(first.socket, 'auth:verifyEmail', { token: mailer.token('verify') });
    const anonymous = await client();
    expect(await call(anonymous.socket, 'auth:forgotPassword', { login: 'fero@example.com' })).toEqual({ ok: true });
    const reset = await call<AuthSession>(anonymous.socket, 'auth:resetPassword', { token: mailer.token('reset'), password: 'nove-heslo-9', passwordConfirm: 'nove-heslo-9' });
    expect(reset.ok).toBe(true);
    await until(() => first.events.some((item) => item.event === 'auth:invalid'));
    expect((await call<AccountView>(anonymous.socket, 'auth:me')).data?.username).toBe('Fero');
  });

  it('odhlásenie zruší token aj v iných kartách s rovnakým tokenom; prihlásenie za iný účet volá onLogout', async () => {
    const first = await client();
    const session = await registerVia(first.socket);
    const tab = await client(session.token);
    expect(await call(first.socket, 'auth:logout')).toEqual({ ok: true });
    await until(() => tab.events.some((item) => item.event === 'auth:invalid'));
    expect(calls.logout).toEqual(expect.arrayContaining([first.socket.id, tab.socket.id]));

    await registerVia(first.socket, 'druhy@example.com', 'Druhý');
    calls.logout.length = 0;
    const login = await call<AuthSession>(first.socket, 'auth:login', { login: 'Fero', password: PASSWORD });
    expect(login.ok).toBe(true);
    expect(calls.logout).toEqual([first.socket.id]);
  });

  it('zmena profilu rozošle account:updated a zavolá onProfileChanged', async () => {
    const first = await client();
    const session = await registerVia(first.socket);
    const tab = await client(session.token);
    const updated = await call<AccountView>(first.socket, 'account:update', { username: 'Fero Nový', avatar: { emoji: '🃏', color: '#e76f51' } });
    expect(updated.data).toMatchObject({ username: 'Fero Nový', avatar: { emoji: '🃏', color: '#e76f51' } });
    await until(() => tab.events.some((item) => item.event === 'account:updated' && (item.payload as AccountView).username === 'Fero Nový'));
    expect(calls.profileChanged).toEqual([session.account.id]);
  });

  it('HTTP: nahratie fotky (Bearer), chyby ako JSON a servírovanie s cache hlavičkami', async () => {
    const first = await client();
    const session = await registerVia(first.socket);
    const upload = (body: Buffer, type: string, token: string | null = session.token) =>
      fetch(`${url}/api/account/photo`, { method: 'POST', body, headers: { 'Content-Type': type, ...(token ? { Authorization: `Bearer ${token}` } : {}) } });

    expect((await upload(JPEG, 'image/jpeg', null)).status).toBe(401);
    const wrongType = await upload(JPEG, 'image/png');
    expect(wrongType.status).toBe(415);
    expect(((await wrongType.json()) as Ack).ok).toBe(false);
    const tooBig = await upload(Buffer.alloc(200_000), 'image/jpeg');
    expect(tooBig.status).toBe(413);
    expect(await tooBig.json()).toEqual({ ok: false, error: 'Fotka je príliš veľká' });
    expect((await upload(Buffer.from('nie je obrazok'), 'image/jpeg')).status).toBe(400);

    const ok = await upload(JPEG, 'image/jpeg');
    expect(ok.status).toBe(200);
    const result = (await ok.json()) as Ack<AccountView>;
    const photoUrl = result.data?.avatar.photo ?? '';
    expect(photoUrl).toBe(`/api/photos/${session.account.id}.jpg?v=1`);
    await until(() => first.events.some((item) => item.event === 'account:updated' && Boolean((item.payload as AccountView).avatar.photo)));
    expect(calls.profileChanged).toContain(session.account.id);

    const served = await fetch(`${url}${photoUrl}`);
    expect(served.status).toBe(200);
    expect(served.headers.get('content-type')).toBe('image/jpeg');
    expect(served.headers.get('x-content-type-options')).toBe('nosniff');
    expect(served.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(Buffer.from(await served.arrayBuffer()).equals(JPEG)).toBe(true);

    expect((await fetch(`${url}/api/photos/${session.account.id}.webp`)).status).toBe(404);
    expect((await fetch(`${url}/api/photos/..%2Fusers.json`)).status).toBe(404);

    const deleted = await call<AccountView>(first.socket, 'account:deletePhoto');
    expect(deleted.data?.avatar.photo).toBeUndefined();
    expect((await fetch(`${url}${photoUrl}`)).status).toBe(404);
  });
});
