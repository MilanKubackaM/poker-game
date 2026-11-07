import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import type { Server } from 'socket.io';
import { PHOTO_MAX_BYTES, PHOTO_MIME_TYPES, type AccountStats, type AccountView, type AuthSession } from '../shared/account';
import type { Ack } from '../shared/types';
import { photoMime, type AccountService } from './accounts/AccountService';

/** Minimálny tvar socketu, ktorý hub potrebuje (nezávislý od `GameSocket` v index.ts). */
export interface AccountSocket {
  id: string;
  data: { userId?: string; authToken?: string; ip?: string };
  handshake: { auth?: Record<string, unknown> };
  emit(event: string, ...args: any[]): unknown;
  join(room: string): unknown;
  leave(room: string): unknown;
}

/** `handle` z `io.on('connection')` v index.ts (limit požiadaviek spojenia + try/catch). */
export type AccountHandle = <P>(event: string, handler: (payload: P, ack: unknown) => void) => void;

export interface AccountHubHooks {
  /** Zmenilo sa meno / avatar / fotka / overenie e-mailu — stoly prekreslia hráča. */
  onProfileChanged(userId: string): void;
  /** Po zmene / resete hesla sa zrušili ostatné prihlásenia účtu (`exceptSocketId` = spojenie, ktoré zmenu urobilo). */
  onSessionsRevoked(userId: string, exceptSocketId: string | null): void;
  /** Spojenie prestalo patriť účtu (odhlásenie, neplatný token, prihlásenie za iný účet) — odpojiť ho od stola. */
  onLogout(socketId: string): void;
}

export interface AccountHub {
  /** `io.use(hub.middleware)` — prečíta `auth.token` z handshake; spojenie nikdy neodmietne. */
  middleware(socket: AccountSocket, next: (error?: Error) => void): void;
  /** V `io.on('connection')`: miestnosť účtu, úvodné `account:updated` / `auth:invalid` a všetky `auth:*` / `account:*` handlery. */
  register(socket: AccountSocket, handle: AccountHandle, ip: string): void;
  /** `POST /api/account/photo` a `GET /api/photos/:file` — zaregistrovať pred SPA fallbackom. */
  httpRoutes(app: Express): void;
  /** Po zmene profilu mimo hubu: pošle `account:updated` všetkým zariadeniam účtu (bez volania hooks). */
  sendAccount(userId: string): void;
}

const NOT_LOGGED_IN = 'Nie si prihlásený';
const NOT_VERIFIED = 'Najprv over svoj e-mail';
const SERVER_ERROR = 'Chyba servera';
const PHOTO_FILE_PATTERN = /^[0-9a-f-]{36}\.(webp|jpg)$/;

export function userRoom(userId: string): string {
  return `user:${userId}`;
}

function reply<T>(ack: unknown, payload: Ack<T>): void {
  if (typeof ack === 'function') {
    ack(payload);
  }
}

function field(payload: unknown, key: string): unknown {
  return payload && typeof payload === 'object' ? (payload as Record<string, unknown>)[key] : undefined;
}

function bearer(header: string | undefined): string | undefined {
  const match = header?.match(/^Bearer\s+(\S+)$/i);
  return match?.[1];
}

/** Socketové udalosti účtov a HTTP cesty fotiek. */
export function createAccountHub(io: Server, accounts: AccountService, hooks: AccountHubHooks): AccountHub {
  /** Spojenia, ktoré prišli s neplatným tokenom — po pripojení dostanú `auth:invalid`. */
  const invalidAtConnect = new WeakSet<object>();

  const setIdentity = (socket: AccountSocket, userId: string, token: string) => {
    const previous = socket.data.userId;
    if (previous && previous !== userId) {
      socket.leave(userRoom(previous));
      hooks.onLogout(socket.id);
    }
    socket.data.userId = userId;
    socket.data.authToken = token;
    socket.join(userRoom(userId));
  };

  const clearIdentity = (socket: AccountSocket) => {
    if (socket.data.userId) {
      socket.leave(userRoom(socket.data.userId));
    }
    socket.data.userId = undefined;
    socket.data.authToken = undefined;
  };

  /** Spojenie stratilo platné prihlásenie: klient sa odhlási, server ho odpojí od účtu aj od stola. */
  const invalidate = (socket: AccountSocket) => {
    socket.emit('auth:invalid', {});
    clearIdentity(socket);
    hooks.onLogout(socket.id);
  };

  /** Ostatné spojenia účtu, ktorých token už neplatí (zmena hesla, odhlásenie v inej karte), dostanú `auth:invalid`. */
  const dropRevoked = (userId: string, exceptSocketId: string | null) => {
    const ids = io.sockets.adapter.rooms.get(userRoom(userId));
    for (const id of [...(ids ?? [])]) {
      const other = io.sockets.sockets.get(id) as AccountSocket | undefined;
      if (!other || other.id === exceptSocketId) {
        continue;
      }
      if (!accounts.authenticate(other.data.authToken)) {
        invalidate(other);
      }
    }
  };

  const sendAccount = (userId: string) => {
    const view = accounts.view(userId);
    if (view) {
      io.to(userRoom(userId)).emit('account:updated', view);
    }
  };

  const profileChanged = (userId: string) => {
    sendAccount(userId);
    hooks.onProfileChanged(userId);
  };

  return {
    middleware(socket, next) {
      const token = socket.handshake.auth?.token;
      if (token !== undefined && token !== null && token !== '') {
        const profile = accounts.authenticate(token);
        if (profile) {
          socket.data.userId = profile.id;
          socket.data.authToken = token as string;
        } else {
          invalidAtConnect.add(socket);
        }
      }
      next();
    },

    register(socket, handle, ip) {
      if (invalidAtConnect.has(socket)) {
        invalidAtConnect.delete(socket);
        socket.emit('auth:invalid', {});
      }
      if (socket.data.userId) {
        socket.join(userRoom(socket.data.userId));
        const view = accounts.view(socket.data.userId);
        if (view) {
          socket.emit('account:updated', view);
        }
      }

      /** Async handler: odpovie výsledkom, výnimku zaloguje a odpovie „Chyba servera“. */
      const on = <T>(event: string, run: (payload: unknown) => Ack<T> | Promise<Ack<T>>) => {
        handle<unknown>(event, (payload, ack) => {
          Promise.resolve()
            .then(() => run(payload))
            .then((result) => reply(ack, result))
            .catch((error: unknown) => {
              console.error(`Handler ${event} failed`, error);
              reply(ack, { ok: false, error: SERVER_ERROR });
            });
        });
      };

      /** Id prihláseného účtu s platným tokenom; inak spojenie odhlási a vráti undefined. */
      const currentUser = (): string | undefined => {
        if (!socket.data.userId) {
          return undefined;
        }
        const profile = accounts.authenticate(socket.data.authToken);
        if (!profile || profile.id !== socket.data.userId) {
          invalidate(socket);
          return undefined;
        }
        return profile.id;
      };

      const loggedIn = <T>(run: (userId: string, payload: unknown) => Ack<T> | Promise<Ack<T>>) => (payload: unknown) => {
        const userId = currentUser();
        return userId ? run(userId, payload) : ({ ok: false, error: NOT_LOGGED_IN } as Ack<T>);
      };

      const signedIn = (result: Ack<AuthSession>): Ack<AuthSession> => {
        if (result.ok && result.data) {
          setIdentity(socket, result.data.account.id, result.data.token);
        }
        return result;
      };

      on<AuthSession>('auth:register', async (payload) =>
        signedIn(await accounts.register(field(payload, 'email'), field(payload, 'username'), field(payload, 'password'), field(payload, 'passwordConfirm'), ip)),
      );

      on<AuthSession>('auth:login', async (payload) => signedIn(await accounts.login(field(payload, 'login'), field(payload, 'password'), ip)));

      on('auth:logout', () => {
        const userId = socket.data.userId;
        if (userId) {
          accounts.logout(socket.data.authToken);
          clearIdentity(socket);
          hooks.onLogout(socket.id);
          dropRevoked(userId, socket.id);
        }
        return { ok: true };
      });

      on<AccountView>(
        'auth:me',
        loggedIn((userId) => {
          const view = accounts.view(userId);
          return view ? { ok: true, data: view } : { ok: false, error: NOT_LOGGED_IN };
        }),
      );

      on<AccountView>('auth:verifyEmail', (payload) => {
        const result = accounts.verifyEmail(field(payload, 'token'));
        if (result.ok && result.data) {
          profileChanged(result.data.id);
        }
        return result;
      });

      on('auth:resendVerification', loggedIn((userId) => accounts.resendVerification(userId)));

      on<AccountView>(
        'auth:changeEmail',
        loggedIn(async (userId, payload) => {
          const result = await accounts.changeEmail(userId, field(payload, 'email'), field(payload, 'password'), ip);
          if (result.ok) {
            profileChanged(userId);
          }
          return result;
        }),
      );

      on('auth:forgotPassword', (payload) => accounts.forgotPassword(field(payload, 'login'), ip));

      on<AuthSession>('auth:resetPassword', async (payload) => {
        const result = signedIn(await accounts.resetPassword(field(payload, 'token'), field(payload, 'password'), field(payload, 'passwordConfirm')));
        if (result.ok && result.data) {
          const userId = result.data.account.id;
          dropRevoked(userId, socket.id);
          hooks.onSessionsRevoked(userId, socket.id);
        }
        return result;
      });

      on(
        'account:changePassword',
        loggedIn(async (userId, payload) => {
          const result = await accounts.changePassword(
            userId,
            socket.data.authToken,
            field(payload, 'currentPassword'),
            field(payload, 'password'),
            field(payload, 'passwordConfirm'),
            ip,
          );
          if (result.ok) {
            dropRevoked(userId, socket.id);
            hooks.onSessionsRevoked(userId, socket.id);
          }
          return result;
        }),
      );

      on<AccountView>(
        'account:update',
        loggedIn((userId, payload) => {
          const result = accounts.updateProfile(userId, { username: field(payload, 'username'), avatar: field(payload, 'avatar') });
          if (result.ok) {
            profileChanged(userId);
          }
          return result;
        }),
      );

      on<AccountView>(
        'account:deletePhoto',
        loggedIn((userId) => {
          const result = accounts.deletePhoto(userId);
          if (result.ok) {
            profileChanged(userId);
          }
          return result;
        }),
      );

      on<AccountStats>(
        'account:stats',
        loggedIn((userId) => {
          if (!accounts.profile(userId)?.emailVerified) {
            return { ok: false, error: NOT_VERIFIED };
          }
          const stats = accounts.stats(userId);
          return stats ? { ok: true, data: stats } : { ok: false, error: NOT_LOGGED_IN };
        }),
      );
    },

    httpRoutes(app) {
      const rawPhoto = express.raw({ type: [...PHOTO_MIME_TYPES], limit: PHOTO_MAX_BYTES });

      app.post('/api/account/photo', (request: Request, response: Response, next: NextFunction) => {
        const profile = accounts.authenticate(bearer(request.headers.authorization));
        if (!profile) {
          response.status(401).json({ ok: false, error: NOT_LOGGED_IN } satisfies Ack);
          return;
        }
        rawPhoto(request, response, (error?: unknown) => {
          try {
            if (error) {
              const tooLarge = (error as { type?: string }).type === 'entity.too.large';
              response.status(tooLarge ? 413 : 400).json({ ok: false, error: tooLarge ? 'Fotka je príliš veľká' : 'Fotku sa nepodarilo prijať' } satisfies Ack);
              return;
            }
            if (!Buffer.isBuffer(request.body)) {
              response.status(415).json({ ok: false, error: 'Fotka musí byť vo formáte WebP alebo JPEG' } satisfies Ack);
              return;
            }
            const result = accounts.setPhoto(profile.id, request.body, request.headers['content-type']);
            if (result.ok) {
              profileChanged(profile.id);
            }
            response.status(result.ok ? 200 : 400).json(result);
          } catch (caught) {
            next(caught);
          }
        });
      });

      app.get('/api/photos/:file', (request: Request, response: Response) => {
        const file = String(request.params.file ?? '');
        const target = PHOTO_FILE_PATTERN.test(file) ? accounts.photoPath(file) : undefined;
        if (!target) {
          response.status(404).end();
          return;
        }
        response.sendFile(
          target,
          {
            cacheControl: false,
            headers: {
              'Content-Type': photoMime(file),
              'X-Content-Type-Options': 'nosniff',
              // URL nesie verziu (`?v=`), nová fotka = nová adresa.
              'Cache-Control': 'public, max-age=31536000, immutable',
            },
          },
          (error) => {
            if (error && !response.headersSent) {
              response.status(404).end();
            }
          },
        );
      });
    },

    sendAccount,
  };
}
