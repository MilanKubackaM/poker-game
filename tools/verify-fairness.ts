/**
 * Independent verifier for Poker Night's provably fair shuffle.
 *
 *   npx tsx tools/verify-fairness.ts poker-fairness-ABC123-2026-11-03.json
 *
 * The input is the file a player downloads in the app (Statistics → History → "Stiahnuť dôkazy"). It contains what the
 * player's own browser recorded before revealing its seed, plus the server's proofs. Nothing is fetched from the server.
 * Exit code 0 = every revealed hand verified, 1 = at least one problem, 2 = unreadable input.
 */
import { readFileSync } from 'node:fs';
import type { FairExport } from '../shared/fairness';
import { verifyExport } from '../server/poker/fairVerify';

const file = process.argv[2];
if (!file) {
  console.error('Usage: npx tsx tools/verify-fairness.ts <exported-file.json>');
  process.exit(2);
}

let report;
try {
  report = verifyExport(JSON.parse(readFileSync(file, 'utf8')) as FairExport);
} catch (error) {
  console.error(`Cannot verify ${file}: ${(error as Error).message}`);
  process.exit(2);
}

console.log(`Table ${report.table}, player ${report.playerId}`);
for (const hand of report.hands) {
  const label = { verified: 'OK     ', failed: 'FAILED ', pending: 'PENDING', 'checked-without-local-record': 'SEEDS OK' }[hand.status];
  console.log(`${label} hand #${hand.handNumber} (round ${hand.roundId})`);
  for (const problem of hand.problems) {
    console.log(`        ✗ ${problem}`);
  }
  for (const note of hand.notes) {
    console.log(`        · ${note}`);
  }
}
for (const line of report.general) {
  console.log(`NOTE    ${line}`);
}
const { verified, failed, pending, withoutRecord, discardedRounds, missingProofs } = report.summary;
console.log(
  `\n${verified} hands fully verified, ${withoutRecord} checked without your local record, ${pending} waiting for the server seed, ${failed} failed, ${discardedRounds} discarded rounds, ${missingProofs} hands without a proof.`,
);
if (pending) {
  console.log('Server seeds are published when the game ends (table back in the lobby) or 30 minutes after the last hand — export again later.');
}
process.exit(failed || discardedRounds || missingProofs ? 1 : 0);
