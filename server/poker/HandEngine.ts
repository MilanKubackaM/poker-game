import { randomInt } from 'node:crypto';
import type { BountyView, Card, HandRules, LegalActions, PlayerAction, PlayerStatus, Street, WinnerView } from '../../shared/types';
import { HOLE_CARD_COUNT } from '../../shared/constants';
import { freshDeck, rankValue, shuffle } from './cards';
import { evaluateHoldem, evaluateOmaha, type EvaluatedHand } from './evaluator';
import { buildPots, findUncalled, splitAmount, type Pot } from './pots';

export interface HandSeat {
  id: string;
  name: string;
  seat: number;
  stack: number;
  /**
   * Návrat do hry so zaplatením zmeškaných blindov (`ReturnMode` `post`): `live` = živý BB — počíta sa ako hráčova
   * stávka (preflop môže checkovať, ak nikto nenavýšil), `dead` = mŕtvy SB — ide rovno do potu, nie je to jeho stávka.
   * Pri nedostatku žetónov sa platí najprv živá časť, potom mŕtva (all-in ako pri blindoch).
   */
  post?: { live: number; dead: number };
}

export interface HandInput {
  handNumber: number;
  seats: HandSeat[];
  dealerSeat: number;
  rules: HandRules;
  deck?: Card[];
  formatAmount?: (cents: number) => string;
  /** Ante z predchádzajúcej ruky (zaplatené odkrytie boardu) — mŕtve peniaze v hlavnom pote, nepatria žiadnemu hráčovi. */
  ante?: number;
}

export interface EnginePlayer {
  id: string;
  name: string;
  seat: number;
  startStack: number;
  stack: number;
  hole: Card[];
  status: PlayerStatus;
  bet: number;
  /** Živé príspevky do potu (stávky); z nich sa počítajú side poty a nedorovnaná stávka. */
  total: number;
  /** Mŕtve peniaze (mŕtvy SB pri návrate) — patria do hlavného potu, hráčovi nedávajú nárok na pot. */
  dead: number;
  hasActed: boolean;
  canRaise: boolean;
  discarded: boolean;
  lastAction: string | null;
  evaluated: EvaluatedHand | null;
}

export interface HandResult {
  winners: WinnerView[];
  bounty: BountyView | null;
  revealed: Record<string, Card[]>;
  wonWithoutShowdown: boolean;
}

export interface EngineLog {
  text: string;
  playerId?: string;
  kind: 'action' | 'result' | 'bounty' | 'info';
}

export type ActResult = { ok: true } | { ok: false; error: string };

export class HandEngine {
  readonly handNumber: number;
  readonly rules: HandRules;
  readonly players: EnginePlayer[];
  readonly dealerSeat: number;
  smallBlindSeat = -1;
  bigBlindSeat = -1;
  street: Street = 'preflop';
  board: Card[] = [];
  currentBet = 0;
  lastRaiseSize = 0;
  toActIndex = -1;
  awaitingRunout = false;
  /** Koľkokrát sa dorozdá board po all-in (1–3); ďalšie behy sú v `extraBoards`. */
  runs = 1;
  /** Počet kariet na boarde v momente all-in — od neho sa líšia jednotlivé behy. */
  runoutBase = 0;
  readonly extraBoards: Card[][] = [];
  result: HandResult | null = null;
  readonly ante: number;
  private readonly posts = new Map<string, { live: number; dead: number }>();
  private deck: Card[];
  private discardPhaseDone = false;
  private pendingLog: EngineLog[] = [];
  private readonly money: (cents: number) => string;

  constructor(input: HandInput) {
    if (input.seats.length < 2) {
      throw new Error('A hand needs at least two players');
    }
    this.handNumber = input.handNumber;
    this.rules = input.rules;
    this.dealerSeat = input.dealerSeat;
    this.money = input.formatAmount ?? String;
    this.ante = Math.max(0, Math.floor(input.ante ?? 0));
    this.deck = input.deck ? [...input.deck] : shuffle(freshDeck());
    this.players = [...input.seats]
      .sort((left, right) => left.seat - right.seat)
      .map((seat) => ({
        id: seat.id,
        name: seat.name,
        seat: seat.seat,
        startStack: seat.stack,
        stack: seat.stack,
        hole: [],
        status: 'active' as PlayerStatus,
        bet: 0,
        total: 0,
        dead: 0,
        hasActed: false,
        canRaise: true,
        discarded: false,
        lastAction: null,
        evaluated: null,
      }));
    if (!this.players.some((player) => player.seat === this.dealerSeat)) {
      throw new Error('Dealer must be one of the players');
    }
    for (const seat of input.seats) {
      if (seat.post && (seat.post.live > 0 || seat.post.dead > 0)) {
        this.posts.set(seat.id, { live: Math.max(0, Math.floor(seat.post.live)), dead: Math.max(0, Math.floor(seat.post.dead)) });
      }
    }
  }

  get isComplete(): boolean {
    return this.street === 'complete';
  }

  get toAct(): EnginePlayer | null {
    return this.toActIndex >= 0 ? this.players[this.toActIndex] : null;
  }

  get totalPot(): number {
    return this.players.reduce((sum, player) => sum + player.total + player.dead, 0) + this.ante;
  }

  /**
   * Karty, ktoré by ešte prišli na board, keby sa ruka dohrala (s pálením kariet ako pri bežnom rozdávaní) —
   * pre zaplatené odkrytie boardu po skončení ruky. Balíček sa nemení.
   */
  remainingBoard(): Card[] {
    const deck = [...this.deck];
    const cards: Card[] = [];
    let length = this.board.length;
    while (length < 5) {
      deck.shift();
      const count = length === 0 ? 3 : 1;
      for (let index = 0; index < count; index++) {
        const card = deck.shift();
        if (!card) {
          return cards;
        }
        cards.push(card);
      }
      length += count;
    }
    return cards;
  }

  drainLog(): EngineLog[] {
    const log = this.pendingLog;
    this.pendingLog = [];
    return log;
  }

  player(id: string): EnginePlayer | undefined {
    return this.players.find((player) => player.id === id);
  }

  pots(): Pot[] {
    const pots = buildPots(this.players.map((player) => ({ playerId: player.id, amount: player.total, folded: player.status === 'folded' })));
    const dead = this.players.reduce((sum, player) => sum + player.dead, 0) + this.ante;
    if (dead > 0) {
      if (pots.length) {
        pots[0].amount += dead;
      } else {
        pots.push({ amount: dead, eligible: this.livePlayers().map((player) => player.id) });
      }
    }
    return pots;
  }

  start(): void {
    const holeCount = HOLE_CARD_COUNT[this.rules.variant];
    const dealOrder = this.orderFrom(this.indexOfSeat(this.dealerSeat) + 1);
    for (let round = 0; round < holeCount; round++) {
      for (const player of dealOrder) {
        player.hole.push(this.draw());
      }
    }

    const positions = blindSeats(this.players.map((player) => player.seat), this.dealerSeat);
    const smallBlindIndex = this.indexOfSeat(positions.smallBlindSeat);
    const bigBlindIndex = this.indexOfSeat(positions.bigBlindSeat);
    this.smallBlindSeat = positions.smallBlindSeat;
    this.bigBlindSeat = positions.bigBlindSeat;
    this.postBlind(this.players[smallBlindIndex], this.rules.smallBlind, 'SB');
    this.postBlind(this.players[bigBlindIndex], this.rules.bigBlind, 'BB');
    for (const player of this.players) {
      const post = this.posts.get(player.id);
      if (post && player.seat !== this.smallBlindSeat && player.seat !== this.bigBlindSeat) {
        this.postReturn(player, post);
      }
    }

    this.currentBet = Math.max(this.rules.bigBlind, ...this.players.map((player) => player.bet));
    this.lastRaiseSize = this.rules.bigBlind;
    this.toActIndex = bigBlindIndex;
    this.log(`Ruka #${this.handNumber} — rozdané`, 'info');
    if (this.isRoundComplete()) {
      this.closeRound();
      this.proceedAfterBetting();
      return;
    }
    this.moveToNextActor();
  }

  legalActions(playerId: string): LegalActions | null {
    const player = this.toAct;
    if (!player || player.id !== playerId || this.street === 'discard') {
      return null;
    }
    const toCall = Math.min(this.currentBet - player.bet, player.stack);
    const maxTotal = player.bet + player.stack;
    const capped = Math.min(maxTotal, this.maxRaiseTarget(player));
    const canAggress = player.canRaise && maxTotal > this.currentBet;
    const minRaiseTo = Math.min(this.currentBet + this.lastRaiseSize, maxTotal);
    return {
      canFold: true,
      canCheck: toCall === 0,
      callAmount: Math.max(0, toCall),
      canBet: canAggress && this.currentBet === 0,
      canRaise: canAggress && this.currentBet > 0,
      minRaiseTo,
      maxRaiseTo: Math.max(minRaiseTo, capped),
      currentBet: this.currentBet,
    };
  }

  act(playerId: string, action: PlayerAction): ActResult {
    const player = this.toAct;
    if (this.street === 'discard' || this.awaitingRunout || this.isComplete) {
      return { ok: false, error: 'Teraz sa nedá konať' };
    }
    if (!player || player.id !== playerId) {
      return { ok: false, error: 'Nie si na ťahu' };
    }
    const toCall = this.currentBet - player.bet;

    switch (action.type) {
      case 'fold':
        player.status = 'folded';
        player.hasActed = true;
        player.lastAction = 'Fold';
        this.log(`${player.name}: fold`, 'action', player.id);
        break;
      case 'check':
        if (toCall > 0) {
          return { ok: false, error: 'Nemôžeš checkovať, treba dorovnať' };
        }
        player.hasActed = true;
        player.lastAction = 'Check';
        this.log(`${player.name}: check`, 'action', player.id);
        break;
      case 'call':
        if (toCall <= 0) {
          return { ok: false, error: 'Nie je čo dorovnať' };
        }
        this.call(player);
        break;
      case 'bet':
      case 'raise':
      case 'allin': {
        const target = action.type === 'allin' ? player.bet + player.stack : Math.floor(Number(action.amount));
        const outcome = this.raiseTo(player, target, action.type === 'allin');
        if (!outcome.ok) {
          return outcome;
        }
        break;
      }
      default:
        return { ok: false, error: 'Neznáma akcia' };
    }

    this.afterAction();
    return { ok: true };
  }

  /**
   * Fold mimo poradia (hráča vyhodil host): hráč hneď prestáva byť v ruke, aj keď nie je na ťahu, je all-in alebo sa
   * práve zahadzuje / dorozdáva board. Jeho žetóny v pote ostávajú v pote. Vráti false, ak v ruke už nebol.
   */
  foldOut(playerId: string): boolean {
    const player = this.player(playerId);
    if (!player || this.isComplete || player.status === 'folded') {
      return false;
    }
    if (this.toAct === player && this.street !== 'discard' && !this.awaitingRunout) {
      return this.act(playerId, { type: 'fold' }).ok;
    }
    player.status = 'folded';
    player.hasActed = true;
    player.lastAction = 'Fold';
    this.log(`${player.name}: fold`, 'action', player.id);
    const live = this.livePlayers();
    if (live.length === 1) {
      this.returnUncalled();
      this.finishFoldWin(live[0]);
      return true;
    }
    if (this.awaitingRunout) {
      return true;
    }
    if (this.street === 'discard') {
      if (this.pendingDiscards().length === 0) {
        this.discardPhaseDone = true;
        this.proceedAfterBetting();
      }
      return true;
    }
    if (this.isRoundComplete()) {
      this.closeRound();
      this.proceedAfterBetting();
    }
    return true;
  }

  discard(playerId: string, cardIndex: number): ActResult {
    if (this.street !== 'discard') {
      return { ok: false, error: 'Teraz sa nezahadzuje' };
    }
    const player = this.player(playerId);
    if (!player || player.status === 'folded') {
      return { ok: false, error: 'Nie si v hre' };
    }
    if (player.discarded) {
      return { ok: false, error: 'Kartu už máš zahodenú' };
    }
    if (!Number.isInteger(cardIndex) || cardIndex < 0 || cardIndex >= player.hole.length) {
      return { ok: false, error: 'Neplatná karta' };
    }
    player.hole.splice(cardIndex, 1);
    player.discarded = true;
    this.log(`${player.name} zahadzuje kartu`, 'action', player.id);
    if (this.pendingDiscards().length === 0) {
      this.discardPhaseDone = true;
      this.proceedAfterBetting();
    }
    return { ok: true };
  }

  pendingDiscards(): EnginePlayer[] {
    if (this.street !== 'discard') {
      return [];
    }
    return this.players.filter((player) => player.status !== 'folded' && !player.discarded);
  }

  /**
   * Za hráča, ktorý sa nerozhodol (vypršal čas, je na pauze), zahodí náhodnú kartu. `random(max)` vracia celé číslo
   * 0…max−1 — predvolene kryptografický `randomInt`, testy podstrčia vlastný.
   */
  autoDiscard(playerId: string, random: (max: number) => number = randomInt): ActResult {
    const player = this.player(playerId);
    if (this.street !== 'discard' || !player || player.status === 'folded' || player.discarded) {
      return { ok: false, error: 'Teraz sa nezahadzuje' };
    }
    return this.discard(playerId, random(player.hole.length));
  }

  /** Všetkým, čo ešte nezahodili, zahodí náhodnú kartu (pozri `autoDiscard`). */
  autoDiscardRemaining(random: (max: number) => number = randomInt): void {
    for (const player of this.pendingDiscards()) {
      this.autoDiscard(player.id, random);
    }
  }

  autoAct(): void {
    const player = this.toAct;
    if (!player) {
      return;
    }
    const canCheck = this.currentBet - player.bet <= 0;
    this.act(player.id, { type: canCheck ? 'check' : 'fold' });
  }

  /** Koľko behov sa dá dorozdať zo zvyšku balíčka (každý beh potrebuje svoje karty aj pálenie), najviac 3. */
  maxRuns(): number {
    if (!this.awaitingRunout || this.board.length >= 5) {
      return 1;
    }
    const streets = this.board.length === 0 ? 3 : this.board.length === 3 ? 2 : 1;
    const perRun = 5 - this.board.length + streets;
    return Math.max(1, Math.min(3, Math.floor(this.deck.length / perRun)));
  }

  /** Nastaví počet behov pred prvým dorozdaním (po hlasovaní hráčov); vráti skutočný počet. */
  setRuns(runs: number): number {
    if (!this.awaitingRunout || this.board.length !== this.runoutBase || this.extraBoards.length) {
      return this.runs;
    }
    this.runs = Math.max(1, Math.min(this.maxRuns(), Math.floor(runs)));
    return this.runs;
  }

  runoutStep(): void {
    if (!this.awaitingRunout || this.isComplete) {
      return;
    }
    if (this.board.length < 5) {
      this.dealNextStreet();
    } else {
      const run = this.extraBoards.findIndex((board) => board.length < 5);
      const index = run >= 0 ? run : this.extraBoards.length;
      if (index >= this.runs - 1) {
        this.awaitingRunout = false;
        this.showdown();
        return;
      }
      const board = this.extraBoards[index] ?? this.board.slice(0, this.runoutBase);
      this.extraBoards[index] = board;
      this.draw();
      const count = board.length === 0 ? 3 : 1;
      for (let card = 0; card < count; card++) {
        board.push(this.draw());
      }
      const street = board.length === 3 ? 'Flop' : board.length === 4 ? 'Turn' : 'River';
      this.log(`${index + 2}. beh — ${street}: ${board.join(' ')}`, 'info');
    }
    const done = this.board.length >= 5 && this.extraBoards.length === this.runs - 1 && this.extraBoards.every((board) => board.length >= 5);
    if (done) {
      this.awaitingRunout = false;
      this.showdown();
    }
  }

  private call(player: EnginePlayer): void {
    const amount = Math.min(this.currentBet - player.bet, player.stack);
    this.commit(player, amount);
    player.hasActed = true;
    player.lastAction = player.status === 'allin' ? `All-in ${this.money(player.bet)}` : `Call ${this.money(amount)}`;
    this.log(`${player.name}: call ${this.money(amount)}${player.status === 'allin' ? ' (all-in)' : ''}`, 'action', player.id);
  }

  private raiseTo(player: EnginePlayer, requested: number, allIn: boolean): ActResult {
    if (!Number.isFinite(requested) || requested <= 0) {
      return { ok: false, error: 'Neplatná suma' };
    }
    const maxTotal = player.bet + player.stack;
    const potCap = this.maxRaiseTarget(player);
    let target = Math.min(requested, maxTotal);
    if (allIn && target > potCap) {
      target = potCap;
    }
    if (target > potCap) {
      return { ok: false, error: `Pot-limit: maximum je ${this.money(potCap)}` };
    }
    if (target <= this.currentBet) {
      if (target === maxTotal && this.currentBet > player.bet) {
        this.call(player);
        return { ok: true };
      }
      return { ok: false, error: 'Suma musí byť vyššia ako aktuálna stávka' };
    }
    if (!player.canRaise) {
      return { ok: false, error: 'Po krátkom all-in už nemôžeš navyšovať' };
    }
    const raiseSize = target - this.currentBet;
    const isAllIn = target === maxTotal;
    if (raiseSize < this.lastRaiseSize && !isAllIn) {
      return { ok: false, error: `Minimálne navýšenie je na ${this.money(this.currentBet + this.lastRaiseSize)}` };
    }

    const wasOpen = this.currentBet === 0;
    this.commit(player, target - player.bet);
    player.hasActed = true;
    const fullRaise = raiseSize >= this.lastRaiseSize;
    for (const other of this.players) {
      if (other === player || other.status !== 'active') {
        continue;
      }
      if (fullRaise) {
        other.canRaise = true;
      } else if (other.hasActed) {
        other.canRaise = false;
      }
      other.hasActed = false;
    }
    if (fullRaise) {
      this.lastRaiseSize = raiseSize;
    }
    this.currentBet = target;
    const verb = wasOpen ? 'Bet' : 'Raise';
    player.lastAction = player.status === 'allin' ? `All-in ${this.money(target)}` : `${verb} ${this.money(target)}`;
    this.log(`${player.name}: ${wasOpen ? 'bet' : 'raise na'} ${this.money(target)}${player.status === 'allin' ? ' (all-in)' : ''}`, 'action', player.id);
    return { ok: true };
  }

  private maxRaiseTarget(player: EnginePlayer): number {
    const maxTotal = player.bet + player.stack;
    if (this.rules.structure !== 'pot-limit') {
      return maxTotal;
    }
    const toCall = Math.max(0, this.currentBet - player.bet);
    const potAfterCall = this.totalPot + toCall;
    return Math.min(maxTotal, this.currentBet + potAfterCall);
  }

  private afterAction(): void {
    const live = this.livePlayers();
    if (live.length === 1) {
      this.returnUncalled();
      this.finishFoldWin(live[0]);
      return;
    }
    if (this.isRoundComplete()) {
      this.closeRound();
      this.proceedAfterBetting();
      return;
    }
    this.moveToNextActor();
  }

  private isRoundComplete(): boolean {
    const active = this.players.filter((player) => player.status === 'active');
    if (active.length === 0) {
      return true;
    }
    if (active.length === 1 && this.livePlayers().length > 1) {
      return active[0].bet >= this.currentBet;
    }
    return active.every((player) => player.hasActed && player.bet === this.currentBet);
  }

  private closeRound(): void {
    this.returnUncalled();
    for (const player of this.players) {
      player.bet = 0;
      player.hasActed = false;
      player.canRaise = true;
    }
    this.currentBet = 0;
    this.lastRaiseSize = this.rules.bigBlind;
    this.toActIndex = -1;
  }

  private proceedAfterBetting(): void {
    if (this.livePlayers().length === 1) {
      this.finishFoldWin(this.livePlayers()[0]);
      return;
    }
    if (this.rules.variant === 'pineapple' && !this.discardPhaseDone && this.board.length === 0) {
      this.street = 'discard';
      this.toActIndex = -1;
      this.log('Pineapple — každý zahodí jednu kartu', 'info');
      return;
    }
    if (this.board.length >= 5) {
      this.showdown();
      return;
    }
    const canBet = this.players.filter((player) => player.status === 'active').length >= 2;
    if (!canBet) {
      this.awaitingRunout = true;
      this.runoutBase = this.board.length;
      this.toActIndex = -1;
      if (this.street === 'discard') {
        this.street = 'preflop';
      }
      return;
    }
    this.dealNextStreet();
    this.startBettingRound();
  }

  private startBettingRound(): void {
    for (const player of this.players) {
      player.lastAction = player.status === 'active' ? null : player.lastAction;
    }
    this.toActIndex = this.indexOfSeat(this.dealerSeat);
    this.moveToNextActor();
  }

  private dealNextStreet(): void {
    this.draw();
    if (this.board.length === 0) {
      this.board.push(this.draw(), this.draw(), this.draw());
      this.street = 'flop';
    } else if (this.board.length === 3) {
      this.board.push(this.draw());
      this.street = 'turn';
    } else {
      this.board.push(this.draw());
      this.street = 'river';
    }
    this.log(`${this.street === 'flop' ? 'Flop' : this.street === 'turn' ? 'Turn' : 'River'}: ${this.board.join(' ')}`, 'info');
  }

  private moveToNextActor(): void {
    const count = this.players.length;
    for (let step = 1; step <= count; step++) {
      const index = (this.toActIndex + step) % count;
      const candidate = this.players[index];
      if (candidate.status === 'active' && (!candidate.hasActed || candidate.bet < this.currentBet)) {
        this.toActIndex = index;
        return;
      }
    }
    this.toActIndex = -1;
  }

  private returnUncalled(): void {
    const uncalled = findUncalled(this.players.map((player) => ({ playerId: player.id, amount: player.total, folded: player.status === 'folded' })));
    if (!uncalled) {
      return;
    }
    const player = this.player(uncalled.playerId);
    if (!player) {
      return;
    }
    player.total -= uncalled.amount;
    player.bet = Math.max(0, player.bet - uncalled.amount);
    player.stack += uncalled.amount;
    if (player.status === 'allin' && player.stack > 0) {
      player.status = 'active';
    }
    this.log(`${player.name} dostáva späť nedorovnaných ${this.money(uncalled.amount)}`, 'info', player.id);
  }

  private finishFoldWin(winner: EnginePlayer): void {
    const amount = this.totalPot;
    winner.stack += amount;
    const winners: WinnerView[] = [{ playerId: winner.id, amount, potIndex: 0, handDescription: null, bestCards: [] }];
    this.log(`${winner.name} vyhráva ${this.money(amount)} (ostatní zložili)`, 'result', winner.id);
    const revealed: Record<string, Card[]> = {};
    const bounty = this.applySevenDeuce(winners);
    if (bounty) {
      revealed[winner.id] = [...winner.hole];
    }
    this.complete({ winners, bounty, revealed, wonWithoutShowdown: true });
  }

  private showdown(): void {
    this.street = 'showdown';
    this.toActIndex = -1;
    const live = this.livePlayers();
    const revealed: Record<string, Card[]> = {};
    for (const player of live) {
      player.evaluated = this.evaluate(player, this.board);
      revealed[player.id] = [...player.hole];
    }
    const boards = [this.board, ...this.extraBoards];
    const multi = boards.length > 1;
    const order = this.orderFrom(this.indexOfSeat(this.dealerSeat) + 1).map((player) => player.id);
    const winners: WinnerView[] = [];
    this.pots().forEach((pot, potIndex) => {
      // Pri viacerých behoch sa každý pot delí na rovnaké časti (zvyšný cent prvému behu).
      const base = Math.floor(pot.amount / boards.length);
      boards.forEach((board, run) => {
        const share = base + (run === 0 ? pot.amount - base * boards.length : 0);
        const contenders = pot.eligible
          .map((id) => this.player(id))
          .filter((player): player is EnginePlayer => !!player && player.status !== 'folded')
          .map((player) => ({ player, evaluated: run === 0 ? player.evaluated! : this.evaluate(player, board) }));
        if (!contenders.length || share <= 0) {
          return;
        }
        const topScore = Math.max(...contenders.map((contender) => contender.evaluated.score));
        const potWinners = contenders.filter((contender) => contender.evaluated.score === topScore);
        const orderedIds = order.filter((id) => potWinners.some((contender) => contender.player.id === id));
        const shares = splitAmount(share, orderedIds);
        for (const [id, amount] of shares) {
          const contender = potWinners.find((candidate) => candidate.player.id === id)!;
          contender.player.stack += amount;
          winners.push({
            playerId: id,
            amount,
            potIndex,
            handDescription: contender.evaluated.description,
            bestCards: contender.evaluated.cards,
            ...(multi ? { run } : {}),
          });
          const potLabel = potIndex === 0 ? 'hlavný pot' : `side pot ${potIndex}`;
          this.log(`${multi ? `${run + 1}. beh: ` : ''}${contender.player.name} vyhráva ${this.money(amount)} (${potLabel}) — ${contender.evaluated.description}`, 'result', id);
        }
      });
    });

    const bounty = this.applySevenDeuce(winners.filter((winner) => (winner.run ?? 0) === 0));
    this.complete({ winners, bounty, revealed, wonWithoutShowdown: false });
  }

  private evaluate(player: EnginePlayer, board: Card[]): EvaluatedHand {
    return this.rules.variant === 'omaha' ? evaluateOmaha(player.hole, board) : evaluateHoldem(player.hole, board);
  }

  private applySevenDeuce(winners: WinnerView[]): BountyView | null {
    if (!this.rules.sevenDeuce || this.rules.variant === 'omaha' || this.rules.sevenDeuceBounty <= 0) {
      return null;
    }
    const mainPotWinners = winners.filter((winner) => winner.potIndex === 0).map((winner) => this.player(winner.playerId)!);
    const holder = mainPotWinners.find((player) => isSevenDeuce(player.hole));
    if (!holder) {
      return null;
    }
    const payers: { playerId: string; amount: number }[] = [];
    for (const player of this.players) {
      if (player === holder) {
        continue;
      }
      const amount = Math.min(this.rules.sevenDeuceBounty, player.stack);
      if (amount > 0) {
        player.stack -= amount;
        holder.stack += amount;
        payers.push({ playerId: player.id, amount });
      }
    }
    const total = payers.reduce((sum, payer) => sum + payer.amount, 0);
    this.log(`7-2! ${holder.name} vyhráva so 7-2 a od ostatných inkasuje bonus ${this.money(total)}`, 'bounty', holder.id);
    return { winnerId: holder.id, total, payers };
  }

  private complete(result: HandResult): void {
    this.result = result;
    this.street = 'complete';
    this.toActIndex = -1;
    this.awaitingRunout = false;
  }

  private postBlind(player: EnginePlayer, amount: number, label: string): void {
    const posted = Math.min(amount, player.stack);
    this.commit(player, posted);
    player.lastAction = `${label} ${this.money(posted)}`;
    this.log(`${player.name} dáva ${label} ${this.money(posted)}`, 'action', player.id);
  }

  /** Zmeškané blindy pri návrate: živý BB ako stávka, mŕtvy SB rovno do potu (najprv živá časť, potom mŕtva). */
  private postReturn(player: EnginePlayer, post: { live: number; dead: number }): void {
    const live = Math.min(post.live, player.stack);
    this.commit(player, live);
    const dead = Math.min(post.dead, player.stack);
    player.stack -= dead;
    player.dead += dead;
    if (player.stack === 0) {
      player.status = 'allin';
    }
    const parts = [`BB ${this.money(live)}`];
    if (dead > 0) {
      parts.push(`mŕtvy SB ${this.money(dead)}`);
    }
    player.lastAction = parts.join(' + ');
    this.log(`${player.name} dopláca zmeškané blindy: ${parts.join(' + ')}`, 'action', player.id);
  }

  private commit(player: EnginePlayer, amount: number): void {
    const real = Math.min(amount, player.stack);
    player.stack -= real;
    player.bet += real;
    player.total += real;
    if (player.stack === 0) {
      player.status = 'allin';
    }
  }

  private livePlayers(): EnginePlayer[] {
    return this.players.filter((player) => player.status !== 'folded');
  }

  private indexOfSeat(seat: number): number {
    return this.players.findIndex((player) => player.seat === seat);
  }

  private orderFrom(startIndex: number): EnginePlayer[] {
    const count = this.players.length;
    return Array.from({ length: count }, (_, offset) => this.players[(startIndex + offset) % count]);
  }

  private draw(): Card {
    const card = this.deck.shift();
    if (!card) {
      throw new Error('Deck is empty');
    }
    return card;
  }

  private log(text: string, kind: EngineLog['kind'], playerId?: string): void {
    this.pendingLog.push({ text, kind, playerId });
  }
}

/**
 * Pozície blindov pre hráčov rozdaných v ruke (`seats` = ich miesta, v ľubovoľnom poradí) a dealera.
 * Heads-up: dealer dáva SB. Rovnaké pravidlo používa engine aj stôl pri rozhodovaní o návrate hráčov.
 */
export function blindSeats(seats: number[], dealerSeat: number): { smallBlindSeat: number; bigBlindSeat: number } {
  const sorted = [...new Set(seats)].sort((left, right) => left - right);
  const dealerIndex = sorted.indexOf(dealerSeat);
  if (dealerIndex < 0 || sorted.length < 2) {
    throw new Error('Dealer must be one of at least two seats');
  }
  const smallBlindIndex = sorted.length === 2 ? dealerIndex : (dealerIndex + 1) % sorted.length;
  const bigBlindIndex = (smallBlindIndex + 1) % sorted.length;
  return { smallBlindSeat: sorted[smallBlindIndex], bigBlindSeat: sorted[bigBlindIndex] };
}

export function isSevenDeuce(hole: Card[]): boolean {
  if (hole.length !== 2) {
    return false;
  }
  const values = hole.map(rankValue).sort((left, right) => left - right);
  return values[0] === 2 && values[1] === 7;
}
