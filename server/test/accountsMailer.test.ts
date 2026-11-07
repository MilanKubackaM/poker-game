import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OutboxMailer, encodeHeader, formatDate } from '../accounts/Mailer';

const dirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function outbox(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'outbox-'));
  dirs.push(dir);
  return dir;
}

function decodeWords(header: string): string {
  return header
    .split(/\r\n /)
    .map((word) => {
      const match = word.match(/^=\?UTF-8\?B\?([A-Za-z0-9+/=]+)\?=$/);
      return match ? Buffer.from(match[1], 'base64').toString('utf8') : word;
    })
    .join('');
}

describe('OutboxMailer', () => {
  it('zapíše .rcpt a .eml (bez dočasných súborov) s CRLF, zakódovaným predmetom a base64 telami', () => {
    const dir = outbox();
    const mailer = new OutboxMailer({ dir, from: 'Poker Night <poker@gmail.com>' });
    const subject = 'Obnovenie hesla — Poker Night a ešte dlhší predmet so ščťžýáíé znakmi';
    mailer.send('fero@example.com', subject, 'Ahoj Fero,\nodkaz: https://poker.test/reset?token=abc', '<p>Ahoj <b>Fero</b></p>');

    const files = readdirSync(dir).sort();
    expect(files).toHaveLength(2);
    expect(files.some((file) => file.includes('.tmp'))).toBe(false);
    const id = files[0].replace(/\.(eml|rcpt)$/, '');
    expect(files).toEqual([`${id}.eml`, `${id}.rcpt`]);
    expect(readFileSync(path.join(dir, `${id}.rcpt`), 'utf8')).toBe('fero@example.com\n');

    const message = readFileSync(path.join(dir, `${id}.eml`), 'utf8');
    expect(message.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
    const separator = message.indexOf('\r\n\r\n');
    const head = message.slice(0, separator);
    const body = message.slice(separator + 4);
    expect(head).toContain('From: "Poker Night" <poker@gmail.com>');
    expect(head).toContain('To: fero@example.com');
    expect(head).toMatch(/Date: \w{3}, \d{2} \w{3} \d{4} \d{2}:\d{2}:\d{2} \+0000/);
    expect(head).toMatch(new RegExp(`Message-ID: <${id}@gmail\\.com>`));
    expect(head).toContain('MIME-Version: 1.0');
    expect(head).toMatch(/Content-Type: multipart\/alternative; boundary="[^"]+"/);

    const subjectHeader = head.match(/Subject: ([\s\S]*?)\r\n(?! )/)?.[1] ?? '';
    expect(subjectHeader).toMatch(/^=\?UTF-8\?B\?/);
    for (const line of subjectHeader.split('\r\n')) {
      expect(line.length).toBeLessThanOrEqual(78);
    }
    expect(decodeWords(subjectHeader)).toBe(subject);

    expect(body).toContain('Content-Type: text/plain; charset=UTF-8');
    expect(body).toContain('Content-Type: text/html; charset=UTF-8');
    const parts = message.split(/--=_pn_[0-9a-f]+(?:--)?\r\n/).slice(1, 3);
    const decoded = parts.map((part) => Buffer.from(part.split('\r\n\r\n')[1].replace(/\r\n/g, ''), 'base64').toString('utf8'));
    expect(decoded[0]).toBe('Ahoj Fero,\r\nodkaz: https://poker.test/reset?token=abc');
    expect(decoded[1]).toBe('<p>Ahoj <b>Fero</b></p>');
  });

  it('bez outboxu vypíše e-mail do logu', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    new OutboxMailer({ dir: null }).send('a@b.sk', 'Predmet', 'Text s odkazom', '<p></p>');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Text s odkazom'));
    expect(log.mock.calls[0][0]).toContain('a@b.sk');
  });

  it('odmietne adresáta s riadiacimi znakmi (vloženie hlavičky)', () => {
    const mailer = new OutboxMailer({ dir: outbox() });
    expect(() => mailer.send('a@b.sk\r\nBcc: x@y.sk', 'S', 'T', 'H')).toThrow();
  });

  it('predmet bez diakritiky ostane čitateľný; dátum má číselnú zónu', () => {
    expect(encodeHeader('Poker Night')).toBe('Poker Night');
    expect(encodeHeader('a\r\nBcc: x')).toBe('a Bcc: x');
    expect(formatDate(new Date(Date.UTC(2026, 10, 7, 9, 5, 3)))).toBe('Sat, 07 Nov 2026 09:05:03 +0000');
  });

  it('zobrazované meno s diakritikou zakóduje', () => {
    const dir = outbox();
    new OutboxMailer({ dir, from: 'Pokrová noc <poker@gmail.com>' }).send('a@b.sk', 'S', 'T', 'H');
    const eml = readdirSync(dir).find((file) => file.endsWith('.eml'))!;
    const from = readFileSync(path.join(dir, eml), 'utf8').match(/From: (.*)\r\n/)?.[1] ?? '';
    expect(from).toMatch(/^=\?UTF-8\?B\?.+\?= <poker@gmail\.com>$/);
  });
});
