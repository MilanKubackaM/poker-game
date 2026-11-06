import { useEffect, useMemo, useState } from 'react';
import type { Card, TableEvent, TableView } from '../../../shared/types';
import { Lobby } from '../components/Lobby';
import type { TableHandlers, TableUiState } from '../components/TableScreen';
import { GameScreen } from '../components/WaitingRoom';
import { ConfirmHost } from '../components/ConfirmDialog';
import type { ChatToastItem } from '../hooks/useChatToasts';
import { MyHandsContext } from '../myHands';
import type { Profile } from '../storage';
import {
  DEMO_LEFT_TABLES,
  DEMO_TABLE_ERRORS,
  demoDeparted,
  demoDraw,
  demoEvents,
  demoModeIntro,
  demoMyHands,
  demoPiggy,
  demoHand,
  demoLeaderboard,
  demoLedger,
  demoPlayers,
  demoSummaries,
  demoView,
  lobbyEvents,
  lobbyLeaderboard,
  lobbyLedger,
  lobbyPlayers,
} from './fixtures';

function fakeCamera(color: string, emoji: string): MediaStream | null {
  const canvas = document.createElement('canvas');
  canvas.width = 240;
  canvas.height = 240;
  const context = canvas.getContext('2d');
  if (!context || !canvas.captureStream) {
    return null;
  }
  let frame = 0;
  const draw = () => {
    frame += 1;
    const gradient = context.createLinearGradient(0, 0, 240, 240);
    gradient.addColorStop(0, '#3b3f4a');
    gradient.addColorStop(1, color);
    context.fillStyle = gradient;
    context.fillRect(0, 0, 240, 240);
    context.fillStyle = 'rgba(255, 220, 160, 0.18)';
    context.beginPath();
    context.arc(190, 40, 70, 0, Math.PI * 2);
    context.fill();
    const sway = Math.sin(frame / 20) * 4;
    context.fillStyle = '#1c1d22';
    context.beginPath();
    context.ellipse(120 + sway, 250, 95, 75, 0, Math.PI, 0);
    context.fill();
    context.fillStyle = '#e0ac8a';
    context.beginPath();
    context.arc(120 + sway, 118, 46, 0, Math.PI * 2);
    context.fill();
    context.fillStyle = '#3a2a20';
    context.beginPath();
    context.ellipse(120 + sway, 84, 48, 24, 0, Math.PI, 0);
    context.fill();
    context.font = '28px serif';
    context.fillText(emoji, 12, 36);
  };
  draw();
  const timer = window.setInterval(draw, 66);
  const stream = canvas.captureStream(15);
  stream.getVideoTracks()[0]?.addEventListener('ended', () => window.clearInterval(timer));
  return stream;
}

const noop = () => undefined;
const handlers: TableHandlers = {
  onAction: noop,
  onDiscard: noop,
  onChat: async () => null,
  onToggleCamera: noop,
  onToggleMicrophone: noop,
  onSitOut: noop,
  onAway: noop,
  onReturn: noop,
  onModeAck: noop,
  onSeat: noop,
  onLeave: noop,
  onDrawAck: noop,
  onDrawPick: noop,
  onShowCards: noop,
  onRabbit: noop,
  onRuns: noop,
  host: {
    start: noop,
    pause: noop,
    dealerChoice: noop,
    saveSettings: async () => null,
    nextHand: noop,
    kick: noop,
    merge: noop,
    setBanker: noop,
    setAdmin: noop,
    piggy: noop,
    toLobby: noop,
    deleteTable: async () => null,
    resolveJoin: noop,
  },
  bank: {
    chips: async () => null,
    settle: async () => null,
    undo: async () => null,
  },
};

interface Scenario {
  view: TableView;
  ui?: TableUiState;
  events?: TableEvent[];
  chatToasts?: ChatToastItem[];
  /** Hráči, ktorí v deme „hovoria“ (zelený okraj); `?speaking=p1,p2` to prepíše. */
  speaking?: string[];
}

const SCREENS = [
  'lobby',
  'invite',
  'room',
  'room-guest',
  'dealer-choice',
  'draw-explain',
  'draw-pick',
  'draw-done',
  'table',
  'omaha',
  'pineapple',
  'showdown',
  'chat',
  'transactions',
  'menu',
  'host-game',
  'host-rules',
  'host-players',
  'my-tables',
  'delete-table',
  'leaderboard',
  'history',
  'cashout',
  'cashout-guest',
  'rabbit',
  'pre-actions',
  'run-vote',
  'run-twice',
  'to-lobby',
  'chat-toasts',
  'away',
  'return-dialog',
  'mode-intro-piggy',
  'mode-intro-omaha',
  'piggy',
  'piggy-won',
  'host-piggy',
  'room-piggy',
  'timebank',
  'timebank-full',
  'room-playing',
  'omaha-showdown',
  'table-roles',
  'speaking',
  'seat-menu',
  'seat-menu-guest',
  'merge-dialog',
  'host-departed',
  'room-departed',
  'host-modes',
  'help',
];

/** Stôl pred prvou rukou: čakacia miestnosť (`lobby`) alebo losovanie o dealer button (`draw`). */
function preGameView(overrides: Partial<TableView>): TableView {
  return demoView({
    running: false,
    players: lobbyPlayers(),
    hand: null,
    legal: null,
    ledger: lobbyLedger(),
    phase: 'lobby',
    history: [],
    leaderboard: lobbyLeaderboard(),
    ...overrides,
  });
}

function drawEvents(...texts: [string, string?][]): TableEvent[] {
  return [...lobbyEvents(), ...texts.map(([text, playerId], index) => ({ id: 1000 + index, at: Date.now(), kind: 'info' as const, text, playerId }))];
}

function scenario(screen: string): Scenario | null {
  switch (screen) {
    case 'table':
      return { view: demoView() };
    case 'table-roles':
      return { view: demoView({ bankerId: 'p3' }) };
    case 'speaking':
      return { view: demoView({ legal: null, hand: demoHand({ toActId: 'p3' }) }), speaking: ['p1', 'p4'] };
    case 'help':
      return { view: demoView({ legal: null, hand: demoHand({ toActId: 'p3' }) }), ui: { helpChapter: new URLSearchParams(window.location.search).get('chapter') ?? 'start' } };
    case 'host':
    case 'host-game':
      return { view: demoView({ nextHand: { variant: 'omaha' }, settings: { ...demoView().settings, sevenDeuceAlways: true } }), ui: { hostOpen: true, hostTab: 'game' } };
    case 'to-lobby':
      return {
        view: demoView({ legal: null, hand: demoHand({ toActId: 'p3' }), returnToLobbyPending: true, settings: { ...demoView().settings, sevenDeuceAlways: true } }),
        ui: { hostOpen: true, hostTab: 'game' },
      };
    case 'leaderboard': {
      const players = lobbyPlayers().map((player) => ({ ...player, stack: demoLeaderboard().find((row) => row.playerId === player.id)?.stack ?? player.stack }));
      return { view: demoView({ running: false, players, hand: null, legal: null, ledger: demoLedger(), phase: 'lobby' }), events: lobbyEvents(), ui: { statsTab: 'leaderboard' } };
    }
    case 'cashout':
    case 'cashout-guest': {
      const leaderboard = demoLeaderboard().map((row) => (row.playerId === 'p5' ? { ...row, stack: row.stack + 670, result: row.result + 670 } : row));
      const players = lobbyPlayers().map((player) => ({ ...player, stack: leaderboard.find((row) => row.playerId === player.id)?.stack ?? player.stack }));
      return {
        view: demoView({ running: false, players, hand: null, legal: null, ledger: demoLedger(), leaderboard, phase: 'lobby', youId: screen === 'cashout' ? 'me' : 'p2' }),
        events: lobbyEvents(),
        ui: { statsTab: 'cashout' },
      };
    }
    case 'rabbit':
    case 'rabbit-offer': {
      const players = demoPlayers().map((player) => ({ ...player, bet: 0, status: player.id === 'p1' ? ('active' as const) : ('folded' as const) }));
      return {
        view: demoView({
          players,
          hand: demoHand({ street: 'complete', board: ['Qh', '7h', '2h'] as Card[], toActId: null, turnDeadline: null }),
          legal: null,
          lastResult: { handNumber: 27, winners: [{ playerId: 'p1', amount: 2200, potIndex: 0, handDescription: null, bestCards: [] }], bounty: null, revealed: {}, wonWithoutShowdown: true },
          nextHandAt: Date.now() + 4000,
          rabbit: screen === 'rabbit' ? { handNumber: 27, cards: ['Kd', '9h'] as Card[], playerId: 'p3', playerName: 'Zuzka', until: Date.now() + 60_000 } : null,
        }),
      };
    }
    case 'run-vote':
    case 'run-twice': {
      const twice = screen === 'run-twice';
      const players = demoPlayers().map((player) => {
        if (player.id === 'me') {
          return { ...player, bet: 0, status: 'allin' as const, cards: ['Ah', 'Kd'] as Card[] };
        }
        if (player.id === 'p3') {
          return { ...player, bet: 0, status: 'active' as const, cards: ['Qs', 'Qd'] as Card[] };
        }
        return { ...player, bet: 0, status: 'folded' as const, cards: player.cards.map(() => null) };
      });
      return {
        view: demoView({
          players,
          legal: null,
          hand: demoHand({
            toActId: null,
            turnDeadline: null,
            street: twice ? 'complete' : 'preflop',
            board: twice ? (['Qh', '7h', '2s', 'Ac', '9d'] as Card[]) : [],
            ...(twice ? { extraBoards: [['Ks', '5c', '8h', '3d', 'Jc'] as Card[]], runs: 2, runoutBase: 0 } : {}),
          }),
          lastResult: twice
            ? {
                handNumber: 27,
                winners: [
                  { playerId: 'p3', amount: 1100, potIndex: 0, handDescription: 'Trojica — dámy', bestCards: [], run: 0 },
                  { playerId: 'me', amount: 1100, potIndex: 0, handDescription: 'Pár — králi', bestCards: [], run: 1 },
                ],
                bounty: null,
                revealed: {},
                wonWithoutShowdown: false,
              }
            : null,
          runVote: twice ? null : { handNumber: 27, participants: ['me', 'p3'], choices: { p3: 3 }, maxRuns: 3, deadline: Date.now() + 9000 },
        }),
      };
    }
    case 'pre-actions':
      return { view: demoView({ legal: null, hand: demoHand({ toActId: 'p3' }) }) };
    case 'chat-toasts':
      return {
        view: demoView({ legal: null, hand: demoHand({ toActId: 'p3' }) }),
        ui: { sideTab: 'log' },
        chatToasts: [
          { id: 901, playerId: 'p1', text: 'Kto mi požičia na ďalší buy-in? 😅', kind: 'chat', leaving: false },
          { id: 904, text: 'Host vyhlasuje špeciálne kolo: Omaha na 3 kolá od ďalšej ruky', kind: 'mode', leaving: false },
          {
            id: 902,
            playerId: 'p3',
            text: 'Milan, ten river bol fakt drzý. Nabudúce ti to vrátim s úrokmi, sľubujem — a pošli mi potom aj tú fotku z minulého piatku, tú kde Peťo spí na gauči',
            kind: 'chat',
            leaving: false,
          },
          { id: 903, playerId: 'p2', text: 'idem si po pivo, beriem aj vám?', kind: 'chat', leaving: false },
        ],
      };
    case 'history':
      return { view: demoView({ legal: null, hand: demoHand({ toActId: 'p3' }) }), ui: { chatOpen: true, sideTab: 'history' } };
    case 'host-rules':
      return { view: demoView(), ui: { hostOpen: true, hostTab: 'rules' } };
    case 'delete-table':
      return { view: preGameView({}), events: lobbyEvents(), ui: { deleteOpen: true } };
    case 'host-players':
      return { view: demoView(), ui: { hostOpen: true, hostTab: 'players' } };
    case 'transactions':
      return { view: demoView({ legal: null, hand: demoHand({ toActId: 'p3' }) }), ui: { chatOpen: true, sideTab: 'ledger' } };
    case 'chat':
      return { view: demoView({ legal: null, hand: demoHand({ toActId: 'p3' }) }), ui: { chatOpen: true } };
    case 'menu':
      return { view: demoView({ legal: null, hand: demoHand({ toActId: 'p3' }) }), ui: { menuOpen: true } };
    case 'omaha': {
      const players = demoPlayers().map((player) => ({
        ...player,
        cards: player.id === 'me' ? (['Ah', 'Kd', '8h', '7c'] as Card[]) : player.status === 'folded' ? [] : [null, null, null, null],
        cardCount: 4,
        handDescription: player.id === 'me' ? 'Postupka do esa' : null,
      }));
      return {
        view: demoView({
          players,
          hand: demoHand({
            rules: { variant: 'omaha', structure: 'pot-limit', sevenDeuce: false, sevenDeuceBounty: 40, smallBlind: 10, bigBlind: 20 },
            board: ['Qh', 'Js', 'Tc', '3d'] as Card[],
            street: 'turn',
          }),
          legal: { canFold: true, canCheck: false, callAmount: 120, canBet: false, canRaise: true, minRaiseTo: 240, maxRaiseTo: 2560, currentBet: 120 },
        }),
      };
    }
    case 'pineapple': {
      const players = demoPlayers().map((player) => ({
        ...player,
        bet: 0,
        lastAction: player.status === 'folded' ? 'Fold' : 'Call 0,20 €',
        cards: player.id === 'me' ? (['7c', '2d', 'Ks'] as Card[]) : player.status === 'folded' ? [] : player.id === 'p1' ? [null, null] : [null, null, null],
        cardCount: player.id === 'p1' ? 2 : 3,
        handDescription: null,
        hasDiscarded: player.id === 'p1',
      }));
      return {
        view: demoView({
          players,
          hand: demoHand({
            rules: { variant: 'pineapple', structure: 'no-limit', sevenDeuce: true, sevenDeuceBounty: 40, smallBlind: 10, bigBlind: 20 },
            street: 'discard',
            board: [],
            toActId: null,
            turnDeadline: null,
            discardDeadline: Date.now() + 14_000,
            totalPot: 100,
            pots: [{ amount: 100, eligible: [] }],
          }),
          legal: null,
        }),
      };
    }
    case 'showdown': {
      const players = demoPlayers().map((player) => {
        if (player.id === 'p1') {
          return { ...player, bet: 0, cards: ['7d', '2c'] as Card[], stack: 1810 + 2200 + 200, handDescription: 'Full house — sedmičky a dvojky' };
        }
        if (player.id === 'me') {
          return { ...player, bet: 0, cards: ['Ah', 'Kd'] as Card[], handDescription: 'Pár — sedmičky', stack: 2300 };
        }
        if (player.id === 'p3') {
          return { ...player, bet: 0, cards: ['Qs', 'Jd'] as Card[], handDescription: 'Dva páry — dámy a sedmičky', stack: 3080 };
        }
        if (player.id === 'p4') {
          return { ...player, bet: 0, cards: ['9c', '9d'] as Card[], handDescription: 'Dva páry — deviatky a sedmičky' };
        }
        return { ...player, bet: 0 };
      });
      return {
        view: demoView({
          players,
          hand: demoHand({
            street: 'complete',
            board: ['Qh', '7h', '2s', '7s', '4d'] as Card[],
            toActId: null,
            turnDeadline: null,
            rules: { variant: 'holdem', structure: 'no-limit', sevenDeuce: true, sevenDeuceBounty: 40, smallBlind: 10, bigBlind: 20 },
          }),
          legal: null,
          lastResult: {
            handNumber: 27,
            winners: [{ playerId: 'p1', amount: 2200, potIndex: 0, handDescription: 'Full house — sedmičky a dvojky', bestCards: ['7d', '2c', '7h', '7s', '2s'] as Card[] }],
            bounty: { winnerId: 'p1', total: 200, payers: [] },
            revealed: {},
            wonWithoutShowdown: false,
          },
          nextHandAt: Date.now() + 4000,
        }),
      };
    }
    case 'omaha-showdown': {
      const hands: Record<string, [Card[], string]> = {
        me: [['Ah', 'Kd', '8h', '7c'] as Card[], 'Postupka do esa'],
        p1: [['Tc', '9d', 'Qs', '2h'] as Card[], 'Dva páry — dámy a desiatky'],
        p3: [['Kh', 'Kc', '5s', '4d'] as Card[], 'Trojica — králi'],
        p4: [['Jh', 'Jc', '6s', '6d'] as Card[], 'Trojica — dolníky'],
      };
      const players = demoPlayers().map((player) => {
        const hand = hands[player.id];
        return hand
          ? { ...player, bet: 0, cards: hand[0], cardCount: 4, handDescription: hand[1], status: player.status === 'allin' ? player.status : ('active' as const) }
          : { ...player, bet: 0 };
      });
      return {
        view: demoView({
          players,
          hand: demoHand({
            street: 'complete',
            board: ['Qh', 'Js', 'Tc', 'Kd', '3d'] as Card[],
            toActId: null,
            turnDeadline: null,
            rules: { variant: 'omaha', structure: 'pot-limit', sevenDeuce: false, sevenDeuceBounty: 40, smallBlind: 10, bigBlind: 20 },
          }),
          legal: null,
          lastResult: {
            handNumber: 27,
            winners: [{ playerId: 'me', amount: 2200, potIndex: 0, handDescription: 'Postupka do esa', bestCards: ['Ah', '8h', 'Qh', 'Js', 'Tc'] as Card[] }],
            bounty: null,
            revealed: {},
            wonWithoutShowdown: false,
          },
          nextHandAt: Date.now() + 4000,
        }),
      };
    }
    case 'room':
    case 'waiting':
      return { view: preGameView({}), events: lobbyEvents() };
    case 'room-guest':
      return { view: preGameView({ youId: 'p2' }), events: lobbyEvents() };
    case 'dealer-choice':
      return { view: preGameView({ phase: 'draw', draw: demoDraw() }), events: drawEvents(['Host spustil hru — rozhoduje sa o dealer buttone']) };
    case 'draw-explain':
      return {
        view: preGameView({ phase: 'draw', draw: demoDraw({ stage: 'explain', acknowledged: ['p1', 'p3', 'p5'], deadline: Date.now() + 47_000 }) }),
        events: drawEvents(['Host zvolil losovanie o dealer button — najprv si všetci prečítajte pravidlá']),
      };
    case 'draw-pick':
      return {
        view: preGameView({
          phase: 'draw',
          draw: demoDraw(
            { stage: 'drawing', acknowledged: ['me', 'p1', 'p2', 'p3', 'p5'], deadline: Date.now() + 23_000 },
            { 17: ['p1', 'Kh'], 40: ['p2', '7c'], 6: ['p5', 'Qd'] },
          ),
        }),
        events: drawEvents(['Juraj si vytiahol K♥', 'p1'], ['Michal si vytiahol 7♣', 'p2'], ['Katka nestihol ťahať — automaticky dostal Q♦', 'p5']),
      };
    case 'draw-done':
      return {
        view: preGameView({
          phase: 'draw',
          draw: demoDraw(
            { stage: 'done', acknowledged: ['me', 'p1', 'p2', 'p3', 'p5'], deadline: Date.now() + 3_000, winnerId: 'p1' },
            { 17: ['p3', 'Kh'], 40: ['p1', 'As'], 6: ['p5', 'Qd'], 28: ['me', 'Ah'], 51: ['p2', '4c'] },
          ),
        }),
        events: drawEvents(['Juraj vyhral losovanie s A♠ a dostáva dealer button', 'p1']),
      };
    case 'away': {
      const players = demoPlayers().map((player) =>
        player.id === 'me' ? { ...player, away: true, status: 'folded' as const, lastAction: 'Fold', handDescription: null } : player,
      );
      return { view: demoView({ players, legal: null, hand: demoHand({ toActId: 'p3' }) }) };
    }
    case 'return-dialog': {
      const players = demoPlayers().map((player) =>
        player.id === 'me'
          ? {
              ...player,
              sittingOut: true,
              inHand: false,
              status: null,
              cards: [],
              cardCount: 0,
              handDescription: null,
              missedBlinds: 'small-and-big' as const,
              returnMode: 'post' as const,
            }
          : player.id === 'p2'
            ? { ...player, sittingOut: true, inHand: false, status: null, cards: [], cardCount: 0, lastAction: null, missedBlinds: 'big' as const, returnMode: 'wait-bb' as const }
            : player,
      );
      return { view: demoView({ players, legal: null, hand: demoHand({ toActId: 'p3' }) }), ui: { returnOpen: true } };
    }
    case 'mode-intro-piggy':
    case 'mode-intro-omaha': {
      const piggyMode = screen === 'mode-intro-piggy';
      const players = demoPlayers().map((player) => ({ ...player, inHand: false, status: null, bet: 0, cards: [], cardCount: 0, lastAction: null, handDescription: null }));
      return {
        view: demoView({
          players,
          hand: null,
          legal: null,
          nextHand: piggyMode ? null : { variant: 'omaha' },
          piggy: piggyMode ? demoPiggy({ amount: 0, wins: {}, contributed: {}, startedAtHand: 28 }) : null,
          modeIntro: demoModeIntro(piggyMode ? {} : { mode: 'omaha', acknowledged: ['me', 'p1', 'p3'] }),
          settings: { ...demoView().settings, sevenDeuceAlways: true },
        }),
      };
    }
    case 'piggy':
      return { view: demoView({ piggy: demoPiggy() }) };
    case 'timebank': {
      // Milanovi vypršal základný čas pred 3 s — z timebanku 50 s ostáva 47 s.
      const now = Date.now();
      return { view: demoView({ hand: demoHand({ turnBaseDeadline: now - 3_000, turnDeadline: now + 47_000 }) }) };
    }
    case 'timebank-full': {
      // Plný stôl, každý má stávku; `?turn=<id>` určí, kto je na ťahu (kontrola prekryvu odpočtu so stávkou na všetkých 9 miestach).
      const turn = new URLSearchParams(window.location.search).get('turn') ?? 'me';
      const extra = [
        { id: 'p6', name: 'Oli', seat: 2, emoji: '🐸', color: '#4caf50' },
        { id: 'p7', name: 'Dana', seat: 5, emoji: '🐙', color: '#f4a261' },
        { id: 'p8', name: 'Rasťo', seat: 8, emoji: '🦁', color: '#6d597a' },
      ].map(({ emoji, color, ...rest }) => ({
        ...demoPlayers()[2],
        ...rest,
        avatar: { emoji, color },
        status: 'active' as const,
        cards: [null, null],
        lastAction: 'Call 12,40 €',
      }));
      const allVideo = new URLSearchParams(window.location.search).get('video') === '1';
      const players = [...demoPlayers(), ...extra].map((player) => ({
        ...player,
        status: player.status === 'allin' ? player.status : ('active' as const),
        connected: true,
        bet: 1240,
        lastAction: 'Raise 12,40 €',
        camera: allVideo || player.camera,
      }));
      const now = Date.now();
      return { view: demoView({ players, hand: demoHand({ toActId: turn, turnBaseDeadline: now - 3_000, turnDeadline: now + 47_000 }) }) };
    }
    case 'room-playing': {
      // Milan odišiel od stola do čakárne, ostatní hrajú ďalej.
      const players = demoPlayers().map((player) =>
        player.id === 'me' ? { ...player, sittingOut: true, inHand: false, status: 'folded' as const, cards: [], bet: 0, missedBlinds: 'big' as const, lastAction: null } : player,
      );
      return { view: demoView({ players, legal: null, hand: demoHand({ toActId: 'p3' }) }), ui: { roomView: true } };
    }
    case 'host-piggy':
      return { view: demoView({ piggy: demoPiggy() }), ui: { hostOpen: true, hostTab: 'game' } };
    case 'seat-menu':
    case 'merge-dialog': {
      // Katka je offline a nie je v ruke — host ju môže zlúčiť do iného hráča.
      const players = demoPlayers().map((player) => (player.id === 'p5' ? { ...player, inHand: false, status: null, lastAction: null } : player));
      return { view: demoView({ players, departed: demoDeparted() }), ui: screen === 'seat-menu' ? { seatMenu: 'p5' } : { mergeFrom: 'p5' } };
    }
    case 'seat-menu-guest':
      return { view: demoView({ youId: 'p2', legal: null }), ui: { seatMenu: 'p3' } };
    case 'host-departed':
      return { view: demoView({ departed: demoDeparted() }), ui: { hostOpen: true, hostTab: 'players' } };
    case 'room-departed':
      return { view: preGameView({ departed: demoDeparted() }), events: lobbyEvents() };
    case 'host-modes':
      // Séria 5 hier, beží 3. hra.
      return {
        view: demoView({ nextHand: { variant: 'pineapple', permanent: true }, piggy: demoPiggy({ series: { remaining: 3, permanent: false, stopping: false, total: 5 } }) }),
        ui: { hostOpen: true, hostTab: 'game' },
      };
    case 'room-piggy': {
      const players = lobbyPlayers().map((player) => (player.id === 'p2' ? { ...player, away: true } : player.id === 'p3' ? { ...player, sittingOut: true } : player));
      return {
        view: preGameView({ players, piggy: demoPiggy({ contributed: { me: 80, p1: 80, p2: 80, p3: 80, p5: 80 }, wins: { me: 1, p1: 2, p3: 1 } }) }),
        events: lobbyEvents(),
      };
    }
    case 'piggy-won': {
      const players = demoPlayers().map((player) => {
        if (player.id === 'p1') {
          return { ...player, bet: 0, cards: ['Kc', 'Kd'] as Card[], stack: 1810 + 2200 + 600, handDescription: 'Trojica — králi' };
        }
        if (player.id === 'me') {
          return { ...player, bet: 0, cards: ['Ah', 'Qd'] as Card[], handDescription: 'Pár — dámy', stack: 2300 };
        }
        return { ...player, bet: 0 };
      });
      return {
        view: demoView({
          players,
          hand: demoHand({ street: 'complete', board: ['Qh', 'Ks', '2s', '7c', '4d'] as Card[], toActId: null, turnDeadline: null }),
          legal: null,
          lastResult: {
            handNumber: 27,
            winners: [{ playerId: 'p1', amount: 2200, potIndex: 0, handDescription: 'Trojica — králi', bestCards: ['Kc', 'Kd', 'Ks', 'Qh', '7c'] as Card[] }],
            bounty: null,
            revealed: {},
            wonWithoutShowdown: false,
          },
          nextHandAt: Date.now() + 5000,
          piggy: demoPiggy({
            status: 'finished',
            amount: 600,
            wins: { me: 1, p1: 3, p3: 2, p2: 0, p4: 0, p5: 0 },
            winners: [{ playerId: 'p1', playerName: 'Juraj', amount: 600 }],
          }),
        }),
      };
    }
    default:
      return null;
  }
}

/** Demo nemá server — moje karty v histórii sú ukážkové (inak by sa História pokúsila pripojiť cez socket). */
const loadDemoMyHands = () => Promise.resolve(demoMyHands());

export function DemoApp({ screen }: { screen: string }) {
  const [profile, setProfile] = useState<Profile>({ name: 'Milan', avatar: { emoji: '🦊', color: '#e76f51' } });
  const data = useMemo(() => scenario(screen || 'table'), [screen]);
  const [streams, setStreams] = useState<Map<string, MediaStream>>(new Map());
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);

  useEffect(() => {
    if (!data) {
      return;
    }
    const next = new Map<string, MediaStream>();
    for (const player of data.view.players) {
      if (player.camera && player.id !== 'me') {
        const stream = fakeCamera(player.avatar.color, player.avatar.emoji);
        if (stream) {
          next.set(player.id, stream);
        }
      }
    }
    setStreams(next);
    setLocalStream(fakeCamera('#e76f51', '🦊'));
  }, [data]);

  if (screen === 'lobby' || screen === 'invite' || screen === 'my-tables') {
    return (
      <Lobby
        profile={profile}
        onProfileChange={setProfile}
        inviteCode={screen === 'invite' ? 'K7QX2M' : null}
        busy={false}
        error={null}
        onCreate={noop}
        onJoin={noop}
        onCancelInvite={noop}
        myTables={screen === 'my-tables' ? demoSummaries() : []}
        leftTables={screen === 'my-tables' ? DEMO_LEFT_TABLES : []}
        tableErrors={screen === 'my-tables' ? DEMO_TABLE_ERRORS : {}}
        notice={screen === 'my-tables' ? { text: 'Žetóny 18,60 € ostávajú uložené pri stole „Utorková partia“.', tone: 'info' } : null}
        onDismissNotice={noop}
        onResumeTable={noop}
        onForgetTable={noop}
      />
    );
  }

  if (!data) {
    return <div className="loading-screen">Demo obrazovky: {SCREENS.join(', ')}</div>;
  }

  return (
    <MyHandsContext.Provider value={loadDemoMyHands}>
      <ConfirmHost />
      <GameScreen
        view={data.view}
        events={data.events ?? demoEvents()}
        streams={streams}
        localStream={localStream}
        speaking={new Set(new URLSearchParams(window.location.search).get('speaking')?.split(',') ?? data.speaking ?? [])}
        camera
        microphone
        mediaError={null}
        clockOffset={0}
        handlers={handlers}
        inviteUrl={`${window.location.origin}/t/${data.view.code}`}
        initialUi={data.ui}
        toast={null}
        chatToasts={data.chatToasts}
        onClearChatToasts={noop}
      />
    </MyHandsContext.Provider>
  );
}
