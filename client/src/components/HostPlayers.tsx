import { useEffect, useMemo, useRef, useState } from 'react';
import type { LedgerEntry, SeatPlayerView, Settlement, TableSettings, TableView } from '../../../shared/types';
import { formatMoney, parseMoney } from '../../../shared/money';
import { centsToText } from '../moneyRules';
import { bankerIdOf, isAdminId, isOwner } from '../roles';
import { AvatarBadge } from './AvatarPicker';
import type { BankActions, HostActions } from './HostPanel';
import { computeCashout } from '../../../shared/settlement';
import { PlayerMoneyHistory } from './MoneyHistory';
import { MoneyInput } from './MoneyInput';

type AdminActions = Pick<HostActions, 'kick' | 'setAdmin' | 'setBanker'>;

/** Kto je kto pri stole: ja, vlastník stola, bankár, ostatní s právami hosta. */
export interface PlayerRoles {
  youId: string;
  ownerId: string;
  bankerId: string;
  /** Som vlastník — môžem odovzdať vlastníctvo stola. */
  youAreOwner: boolean;
  youAreAdmin: boolean;
  youAreBanker: boolean;
  isAdmin: (playerId: string) => boolean;
}

export function playerRoles(view: TableView): PlayerRoles {
  const bankerId = bankerIdOf(view);
  return {
    youId: view.youId,
    ownerId: view.hostId,
    bankerId,
    youAreOwner: isOwner(view),
    youAreAdmin: isAdminId(view, view.youId),
    youAreBanker: bankerId === view.youId,
    isAdmin: (playerId) => isAdminId(view, playerId),
  };
}

/** Odznak ♛ pre vlastníka stola, ★ pre spoluhosta (pridelené práva hosta), 🏦 pre bankára. */
export function RoleBadge({ playerId, roles }: { playerId: string; roles: Pick<PlayerRoles, 'ownerId' | 'bankerId' | 'isAdmin'> }) {
  return (
    <>
      {playerId === roles.ownerId ? (
        <span className="host-crown" title="Hlavný host (zakladateľ stola)">
          ♛
        </span>
      ) : (
        roles.isAdmin(playerId) && (
          <span className="cohost-star" title="Spoluhost — má práva hosta">
            ★
          </span>
        )
      )}
      {playerId === roles.bankerId && (
        <span className="banker-badge" title="Bankár — dobíja žetóny a potvrdzuje platby v cashoute">
          🏦
        </span>
      )}
    </>
  );
}

/** Typ transakcie v riadku bankára: dobitie / výber × peniaze prešli hneď / vyrovná sa v cashoute. */
type TransactionKind = 'paid' | 'owed' | 'out-paid' | 'out-owed';

const TRANSACTION_LABELS: Record<TransactionKind, string> = {
  paid: '💵 Poslal bankárovi',
  owed: '📝 Dlh',
  'out-paid': '↩ Výber · vyplatené',
  'out-owed': '↩ Výber · bank dlží',
};

const SELF_LABELS: Partial<Record<TransactionKind, string>> = {
  paid: '💵 Vklad',
  'out-paid': '↩ Výber',
};

interface BankTransactionProps {
  player: SeatPlayerView;
  settings: TableSettings;
  /** Počas rozohranej ruky sa hráčovi v ruke nedajú žetóny vybrať. */
  handRunning: boolean;
  bank: BankActions;
  /** Hráč je sám bankár — drží vlastné peniaze, dlh nemá zmysel. */
  isBankerSelf: boolean;
}

/** Bankár: tlačidlo „+ Transakcia“ otvorí riadok so sumou, typom (poslal bankárovi / dlh / výber) a „Hotovo“. */
export function BankTransaction({ player, settings, handRunning, bank, isBankerSelf }: BankTransactionProps) {
  const [open, setOpen] = useState(false);
  const [amountText, setAmountText] = useState(() => centsToText(settings.bigBlind * 100));
  const [kind, setKind] = useState<TransactionKind>('paid');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cents = parseMoney(amountText);
  const amountValid = cents !== null && cents > 0;
  const withdrawal = kind === 'out-paid' || kind === 'out-owed';
  const withdrawalBlocked = withdrawal && handRunning && player.inHand;
  const labels = isBankerSelf ? SELF_LABELS : TRANSACTION_LABELS;

  const submit = async () => {
    if (busy || !amountValid || withdrawalBlocked) {
      return;
    }
    setBusy(true);
    setError(null);
    const settlement: Settlement = kind === 'paid' || kind === 'out-paid' ? 'paid' : 'owed';
    const failure = await bank.chips(player.id, withdrawal ? -cents : cents, settlement, '');
    setBusy(false);
    if (failure) {
      setError(failure);
      return;
    }
    setOpen(false);
    setKind('paid');
  };

  if (!open) {
    return (
      <button type="button" className="btn btn-chip chip-add bank-transaction-open" onClick={() => setOpen(true)} aria-label={`Nová transakcia pre ${player.name}`}>
        + Transakcia
      </button>
    );
  }

  return (
    <div className="bank-transaction">
      <div className="bank-transaction-row">
        <MoneyInput value={amountText} onChange={setAmountText} currency={settings.currency} invalid={!amountValid} ariaLabel={`Suma pre ${player.name}`} />
        <select value={kind} onChange={(event) => setKind(event.target.value as TransactionKind)} aria-label="Typ transakcie">
          {(Object.keys(labels) as TransactionKind[]).map((key) => (
            <option key={key} value={key}>
              {labels[key]}
            </option>
          ))}
        </select>
      </div>
      <div className="bank-transaction-row">
        <button type="button" className="btn btn-ghost btn-small" onClick={() => setOpen(false)} disabled={busy}>
          Zrušiť
        </button>
        <button type="button" className="btn btn-primary btn-small bank-transaction-done" onClick={() => void submit()} disabled={busy || !amountValid || withdrawalBlocked}>
          {busy ? '…' : '✓ Hotovo'}
        </button>
      </div>
      {withdrawalBlocked && <div className="chip-feedback error">Vybrať môžeš až po skončení ruky</div>}
      {error && (
        <div className="chip-feedback error" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}

/** Nesplatené dlhy hráčov z cashoutu (playerId → suma). */
export function useDebts(view: TableView): Map<string, number> {
  const ledger = view.ledger;
  const leaderboard = view.leaderboard;
  return useMemo(() => {
    const members = (leaderboard ?? []).map((row) => ({ playerId: row.playerId, playerName: row.playerName, stack: row.stack }));
    return new Map(computeCashout(ledger ?? [], members).rows.map((row) => [row.playerId, row.debt]));
  }, [ledger, leaderboard]);
}

/** Tlačidlo „Akcie“ vpravo hore na karte hráča: práva hosta, bankár, vyhodenie (len pre hosta). */
export function PlayerActionsMenu({ player, actions, roles }: { player: SeatPlayerView; actions: AdminActions; roles: PlayerRoles }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const isSelf = player.id === roles.youId;
  const isOwner = player.id === roles.ownerId;

  useEffect(() => {
    if (!open) {
      return;
    }
    const onDown = (event: PointerEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open]);

  const items: { key: string; label: string; danger?: boolean; run: () => void }[] = [];
  if (!isSelf && !isOwner) {
    items.push(
      roles.isAdmin(player.id)
        ? { key: 'admin', label: 'Odobrať práva hosta', run: () => actions.setAdmin(player.id, false) }
        : { key: 'admin', label: '★ Dať práva hosta', run: () => actions.setAdmin(player.id, true) },
    );
  }
  if (isSelf && !isOwner) {
    items.push({ key: 'admin', label: 'Vzdať sa práv hosta', run: () => actions.setAdmin(player.id, false) });
  }
  if (player.id !== roles.bankerId) {
    items.push({ key: 'banker', label: '🏦 Označiť ako bankára', run: () => actions.setBanker(player.id) });
  }
  if (!isSelf && !isOwner) {
    items.push({ key: 'kick', label: 'Vyhodiť', danger: true, run: () => actions.kick(player.id) });
  }
  if (items.length === 0) {
    return null;
  }

  return (
    <div className="menu-wrap player-actions" ref={wrapRef}>
      <button type="button" className="btn btn-ghost btn-small" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        Akcie ▾
      </button>
      {open && (
        <div className="menu player-actions-menu" role="menu">
          {items.map((item) => (
            <button
              key={item.key}
              type="button"
              role="menuitem"
              className={item.danger ? 'menu-item danger' : 'menu-item'}
              onClick={() => {
                setOpen(false);
                item.run();
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Spodok karty hráča: história transakcií (verejná) a pre bankára riadok na novú transakciu. */
export function PlayerMoneySection({ player, view, ledger, debt, bank, handRunning }: { player: SeatPlayerView; view: TableView; ledger: LedgerEntry[]; debt: number; bank?: BankActions; handRunning: boolean }) {
  const roles = playerRoles(view);
  return (
    <div className="player-money">
      <PlayerMoneyHistory ledger={ledger} playerId={player.id} currency={view.settings.currency} debt={debt} />
      {bank && roles.youAreBanker && <BankTransaction player={player} settings={view.settings} handRunning={handRunning} bank={bank} isBankerSelf={player.id === roles.bankerId} />}
    </div>
  );
}

/** Záložka „Hráči a žetóny" v paneli hosta / bankára počas hry — rovnaké karty ako v čakárni. */
export function HostPlayersList({ view, actions, bank }: { view: TableView; actions: AdminActions; bank: BankActions }) {
  const debts = useDebts(view);
  const handRunning = !!view.hand && view.hand.street !== 'complete';
  const roles = playerRoles(view);
  return (
    <div className="stack-gap">
      {view.players.map((player) => (
        <div key={player.id} className="host-player">
          <div className="host-player-head">
            <AvatarBadge avatar={player.avatar} size={40} />
            <div className="host-player-info">
              <div className="host-player-name">
                <RoleBadge playerId={player.id} roles={roles} />
                {player.name}
                {player.id !== roles.ownerId && roles.isAdmin(player.id) && <span className="badge badge-cohost">spoluhost</span>}
                {player.id === roles.bankerId && <span className="badge badge-banker">bankár</span>}
                {!player.connected && <span className="badge badge-muted">offline</span>}
                {player.sittingOut && <span className="badge badge-muted">pauza</span>}
              </div>
              <div className="host-player-stack">{formatMoney(player.stack, view.settings.currency)}</div>
            </div>
            {roles.youAreAdmin && <PlayerActionsMenu player={player} actions={actions} roles={roles} />}
          </div>
          <PlayerMoneySection player={player} view={view} ledger={view.ledger ?? []} debt={debts.get(player.id) ?? 0} bank={bank} handRunning={handRunning} />
        </div>
      ))}
    </div>
  );
}
