import { randomBytes } from 'node:crypto';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** Odoslanie e-mailu. Volajúci posiela len overenú adresu (`validateEmail` vylúči CR/LF a medzery). */
export interface Mailer {
  send(to: string, subject: string, text: string, html: string): void;
}

export interface OutboxMailerOptions {
  /** Priečinok outboxu (predvolene `MAIL_OUTBOX_DIR`); bez neho sa správa len vypíše do logu. */
  dir?: string | null;
  /** Odosielateľ, napr. `Poker Night <x@gmail.com>` (predvolene `MAIL_FROM`). */
  from?: string;
}

const CRLF = '\r\n';
const DEFAULT_FROM = 'Poker Night <poker-night@localhost>';

/**
 * Pošta cez outbox: pre každú správu zapíše `<id>.rcpt` (adresát na jednom riadku) a potom `<id>.eml` (celá RFC 5322 správa).
 * Oba súbory vznikajú cez tmp + rename, takže sidecar (curl → Gmail SMTP), ktorý číta `*.eml`, nikdy nenájde polovičný súbor.
 * Bez outboxu (vývoj) vypíše adresáta, predmet a text do logu — odkaz z e-mailu je tak vidieť v konzole.
 */
export class OutboxMailer implements Mailer {
  private readonly dir: string | null;
  private readonly from: string;

  constructor(options: OutboxMailerOptions = {}) {
    this.dir = options.dir !== undefined ? options.dir : process.env.MAIL_OUTBOX_DIR?.trim() || null;
    const from = (options.from ?? process.env.MAIL_FROM ?? '').trim();
    this.from = from && !/[\r\n]/.test(from) ? from : DEFAULT_FROM;
    if (this.dir) {
      mkdirSync(this.dir, { recursive: true });
      if (!from) {
        console.warn(`MAIL_FROM nie je nastavené — odosielateľ bude ${DEFAULT_FROM}`);
      }
    }
  }

  send(to: string, subject: string, text: string, html: string): void {
    if (/[\r\n\s<>"]/.test(to)) {
      throw new Error('Neplatný adresát e-mailu');
    }
    if (!this.dir) {
      console.log(`[e-mail] Komu: ${to}\n[e-mail] Predmet: ${subject}\n${text}`);
      return;
    }
    const id = `${Date.now()}-${randomBytes(8).toString('hex')}`;
    const message = buildMessage({ id, from: this.from, to, subject, text, html, date: new Date() });
    writeAtomic(path.join(this.dir, `${id}.rcpt`), `${to}\n`);
    writeAtomic(path.join(this.dir, `${id}.eml`), message);
  }
}

function writeAtomic(target: string, content: string): void {
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, target);
}

export interface MessageParts {
  id: string;
  from: string;
  to: string;
  subject: string;
  text: string;
  html: string;
  date: Date;
}

/** Celá správa (multipart/alternative, UTF-8, base64 telá, CRLF konce riadkov). */
export function buildMessage(parts: MessageParts): string {
  const boundary = `=_pn_${randomBytes(12).toString('hex')}`;
  const headers = [
    `From: ${encodeAddress(parts.from)}`,
    `To: ${parts.to}`,
    `Subject: ${encodeHeader(parts.subject)}`,
    `Date: ${formatDate(parts.date)}`,
    `Message-ID: <${parts.id}@${domainOf(parts.from)}>`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ];
  const body = [
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64Lines(parts.text),
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64Lines(parts.html),
    `--${boundary}--`,
    '',
  ];
  return [...headers, '', ...body].join(CRLF);
}

function base64Lines(content: string): string {
  const encoded = Buffer.from(content.replace(/\r?\n/g, CRLF), 'utf8').toString('base64');
  return encoded.match(/.{1,76}/g)?.join(CRLF) ?? '';
}

/** RFC 2047: ASCII bez riadiacich znakov ostane, inak `=?UTF-8?B?…?=` po kúskoch (celé znaky, ≤ 75 znakov na slovo). */
export function encodeHeader(value: string): string {
  const clean = value.replace(/[\r\n]+/g, ' ');
  if (/^[\x20-\x7e]*$/.test(clean) && !clean.includes('=?')) {
    return clean;
  }
  const words: string[] = [];
  let chunk = '';
  for (const char of clean) {
    if (Buffer.byteLength(chunk + char, 'utf8') > 45) {
      words.push(chunk);
      chunk = '';
    }
    chunk += char;
  }
  if (chunk) {
    words.push(chunk);
  }
  return words.map((word) => `=?UTF-8?B?${Buffer.from(word, 'utf8').toString('base64')}?=`).join(`${CRLF} `);
}

/** `Meno <adresa>` — zobrazované meno s diakritikou sa zakóduje podľa RFC 2047. */
function encodeAddress(value: string): string {
  const match = value.match(/^\s*(.*?)\s*<([^<>\s]+)>\s*$/);
  if (!match) {
    return value;
  }
  const [, name, address] = match;
  if (!name) {
    return `<${address}>`;
  }
  const display = /^[\x20-\x7e]*$/.test(name) ? `"${name.replace(/^"|"$/g, '').replace(/["\\]/g, '')}"` : encodeHeader(name);
  return `${display} <${address}>`;
}

function domainOf(from: string): string {
  const address = from.match(/<([^<>\s]+)>/)?.[1] ?? from;
  const domain = address.split('@')[1]?.replace(/[^A-Za-z0-9.-]/g, '');
  return domain || 'localhost';
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** RFC 5322 dátum v UTC s číselnou zónou (`+0000`). */
export function formatDate(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${DAYS[date.getUTCDay()]}, ${pad(date.getUTCDate())} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} +0000`;
}
