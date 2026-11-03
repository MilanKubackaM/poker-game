/**
 * Checks that the web client served by a running Poker Night server is byte-for-byte the client built from this
 * source tree.
 *
 *   git checkout <commit you want to check> && npm ci && npm run build:client
 *   npx tsx tools/verify-client.ts https://poker.example.ts.net
 *
 * Every file of the local build (dist/client) is downloaded from the server and compared by SHA-256. The entry page
 * only loads scripts by their content-hashed names, so matching files mean the browser runs exactly this code.
 * Limitation: a server could in theory send different files to different visitors; this proves what it sent to you.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const base = process.argv[2]?.replace(/\/+$/, '');
if (!base) {
  console.error('Usage: npx tsx tools/verify-client.ts <https://server-url>');
  process.exit(2);
}
const root = path.resolve('dist/client');

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? files(full) : [full];
  });
}

const sha256 = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');

let local: string[];
try {
  local = files(root);
} catch {
  console.error('dist/client not found — run `npm ci && npm run build:client` first.');
  process.exit(2);
}

let mismatches = 0;
for (const file of local.sort()) {
  const relative = path.relative(root, file).split(path.sep).join('/');
  const response = await fetch(`${base}/${relative === 'index.html' ? '' : relative}`, { cache: 'no-store' });
  const served = new Uint8Array(await response.arrayBuffer());
  const expected = sha256(readFileSync(file));
  const actual = sha256(served);
  const ok = response.ok && expected === actual;
  mismatches += ok ? 0 : 1;
  console.log(`${ok ? 'OK      ' : 'MISMATCH'} ${relative}  ${actual}`);
}
console.log(mismatches ? `\n${mismatches} file(s) differ from this source tree.` : `\nAll ${local.length} files match this source tree.`);
process.exit(mismatches ? 1 : 0);
