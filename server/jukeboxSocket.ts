import type { Server, Socket } from 'socket.io';
import type { Ack, JukeboxStatePayload, JukeboxView } from '../shared/types';
import { Jukebox } from './Jukebox';
import type { Table, TablePlayer } from './Table';

/** Registrácia handlera s overeným hráčom (`withPlayer` / `withHost` z `io.on('connection')` v index.ts). */
type Register = <P>(event: string, handler: (payload: P, table: Table, player: TablePlayer, ack: unknown) => void) => void;

export interface JukeboxHub {
  /** Handlery `jukebox:get`, `jukebox:add` a `host:jukebox` pre jedno spojenie. */
  register(withPlayer: Register, withHost: Register): void;
  /** Aktuálny stav jukeboxu spojeniu, ktoré sa práve pripojilo ku stolu. */
  sendTo(socket: Socket, table: Table): void;
  /** Po zmene stola: ak sa zmenilo, kto môže pridať pesničku (dohraná ruka, víťaz odišiel), rozpošle stav. */
  tableChanged(table: Table): void;
  /** Stôl bol zmazaný — zastaví časovač jukeboxu. */
  tableRemoved(table: Table): void;
}

function reply<T>(ack: unknown, payload: Ack<T>): void {
  if (typeof ack === 'function') {
    ack(payload);
  }
}

/** Jukeboxy stolov (len v pamäti) a ich socketové udalosti. */
export function createJukeboxHub(io: Server, room: (code: string) => string, isAlive: (table: Table) => boolean): JukeboxHub {
  const jukeboxes = new WeakMap<Table, Jukebox>();
  /** Kto mohol pridávať v naposledy rozposlanom stave (na zistenie zmeny po dohranej ruke). */
  const sentEligible = new WeakMap<Table, string>();

  const payloadOf = (table: Table, jukebox: Jukebox): JukeboxStatePayload => ({ code: table.code, jukebox: jukebox.view() });

  const broadcast = (table: Table) => {
    const jukebox = jukeboxes.get(table);
    if (!jukebox) {
      return;
    }
    const payload = payloadOf(table, jukebox);
    sentEligible.set(table, payload.jukebox.eligibleIds.join(','));
    io.to(room(table.code)).emit('jukebox:state', payload);
  };

  const jukeboxOf = (table: Table): Jukebox => {
    let jukebox = jukeboxes.get(table);
    if (!jukebox) {
      jukebox = new Jukebox({
        winners: () => {
          const winners = table.lastHandWinners();
          return winners && { handNumber: winners.handNumber, playerIds: winners.playerIds.filter((id) => table.players.has(id)) };
        },
        onChange: () => broadcast(table),
        isAlive: () => isAlive(table),
      });
      jukeboxes.set(table, jukebox);
    }
    return jukebox;
  };

  return {
    register(withPlayer, withHost) {
      withPlayer('jukebox:get', (_payload, table, _player, ack) => {
        reply<JukeboxView>(ack, { ok: true, data: jukeboxOf(table).view() });
      });
      withPlayer<{ videoId?: unknown; title?: unknown; durationSec?: unknown }>('jukebox:add', (payload, table, player, ack) => {
        reply(ack, jukeboxOf(table).add(player, payload ?? {}));
      });
      withHost<{ enabled?: unknown }>('host:jukebox', (payload, table, _player, ack) => {
        reply(ack, jukeboxOf(table).setEnabled(payload?.enabled));
      });
    },
    sendTo(socket, table) {
      socket.emit('jukebox:state', payloadOf(table, jukeboxOf(table)));
    },
    tableChanged(table) {
      const jukebox = jukeboxes.get(table);
      if (jukebox && jukebox.view().eligibleIds.join(',') !== (sentEligible.get(table) ?? '')) {
        broadcast(table);
      }
    },
    tableRemoved(table) {
      jukeboxes.get(table)?.dispose();
      jukeboxes.delete(table);
    },
  };
}
