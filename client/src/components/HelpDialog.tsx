import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { Card, SeatPlayerView, TableView } from '../../../shared/types';
import { DISCARD_TIMEOUT_SEC, JUKEBOX_MAX_DURATION_SEC, JUKEBOX_MAX_QUEUE, MAX_PIGGY_GAMES, MAX_SPECIAL_HANDS, MODE_INTRO_TIMEOUT_SEC, PIGGY_TARGET_WINS, RABBIT_SHOW_MS, RUN_VOTE_SEC, TIME_BANK_MAX_SEC, VARIANT_LABELS } from '../../../shared/constants';
import { formatMoney } from '../../../shared/money';
import { modeInfo, piggySeriesLabel, PiggyDots, specialRoundLabel, type ModeInfo } from './GameModes';
import { RoleBadge, playerRoles, type PlayerRoles } from './HostPlayers';
import { MicIcon } from './MicIcon';
import { PlayingCard } from './PlayingCard';
import '../help.css';

/** Čo kapitola potrebuje zo stola: nastavenia, roly, ja. */
interface HelpContext {
  view: TableView;
  me: SeatPlayerView | null;
  roles: PlayerRoles;
  money: (cents: number) => string;
  nameOf: (playerId: string) => string;
}

interface Chapter {
  id: string;
  group: string;
  icon: string;
  title: string;
  body: (ctx: HelpContext) => ReactNode;
  /** Box „Pri tomto stole“ — reálny stav k téme kapitoly; null = box sa neukáže. */
  atTable?: (ctx: HelpContext) => ReactNode | null;
}

/* ---------- Stavebné kamene ---------- */

function Shot({ name, alt, caption, onZoom }: { name: string; alt: string; caption?: ReactNode; onZoom: (src: string, alt: string) => void }) {
  const src = `/help/${name}.webp`;
  return (
    <figure className="help-shot">
      <button type="button" className="help-shot-button" onClick={() => onZoom(src, alt)} title="Zväčšiť">
        <img src={src} alt={alt} loading="lazy" decoding="async" />
      </button>
      {caption && <figcaption>{caption}</figcaption>}
    </figure>
  );
}

function Steps({ items }: { items: ReactNode[] }) {
  return (
    <ol className="help-steps">
      {items.map((item, index) => (
        <li key={index}>{item}</li>
      ))}
    </ol>
  );
}

function Points({ items }: { items: ReactNode[] }) {
  return (
    <ul className="help-points">
      {items.map((item, index) => (
        <li key={index}>{item}</li>
      ))}
    </ul>
  );
}

function ModeRules({ info }: { info: ModeInfo }) {
  return (
    <>
      <p className="help-lead">
        <span className="help-lead-icon" aria-hidden>
          {info.icon}
        </span>
        {info.lead}
      </p>
      <Steps items={info.rules} />
    </>
  );
}

function Cards({ cards, highlight = [] }: { cards: Card[]; highlight?: Card[] }) {
  return (
    <span className="help-cards">
      {cards.map((card) => (
        <PlayingCard key={card} card={card} size="sm" highlight={highlight.includes(card)} />
      ))}
    </span>
  );
}

const HAND_RANKS: { name: string; note: string; cards: Card[] }[] = [
  { name: 'Kráľovská postupka', note: '10 až eso v jednej farbe', cards: ['Ah', 'Kh', 'Qh', 'Jh', 'Th'] },
  { name: 'Postupka vo farbe', note: 'päť po sebe v jednej farbe', cards: ['9s', '8s', '7s', '6s', '5s'] },
  { name: 'Poker', note: 'štyri rovnaké', cards: ['Qc', 'Qd', 'Qh', 'Qs', '4d'] },
  { name: 'Full house', note: 'trojica + pár', cards: ['Jh', 'Js', 'Jd', '8c', '8h'] },
  { name: 'Farba', note: 'päť v jednej farbe', cards: ['Ad', 'Jd', '9d', '6d', '2d'] },
  { name: 'Postupka', note: 'päť po sebe', cards: ['Tc', '9d', '8h', '7s', '6c'] },
  { name: 'Trojica', note: 'tri rovnaké', cards: ['7c', '7d', '7h', 'Ks', '2d'] },
  { name: 'Dva páry', note: '', cards: ['Ah', 'As', '5c', '5d', 'Jh'] },
  { name: 'Pár', note: '', cards: ['Kd', 'Kc', '9s', '6h', '3c'] },
  { name: 'Vyššia karta', note: 'nič z vyššie uvedeného', cards: ['Ac', 'Qd', '8s', '5h', '3c'] },
];

function HandRanks() {
  return (
    <ol className="help-ranks">
      {HAND_RANKS.map((rank) => (
        <li key={rank.name}>
          <span className="help-rank-name">
            <strong>{rank.name}</strong>
            {rank.note && <small>{rank.note}</small>}
          </span>
          <Cards cards={rank.cards} />
        </li>
      ))}
    </ol>
  );
}

/** Živá ukážka označenia hovoriaceho hráča — tie isté štýly ako pri stole. */
function SpeakingDemo() {
  return (
    <div className="help-demo-row" aria-hidden>
      <span className="help-demo-player">
        <span className="room-portrait speaking" style={{ background: '#2a9d8f' }}>
          <span className="room-emoji">🐼</span>
          <span className="seat-speaking-mic">
            <MicIcon size={14} />
          </span>
        </span>
        <small>hovorí</small>
      </span>
      <span className="help-demo-player">
        <span className="room-portrait" style={{ background: '#8e7dbe' }}>
          <span className="room-emoji">🦉</span>
        </span>
        <small>ticho</small>
      </span>
    </div>
  );
}

function RolesDemo() {
  const roles = { ownerId: 'owner', bankerId: 'banker', isAdmin: (id: string) => id === 'owner' || id === 'cohost' };
  return (
    <div className="help-roles-demo" aria-hidden>
      <span className="help-role-sample">
        <RoleBadge playerId="owner" roles={roles} />
        Zakladateľ
      </span>
      <span className="help-role-sample">
        <RoleBadge playerId="cohost" roles={roles} />
        Spoluhost
      </span>
      <span className="help-role-sample">
        <RoleBadge playerId="banker" roles={roles} />
        Bankár
      </span>
      <span className="help-role-sample">
        <RoleBadge playerId="owner" roles={{ ...roles, bankerId: 'owner' }} />
        Zakladateľ a bankár
      </span>
    </div>
  );
}

/* ---------- Kapitoly ---------- */

function chapters(zoom: (src: string, alt: string) => void): Chapter[] {
  const shot = (name: string, alt: string, caption?: ReactNode) => <Shot name={name} alt={alt} caption={caption} onZoom={zoom} />;
  return [
    {
      id: 'start',
      group: 'Začíname',
      icon: '🚀',
      title: 'Rýchly štart',
      body: () => (
        <>
          <Steps
            items={[
              <>
                Host založí stôl a pošle odkaz (<strong>🔗 Pozvať</strong>). Nový hráč z odkazu <strong>požiada o prístup</strong> a host ho pustí.
              </>,
              <>
                Pri príchode máš <strong>0 žetónov</strong>. Žetóny ti dá <strong>bankár 🏦</strong> — povedz mu, koľko chceš.
              </>,
              <>
                Host spustí hru (<strong>♛ Host → Spustiť hru</strong>). Dealer button sa určí losovaním alebo náhodne.
              </>,
              <>
                Ruky sa rozdávajú samy. Na ťah máš <strong>základný čas + osobný timebank</strong>.
              </>,
              <>
                Na chvíľu preč? Daj <strong>☕ Krátku pauzu</strong>. Na dlhšie sa <strong>postav od stola</strong>.
              </>,
              <>
                Na konci je vo <strong>Výsledkoch stola → Cashout</strong>, kto komu koľko pošle.
              </>,
            ]}
          />
          {shot('room', 'Čakacia miestnosť stola s hráčmi a pravidlami', 'Čakáreň stola — hráči, ich žetóny a roly, vpravo pravidlá a chat')}
        </>
      ),
      atTable: ({ view, money, roles, nameOf }) => (
        <>
          {VARIANT_LABELS[view.settings.defaultVariant]} · blindy {money(view.settings.smallBlind)}/{money(view.settings.bigBlind)} · host <strong>{nameOf(roles.ownerId)}</strong> · bankár <strong>{nameOf(roles.bankerId)}</strong> ·{' '}
          {view.phase === 'lobby' ? 'hra ešte nezačala' : view.running ? 'hra beží' : 'hra je pozastavená'}
        </>
      ),
    },
    {
      id: 'holdem',
      group: 'Začíname',
      icon: '♠',
      title: "Ako sa hrá Texas Hold'em",
      body: () => (
        <>
          <Points
            items={[
              <>
                Každý dostane <strong>2 karty</strong>. Na stôl postupne prídu 3 (<strong>flop</strong>), 1 (<strong>turn</strong>) a 1 (<strong>river</strong>).
              </>,
              <>
                Pred rozdaním vložia dvaja hráči naľavo od dealera (<strong>D</strong>) povinné stávky: <strong>small blind (SB)</strong> a <strong>big blind (BB)</strong>.
              </>,
              <>
                Na ťahu môžeš <strong>Fold</strong> (zahodiť), <strong>Check</strong> (nič nevložiť, ak nikto nestavil), <strong>Call</strong> (dorovnať) alebo <strong>Raise</strong> (zvýšiť — najmenej o toľko, o koľko zvýšil posledný).
              </>,
              <>
                Vyhráva najlepšia <strong>päťkartová kombinácia</strong> zo 7 kariet (2 v ruke + 5 na stole). Hrá sa <strong>no-limit</strong> — all-in môžeš dať kedykoľvek.
              </>,
            ]}
          />
          {shot('table', 'Stôl počas ruky, si na ťahu', 'Si na ťahu: dole tvoje karty a akcie Fold / Call / Raise, pri hráčoch D, SB a BB')}
          <h4 className="help-subtitle">Poradie kombinácií (od najvyššej)</h4>
          <HandRanks />
        </>
      ),
      atTable: ({ view, money }) => (
        <>
          Small blind <strong>{money(view.settings.smallBlind)}</strong> · big blind <strong>{money(view.settings.bigBlind)}</strong>
        </>
      ),
    },
    {
      id: 'omaha',
      group: 'Herné módy',
      icon: '🃏',
      title: 'Omaha',
      body: ({ view }) => (
        <>
          <ModeRules info={modeInfo('omaha', view.settings, view.piggy ?? null)} />
          <p className="help-example">
            Príklad: <Cards cards={['Ah', 'Kh', 'Qh', 'Jh']} /> v ruke a jedno srdce na stole <strong>nie je farba</strong> — z ruky sa berú presne 2 karty, takže treba 3 srdcia na stole.
          </p>
          {shot('omaha', 'Omaha — 4 karty v ruke', 'Omaha: 4 karty v ruke, pri pot-limite tlačidlo „Max“ namiesto All-in')}
        </>
      ),
      atTable: ({ view }) => <>Omaha sa pri tomto stole hrá ako {view.settings.omahaPotLimit ? <strong>pot-limit</strong> : <strong>no-limit</strong>}</>,
    },
    {
      id: 'pineapple',
      group: 'Herné módy',
      icon: '🍍',
      title: 'Pineapple',
      body: ({ view }) => (
        <>
          <ModeRules info={modeInfo('pineapple', view.settings, view.piggy ?? null)} />
          <p className="help-note">Na krátkej pauze sa karta zahodí za teba hneď. Bez výberu sa po {DISCARD_TIMEOUT_SEC} s zahodí <strong>náhodná</strong> karta.</p>
          {shot('pineapple', 'Pineapple — výber karty na zahodenie', 'Pineapple: ťukni na kartu, ktorú zahodíš, a potvrď')}
        </>
      ),
    },
    {
      id: 'special',
      group: 'Herné módy',
      icon: '✨',
      title: 'Špeciálne kolo',
      body: () => (
        <>
          <Points
            items={[
              <>
                Host môže počas hry vyhlásiť <strong>Omahu alebo Pineapple</strong> na jednu alebo viac nasledujúcich rúk (najviac {MAX_SPECIAL_HANDS}) alebo <strong>natrvalo</strong> — vtedy sa hrá, kým ho host nevypne (od ďalšej ruky).
              </>,
              <>
                V lište svieti <strong>„Ďalšia ruka: Omaha“</strong> a počas kola <strong>„Omaha · ešte 2 kolá“</strong> alebo <strong>„Omaha · natrvalo“</strong>. Potom sa hra vráti k bežnému variantu.
              </>,
              <>Špeciálne kolo sa dá kombinovať s Prasiatkom aj s pravidlom 7-2.</>,
              <>
                Pred prvou rukou nového módu sa všetkým ukážu jeho pravidlá. Ruka sa rozdá, keď všetci kliknú <strong>Rozumiem</strong> (najneskôr po {MODE_INTRO_TIMEOUT_SEC} s).
              </>,
            ]}
          />
          {shot('mode-intro-omaha', 'Dialóg s pravidlami pred prvou rukou Omahy', 'Pravidlá módu pred prvou rukou — „Rozumiem“ a kto ešte nepotvrdil')}
          {shot('host-game', 'Panel hosta — záložka Hra', 'Host vyhlasuje špeciálne kolo, 7-2 a Prasiatko v ♛ Host → Hra')}
        </>
      ),
      atTable: ({ view }) =>
        view.nextHand?.variant ? (
          <>
            Naplánované: <strong>{VARIANT_LABELS[view.nextHand.variant]}</strong> od ďalšej ruky · {specialRoundLabel(view.nextHand)}
          </>
        ) : null,
    },
    {
      id: 'seven-deuce',
      group: 'Herné módy',
      icon: '7·2',
      title: 'Pravidlo 7-2',
      body: ({ view, money }) => (
        <>
          <ModeRules info={modeInfo('seven-deuce', view.settings, view.piggy ?? null)} />
          <p className="help-example">
            Príklad: <Cards cards={['7c', '2d']} /> vyhrá ruku, v ruke bolo 5 hráčov a bonus je {money(view.settings.sevenDeuceBounty)} → víťaz dostane navyše 4 × {money(view.settings.sevenDeuceBounty)} ={' '}
            <strong>{money(4 * view.settings.sevenDeuceBounty)}</strong>.
          </p>
          {shot('showdown', 'Showdown s bonusom 7-2', 'Výhra so 7-2: bonus od každého hráča v ruke')}
        </>
      ),
      atTable: ({ view, money }) => (view.settings.sevenDeuceAlways ? <>Bonus 7-2 je zapnutý: <strong>{money(view.settings.sevenDeuceBounty)}</strong> od každého</> : <>Bonus 7-2 je teraz vypnutý</>),
    },
    {
      id: 'piggy',
      group: 'Herné módy',
      icon: '🐷',
      title: 'Prasiatko',
      body: ({ view }) => (
        <>
          <ModeRules info={modeInfo('piggy', view.settings, view.piggy ?? null)} />
          <p className="help-note">
            Séria: host zvolí počet hier (1–{MAX_PIGGY_GAMES}) alebo <strong>natrvalo</strong>. <strong>Ukončiť po tejto hre</strong> dohrá bežiacu hru a ďalšiu už nespustí; <strong>Zrušiť hneď</strong> vráti vklady.
          </p>
          <div className="help-demo-row">
            <span className="help-demo-inline">
              <PiggyDots wins={1} target={PIGGY_TARGET_WINS} /> 1 výhra
            </span>
            <span className="help-demo-inline">
              <PiggyDots wins={2} target={PIGGY_TARGET_WINS} /> 2 výhry — ešte jedna a berie všetko
            </span>
          </div>
          {shot('piggy', 'Prasiatko pri pote a krúžky pri hráčoch', 'Prasiatko pri pote ukazuje sumu, krúžky pod menami výhry')}
          {shot('piggy-won', 'Prasiatko vyhraté', 'Kto má prvý 3 krúžky, berie celé prasiatko')}
        </>
      ),
      atTable: ({ view, me, money }) =>
        view.piggy?.status === 'running' ? (
          <>
            Prasiatko beží: <strong>{money(view.piggy.amount)}</strong>
            {piggySeriesLabel(view.piggy) && ` · ${piggySeriesLabel(view.piggy)}`}
            {me && (
              <>
                {' '}
                · ty <PiggyDots wins={view.piggy.wins?.[me.id] ?? 0} target={view.piggy.target} />
              </>
            )}
          </>
        ) : null,
    },
    {
      id: 'turn',
      group: 'Hra',
      icon: '⏱',
      title: 'Čas na ťah a predvoľby',
      body: ({ view }) => (
        <>
          <h4 className="help-subtitle">Čas a timebank</h4>
          <Points
            items={[
              <>
                Na každý ťah máš <strong>základný čas ({view.settings.actionTimeoutSec} s)</strong>. Keď uplynie, cinkne a začne sa míňať tvoj <strong>osobný timebank</strong> — oranžový krúžok okolo avatara.
              </>,
              <>
                Keď ťah stihneš v základnom čase, <strong>štvrtina ušetreného času</strong> sa ti pripíše do timebanku (najviac {TIME_BANK_MAX_SEC} s).
              </>,
              <>
                Keď minieš aj timebank, hra za teba <strong>checkne</strong>, ak sa dá, inak <strong>zahodí karty</strong>.
              </>,
            ]}
          />
          {shot('timebank', 'Míňa sa timebank', 'Oranžový krúžok = míňa sa tvoj timebank')}
          <h4 className="help-subtitle">Predvoľby — kým nie si na ťahu</h4>
          <Points
            items={[
              <>
                <strong>Check</strong> — checkne, ak sa dá. Keď niekto stavil, predvoľba sa zruší a rozhodneš sám.
              </>,
              <>
                <strong>Check / Fold</strong> — checkne, ak sa dá, inak zahodí.
              </>,
              <>
                <strong>Call 1,20 €</strong> — dorovná presne túto sumu. Keď sa suma zmení, zruší sa.
              </>,
              <>
                <strong>Call any</strong> — dorovná čokoľvek.
              </>,
              <>
                Predvoľby sú na rovnakých miestach ako tlačidlá Fold / Check · Call / Bet · Raise. Keď na teba príde rad, tlačidlá na chvíľku (0,4 s) nereagujú — aby si omylom nekliklo niečo iné.
              </>,
            ]}
          />
          {shot('pre-actions', 'Predvoľby akcií', 'Zaškrtnutá predvoľba sa vykoná sama, keď na teba príde rad')}
        </>
      ),
      atTable: ({ view, me }) => (
        <>
          Základný čas <strong>{view.settings.actionTimeoutSec} s</strong>
          {me && (
            <>
              {' '}
              · tvoj timebank <strong>{Math.round(me.timeBankMs / 1000)} s</strong>
            </>
          )}
        </>
      ),
    },
    {
      id: 'allin',
      group: 'Hra',
      icon: '🔥',
      title: 'All-in, viac behov a koniec ruky',
      body: ({ view, money }) => (
        <>
          <Points
            items={[
              <>
                <strong>All-in</strong> = vložíš všetky žetóny. Čo ostatní stavia navyše, ide do <strong>vedľajšieho potu (side pot)</strong>, o ktorý hrajú len tí, čo na to mali.
              </>,
              <>
                Keď sú všetci all-in pred riverom, hráči v ruke majú {RUN_VOTE_SEC} s na voľbu, <strong>koľkokrát sa board dorozdá — 1×, 2× alebo 3×</strong>. Platí <strong>najmenšia</strong> voľba a pot sa rozdelí medzi behy.
              </>,
              <>Karty hráčov v all-ine sa odkryjú a board sa dorozdáva pomaly, nech je čas to vidieť.</>,
            ]}
          />
          {shot('run-vote', 'Hlasovanie o počte behov', 'All-in: koľkokrát ideme — 1×, 2× alebo 3×')}
          {shot('run-twice', 'Dva boardy pri behu dvakrát', 'Beh dvakrát: druhý board pod prvým, každý berie polovicu potu')}
          <h4 className="help-subtitle">Po skončení ruky</h4>
          <Points
            items={[
              <>
                <strong>👁 Ukázať karty</strong> — dobrovoľne ukážeš svoje karty, aj keď nemusíš.
              </>,
              <>
                <strong>👀 Odkryť board · {money(view.settings.bigBlind)}</strong> — keď ruka skončila skôr, za 1 BB sa na {Math.round(RABBIT_SHOW_MS / 1000)} s ukážu karty, ktoré by prišli. Zaplatený BB ide do potu ďalšej ruky.
              </>,
            ]}
          />
          {shot('rabbit', 'Odkrytý zvyšok boardu', 'Odkrytie boardu: karty, ktoré by prišli')}
        </>
      ),
    },
    {
      id: 'pause',
      group: 'Hra',
      icon: '☕',
      title: 'Pauza, postavenie sa a odchod',
      body: () => (
        <>
          <div className="help-table-wrap">
            <table className="help-table">
              <thead>
                <tr>
                  <th />
                  <th>☕ Krátka pauza</th>
                  <th>Postaviť sa</th>
                  <th>Odísť od stola</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <th>Na ako dlho</th>
                  <td>pár minút</td>
                  <td>dlhšie</td>
                  <td>koniec alebo dlhá prestávka</td>
                </tr>
                <tr>
                  <th>Dostávam karty</th>
                  <td>áno, hra za mňa hneď checkne / zahodí</td>
                  <td>nie</td>
                  <td>nie</td>
                </tr>
                <tr>
                  <th>Platím blindy</th>
                  <td>
                    <strong>áno</strong>
                  </td>
                  <td>nie</td>
                  <td>nie</td>
                </tr>
                <tr>
                  <th>Kde som</th>
                  <td>pri stole, „pauza ☕“</td>
                  <td>pri stole, „mimo hry“</td>
                  <td>v čakárni stola</td>
                </tr>
                <tr>
                  <th>Návrat</th>
                  <td>znova ☕</td>
                  <td>☰ → Vrátiť sa do hry</td>
                  <td>„Späť ku stolu“</td>
                </tr>
              </tbody>
            </table>
          </div>
          {shot('away', 'Hráč na krátkej pauze', 'Krátka pauza: odznak „pauza ☕“, za hráča sa hrá automaticky')}
          <h4 className="help-subtitle">Návrat do hry</h4>
          <Steps
            items={[
              <>
                <strong>Počkať na big blind (zadarmo)</strong> — vrátiš sa, keď na teba príde rad s BB.
              </>,
              <>
                <strong>Zaplatiť a hrať hneď</strong> — doplatíš zmeškané blindy a karty dostaneš od ďalšej ruky.
              </>,
            ]}
          />
          {shot('return-dialog', 'Dialóg návratu do hry', 'Návrat: počkať na BB alebo zaplatiť')}
          <h4 className="help-subtitle">Odísť od stola vs. Opustiť hru</h4>
          <Points
            items={[
              <>
                <strong>Odísť od stola</strong> ťa postaví a presunie do čakárne — hra beží ďalej bez teba.
              </>,
              <>
                <strong>Opustiť hru</strong> (v čakárni) uvoľní miesto. Žetóny, štatistiky aj timebank ostanú uložené a cez <strong>Moje stoly</strong> si sadneš späť.
              </>,
              <>Odchod nikdy nezmaže stôl. Počas losovania o dealer button sa odísť nedá.</>,
            ]}
          />
          {shot('room-playing', 'Čakáreň počas hry', 'Čakáreň počas hry — „Späť ku stolu“ alebo „Opustiť hru“')}
        </>
      ),
      atTable: ({ me }) => {
        if (!me) {
          return null;
        }
        const state = me.away ? 'si na krátkej pauze ☕' : me.sittingOut ? (me.returnMode === 'wait-bb' ? 'čakáš na big blind' : 'stojíš mimo hry') : 'hráš';
        return (
          <>
            Teraz: <strong>{state}</strong>
          </>
        );
      },
    },
    {
      id: 'chips',
      group: 'Peniaze a roly',
      icon: '🏦',
      title: 'Žetóny, bankár a vyplácanie',
      body: () => (
        <>
          <h4 className="help-subtitle">Bankár 🏦</h4>
          <Points
            items={[
              <>
                Žetóny mení <strong>iba bankár</strong> — predvolene zakladateľ stola, host môže rolu presunúť.
              </>,
              <>
                Pri príchode máš <strong>0 žetónov</strong>. Keď chceš hrať alebo si dokúpiť, <strong>povedz bankárovi</strong> (v chate alebo nahlas). V appke sa o žetóny nežiada.
              </>,
              <>
                Bankár ti žetóny pripíše a zaklikne <strong>Zaplatené</strong> (peniaze si mu dal hneď) alebo <strong>Na dlh</strong> (vyrovnáte sa po hre).
              </>,
              <>
                Každé dobitie aj výber je <strong>verejné</strong> — v chate, v Transakciách aj na karte hráča. Potajme si žetóny nepridá nikto.
              </>,
            ]}
          />
          {shot('host-players', 'Bankár dobíja žetóny', 'Bankár pripisuje žetóny v ♛ Host / 🏦 Bank → Hráči a žetóny')}
          <h4 className="help-subtitle">Keď ti dôjdu žetóny</h4>
          <Points
            items={[
              <>Nedostávaš karty, kým ti bankár nedobije.</>,
              <>
                Ak ťa medzitým minul big blind, po dobití <strong>počkáš na big blind</strong>.
              </>,
            ]}
          />
          <h4 className="help-subtitle">Cashout — vyplácanie</h4>
          <Points
            items={[
              <>
                Vo <strong>Výsledkoch stola → Cashout</strong> appka spočíta, <strong>kto komu koľko pošle najmenším počtom prevodov</strong> — so započítaním toho, čo kto zaplatil bankárovi a čo dlží.
              </>,
              <>Bankár odklikáva splatené dlhy a prebehnuté prevody (omyl sa dá vrátiť).</>,
              <>
                <strong>Appka peniaze neposiela</strong>, len ich eviduje. Prevody robíte sami.
              </>,
            ]}
          />
          {shot('cashout', 'Cashout — kto komu koľko pošle', 'Cashout: zoznam prevodov na vyrovnanie')}
          {shot('transactions', 'Transakcie', 'Transakcie: každé dobitie a výber, verejne pre všetkých')}
        </>
      ),
      atTable: ({ roles, nameOf, me, money }) => (
        <>
          Bankár: <strong>{nameOf(roles.bankerId)}</strong>
          {me && (
            <>
              {' '}
              · tvoje žetóny <strong>{money(me.stack)}</strong>
            </>
          )}
        </>
      ),
    },
    {
      id: 'roles',
      group: 'Peniaze a roly',
      icon: '♛',
      title: 'Roly pri stole',
      body: () => (
        <>
          <p>Roly sú označené ikonkou pred menom — v čakárni aj pri mieste za stolom:</p>
          <RolesDemo />
          <div className="help-table-wrap">
            <table className="help-table">
              <thead>
                <tr>
                  <th>Rola</th>
                  <th>Čo môže</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <th>♛ Zakladateľ (host)</th>
                  <td>všetko, čo spoluhost, a navyše zmazať stôl; po návrate dostane práva späť</td>
                </tr>
                <tr>
                  <th>★ Spoluhost</th>
                  <td>spustiť a pozastaviť hru, meniť pravidlá (platia od ďalšej ruky), špeciálne kolá, 7-2, Prasiatko, jukebox, púšťať nových hráčov, vyhodiť alebo zlúčiť hráča, prideliť práva hosta a rolu bankára</td>
                </tr>
                <tr>
                  <th>🏦 Bankár</th>
                  <td>dobíjať a vyberať žetóny, odklikávať platby v cashoute</td>
                </tr>
                <tr>
                  <th>Hráč</th>
                  <td>hrať, chat, kamera, štatistiky</td>
                </tr>
              </tbody>
            </table>
          </div>
          <Points
            items={[
              <>Nový hráč z odkazu musí byť schválený hostom — kým nie je, nevidí nič zo stola. Vracajúci sa hráč schválenie nepotrebuje.</>,
              <>Keď bankár alebo host odíde, rola prejde na niekoho, kto už rolu má — nikdy nie na náhodného hráča.</>,
              <>
                <strong>Vyhodiť</strong> môže host každého okrem seba a zakladateľa — aj hráča v ruke (hneď zloží karty), offline aj toho, kto odišiel od stola. Žetóny ostanú v transakciách a vyrovnajú sa v cashoute; späť sa vyhodený dostane len so súhlasom hosta.
              </>,
              <>
                <strong>Zlúčiť do…</strong> — keď sa niekto pripojil z iného zariadenia ako nový hráč: host klikne na pôvodného (offline) hráča a vyberie nového. Žetóny, transakcie, štatistiky aj história prejdú na nového a pôvodný zo stola zmizne. Nedá sa počas rozohranej ruky toho hráča ani počas losovania.
              </>,
              <>Kto od stola odišiel, je v paneli hosta aj v čakárni v sekcii „Odišli od stola“ — host ho odtiaľ môže vyhodiť alebo zlúčiť.</>,
            ]}
          />
          {shot('table-roles', 'Odznaky rolí pri stole', 'Pri stole: ♛ a 🏦 pred menom hosta, ★ pri spoluhostovi')}
        </>
      ),
      atTable: ({ view, roles }) => {
        const marked = view.players.filter((player) => player.id === roles.ownerId || player.id === roles.bankerId || roles.isAdmin(player.id));
        return marked.length ? (
          <span className="help-at-roles">
            {marked.map((player) => (
              <span key={player.id}>
                <RoleBadge playerId={player.id} roles={roles} />
                {player.name}
              </span>
            ))}
          </span>
        ) : null;
      },
    },
    {
      id: 'voice',
      group: 'Ostatné',
      icon: '🎙',
      title: 'Kamera, mikrofón, zvuk a chat',
      body: () => (
        <>
          <Points
            items={[
              <>
                <strong>Kamera a mikrofón</strong> — video a zvuk idú priamo medzi hráčmi, nie cez server. Video nahradí avatara na tvojom mieste.
              </>,
              <>
                <strong>Kto práve hovorí</strong> má okolo avatara <strong>zelený pulzujúci okraj</strong> a pri ňom zelený mikrofón — hneď vidno, od koho ide zvuk. Funguje pri stole aj v čakárni.
              </>,
              <>Pri hráčovi so zapnutou kamerou a vypnutým mikrofónom svieti červený preškrtnutý mikrofón.</>,
              <>
                <strong>Push-to-talk</strong> (len počítač) — šípka pri mikrofóne. Mikrofón vysiela, len kým držíš zvolený kláves.
              </>,
              <>
                <strong>Zvuk</strong> — stlmenie všetkého, zvukové efekty, upozornenie na ťah, hlasitosť efektov a hlasitosť hráčov.
              </>,
              <>
                <strong>Hlasitosť jedného hráča</strong> — klikni na jeho miesto pri stole: posuvník 0–150 % a <strong>Stlmiť</strong>. Platí len pre teba a pamätá sa; stlmený hráč má pri mieste ikonku 🔇.
              </>,
              <>
                Na <strong>mobile</strong> sú pauza, kamera, mikrofón a zvuk v menu ☰.
              </>,
            ]}
          />
          <SpeakingDemo />
          {shot('speaking', 'Hráč, ktorý práve hovorí', 'Pri stole: hovoriaci hráč má zelený okraj a mikrofón')}
          <h4 className="help-subtitle">Chat</h4>
          <Points items={[<>Správy sa ukážu aj ako notifikácie — najviac 3 naraz, každá na 10 s. V chate je aj priebeh hry.</>]} />
          {shot('chat-toasts', 'Notifikácie správ z chatu', 'Nové správy ako notifikácie pri stole')}
        </>
      ),
    },
    {
      id: 'jukebox',
      group: 'Ostatné',
      icon: '🎵',
      title: 'Jukebox',
      body: () => (
        <Points
          items={[
            <>Host jukebox zapína a vypína pre celý stôl. Všetci počujú tú istú pesničku v rovnakom čase.</>,
            <>
              Pesničku (odkaz na YouTube, najviac {Math.round(JUKEBOX_MAX_DURATION_SEC / 60)} min) môže pridať <strong>len víťaz poslednej dohranej ruky</strong> — jednu za výhru.
            </>,
            <>
              Vo fronte je najviac <strong>{JUKEBOX_MAX_QUEUE} pesničiek</strong> a vidia ho všetci (názov a kto ju pridal).
            </>,
            <>Pesničky sa nedajú preskočiť, pretáčať ani pozastaviť — ani hostom. Hlasitosť a stlmenie jukeboxu má každý vlastné.</>,
          ]}
        />
      ),
    },
    {
      id: 'stats',
      group: 'Ostatné',
      icon: '📊',
      title: 'Štatistiky a férovosť',
      body: () => (
        <>
          <Points
            items={[
              <>
                <strong>📊 Leaderboard a História</strong> — záložky bočného panela: kto je koľko hore/dole a odohrané ruky s kartami, ktoré sa ukázali. Pri každej ruke vidíš aj svoje karty a koľko si v nej vyhral či prehral (cudzie skryté karty nikdy) a výhry z Prasiatka aj 7-2 bonusu.
              </>,
              <>
                <strong>Férové miešanie</strong> — do každého balíčka prispieva náhodou aj tvoj prehliadač, takže balíček nevie zvoliť nikto, ani prevádzkovateľ servera. Po hre si v Histórii stiahneš dôkazy a overíš ich.
              </>,
              <>Úprimne: server počas ruky technicky vidí karty — tak to funguje v každom online pokri. Celé vysvetlenie je v README projektu.</>,
            ]}
          />
          {shot('leaderboard', 'Leaderboard', 'Leaderboard stola')}
          {shot('history', 'História rúk', 'História rúk s dôkazmi férového miešania')}
        </>
      ),
    },
    {
      id: 'app',
      group: 'Ostatné',
      icon: '📱',
      title: 'Appka, dealer button a výpadky',
      body: () => (
        <>
          <Points
            items={[
              <>
                <strong>Inštalácia</strong> — v úvodnej obrazovke tlačidlo „Nainštalovať ako aplikáciu“ (na iPhone ukáže návod krok po kroku). Je to tá istá stránka, aktualizuje sa sama.
              </>,
              <>
                <strong>Losovanie o dealer button</strong> — každý si potiahne kartu, najvyššia vyhráva. Pri rovnakej hodnote rozhoduje farba ♠ &gt; ♥ &gt; ♦ &gt; ♣.
              </>,
              <>
                <strong>Výpadok spojenia</strong> — po obnovení stránky sa vrátiš na svoje miesto. Ruka medzitým beží ďalej, aj čas na ťah.
              </>,
            ]}
          />
          {shot('draw-pick', 'Losovanie o dealer button', 'Losovanie: každý si potiahne jednu kartu')}
        </>
      ),
    },
  ];
}

/* ---------- Dialóg ---------- */

interface HelpDialogProps {
  view: TableView;
  initialChapter?: string;
  onClose: () => void;
}

const CHAPTER_KEY = 'poker.help.chapter';

function storedChapter(): string | null {
  try {
    return window.localStorage.getItem(CHAPTER_KEY);
  } catch {
    return null;
  }
}

export function HelpDialog({ view, initialChapter, onClose }: HelpDialogProps) {
  const [zoomed, setZoomed] = useState<{ src: string; alt: string } | null>(null);
  const list = chapters((src, alt) => setZoomed({ src, alt }));
  const [chapterId, setChapterId] = useState(() => {
    const wanted = initialChapter ?? storedChapter();
    return list.some((chapter) => chapter.id === wanted) ? wanted! : list[0].id;
  });
  const contentRef = useRef<HTMLDivElement>(null);
  const index = Math.max(0, list.findIndex((chapter) => chapter.id === chapterId));
  const chapter = list[index];
  const me = view.players.find((player) => player.id === view.youId) ?? null;
  const ctx: HelpContext = {
    view,
    me,
    roles: playerRoles(view),
    money: (cents) => formatMoney(cents, view.settings.currency),
    nameOf: (playerId) => view.players.find((player) => player.id === playerId)?.name ?? '—',
  };
  const myTurn = !!view.hand && view.hand.street !== 'complete' && view.hand.toActId === view.youId;
  const atTable = chapter.atTable?.(ctx) ?? null;

  const select = (id: string) => {
    setChapterId(id);
    try {
      window.localStorage.setItem(CHAPTER_KEY, id);
    } catch {
      // Bez úložiska sa kapitola len nezapamätá.
    }
    contentRef.current?.scrollTo({ top: 0 });
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') {
        return;
      }
      if (zoomed) {
        setZoomed(null);
      } else {
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [zoomed, onClose]);

  useEffect(() => {
    contentRef.current?.parentElement?.querySelector('.help-nav-item.active')?.scrollIntoView({ block: 'nearest', inline: 'center' });
  }, [chapterId]);

  const groups = [...new Set(list.map((item) => item.group))];
  const previous = list[index - 1];
  const next = list[index + 1];

  // Portál do <body>: horná lišta má backdrop-filter, ktorý by fixed modal uzavrel do seba.
  return createPortal(
    <div className="modal-backdrop help-backdrop" onClick={onClose}>
      <div className="help-dialog" role="dialog" aria-modal="true" aria-labelledby="help-title" onClick={(event) => event.stopPropagation()}>
        <header className="help-head">
          <h2 id="help-title">📖 Vysvetlivky</h2>
          <button type="button" className="icon-btn help-close" onClick={onClose} aria-label="Zavrieť">
            ✕
          </button>
        </header>
        {myTurn && (
          <button type="button" className="help-turn" onClick={onClose}>
            ⏳ Si na ťahu — <strong>Späť ku stolu</strong>
          </button>
        )}
        <div className="help-body">
          <nav className="help-nav" aria-label="Kapitoly">
            {groups.map((group) => (
              <div key={group} className="help-nav-group">
                <span className="help-nav-group-title">{group}</span>
                {list
                  .filter((item) => item.group === group)
                  .map((item) => (
                    <button key={item.id} type="button" className={item.id === chapter.id ? 'help-nav-item active' : 'help-nav-item'} onClick={() => select(item.id)} aria-current={item.id === chapter.id ? 'page' : undefined}>
                      <span className="help-nav-icon" aria-hidden>
                        {item.icon}
                      </span>
                      {item.title}
                    </button>
                  ))}
              </div>
            ))}
          </nav>
          <div className="help-content" ref={contentRef}>
            <h3 className="help-chapter-title">
              <span className="help-chapter-icon" aria-hidden>
                {chapter.icon}
              </span>
              {chapter.title}
            </h3>
            {chapter.body(ctx)}
            {atTable && (
              <aside className="help-at-table">
                <span className="help-at-table-title">Pri tomto stole</span>
                <span>{atTable}</span>
              </aside>
            )}
            <div className="help-pager">
              {previous ? (
                <button type="button" className="btn btn-ghost" onClick={() => select(previous.id)}>
                  ‹ {previous.title}
                </button>
              ) : (
                <span />
              )}
              {next && (
                <button type="button" className="btn btn-ghost" onClick={() => select(next.id)}>
                  {next.title} ›
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
      {zoomed && (
        <div
          className="help-zoom"
          onClick={(event) => {
            event.stopPropagation();
            setZoomed(null);
          }}
          role="dialog"
          aria-label={zoomed.alt}
        >
          <img src={zoomed.src} alt={zoomed.alt} />
        </div>
      )}
    </div>,
    document.body,
  );
}
