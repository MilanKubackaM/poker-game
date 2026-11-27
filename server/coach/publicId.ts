import { createHmac, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const SECRET_FILE = 'coach-secret.key';

export interface PublicIds {
  /** Stále ID účtu pre coach API — rovnaké pri každom stole, neprezradí e-mail ani interné ID. */
  ofUser(userId: string): string;
  /** Miesto bez účtu (stoly spred účtov) — platí len pre daný stôl. */
  ofSeat(tableCode: string, playerId: string): string;
}

export function loadCoachSecret(dataDir: string): Buffer {
  const file = path.join(dataDir, SECRET_FILE);
  if (existsSync(file)) {
    const stored = Buffer.from(readFileSync(file, 'utf8').trim(), 'hex');
    if (stored.length === 32) {
      return stored;
    }
  }
  mkdirSync(dataDir, { recursive: true });
  const secret = randomBytes(32);
  writeFileSync(file, secret.toString('hex'), { mode: 0o600 });
  chmodSync(file, 0o600);
  return secret;
}

export function createPublicIds(secret: Buffer): PublicIds {
  const derive = (scope: string, value: string) => createHmac('sha256', secret).update(`${scope}:${value}`).digest('base64url').slice(0, 16);
  return {
    ofUser: (userId) => `u_${derive('user', userId)}`,
    ofSeat: (tableCode, playerId) => `s_${derive('seat', `${tableCode}:${playerId}`)}`,
  };
}
