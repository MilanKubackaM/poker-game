import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ACCEPTED_AVATAR_EMOJIS, AVATAR_COLORS } from '../../shared/constants';
import type { Ack, Avatar } from '../../shared/types';
import { PHOTO_MAX_BYTES, PHOTO_MIME_TYPES, RESET_TOKEN_TTL_MS, SESSION_TTL_MS, VERIFY_TOKEN_TTL_MS, aggregateStats, cleanEmail, cleanUsername, usernameKey, validateEmail, validatePassword, validateUsername, type AccountStats, type AccountTableStat, type AccountView, type AuthSession } from '../../shared/account';
import { LIMITS, WINDOWS, WindowCounter } from '../limits';
import type { AccountDirectory, AccountProfile } from './directory';
import { OutboxMailer, type Mailer } from './Mailer';
import { SCRYPT_DEFAULTS, hashPassword, hashToken, isTokenShape, randomToken, verifyPassword } from './password';
import { MAX_SESSIONS, UserStore, type OneTimeToken, type UserPhoto, type UserRecord } from './UserStore';

export interface AccountServiceOptions {
  /** Priečinok dát (`users.json`, `photos/`); null = len v pamäti (testy). */
  dataDir: string | null;
  /** Verejná adresa aplikácie pre odkazy v e-mailoch (napr. `https://poker.example.ts.net`). */
  publicUrl: string;
  mailer?: Mailer;
  /** Hodiny (testy). */
  now?: () => number;
  /** Cena scrypt (testy ju znížia, aby bežali rýchlo). */
  scryptN?: number;
}

export const ACCOUNT_ERRORS = {
  invalidLogin: 'Nesprávne prihlasovacie údaje',
  tooMany: 'Príliš veľa pokusov — skús to o chvíľu',
  wrongPassword: 'Nesprávne heslo',
  emailTaken: 'Účet s týmto e-mailom už existuje',
  usernameTaken: 'Toto hráčske meno už niekto používa',
  invalidLink: 'Odkaz je neplatný alebo už vypršal',
  noAccount: 'Účet neexistuje',
  alreadyVerified: 'E-mail je už overený',
  sameEmail: 'Toto je tvoj súčasný e-mail',
  invalidAvatar: 'Neplatný avatar',
  photoTooLarge: 'Fotka je príliš veľká',
  photoFormat: 'Fotka musí byť vo formáte WebP alebo JPEG',
} as const;

/** Sliding session: `lastSeenAt` sa zapisuje najviac raz za hodinu. */
const SESSION_TOUCH_MS = WINDOWS.HOUR;
const PHOTO_FILE_PATTERN = /^([0-9a-f-]{36})\.(webp|jpg)$/;

function fail<T>(error: string): Ack<T> {
  return { ok: false, error };
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char);
}

function hoursText(ms: number): string {
  const hours = Math.round(ms / WINDOWS.HOUR);
  if (hours === 1) {
    return '1 hodinu';
  }
  return hours >= 2 && hours <= 4 ? `${hours} hodiny` : `${hours} hodín`;
}

/** Typ fotky podľa obsahu (nie podľa hlavičky): WebP = `RIFF????WEBP`, JPEG = `FF D8 FF`. */
export function detectPhotoType(data: Buffer): UserPhoto['ext'] | null {
  if (data.length >= 12 && data.toString('latin1', 0, 4) === 'RIFF' && data.toString('latin1', 8, 12) === 'WEBP') {
    return 'webp';
  }
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return 'jpg';
  }
  return null;
}

const MIME_BY_EXT: Record<UserPhoto['ext'], string> = { webp: 'image/webp', jpg: 'image/jpeg' };

export function photoMime(file: string): string {
  return file.endsWith('.webp') ? MIME_BY_EXT.webp : MIME_BY_EXT.jpg;
}

/**
 * Účty hráčov: registrácia, prihlásenia, overenie e-mailu, obnovenie hesla, profil, fotka a štatistiky.
 * Metódy, ktoré prijímajú dáta od klienta, berú `unknown` a všetko overia samy; chyby vracajú ako `Ack` s textom pre hráča.
 * `ip` = kľúč klienta pre limity (`clientKey` z limits.ts).
 */
export class AccountService implements AccountDirectory {
  private readonly store: UserStore;
  private readonly mailer: Mailer;
  private readonly publicUrl: string;
  private readonly photosDir: string | null;
  private readonly now: () => number;
  private readonly scryptN: number;
  private dummyHash: Promise<string> | null = null;

  private readonly registerPerIp = new WindowCounter(LIMITS.registerPerIpHour, WINDOWS.HOUR);
  private readonly loginFailuresPerIp = new WindowCounter(LIMITS.loginFailuresPerIp, LIMITS.loginFailureWindowMs);
  private readonly loginFailuresPerAccount = new WindowCounter(LIMITS.loginFailuresPerAccount, LIMITS.loginFailureWindowMs);
  private readonly forgotPerIp = new WindowCounter(LIMITS.forgotPerIpHour, WINDOWS.HOUR);
  private readonly forgotPerAccount = new WindowCounter(LIMITS.forgotPerAccountHour, WINDOWS.HOUR);
  private readonly verifyMailsPerAccount = new WindowCounter(LIMITS.verifyMailsPerAccountHour, WINDOWS.HOUR);
  private readonly photoUploadsPerAccount = new WindowCounter(LIMITS.photoUploadsPerAccountHour, WINDOWS.HOUR);

  constructor(options: AccountServiceOptions) {
    this.store = new UserStore(options.dataDir);
    this.mailer = options.mailer ?? new OutboxMailer();
    this.publicUrl = options.publicUrl.trim().replace(/\/+$/, '');
    this.photosDir = options.dataDir ? path.join(options.dataDir, 'photos') : null;
    if (this.photosDir) {
      mkdirSync(this.photosDir, { recursive: true });
    }
    this.now = options.now ?? Date.now;
    this.scryptN = options.scryptN ?? SCRYPT_DEFAULTS.N;
    this.pruneAll();
  }

  // ——— registrácia a prihlásenie ———

  async register(email: unknown, username: unknown, password: unknown, passwordConfirm: unknown, ip = 'unknown'): Promise<Ack<AuthSession>> {
    const error = validateEmail(str(email)) ?? validateUsername(str(username)) ?? validatePassword(str(password), str(passwordConfirm));
    if (error) {
      return fail(error);
    }
    if (!this.registerPerIp.hit(ip, this.now())) {
      return fail(ACCOUNT_ERRORS.tooMany);
    }
    const cleanAddress = cleanEmail(str(email));
    const name = cleanUsername(str(username));
    const taken = this.uniquenessError(cleanAddress, name, null);
    if (taken) {
      return fail(taken);
    }
    const passwordHash = await hashPassword(str(password), this.scryptN);
    // Počas hashovania mohol rovnaký e-mail / meno zaregistrovať niekto iný.
    const takenNow = this.uniquenessError(cleanAddress, name, null);
    if (takenNow) {
      return fail(takenNow);
    }
    const now = this.now();
    const user: UserRecord = {
      id: randomUUID(),
      email: cleanAddress,
      emailVerified: false,
      username: name,
      passwordHash,
      avatar: this.randomAvatar(),
      photo: null,
      photoSeq: 0,
      createdAt: now,
      updatedAt: now,
      sessions: [],
      tokens: [],
      stats: {},
    };
    const token = this.addSession(user);
    const verifyToken = this.addOneTimeToken(user, 'verify', VERIFY_TOKEN_TTL_MS, user.email);
    this.store.insert(user);
    this.sendVerification(user, verifyToken);
    return { ok: true, data: { token, account: this.viewOf(user) } };
  }

  /** `login` obsahuje @ → e-mail, inak hráčske meno (bez ohľadu na veľkosť písmen). */
  async login(login: unknown, password: unknown, ip = 'unknown'): Promise<Ack<AuthSession>> {
    const loginText = str(login).trim();
    const passwordText = str(password);
    if (!loginText || !passwordText) {
      return fail(ACCOUNT_ERRORS.invalidLogin);
    }
    const user = this.findByLogin(loginText);
    const accountKey = user?.id ?? `login:${loginText.includes('@') ? cleanEmail(loginText) : usernameKey(loginText)}`;
    const now = this.now();
    if (!this.loginFailuresPerIp.allows(ip, now) || !this.loginFailuresPerAccount.allows(accountKey, now)) {
      return fail(ACCOUNT_ERRORS.tooMany);
    }
    // Neexistujúci účet: rovnako drahý výpočet, aby čas odpovede neprezradil, či účet existuje.
    const hashBefore = user?.passwordHash;
    let valid = false;
    if (user && hashBefore) {
      valid = await verifyPassword(passwordText, hashBefore);
    } else {
      await verifyPassword(passwordText, await this.dummy());
    }
    // Heslo sa mohlo počas overovania zmeniť (reset) — prihlásenie starým heslom by prežilo zrušenie prihlásení.
    const current = user && this.store.get(user.id);
    if (!valid || !current || current.passwordHash !== hashBefore) {
      this.loginFailuresPerIp.add(ip, this.now());
      this.loginFailuresPerAccount.add(accountKey, this.now());
      return fail(ACCOUNT_ERRORS.invalidLogin);
    }
    const token = this.addSession(current);
    this.store.update(current, true);
    return { ok: true, data: { token, account: this.viewOf(current) } };
  }

  /** Profil prihláseného účtu podľa tokenu, alebo undefined (neplatný / expirovaný / odhlásený). */
  authenticate(token: unknown): AccountProfile | undefined {
    const user = this.userForSession(token);
    return user && this.profileOf(user);
  }

  /** Zruší prihlásenie; vráti id účtu, ak token platil. */
  logout(token: unknown): string | undefined {
    const user = this.userForSession(token);
    if (!user) {
      return undefined;
    }
    const hash = hashToken(token as string);
    user.sessions = user.sessions.filter((session) => session.hash !== hash);
    this.store.update(user, true);
    return user.id;
  }

  // ——— overenie e-mailu ———

  /** Odkaz z overovacieho e-mailu (funguje aj bez prihlásenia). */
  verifyEmail(token: unknown): Ack<AccountView> {
    const found = this.consumeToken(token, 'verify');
    if (!found) {
      return fail(ACCOUNT_ERRORS.invalidLink);
    }
    const { user, entry } = found;
    if (entry.email !== user.email) {
      this.store.update(user, true);
      return fail(ACCOUNT_ERRORS.invalidLink);
    }
    user.emailVerified = true;
    user.tokens = user.tokens.filter((item) => item.kind !== 'verify');
    user.updatedAt = this.now();
    this.store.update(user, true);
    return { ok: true, data: this.viewOf(user) };
  }

  resendVerification(userId: string): Ack {
    const user = this.store.get(userId);
    if (!user) {
      return fail(ACCOUNT_ERRORS.noAccount);
    }
    if (user.emailVerified) {
      return fail(ACCOUNT_ERRORS.alreadyVerified);
    }
    if (!this.verifyMailsPerAccount.hit(user.id, this.now())) {
      return fail(ACCOUNT_ERRORS.tooMany);
    }
    user.tokens = user.tokens.filter((item) => item.kind !== 'verify');
    const token = this.addOneTimeToken(user, 'verify', VERIFY_TOKEN_TTL_MS, user.email);
    this.store.update(user, true);
    this.sendVerification(user, token);
    return { ok: true };
  }

  /** Zmena e-mailu (so súčasným heslom): nová adresa je neoverená a odíde na ňu overovací e-mail. */
  async changeEmail(userId: string, email: unknown, password: unknown, ip = 'unknown'): Promise<Ack<AccountView>> {
    const user = this.store.get(userId);
    if (!user) {
      return fail(ACCOUNT_ERRORS.noAccount);
    }
    const error = validateEmail(str(email));
    if (error) {
      return fail(error);
    }
    const address = cleanEmail(str(email));
    if (address === user.email) {
      return fail(ACCOUNT_ERRORS.sameEmail);
    }
    const hashBefore = user.passwordHash;
    const checked = await this.checkPassword(user, password, ip);
    if (checked) {
      return fail(checked);
    }
    if (user.passwordHash !== hashBefore || !this.store.get(user.id)) {
      return fail(ACCOUNT_ERRORS.wrongPassword);
    }
    const taken = this.uniquenessError(address, null, user.id);
    if (taken) {
      return fail(taken);
    }
    if (!this.verifyMailsPerAccount.hit(user.id, this.now())) {
      return fail(ACCOUNT_ERRORS.tooMany);
    }
    user.email = address;
    user.emailVerified = false;
    user.tokens = [];
    user.updatedAt = this.now();
    const token = this.addOneTimeToken(user, 'verify', VERIFY_TOKEN_TTL_MS, address);
    this.store.update(user, true);
    this.sendVerification(user, token);
    return { ok: true, data: this.viewOf(user) };
  }

  // ——— heslo ———

  /**
   * Zabudnuté heslo: odkaz ide len na overený e-mail. Odpoveď je vždy rovnaká (neprezradí, či účet existuje);
   * chybu vráti iba pri prekročení limitu na IP.
   */
  forgotPassword(login: unknown, ip = 'unknown'): Ack {
    const now = this.now();
    if (!this.forgotPerIp.hit(ip, now)) {
      return fail(ACCOUNT_ERRORS.tooMany);
    }
    const loginText = str(login).trim();
    const user = loginText ? this.findByLogin(loginText) : undefined;
    if (!user || !user.emailVerified || !this.forgotPerAccount.hit(user.id, now)) {
      return { ok: true };
    }
    user.tokens = user.tokens.filter((item) => item.kind !== 'reset');
    const token = this.addOneTimeToken(user, 'reset', RESET_TOKEN_TTL_MS);
    this.store.update(user, true);
    const link = `${this.publicUrl}/reset?token=${token}`;
    const validity = hoursText(RESET_TOKEN_TTL_MS);
    const text = [
      `Ahoj ${user.username},`,
      '',
      'niekto požiadal o obnovenie hesla k tvojmu účtu v Poker Night. Nové heslo si nastavíš cez tento odkaz:',
      link,
      '',
      `Odkaz platí ${validity} a dá sa použiť len raz. Ak si to nebol ty, e-mail ignoruj — heslo ostane bez zmeny.`,
      '',
      'Poker Night',
    ].join('\n');
    const html = this.mailHtml(user.username, 'niekto požiadal o obnovenie hesla k tvojmu účtu v Poker Night.', link, 'Nastaviť nové heslo', `Odkaz platí ${validity} a dá sa použiť len raz. Ak si to nebol ty, e-mail ignoruj — heslo ostane bez zmeny.`);
    this.deliver(user.email, 'Obnovenie hesla — Poker Night', text, html);
    return { ok: true };
  }

  /** Nové heslo z odkazu: zruší všetky prihlásenia a vráti nové. Overí aj e-mail (odkaz prišiel na overenú adresu). */
  async resetPassword(token: unknown, password: unknown, passwordConfirm: unknown): Promise<Ack<AuthSession>> {
    const error = validatePassword(str(password), str(passwordConfirm));
    if (error) {
      return fail(error);
    }
    const found = this.consumeToken(token, 'reset');
    if (!found) {
      return fail(ACCOUNT_ERRORS.invalidLink);
    }
    this.store.update(found.user, true);
    const passwordHash = await hashPassword(str(password), this.scryptN);
    const user = this.store.get(found.user.id);
    if (!user) {
      return fail(ACCOUNT_ERRORS.invalidLink);
    }
    user.passwordHash = passwordHash;
    user.sessions = [];
    user.tokens = user.tokens.filter((item) => item.kind !== 'reset');
    user.updatedAt = this.now();
    const session = this.addSession(user);
    this.store.update(user, true);
    return { ok: true, data: { token: session, account: this.viewOf(user) } };
  }

  /** Zmena hesla so súčasným heslom; ostane len prihlásenie `currentToken`, ostatné sa zrušia. */
  async changePassword(userId: string, currentToken: unknown, currentPassword: unknown, password: unknown, passwordConfirm: unknown, ip = 'unknown'): Promise<Ack> {
    const user = this.store.get(userId);
    if (!user) {
      return fail(ACCOUNT_ERRORS.noAccount);
    }
    const error = validatePassword(str(password), str(passwordConfirm));
    if (error) {
      return fail(error);
    }
    const hashBefore = user.passwordHash;
    const checked = await this.checkPassword(user, currentPassword, ip);
    if (checked) {
      return fail(checked);
    }
    const passwordHash = await hashPassword(str(password), this.scryptN);
    // Súbežný reset / iná zmena hesla má prednosť — neprepíšeme ju heslom overeným voči starému hashu.
    if (user.passwordHash !== hashBefore || !this.store.get(user.id)) {
      return fail(ACCOUNT_ERRORS.wrongPassword);
    }
    const keep = isTokenShape(currentToken) ? hashToken(currentToken) : '';
    user.passwordHash = passwordHash;
    user.sessions = user.sessions.filter((session) => session.hash === keep);
    user.tokens = user.tokens.filter((item) => item.kind !== 'reset');
    user.updatedAt = this.now();
    this.store.update(user, true);
    return { ok: true };
  }

  // ——— profil ———

  /** Zmena hráčskeho mena a/alebo emoji avatara (fotka sa mení zvlášť). */
  updateProfile(userId: string, changes: { username?: unknown; avatar?: unknown }): Ack<AccountView> {
    const user = this.store.get(userId);
    if (!user) {
      return fail(ACCOUNT_ERRORS.noAccount);
    }
    let username = user.username;
    if (changes.username !== undefined) {
      const error = validateUsername(str(changes.username));
      if (error) {
        return fail(error);
      }
      username = cleanUsername(str(changes.username));
      const taken = this.uniquenessError(null, username, user.id);
      if (taken) {
        return fail(taken);
      }
    }
    let avatar = user.avatar;
    if (changes.avatar !== undefined) {
      const parsed = parseAvatar(changes.avatar);
      if (!parsed) {
        return fail(ACCOUNT_ERRORS.invalidAvatar);
      }
      avatar = parsed;
    }
    if (username !== user.username || avatar.emoji !== user.avatar.emoji || avatar.color !== user.avatar.color) {
      user.username = username;
      user.avatar = avatar;
      user.updatedAt = this.now();
      this.store.update(user, true);
    }
    return { ok: true, data: this.viewOf(user) };
  }

  /** Nová profilová fotka (typ podľa obsahu, musí sedieť s hlavičkou `mime`, ak je zadaná). */
  setPhoto(userId: string, data: Buffer, mime?: string): Ack<AccountView> {
    const user = this.store.get(userId);
    if (!user) {
      return fail(ACCOUNT_ERRORS.noAccount);
    }
    if (data.length > PHOTO_MAX_BYTES) {
      return fail(ACCOUNT_ERRORS.photoTooLarge);
    }
    const ext = detectPhotoType(data);
    const declared = mime?.split(';')[0].trim().toLowerCase();
    if (!ext || (declared !== undefined && (!(PHOTO_MIME_TYPES as readonly string[]).includes(declared) || MIME_BY_EXT[ext] !== declared))) {
      return fail(ACCOUNT_ERRORS.photoFormat);
    }
    if (!this.photoUploadsPerAccount.hit(user.id, this.now())) {
      return fail(ACCOUNT_ERRORS.tooMany);
    }
    const previous = user.photo;
    if (this.photosDir) {
      const target = path.join(this.photosDir, `${user.id}.${ext}`);
      const tmp = `${target}.tmp`;
      writeFileSync(tmp, data);
      renameSync(tmp, target);
      if (previous && previous.ext !== ext) {
        this.removePhotoFile(user.id, previous.ext);
      }
    }
    user.photoSeq += 1;
    user.photo = { ext, version: user.photoSeq };
    user.updatedAt = this.now();
    this.store.update(user, true);
    return { ok: true, data: this.viewOf(user) };
  }

  deletePhoto(userId: string): Ack<AccountView> {
    const user = this.store.get(userId);
    if (!user) {
      return fail(ACCOUNT_ERRORS.noAccount);
    }
    if (user.photo) {
      this.removePhotoFile(user.id, user.photo.ext);
      user.photo = null;
      user.updatedAt = this.now();
      this.store.update(user, true);
    }
    return { ok: true, data: this.viewOf(user) };
  }

  /** Absolútna cesta k aktuálnej fotke účtu podľa názvu súboru z URL, alebo undefined. */
  photoPath(file: string): string | undefined {
    const match = PHOTO_FILE_PATTERN.exec(file);
    if (!match || !this.photosDir) {
      return undefined;
    }
    const user = this.store.get(match[1]);
    if (!user?.photo || user.photo.ext !== match[2]) {
      return undefined;
    }
    const target = path.join(this.photosDir, file);
    return existsSync(target) ? target : undefined;
  }

  view(userId: string): AccountView | undefined {
    const user = this.store.get(userId);
    return user && this.viewOf(user);
  }

  stats(userId: string): AccountStats | undefined {
    const user = this.store.get(userId);
    if (!user) {
      return undefined;
    }
    const tables = Object.values(user.stats).sort((a, b) => b.lastPlayed - a.lastPlayed);
    return { global: aggregateStats(tables), tables };
  }

  // ——— AccountDirectory (pre stoly) ———

  profile(userId: string): AccountProfile | undefined {
    const user = this.store.get(userId);
    return user && this.profileOf(user);
  }

  recordTableStat(userId: string, stat: AccountTableStat): void {
    const user = this.store.get(userId);
    if (!user) {
      return;
    }
    const previous = user.stats[stat.code];
    if (previous && JSON.stringify(previous) === JSON.stringify(stat)) {
      return;
    }
    user.stats[stat.code] = { ...stat };
    this.store.update(user);
  }

  markTableDeleted(code: string): void {
    for (const user of this.store.all()) {
      const stat = user.stats[code];
      if (stat && !stat.deleted) {
        user.stats[code] = { ...stat, deleted: true };
        this.store.update(user);
      }
    }
  }

  /** Okamžite zapíše zmeny (pri vypínaní servera). */
  flush(): void {
    this.store.flush();
  }

  // ——— interné ———

  private viewOf(user: UserRecord): AccountView {
    return {
      id: user.id,
      username: user.username,
      email: user.email,
      emailVerified: user.emailVerified,
      avatar: this.avatarOf(user),
      createdAt: user.createdAt,
    };
  }

  private profileOf(user: UserRecord): AccountProfile {
    return { id: user.id, username: user.username, avatar: this.avatarOf(user), emailVerified: user.emailVerified };
  }

  private avatarOf(user: UserRecord): Avatar {
    const avatar: Avatar = { emoji: user.avatar.emoji, color: user.avatar.color };
    if (user.photo) {
      avatar.photo = `/api/photos/${user.id}.${user.photo.ext}?v=${user.photo.version}`;
    }
    return avatar;
  }

  private randomAvatar(): Avatar {
    const pick = <T>(items: readonly T[]): T => items[Math.floor(Math.random() * items.length)];
    return { emoji: pick(ACCEPTED_AVATAR_EMOJIS), color: pick(AVATAR_COLORS) };
  }

  private findByLogin(login: string): UserRecord | undefined {
    return login.includes('@') ? this.store.byEmailAddress(login) : this.store.byName(login);
  }

  /** Chyba jedinečnosti e-mailu / mena (null = voľné); `selfId` = vlastný účet sa nepočíta. */
  private uniquenessError(email: string | null, username: string | null, selfId: string | null): string | null {
    const byEmail = email !== null ? this.store.byEmailAddress(email) : undefined;
    if (byEmail && byEmail.id !== selfId) {
      return ACCOUNT_ERRORS.emailTaken;
    }
    const byName = username !== null ? this.store.byName(username) : undefined;
    if (byName && byName.id !== selfId) {
      return ACCOUNT_ERRORS.usernameTaken;
    }
    return null;
  }

  /** Overí súčasné heslo s limitom nesprávnych pokusov; vráti chybu alebo null. */
  private async checkPassword(user: UserRecord, password: unknown, ip: string): Promise<string | null> {
    const now = this.now();
    if (!this.loginFailuresPerIp.allows(ip, now) || !this.loginFailuresPerAccount.allows(user.id, now)) {
      return ACCOUNT_ERRORS.tooMany;
    }
    const stored = user.passwordHash;
    if (await verifyPassword(str(password), stored)) {
      return null;
    }
    this.loginFailuresPerIp.add(ip, this.now());
    this.loginFailuresPerAccount.add(user.id, this.now());
    return ACCOUNT_ERRORS.wrongPassword;
  }

  private dummy(): Promise<string> {
    this.dummyHash ??= hashPassword(randomToken(), this.scryptN);
    return this.dummyHash;
  }

  private addSession(user: UserRecord): string {
    const token = randomToken();
    const now = this.now();
    user.sessions.push({ hash: hashToken(token), createdAt: now, lastSeenAt: now });
    if (user.sessions.length > MAX_SESSIONS) {
      user.sessions.sort((a, b) => a.lastSeenAt - b.lastSeenAt);
      user.sessions.splice(0, user.sessions.length - MAX_SESSIONS);
    }
    return token;
  }

  private addOneTimeToken(user: UserRecord, kind: OneTimeToken['kind'], ttl: number, email?: string): string {
    const token = randomToken();
    const entry: OneTimeToken = { kind, hash: hashToken(token), expiresAt: this.now() + ttl };
    if (email !== undefined) {
      entry.email = email;
    }
    user.tokens.push(entry);
    return token;
  }

  /** Účet platného prihlásenia; expirované prihlásenie zahodí, živé posunie (sliding, najviac raz za hodinu). */
  private userForSession(token: unknown): UserRecord | undefined {
    if (!isTokenShape(token)) {
      return undefined;
    }
    const hash = hashToken(token);
    const user = this.store.bySessionHash(hash);
    const session = user?.sessions.find((item) => item.hash === hash);
    if (!user || !session) {
      return undefined;
    }
    const now = this.now();
    if (now - session.lastSeenAt > SESSION_TTL_MS) {
      user.sessions = user.sessions.filter((item) => item !== session);
      this.store.update(user);
      return undefined;
    }
    if (now - session.lastSeenAt > SESSION_TOUCH_MS) {
      session.lastSeenAt = now;
      this.store.update(user);
    }
    return user;
  }

  /** Nájde a odstráni jednorazový token daného druhu (expirovaný sa odstráni, ale vráti undefined). Zápis robí volajúci. */
  private consumeToken(token: unknown, kind: OneTimeToken['kind']): { user: UserRecord; entry: OneTimeToken } | undefined {
    if (!isTokenShape(token)) {
      return undefined;
    }
    const hash = hashToken(token);
    const user = this.store.byTokenHash(hash);
    const entry = user?.tokens.find((item) => item.hash === hash);
    if (!user || !entry) {
      return undefined;
    }
    if (entry.kind !== kind) {
      return undefined;
    }
    const now = this.now();
    user.tokens = user.tokens.filter((item) => item !== entry && item.expiresAt > now);
    if (entry.expiresAt <= now) {
      this.store.update(user, true);
      return undefined;
    }
    return { user, entry };
  }

  /** Pri štarte zahodí expirované prihlásenia a odkazy. */
  private pruneAll(): void {
    const now = this.now();
    for (const user of this.store.all()) {
      const sessions = user.sessions.filter((session) => now - session.lastSeenAt <= SESSION_TTL_MS);
      const tokens = user.tokens.filter((token) => token.expiresAt > now);
      if (sessions.length !== user.sessions.length || tokens.length !== user.tokens.length) {
        user.sessions = sessions;
        user.tokens = tokens;
        this.store.update(user);
      }
    }
  }

  private removePhotoFile(userId: string, ext: UserPhoto['ext']): void {
    if (!this.photosDir) {
      return;
    }
    rmSync(path.join(this.photosDir, `${userId}.${ext}`), { force: true });
  }

  private sendVerification(user: UserRecord, token: string): void {
    const link = `${this.publicUrl}/verify?token=${token}`;
    const validity = hoursText(VERIFY_TOKEN_TTL_MS);
    const text = [
      `Ahoj ${user.username},`,
      '',
      'vitaj v Poker Night! Pred prvou hrou ešte over svoj e-mail kliknutím na tento odkaz:',
      link,
      '',
      `Odkaz platí ${validity}. Ak si to nebol ty, e-mail ignoruj.`,
      '',
      'Poker Night',
    ].join('\n');
    const html = this.mailHtml(user.username, 'vitaj v Poker Night! Pred prvou hrou ešte over svoj e-mail kliknutím na tlačidlo.', link, 'Overiť e-mail', `Odkaz platí ${validity}. Ak si to nebol ty, e-mail ignoruj.`);
    this.deliver(user.email, 'Over svoj e-mail pre Poker Night', text, html);
  }

  private mailHtml(username: string, intro: string, link: string, button: string, footer: string): string {
    const safeLink = escapeHtml(link);
    return [
      '<!doctype html><html lang="sk"><body style="font-family:system-ui,sans-serif;color:#1d2a24;line-height:1.5">',
      `<p>Ahoj ${escapeHtml(username)},</p>`,
      `<p>${escapeHtml(intro)}</p>`,
      `<p><a href="${safeLink}" style="display:inline-block;padding:10px 18px;background:#1f7a4d;color:#fff;border-radius:8px;text-decoration:none">${escapeHtml(button)}</a></p>`,
      `<p style="font-size:13px;color:#555">Ak tlačidlo nefunguje, skopíruj do prehliadača:<br>${safeLink}</p>`,
      `<p style="font-size:13px;color:#555">${escapeHtml(footer)}</p>`,
      '<p>Poker Night</p>',
      '</body></html>',
    ].join('\n');
  }

  /** Chyba pošty nezhodí požiadavku — e-mail sa dá poslať znova. */
  private deliver(to: string, subject: string, text: string, html: string): void {
    try {
      this.mailer.send(to, subject, text, html);
    } catch (error) {
      console.error(`E-mail pre ${to} sa nepodarilo pripraviť`, error);
    }
  }
}

function parseAvatar(value: unknown): Avatar | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const { emoji, color } = value as Record<string, unknown>;
  if (typeof emoji !== 'string' || typeof color !== 'string' || !ACCEPTED_AVATAR_EMOJIS.includes(emoji) || !AVATAR_COLORS.includes(color)) {
    return null;
  }
  return { emoji, color };
}
