import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PHOTO_MAX_BYTES, RESET_TOKEN_TTL_MS, SESSION_TTL_MS, VERIFY_TOKEN_TTL_MS, type AccountTableStat } from '../../shared/account';
import { LIMITS } from '../limits';
import { ACCOUNT_ERRORS, AccountService, detectPhotoType } from '../accounts/AccountService';
import type { Mailer } from '../accounts/Mailer';
import { hashPassword, verifyPassword } from '../accounts/password';

interface SentMail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

class FakeMailer implements Mailer {
  readonly sent: SentMail[] = [];
  send(to: string, subject: string, text: string, html: string): void {
    this.sent.push({ to, subject, text, html });
  }
  last(): SentMail {
    return this.sent[this.sent.length - 1];
  }
  /** Token z odkazu `/verify?token=` alebo `/reset?token=` v poslednom e-maile. */
  token(kind: 'verify' | 'reset'): string {
    const match = this.last().text.match(new RegExp(`/${kind}\\?token=([0-9a-f]{64})`));
    if (!match) {
      throw new Error(`V e-maile nie je odkaz ${kind}`);
    }
    return match[1];
  }
}

const PASSWORD = 'tajne-heslo-1';
const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'accounts-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function setup(options: { dataDir?: string | null; publicUrl?: string } = {}) {
  const mailer = new FakeMailer();
  const clock = { now: 1_800_000_000_000 };
  const accounts = new AccountService({
    dataDir: options.dataDir ?? null,
    publicUrl: options.publicUrl ?? 'https://poker.test',
    mailer,
    now: () => clock.now,
    scryptN: 1024,
  });
  return { accounts, mailer, clock };
}

async function registered(accounts: AccountService, email = 'Fero@Example.com', username = 'Fero Mráz') {
  const result = await accounts.register(email, username, PASSWORD, PASSWORD, `ip-${email}`);
  if (!result.ok || !result.data) {
    throw new Error(result.error);
  }
  return result.data;
}

async function verified(accounts: AccountService, mailer: FakeMailer, email?: string, username?: string) {
  const session = await registered(accounts, email, username);
  expect(accounts.verifyEmail(mailer.token('verify')).ok).toBe(true);
  return session;
}

function stat(code: string, overrides: Partial<AccountTableStat> = {}): AccountTableStat {
  return {
    code,
    tableName: `Stôl ${code}`,
    currency: 'EUR',
    handsPlayed: 10,
    handsWon: 3,
    biggestPot: 500,
    deposited: 1000,
    withdrawn: 0,
    result: 200,
    lastPlayed: 1000,
    archived: false,
    deleted: false,
    ...overrides,
  };
}

const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBPVP8 '), Buffer.alloc(20)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(20)]);

describe('heslá', () => {
  it('scrypt hash má parametre v reťazci a overí sa len správne heslo', async () => {
    const stored = await hashPassword('abc', 1024);
    expect(stored).toMatch(/^scrypt\$1024\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    expect(await verifyPassword('abc', stored)).toBe(true);
    expect(await verifyPassword('abd', stored)).toBe(false);
    expect(await verifyPassword('abc', 'nezmysel')).toBe(false);
  });
});

describe('registrácia a prihlásenie', () => {
  it('zaregistruje účet (neoverený), pošle overovací e-mail a prihlási e-mailom aj menom bez ohľadu na veľkosť písmen', async () => {
    const { accounts, mailer } = setup({ publicUrl: 'https://poker.test/' });
    const session = await registered(accounts);
    expect(session.account).toMatchObject({ email: 'fero@example.com', username: 'Fero Mráz', emailVerified: false });
    expect(session.token).toMatch(/^[0-9a-f]{64}$/);
    expect(accounts.authenticate(session.token)?.id).toBe(session.account.id);
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.last()).toMatchObject({ to: 'fero@example.com', subject: 'Over svoj e-mail pre Poker Night' });
    expect(mailer.last().text).toContain('https://poker.test/verify?token=');
    expect(mailer.last().text).toContain('48 hodín');
    expect(mailer.last().text).toContain('Ak si to nebol ty, e-mail ignoruj');

    for (const login of ['FERO@example.COM', ' fero@example.com ', 'fero mráz', 'FERO   MRÁZ']) {
      const result = await accounts.login(login, PASSWORD);
      expect(result.ok, login).toBe(true);
      expect(result.data?.account.id).toBe(session.account.id);
    }
  });

  it('odmietne obsadený e-mail aj meno (bez ohľadu na veľkosť písmen)', async () => {
    const { accounts } = setup();
    await registered(accounts);
    expect(await accounts.register('FERO@example.com', 'Iné meno', PASSWORD, PASSWORD)).toEqual({ ok: false, error: ACCOUNT_ERRORS.emailTaken });
    expect(await accounts.register('iny@example.com', 'fero MRÁZ', PASSWORD, PASSWORD)).toEqual({ ok: false, error: ACCOUNT_ERRORS.usernameTaken });
  });

  it('overí vstupy na serveri', async () => {
    const { accounts } = setup();
    expect((await accounts.register('zly-email', 'Fero', PASSWORD, PASSWORD)).error).toBe('Neplatný e-mail');
    expect((await accounts.register('a@b.sk', 'Fe', PASSWORD, PASSWORD)).error).toContain('aspoň 3');
    expect((await accounts.register('a@b.sk', 'fero@x', PASSWORD, PASSWORD)).error).toContain('len písmená');
    expect((await accounts.register('a@b.sk', 'Fero', 'kratke', 'kratke')).error).toContain('aspoň 8');
    expect((await accounts.register('a@b.sk', 'Fero', PASSWORD, 'ine-heslo-1')).error).toBe('Heslá sa nezhodujú');
    expect((await accounts.register(42, { x: 1 }, null, undefined)).ok).toBe(false);
  });

  it('nesprávne heslo aj neexistujúci účet majú rovnakú chybu', async () => {
    const { accounts } = setup();
    await registered(accounts);
    expect(await accounts.login('fero@example.com', 'zle-heslo-123')).toEqual({ ok: false, error: ACCOUNT_ERRORS.invalidLogin });
    expect(await accounts.login('nikto@example.com', PASSWORD)).toEqual({ ok: false, error: ACCOUNT_ERRORS.invalidLogin });
    expect(await accounts.login('Nikto', PASSWORD)).toEqual({ ok: false, error: ACCOUNT_ERRORS.invalidLogin });
    expect(await accounts.login('', '')).toEqual({ ok: false, error: ACCOUNT_ERRORS.invalidLogin });
  });

  it('po priveľa nesprávnych heslách zablokuje účet aj IP na okno limitu', async () => {
    const { accounts, clock } = setup();
    await registered(accounts);
    for (let attempt = 0; attempt < LIMITS.loginFailuresPerAccount; attempt += 1) {
      await accounts.login('Fero Mráz', 'zle-heslo-123', `ip-${attempt}`);
    }
    expect(await accounts.login('Fero Mráz', PASSWORD, 'ip-nova')).toEqual({ ok: false, error: ACCOUNT_ERRORS.tooMany });
    clock.now += LIMITS.loginFailureWindowMs;
    expect((await accounts.login('Fero Mráz', PASSWORD, 'ip-nova')).ok).toBe(true);

    for (let attempt = 0; attempt < LIMITS.loginFailuresPerIp; attempt += 1) {
      await accounts.login(`nikto${attempt}`, 'zle-heslo-123', 'ip-utocnik');
    }
    expect(await accounts.login('Fero Mráz', PASSWORD, 'ip-utocnik')).toEqual({ ok: false, error: ACCOUNT_ERRORS.tooMany });
  });

  it('limit registrácií z jednej IP', async () => {
    const { accounts } = setup();
    for (let index = 0; index < LIMITS.registerPerIpHour; index += 1) {
      expect((await accounts.register(`hrac${index}@example.com`, `Hráč ${index}`, PASSWORD, PASSWORD, 'ip-1')).ok).toBe(true);
    }
    expect(await accounts.register('dalsi@example.com', 'Ďalší', PASSWORD, PASSWORD, 'ip-1')).toEqual({ ok: false, error: ACCOUNT_ERRORS.tooMany });
  });

  it('odhlásenie zruší token; prihlásenie vyprší po SESSION_TTL_MS nečinnosti a pri používaní sa predlžuje', async () => {
    const { accounts, clock } = setup();
    const session = await registered(accounts);
    const second = await accounts.login('Fero Mráz', PASSWORD);
    expect(accounts.logout(second.data?.token)).toBe(session.account.id);
    expect(accounts.authenticate(second.data?.token)).toBeUndefined();
    expect(accounts.logout('nezmysel')).toBeUndefined();

    clock.now += SESSION_TTL_MS - 1000;
    expect(accounts.authenticate(session.token)).toBeDefined();
    clock.now += SESSION_TTL_MS - 1000;
    expect(accounts.authenticate(session.token)).toBeDefined();
    clock.now += SESSION_TTL_MS + 1;
    expect(accounts.authenticate(session.token)).toBeUndefined();
  });

  it('drží najviac 20 prihlásení — najstaršie vypadne', async () => {
    const { accounts, clock } = setup();
    const first = await registered(accounts);
    for (let index = 0; index < 20; index += 1) {
      clock.now += 1000;
      await accounts.login('Fero Mráz', PASSWORD);
    }
    expect(accounts.authenticate(first.token)).toBeUndefined();
  });
});

describe('overenie e-mailu', () => {
  it('odkaz overí e-mail a dá sa použiť len raz', async () => {
    const { accounts, mailer } = setup();
    const session = await registered(accounts);
    const token = mailer.token('verify');
    const result = accounts.verifyEmail(token);
    expect(result.ok).toBe(true);
    expect(result.data?.emailVerified).toBe(true);
    expect(accounts.profile(session.account.id)?.emailVerified).toBe(true);
    expect(accounts.verifyEmail(token)).toEqual({ ok: false, error: ACCOUNT_ERRORS.invalidLink });
    expect(accounts.verifyEmail('x'.repeat(64))).toEqual({ ok: false, error: ACCOUNT_ERRORS.invalidLink });
    expect(accounts.resendVerification(session.account.id)).toEqual({ ok: false, error: ACCOUNT_ERRORS.alreadyVerified });
  });

  it('odkaz vyprší po 48 h', async () => {
    const { accounts, mailer, clock } = setup();
    await registered(accounts);
    clock.now += VERIFY_TOKEN_TTL_MS + 1;
    expect(accounts.verifyEmail(mailer.token('verify')).ok).toBe(false);
  });

  it('opätovné odoslanie zneplatní starý odkaz a má limit', async () => {
    const { accounts, mailer } = setup();
    const session = await registered(accounts);
    const old = mailer.token('verify');
    expect(accounts.resendVerification(session.account.id).ok).toBe(true);
    const fresh = mailer.token('verify');
    expect(fresh).not.toBe(old);
    expect(accounts.verifyEmail(old).ok).toBe(false);
    for (let index = 1; index < LIMITS.verifyMailsPerAccountHour; index += 1) {
      expect(accounts.resendVerification(session.account.id).ok).toBe(true);
    }
    expect(accounts.resendVerification(session.account.id)).toEqual({ ok: false, error: ACCOUNT_ERRORS.tooMany });
  });

  it('zmena e-mailu vyžaduje heslo, nová adresa je neoverená a starý odkaz neplatí', async () => {
    const { accounts, mailer } = setup();
    const session = await verified(accounts, mailer);
    await registered(accounts, 'druhy@example.com', 'Druhý');
    const id = session.account.id;
    expect(await accounts.changeEmail(id, 'novy@example.com', 'zle-heslo-123')).toEqual({ ok: false, error: ACCOUNT_ERRORS.wrongPassword });
    expect(await accounts.changeEmail(id, 'DRUHY@example.com', PASSWORD)).toEqual({ ok: false, error: ACCOUNT_ERRORS.emailTaken });
    expect(await accounts.changeEmail(id, 'fero@example.com', PASSWORD)).toEqual({ ok: false, error: ACCOUNT_ERRORS.sameEmail });
    expect((await accounts.changeEmail(id, 'zly', PASSWORD)).error).toBe('Neplatný e-mail');

    const changed = await accounts.changeEmail(id, 'Novy@Example.com', PASSWORD);
    expect(changed.data).toMatchObject({ email: 'novy@example.com', emailVerified: false });
    expect(mailer.last().to).toBe('novy@example.com');
    const link = mailer.token('verify');
    expect((await accounts.login('novy@example.com', PASSWORD)).ok).toBe(true);
    expect((await accounts.login('fero@example.com', PASSWORD)).ok).toBe(false);
    expect(accounts.verifyEmail(link).data?.emailVerified).toBe(true);
  });
});

describe('zabudnuté heslo', () => {
  it('neprezradí účet: neexistujúci aj neoverený dostanú rovnakú odpoveď a žiadny e-mail', async () => {
    const { accounts, mailer } = setup();
    await registered(accounts);
    const before = mailer.sent.length;
    expect(accounts.forgotPassword('nikto@example.com', 'ip-a')).toEqual({ ok: true });
    expect(accounts.forgotPassword('Fero Mráz', 'ip-b')).toEqual({ ok: true });
    expect(accounts.forgotPassword(undefined, 'ip-c')).toEqual({ ok: true });
    expect(mailer.sent).toHaveLength(before);
  });

  it('overený účet dostane jednorazový odkaz; nový odkaz zneplatní starý; reset zruší všetky prihlásenia', async () => {
    const { accounts, mailer } = setup();
    const session = await verified(accounts, mailer);
    const other = await accounts.login('Fero Mráz', PASSWORD);

    expect(accounts.forgotPassword('FERO MRÁZ', 'ip-1')).toEqual({ ok: true });
    expect(mailer.last()).toMatchObject({ to: 'fero@example.com', subject: 'Obnovenie hesla — Poker Night' });
    expect(mailer.last().text).toContain('https://poker.test/reset?token=');
    expect(mailer.last().text).toContain('1 hodinu');
    const old = mailer.token('reset');
    accounts.forgotPassword('fero@example.com', 'ip-1');
    const fresh = mailer.token('reset');

    expect(await accounts.resetPassword(old, 'nove-heslo-9', 'nove-heslo-9')).toEqual({ ok: false, error: ACCOUNT_ERRORS.invalidLink });
    expect((await accounts.resetPassword(fresh, 'nove-heslo-9', 'ine')).error).toBe('Heslá sa nezhodujú');
    const reset = await accounts.resetPassword(fresh, 'nove-heslo-9', 'nove-heslo-9');
    expect(reset.ok).toBe(true);
    expect(reset.data?.account.id).toBe(session.account.id);
    expect(accounts.authenticate(reset.data?.token)?.id).toBe(session.account.id);
    expect(accounts.authenticate(session.token)).toBeUndefined();
    expect(accounts.authenticate(other.data?.token)).toBeUndefined();
    expect((await accounts.login('Fero Mráz', PASSWORD)).ok).toBe(false);
    expect((await accounts.login('Fero Mráz', 'nove-heslo-9')).ok).toBe(true);
    expect((await accounts.resetPassword(fresh, 'ine-heslo-77', 'ine-heslo-77')).ok).toBe(false);
  });

  it('prihlásenie starým heslom počas resetu neprežije reset; zmena hesla počas resetu neprepíše nové heslo', async () => {
    const { accounts, mailer } = setup();
    const session = await verified(accounts, mailer);
    accounts.forgotPassword('Fero Mráz', 'ip-1');
    const [reset, login] = await Promise.all([
      accounts.resetPassword(mailer.token('reset'), 'nove-heslo-9', 'nove-heslo-9'),
      accounts.login('Fero Mráz', PASSWORD),
    ]);
    expect(reset.ok).toBe(true);
    // Podľa poradia dokončenia scryptu prihlásenie zlyhá, alebo jeho token zruší reset — platné prihlásenie nesmie ostať.
    expect(login.ok ? accounts.authenticate(login.data?.token) : undefined).toBeUndefined();

    accounts.forgotPassword('Fero Mráz', 'ip-2');
    const [secondReset] = await Promise.all([
      accounts.resetPassword(mailer.token('reset'), 'tretie-heslo-3', 'tretie-heslo-3'),
      accounts.changePassword(session.account.id, reset.data?.token, 'nove-heslo-9', 'utocnik-heslo', 'utocnik-heslo'),
    ]);
    expect(secondReset.ok).toBe(true);
    expect((await accounts.login('Fero Mráz', 'tretie-heslo-3')).ok).toBe(true);
    expect((await accounts.login('Fero Mráz', 'utocnik-heslo')).ok).toBe(false);
  });

  it('odkaz vyprší po hodine; overovací odkaz nejde použiť ako reset', async () => {
    const { accounts, mailer, clock } = setup();
    await registered(accounts);
    const verifyToken = mailer.token('verify');
    expect((await accounts.resetPassword(verifyToken, 'nove-heslo-9', 'nove-heslo-9')).ok).toBe(false);
    expect(accounts.verifyEmail(verifyToken).ok).toBe(true);
    accounts.forgotPassword('Fero Mráz', 'ip-1');
    clock.now += RESET_TOKEN_TTL_MS + 1;
    expect((await accounts.resetPassword(mailer.token('reset'), 'nove-heslo-9', 'nove-heslo-9')).ok).toBe(false);
  });

  it('limit na IP vráti chybu, limit na účet ticho nepošle e-mail', async () => {
    const { accounts, mailer } = setup();
    await verified(accounts, mailer);
    const before = mailer.sent.length;
    for (let index = 0; index < LIMITS.forgotPerAccountHour + 2; index += 1) {
      expect(accounts.forgotPassword('Fero Mráz', `ip-${index}`)).toEqual({ ok: true });
    }
    expect(mailer.sent.length - before).toBe(LIMITS.forgotPerAccountHour);
    for (let index = 0; index < LIMITS.forgotPerIpHour; index += 1) {
      accounts.forgotPassword('nikto', 'ip-x');
    }
    expect(accounts.forgotPassword('nikto', 'ip-x')).toEqual({ ok: false, error: ACCOUNT_ERRORS.tooMany });
  });
});

describe('zmena hesla a profilu', () => {
  it('zmena hesla vyžaduje súčasné heslo a nechá len aktuálne prihlásenie', async () => {
    const { accounts } = setup();
    const session = await registered(accounts);
    const other = await accounts.login('Fero Mráz', PASSWORD);
    const id = session.account.id;
    expect(await accounts.changePassword(id, session.token, 'zle-heslo-123', 'nove-heslo-9', 'nove-heslo-9')).toEqual({ ok: false, error: ACCOUNT_ERRORS.wrongPassword });
    expect((await accounts.changePassword(id, session.token, PASSWORD, 'nove-heslo-9', 'iné')).ok).toBe(false);
    expect(await accounts.changePassword(id, session.token, PASSWORD, 'nove-heslo-9', 'nove-heslo-9')).toEqual({ ok: true });
    expect(accounts.authenticate(session.token)?.id).toBe(id);
    expect(accounts.authenticate(other.data?.token)).toBeUndefined();
    expect((await accounts.login('Fero Mráz', 'nove-heslo-9')).ok).toBe(true);
  });

  it('zmena mena kontroluje jedinečnosť; vlastné meno s inou veľkosťou písmen je povolené', async () => {
    const { accounts } = setup();
    const session = await registered(accounts);
    await registered(accounts, 'druhy@example.com', 'Druhý');
    const id = session.account.id;
    expect(accounts.updateProfile(id, { username: 'DRUHÝ' })).toEqual({ ok: false, error: ACCOUNT_ERRORS.usernameTaken });
    expect(accounts.updateProfile(id, { username: 'x' }).ok).toBe(false);
    expect(accounts.updateProfile(id, { username: 'FERO mráz' }).data?.username).toBe('FERO mráz');
    expect(accounts.updateProfile(id, { username: '  Nové   meno ' }).data?.username).toBe('Nové meno');
    expect((await accounts.login('nové MENO', PASSWORD)).ok).toBe(true);
    expect((await accounts.login('Fero Mráz', PASSWORD)).ok).toBe(false);
    expect(accounts.profile(id)?.username).toBe('Nové meno');
  });

  it('avatar len z povolených emoji a farieb', async () => {
    const { accounts } = setup();
    const { account } = await registered(accounts);
    expect(accounts.updateProfile(account.id, { avatar: { emoji: '💩', color: '#e76f51' } })).toEqual({ ok: false, error: ACCOUNT_ERRORS.invalidAvatar });
    expect(accounts.updateProfile(account.id, { avatar: { emoji: '🃏', color: 'red' } }).ok).toBe(false);
    expect(accounts.updateProfile(account.id, { avatar: { emoji: '🃏', color: '#e76f51' } }).data?.avatar).toEqual({ emoji: '🃏', color: '#e76f51' });
  });
});

describe('profilová fotka', () => {
  it('rozpozná typ podľa obsahu', () => {
    expect(detectPhotoType(WEBP)).toBe('webp');
    expect(detectPhotoType(JPEG)).toBe('jpg');
    expect(detectPhotoType(Buffer.from('<svg></svg>'))).toBeNull();
    expect(detectPhotoType(Buffer.from('RIFF0000WAVE'))).toBeNull();
  });

  it('odmietne zlý formát, nesúlad s hlavičkou a priveľký súbor', async () => {
    const { accounts } = setup();
    const { account } = await registered(accounts);
    expect(accounts.setPhoto(account.id, Buffer.from('GIF89a........'), 'image/webp')).toEqual({ ok: false, error: ACCOUNT_ERRORS.photoFormat });
    expect(accounts.setPhoto(account.id, JPEG, 'image/webp')).toEqual({ ok: false, error: ACCOUNT_ERRORS.photoFormat });
    expect(accounts.setPhoto(account.id, JPEG, 'image/png')).toEqual({ ok: false, error: ACCOUNT_ERRORS.photoFormat });
    const big = Buffer.concat([JPEG, Buffer.alloc(PHOTO_MAX_BYTES)]);
    expect(accounts.setPhoto(account.id, big, 'image/jpeg')).toEqual({ ok: false, error: ACCOUNT_ERRORS.photoTooLarge });
  });

  it('uloží súbor, zvýši verziu, pri zmene typu zmaže starý a po zmazaní verzia ďalej rastie', async () => {
    const dataDir = tempDir();
    const { accounts } = setup({ dataDir });
    const { account } = await registered(accounts);
    const first = accounts.setPhoto(account.id, WEBP, 'image/webp');
    expect(first.data?.avatar.photo).toBe(`/api/photos/${account.id}.webp?v=1`);
    expect(accounts.profile(account.id)?.avatar.photo).toBe(`/api/photos/${account.id}.webp?v=1`);
    const webpPath = accounts.photoPath(`${account.id}.webp`);
    expect(webpPath && readFileSync(webpPath).equals(WEBP)).toBe(true);

    const second = accounts.setPhoto(account.id, JPEG, 'image/jpeg; charset=binary');
    expect(second.data?.avatar.photo).toBe(`/api/photos/${account.id}.jpg?v=2`);
    expect(existsSync(path.join(dataDir, 'photos', `${account.id}.webp`))).toBe(false);
    expect(accounts.photoPath(`${account.id}.webp`)).toBeUndefined();
    expect(accounts.photoPath(`${account.id}.jpg`)).toBe(path.join(dataDir, 'photos', `${account.id}.jpg`));
    expect(accounts.photoPath('../users.json')).toBeUndefined();

    expect(accounts.deletePhoto(account.id).data?.avatar.photo).toBeUndefined();
    expect(existsSync(path.join(dataDir, 'photos', `${account.id}.jpg`))).toBe(false);
    expect(accounts.setPhoto(account.id, JPEG).data?.avatar.photo).toBe(`/api/photos/${account.id}.jpg?v=3`);
  });

  it('limit nahratí za hodinu', async () => {
    const { accounts } = setup();
    const { account } = await registered(accounts);
    for (let index = 0; index < LIMITS.photoUploadsPerAccountHour; index += 1) {
      expect(accounts.setPhoto(account.id, JPEG).ok).toBe(true);
    }
    expect(accounts.setPhoto(account.id, JPEG)).toEqual({ ok: false, error: ACCOUNT_ERRORS.tooMany });
  });
});

describe('štatistiky', () => {
  it('ukladá štatistiku stolov, označí zmazané stoly a sčíta podľa meny (najnovšie prvé)', async () => {
    const { accounts } = setup();
    const fero = await registered(accounts);
    const druhy = await registered(accounts, 'druhy@example.com', 'Druhý');
    accounts.recordTableStat(fero.account.id, stat('AAAAAA', { lastPlayed: 100, result: 200, biggestPot: 500 }));
    accounts.recordTableStat(fero.account.id, stat('BBBBBB', { lastPlayed: 300, result: -50, biggestPot: 900, handsPlayed: 10, handsWon: 1 }));
    accounts.recordTableStat(fero.account.id, stat('CCCCCC', { lastPlayed: 200, currency: 'CZK', result: 5000, biggestPot: 2000 }));
    accounts.recordTableStat(druhy.account.id, stat('AAAAAA'));
    accounts.recordTableStat('neexistuje', stat('AAAAAA'));
    accounts.recordTableStat(fero.account.id, stat('AAAAAA', { lastPlayed: 100, result: 250, biggestPot: 500 }));

    accounts.markTableDeleted('AAAAAA');
    const stats = accounts.stats(fero.account.id);
    expect(stats?.tables.map((table) => table.code)).toEqual(['BBBBBB', 'CCCCCC', 'AAAAAA']);
    expect(stats?.tables[2]).toMatchObject({ result: 250, deleted: true });
    expect(stats?.global).toEqual({
      tables: 3,
      handsPlayed: 30,
      handsWon: 7,
      winRate: 23.3,
      biggestPot: { EUR: 900, CZK: 2000 },
      result: { EUR: 200, CZK: 5000 },
    });
    expect(accounts.stats(druhy.account.id)?.tables[0].deleted).toBe(true);
    expect(accounts.stats('neexistuje')).toBeUndefined();
  });
});

describe('perzistencia', () => {
  it('účty, prihlásenia, odkazy a štatistiky prežijú reštart', async () => {
    const dataDir = tempDir();
    const first = setup({ dataDir });
    const session = await registered(first.accounts);
    const verifyToken = first.mailer.token('verify');
    first.accounts.recordTableStat(session.account.id, stat('AAAAAA'));
    first.accounts.flush();
    expect(existsSync(path.join(dataDir, 'users.json.tmp'))).toBe(false);
    const raw = readFileSync(path.join(dataDir, 'users.json'), 'utf8');
    expect(raw).not.toContain(session.token);
    expect(raw).not.toContain(verifyToken);
    expect(raw).not.toContain(PASSWORD);

    const second = setup({ dataDir });
    expect(second.accounts.authenticate(session.token)?.id).toBe(session.account.id);
    expect((await second.accounts.login('fero mráz', PASSWORD)).ok).toBe(true);
    expect(second.accounts.verifyEmail(verifyToken).ok).toBe(true);
    expect(second.accounts.stats(session.account.id)?.tables).toHaveLength(1);
    expect(await second.accounts.register('fero@example.com', 'Iný', PASSWORD, PASSWORD)).toEqual({ ok: false, error: ACCOUNT_ERRORS.emailTaken });
  });

  it('poškodený súbor účtov zastaví štart namiesto prepísania', () => {
    const dataDir = tempDir();
    writeFileSync(path.join(dataDir, 'users.json'), '{ nie je json');
    expect(() => setup({ dataDir })).toThrow(/účtov/);
    expect(readFileSync(path.join(dataDir, 'users.json'), 'utf8')).toBe('{ nie je json');
  });
});
