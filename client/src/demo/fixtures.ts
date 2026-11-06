import type { Avatar, Card, DepartedMemberView, DrawView, ModeIntroView, PiggyView, HandHistoryEntry, HandHistoryWinner, HandView, LeaderboardRow, LedgerEntry, MyHandRecord, SeatPlayerView, TableEvent, TableSummary, TableView, Variant } from '../../../shared/types';
import { DEFAULT_SETTINGS } from '../../../shared/constants';

const base = (overrides: Partial<SeatPlayerView> & Pick<SeatPlayerView, 'id' | 'name' | 'seat' | 'avatar'>): SeatPlayerView => ({
  stack: 2000,
  timeBankMs: 50_000,
  connected: true,
  sittingOut: false,
  away: false,
  missedBlinds: 'none',
  returnMode: null,
  isHost: false,
  camera: false,
  microphone: false,
  rtcId: null,
  inHand: true,
  status: 'active',
  bet: 0,
  totalContributed: 0,
  cards: [null, null],
  cardCount: 2,
  hasDiscarded: false,
  lastAction: null,
  handDescription: null,
  ...overrides,
  isAdmin: overrides.isAdmin ?? !!overrides.isHost,
});

export function demoPlayers(): SeatPlayerView[] {
  return [
    base({ id: 'me', name: 'Milan', seat: 0, avatar: { emoji: '🦊', color: '#e76f51' }, isHost: true, stack: 2340, cards: ['Ah', 'Kh'], camera: true, microphone: true, handDescription: 'Farba — eso navrchu' }),
    base({ id: 'p1', name: 'Juraj', seat: 1, avatar: { emoji: '🐻', color: '#2a9d8f' }, isAdmin: true, timeBankMs: 72_000, stack: 1810, bet: 120, lastAction: 'Bet 1,20 €', camera: true, microphone: true }),
    base({ id: 'p2', name: 'Michal', seat: 3, avatar: { emoji: '🤠', color: '#8e7dbe' }, timeBankMs: 31_000, stack: 960, status: 'folded', lastAction: 'Fold', cards: [] }),
    base({ id: 'p3', name: 'Zuzka', seat: 4, avatar: { emoji: '🦄', color: '#ff006e' }, timeBankMs: 58_500, stack: 3120, bet: 120, lastAction: 'Call 1,20 €', camera: true }),
    base({ id: 'p4', name: 'Peťo', seat: 6, avatar: { emoji: '🐼', color: '#3a86ff' }, timeBankMs: 12_000, stack: 0, status: 'allin', bet: 0, totalContributed: 640, lastAction: 'All-in 6,40 €' }),
    base({ id: 'p5', name: 'Katka', seat: 7, avatar: { emoji: '🦉', color: '#e9c46a' }, stack: 1450, connected: false, status: 'folded', cards: [], lastAction: 'Fold' }),
  ];
}

export function demoHand(overrides: Partial<HandView> = {}): HandView {
  return {
    handNumber: 27,
    rules: { variant: 'holdem', structure: 'no-limit', sevenDeuce: false, sevenDeuceBounty: 40, smallBlind: 10, bigBlind: 20 },
    street: 'flop',
    board: ['Qh', '7h', '2h'] as Card[],
    pots: [{ amount: 1960, eligible: ['me', 'p1', 'p3', 'p4'] }, { amount: 240, eligible: ['me', 'p1', 'p3'] }],
    totalPot: 2200,
    dealerSeat: 4,
    smallBlindSeat: 6,
    bigBlindSeat: 7,
    toActId: 'me',
    // Základný čas 15 s (ostáva 9 s) + timebank hráča na ťahu (Milan: 50 s).
    turnBaseDeadline: Date.now() + 9_000,
    turnDeadline: Date.now() + 9_000 + 50_000,
    discardDeadline: null,
    fairRoundId: 'demo',
    ...overrides,
  };
}

export function demoView(overrides: Partial<TableView> = {}): TableView {
  return {
    code: 'K7QX2M',
    hostId: 'me',
    bankerId: 'me',
    youId: 'me',
    canChangeSeat: false,
    departed: [],
    settings: { ...DEFAULT_SETTINGS, name: 'Piatkový poker' },
    nextHand: null,
    running: true,
    paused: false,
    players: demoPlayers(),
    hand: demoHand(),
    fair: { round: null, committed: true },
    legal: { canFold: true, canCheck: false, callAmount: 120, canBet: false, canRaise: true, minRaiseTo: 240, maxRaiseTo: 2340, currentBet: 120 },
    lastResult: null,
    nextHandAt: null,
    serverTime: Date.now(),
    ledger: demoLedger(),
    phase: 'playing',
    draw: null,
    adminIds: ['me', 'p1'],
    createdAt: Date.now() - 100 * MINUTE,
    history: demoHistory(),
    leaderboard: demoLeaderboard(),
    returnToLobbyPending: false,
    piggy: null,
    modeIntro: null,
    rabbit: null,
    anteAmount: 0,
    joinRequests: [],
    runVote: null,
    ...overrides,
  };
}

let eventId = 0;
const event = (kind: TableEvent['kind'], text: string, playerId?: string): TableEvent => ({ id: ++eventId, at: Date.now(), kind, text, playerId });

export function demoEvents(): TableEvent[] {
  return [
    event('host', 'Host spustil hru'),
    event('chat', 'Tak ideme, dnes vás vyčistím 😎', 'p1'),
    event('chat', 'To určite 😂', 'p3'),
    event('info', 'Ruka #27 — rozdané'),
    event('action', 'Peťo dáva SB 0,10 €', 'p4'),
    event('action', 'Katka dáva BB 0,20 €', 'p5'),
    event('action', 'Peťo: raise na 6,40 € (all-in)', 'p4'),
    event('host', 'Špeciálne kolo vyhlásené: ďalšia ruka bude Omaha'),
    event('info', 'Flop: Qh 7h 2h'),
    event('action', 'Juraj: bet 1,20 €', 'p1'),
    event('chat', 'Farba na stole, opatrne…', 'p2'),
    event('action', 'Zuzka: call 1,20 €', 'p3'),
  ];
}

const MINUTE = 60_000;
const PAID = { settlement: 'paid', bankerId: 'me', bankerName: 'Milan' } as const;
const OWED = { settlement: 'owed', bankerId: null, bankerName: null } as const;

export function demoLedger(): LedgerEntry[] {
  const start = Date.now() - 95 * MINUTE;
  let id = 0;
  const entry = (minute: number, fields: Omit<LedgerEntry, 'id' | 'at' | 'note' | 'byName' | 'deferred'> & Partial<Pick<LedgerEntry, 'note' | 'byName' | 'deferred'>>): LedgerEntry => ({
    id: ++id,
    at: start + minute * MINUTE,
    note: '',
    byName: null,
    deferred: false,
    ...fields,
  });
  return [
    entry(0, { kind: 'credit', playerId: 'me', playerName: 'Milan', amount: 2000, stackAfter: 2000, byName: 'Milan', ...PAID }),
    entry(1, { kind: 'credit', playerId: 'p1', playerName: 'Juraj', amount: 2000, stackAfter: 2000, byName: 'Milan', ...PAID }),
    entry(2, { kind: 'credit', playerId: 'p2', playerName: 'Michal', amount: 2000, stackAfter: 2000, byName: 'Milan', ...PAID }),
    entry(2, { kind: 'credit', playerId: 'p3', playerName: 'Zuzka', amount: 2000, stackAfter: 2000, byName: 'Milan', ...PAID }),
    entry(4, { kind: 'credit', playerId: 'p6', playerName: 'Tomáš', amount: 2000, stackAfter: 2000, byName: 'Milan', ...PAID }),
    entry(10, { kind: 'credit', playerId: 'p4', playerName: 'Peťo', amount: 1000, stackAfter: 1000, byName: 'Milan', note: 'dlží peniaze do banku', ...OWED }),
    entry(12, { kind: 'credit', playerId: 'p5', playerName: 'Katka', amount: 2000, stackAfter: 2000, byName: 'Milan', ...OWED }),
    entry(41, { kind: 'credit', playerId: 'p2', playerName: 'Michal', amount: 1000, stackAfter: 1180, byName: 'Milan', note: 'poslal Milanovi na účet', ...PAID }),
    entry(63, { kind: 'leave', playerId: 'p6', playerName: 'Tomáš', amount: -2650, stackAfter: null, note: 'Vyhodenie hostom', byName: 'Milan', ...OWED }),
    entry(78, { kind: 'debit', playerId: 'p3', playerName: 'Zuzka', amount: -1000, stackAfter: 3240, byName: 'Milan', note: 'vyplatené v hotovosti', ...PAID }),
    entry(93, { kind: 'credit', playerId: 'p1', playerName: 'Juraj', amount: 1500, stackAfter: 3310, byName: 'Milan', note: 'pošle cez Revolut po hre', deferred: true, ...OWED }),
  ];
}

/** Hráči v čakacej miestnosti / pri losovaní — žiadna ruka sa ešte nerozdala. */
export function lobbyPlayers(): SeatPlayerView[] {
  const idle = { inHand: false, status: null, bet: 0, totalContributed: 0, cards: [], cardCount: 0, lastAction: null, handDescription: null };
  return [
    base({ id: 'me', name: 'Milan', seat: 0, avatar: { emoji: '🦊', color: '#e76f51' }, isHost: true, stack: 2000, camera: true, microphone: true, ...idle }),
    base({ id: 'p1', name: 'Juraj', seat: 1, avatar: { emoji: '🐻', color: '#2a9d8f' }, isAdmin: true, stack: 2000, camera: true, microphone: true, ...idle }),
    base({ id: 'p2', name: 'Michal', seat: 3, avatar: { emoji: '🤠', color: '#8e7dbe' }, stack: 1500, ...idle }),
    base({ id: 'p3', name: 'Zuzka', seat: 4, avatar: { emoji: '🦄', color: '#ff006e' }, stack: 2000, ...idle }),
    base({ id: 'p4', name: 'Peťo', seat: 6, avatar: { emoji: '🐼', color: '#3a86ff' }, stack: 0, sittingOut: true, ...idle }),
    base({ id: 'p5', name: 'Katka', seat: 7, avatar: { emoji: '🦉', color: '#e9c46a' }, stack: 2000, connected: false, ...idle }),
  ];
}

export function lobbyLedger(): LedgerEntry[] {
  const start = Date.now() - 12 * MINUTE;
  const players = lobbyPlayers();
  const entries: LedgerEntry[] = players
    .filter((player) => player.id !== 'p4')
    .map((player, index) => ({
      id: index + 1,
      at: start + index * MINUTE,
      kind: 'credit',
      playerId: player.id,
      playerName: player.name,
      amount: 2000,
      stackAfter: 2000,
      note: '',
      byName: 'Milan',
      deferred: false,
      ...(player.id === 'p5' || player.id === 'p3' ? OWED : PAID),
    }));
  entries.push({ id: 99, at: start + 9 * MINUTE, kind: 'debit', playerId: 'p2', playerName: 'Michal', amount: -500, stackAfter: 1500, note: 'chce hrať len s 15 €', byName: 'Milan', deferred: false, ...PAID });
  return entries;
}

export function lobbyEvents(): TableEvent[] {
  return [
    event('host', 'Milan založil stôl K7QX2M'),
    event('info', 'Juraj si prisadol', 'p1'),
    event('chat', 'Zapínam kameru, počuť ma?', 'p1'),
    event('info', 'Michal si prisadol', 'p2'),
    event('chat', 'Počuť 👍 Peťo, pošli peniaze a dostaneš žetóny', 'me'),
    event('info', 'Zuzka si prisadla', 'p3'),
  ];
}

/** Losovanie o dealer button; `drawn` = vytiahnuté karty podľa pozície na stole. */
export function demoDraw(overrides: Partial<DrawView> = {}, drawn: Record<number, [string, Card]> = {}): DrawView {
  return {
    stage: 'choose',
    participants: ['me', 'p1', 'p2', 'p3', 'p5'],
    acknowledged: [],
    slots: Array.from({ length: 52 }, (_, index) => ({ index, card: drawn[index]?.[1] ?? null, drawnBy: drawn[index]?.[0] ?? null })),
    deadline: null,
    winnerId: null,
    ...overrides,
  };
}

const AVATARS: Record<string, Avatar> = {
  me: { emoji: '🦊', color: '#e76f51' },
  p1: { emoji: '🐻', color: '#2a9d8f' },
  p2: { emoji: '🤠', color: '#8e7dbe' },
  p3: { emoji: '🦄', color: '#ff006e' },
  p4: { emoji: '🐼', color: '#3a86ff' },
  p5: { emoji: '🦉', color: '#e9c46a' },
  p6: { emoji: '🐺', color: '#264653' },
};
const NAMES: Record<string, string> = { me: 'Milan', p1: 'Juraj', p2: 'Michal', p3: 'Zuzka', p4: 'Peťo', p5: 'Katka', p6: 'Tomáš' };

const win = (playerId: string, amount: number, handDescription: string | null = null, cards: string[] = []): HandHistoryWinner => ({
  playerId,
  playerName: NAMES[playerId],
  amount,
  handDescription,
  cards: cards as Card[],
});

interface HandSpec {
  variant?: Variant;
  sevenDeuce?: boolean;
  dealer: string;
  board: string[];
  winners: HandHistoryWinner[];
  noShowdown?: boolean;
  bounty?: [string, number];
  /** Výplata Prasiatka (hráč, suma). */
  piggy?: [string, number][];
}

/** Ručne napísané ruky #15–#26 (najnovšia na konci) — 7-2 bonus, delený pot, Omaha, Pineapple, výhra bez showdownu. */
const NOTABLE_HANDS: HandSpec[] = [
  { dealer: 'p3', board: ['8c', '5d', 'Js', '3h', 'Ac'], winners: [win('p6', 900, 'Pár — esá', ['As', 'Qd'])] },
  { dealer: 'p5', board: ['Kh', '9c', '4d', '4s', 'Tc'], winners: [win('me', 820, 'Dva páry — králi a štvorky', ['Kd', 'Qh'])] },
  {
    dealer: 'me',
    board: ['As', 'Ks', 'Qs', 'Js', 'Ts'],
    winners: [win('p2', 300, 'Kráľovská farba', ['3c', '4d']), win('me', 300, 'Kráľovská farba', ['9h', '9d']), win('p1', 300, 'Kráľovská farba', ['2h', '6c'])],
  },
  { sevenDeuce: true, dealer: 'p1', board: ['7c', '7d', 'Ks', '4h', '5c'], winners: [win('p5', 540, 'Trojica — sedmičky', ['7h', '2s'])], bounty: ['p5', 200] },
  { sevenDeuce: true, dealer: 'p2', board: ['Ad', 'Th', '4s', '8c', '2h'], winners: [win('p3', 2400, 'Dva páry — esá a desiatky', ['Ac', 'Tc'])] },
  { sevenDeuce: true, dealer: 'p3', board: [], winners: [win('p1', 30)], noShowdown: true },
  { dealer: 'p4', board: ['3d', '7d', 'Kd', '2s', '9c'], winners: [win('p6', 1350, 'Farba — kráľ navrchu', ['Qd', '8d'])] },
  { variant: 'pineapple', dealer: 'p5', board: ['Jc', 'Jd', '5s', '9h', '2d'], winners: [win('p4', 1960, 'Trojica — dolníky', ['Js', '4c'])] },
  { dealer: 'me', board: ['Qc', '8d', '3h'], winners: [win('p2', 260)], noShowdown: true },
  {
    variant: 'omaha',
    dealer: 'p1',
    board: ['Ah', 'Td', '6c', '6s', 'Qh'],
    winners: [win('p3', 560, 'Postupka do esa', ['Kc', 'Jh', '3d', '8s']), win('me', 560, 'Postupka do esa', ['Kd', 'Js', '9c', '2h'])],
  },
  { sevenDeuce: true, dealer: 'p2', board: ['7s', '2h', 'Kc', '9d', '3s'], winners: [win('me', 1240, 'Dva páry — sedmičky a dvojky', ['7d', '2c'])], bounty: ['me', 200] },
  { dealer: 'p3', board: ['Kd', '9s', '4h', '2c', 'Jd'], winners: [win('p1', 680, 'Pár — králi', ['Ks', 'Qc'])], piggy: [['p1', 640]] },
];

/** Staršie, obyčajné ruky #1–#14, aby história mala aj stránkovanie („Zobraziť ďalšie“). */
function fillerHands(count: number): HandSpec[] {
  const ids = ['me', 'p1', 'p2', 'p3', 'p5', 'p6'];
  const boards = [
    ['2c', '6d', 'Th', 'Qs', '5h'],
    ['9d', '9s', '3c', 'Kh', '7s'],
    ['Ah', '4c', '8s', 'Jd', '6h'],
    ['5c', 'Tc', 'Qd', '3s', '8h'],
  ];
  return Array.from({ length: count }, (_, index) => {
    const winner = ids[(index * 5 + 1) % ids.length];
    const showdown = index % 3 !== 1;
    return {
      dealer: ids[index % ids.length],
      board: showdown ? boards[index % boards.length] : [],
      winners: [win(winner, 120 + ((index * 170) % 900), showdown ? 'Pár — dámy' : null, showdown ? ['Qh', '3d'] : [])],
      noShowdown: !showdown,
    };
  });
}

export function demoHistory(): HandHistoryEntry[] {
  const hands = [...fillerHands(14), ...NOTABLE_HANDS];
  const start = Date.now() - 92 * MINUTE;
  return hands.map((hand, index) => ({
    handNumber: index + 1,
    at: start + Math.round(index * 3.4 * MINUTE),
    variant: hand.variant ?? 'holdem',
    sevenDeuce: !!hand.sevenDeuce,
    dealerName: NAMES[hand.dealer],
    board: hand.board as Card[],
    totalPot: hand.winners.reduce((sum, winner) => sum + winner.amount, 0),
    wonWithoutShowdown: !!hand.noShowdown,
    winners: hand.winners,
    bounty: hand.bounty ? { winnerName: NAMES[hand.bounty[0]], total: hand.bounty[1] } : null,
    piggy: hand.piggy ? { winners: hand.piggy.map(([playerId, amount]) => ({ playerId, playerName: NAMES[playerId], amount })) } : null,
  }));
}

/** Moje karty a výsledok v každej ruke histórie (`history:mine`) — výhry podľa `demoHistory`, inak fold alebo prehra. */
export function demoMyHands(): MyHandRecord[] {
  const folds: Card[][] = [
    ['9c', '4d'],
    ['Jh', '3s'],
    ['8d', '2c'],
    ['Tc', '5h'],
  ];
  return demoHistory().map((entry, index) => {
    const mine = entry.winners.find((winner) => winner.playerId === 'me');
    if (mine) {
      return { handNumber: entry.handNumber, cards: mine.cards, net: Math.round(mine.amount * 0.55), folded: false, handDescription: mine.handDescription };
    }
    const cards = entry.variant === 'omaha' ? (['Ad', '7s', '5c', '4h'] as Card[]) : folds[index % folds.length];
    if (index % 3 === 2 && !entry.wonWithoutShowdown && entry.board.length === 5) {
      return { handNumber: entry.handNumber, cards: ['Qs', 'Td'] as Card[], net: -Math.round(entry.totalPot / 2), folded: false, handDescription: 'Pár — dámy' };
    }
    return { handNumber: entry.handNumber, cards, net: index % 2 === 0 ? -20 : 0, folded: true, handDescription: null };
  });
}

/** Zodpovedá `demoLedger` a stackom v `demoPlayers`; Tomáš od stola odišiel. */
export function demoLeaderboard(): LeaderboardRow[] {
  const row = (playerId: string, fields: Omit<LeaderboardRow, 'playerId' | 'playerName' | 'avatar' | 'result' | 'present'> & { present?: boolean }): LeaderboardRow => ({
    playerId,
    playerName: NAMES[playerId],
    avatar: AVATARS[playerId],
    present: fields.present ?? true,
    ...fields,
    result: fields.stack + fields.withdrawn - fields.deposited,
  });
  const rows = [
    row('me', { deposited: 2000, withdrawn: 0, stack: 2340, handsPlayed: 26, handsWon: 6, biggestPot: 1240 }),
    row('p1', { deposited: 3500, withdrawn: 0, stack: 3310, handsPlayed: 26, handsWon: 5, biggestPot: 680 }),
    row('p2', { deposited: 3000, withdrawn: 0, stack: 960, handsPlayed: 25, handsWon: 3, biggestPot: 300 }),
    row('p3', { deposited: 2000, withdrawn: 1000, stack: 3120, handsPlayed: 24, handsWon: 4, biggestPot: 2400 }),
    row('p4', { deposited: 1000, withdrawn: 0, stack: 0, handsPlayed: 16, handsWon: 1, biggestPot: 1960 }),
    row('p5', { deposited: 2000, withdrawn: 0, stack: 1450, handsPlayed: 22, handsWon: 2, biggestPot: 540 }),
    row('p6', { present: false, deposited: 2000, withdrawn: 2650, stack: 0, handsPlayed: 18, handsWon: 4, biggestPot: 1350 }),
  ];
  return rows.sort((left, right) => right.result - left.result);
}

/** Leaderboard čerstvo založeného stola v čakárni — žiadna ruka sa ešte neodohrala. */
export function lobbyLeaderboard(): LeaderboardRow[] {
  return lobbyPlayers().map((player) => {
    const deposited = player.id === 'p4' ? 0 : 2000;
    const withdrawn = player.id === 'p2' ? 500 : 0;
    return {
      playerId: player.id,
      playerName: player.name,
      avatar: player.avatar,
      present: true,
      deposited,
      withdrawn,
      stack: player.stack,
      result: player.stack + withdrawn - deposited,
      handsPlayed: 0,
      handsWon: 0,
      biggestPot: 0,
    };
  });
}

/** Demo „Moje stoly“: od týchto stolov som odišiel (žetóny ostali uložené); pri chate je stôl plný. */
export const DEMO_LEFT_TABLES = ['H8DW3K', 'P4NB8T'];
export const DEMO_TABLE_ERRORS: Record<string, string> = { P4NB8T: 'Stôl je plný — počkaj, kým sa uvoľní miesto' };

/** Prehľad uložených stolov pre demo „Moje stoly“. */
export function demoSummaries(): TableSummary[] {
  const now = Date.now();
  return [
    { code: 'K7QX2M', name: 'Piatkový poker', currency: 'EUR', phase: 'playing', paused: false, handNumber: 27, playerCount: 6, onlineCount: 5, hostName: 'Milan', myStack: 2340, myIsAdmin: true, createdAt: now - 100 * MINUTE, lastActivity: now - 2 * MINUTE },
    { code: 'H8DW3K', name: 'Utorková partia', currency: 'EUR', phase: 'playing', paused: false, handNumber: 61, playerCount: 4, onlineCount: 4, hostName: 'Peťo', myStack: 1860, myIsAdmin: false, createdAt: now - 5 * 60 * MINUTE, lastActivity: now - MINUTE },
    { code: 'P4NB8T', name: 'Chata u Juraja', currency: 'CZK', phase: 'lobby', paused: false, handNumber: 0, playerCount: 3, onlineCount: 1, hostName: 'Juraj', myStack: 50000, myIsAdmin: false, createdAt: now - 26 * 60 * MINUTE, lastActivity: now - 20 * 60 * MINUTE },
    { code: 'Z2RM6W', name: 'Turnaj s kolegami z práce — finále', currency: 'EUR', phase: 'playing', paused: true, handNumber: 143, playerCount: 8, onlineCount: 0, hostName: 'Katka', myStack: 0, myIsAdmin: true, createdAt: now - 9 * 24 * 60 * MINUTE, lastActivity: now - 6 * 24 * 60 * MINUTE },
  ];
}

/** Členovia, ktorí odišli od stola (žetóny uložené) — host ich vidí v sekcii „Odišli od stola“. */
export function demoDeparted(): DepartedMemberView[] {
  return [
    { id: 'd1', name: 'Vilo', avatar: { emoji: '🐺', color: '#264653' }, stack: 1240 },
    { id: 'd2', name: 'Ferko', avatar: { emoji: '🐸', color: '#06d6a0' }, stack: 0 },
  ];
}

/** Prasiatko: 4 odohrané ruky po 0,20 € od piatich hráčov (Peťo je all-in, ale vstup zaplatil). */
export function demoPiggy(overrides: Partial<PiggyView> = {}): PiggyView {
  return {
    status: 'running',
    amount: 480,
    entry: 20,
    target: 3,
    wins: { me: 1, p1: 2, p3: 1, p2: 0, p4: 0, p5: 0 },
    contributed: { me: 80, p1: 80, p2: 80, p3: 80, p4: 80, p5: 80 },
    startedAtHand: 24,
    winners: [],
    series: { remaining: 1, permanent: false, stopping: false, total: 1 },
    ...overrides,
  };
}

export function demoModeIntro(overrides: Partial<ModeIntroView> = {}): ModeIntroView {
  return {
    mode: 'piggy',
    participants: ['me', 'p1', 'p2', 'p3', 'p5'],
    acknowledged: ['p1', 'p3'],
    deadline: Date.now() + 42_000,
    ...overrides,
  };
}
