import { netCells, PROBLEM, type NetCell, type NetSeries } from '../../../shared/netstats';
import { formatKbps, formatMs, formatPct } from './format';

interface Props {
  series: NetSeries;
  index: number;
}

function value(values: (number | null)[] | undefined, index: number): number | null {
  return values ? (values[index] ?? null) : null;
}

function pathLabel(path: string | null): string {
  if (!path) {
    return '?';
  }
  const [local, rest] = path.split('/');
  const [protocol, remote] = (rest ?? '').split('→');
  const relay = local === 'relay' || remote === 'relay';
  return relay ? `Relay ${protocol.toUpperCase()}` : `Priamo ${protocol.toUpperCase()}`;
}

const LIMIT_TEXT: Record<string, string> = { cpu: 'obmedzuje CPU', bandwidth: 'obmedzuje upload', other: 'obmedzené' };

function Cell({ cell, index }: { cell: NetCell; index: number }) {
  const inbound = cell.inbound;
  const outbound = cell.outbound;
  const state = inbound?.state[index] ?? outbound?.state[index] ?? null;
  const path = inbound?.path[index] ?? outbound?.path[index] ?? null;
  const rtt = value(inbound?.rtt, index) ?? value(outbound?.rtt, index);
  const conceal = value(inbound?.conceal, index);
  const audioLoss = value(inbound?.audioLoss, index);
  const videoLoss = value(inbound?.videoLoss, index);
  const fps = value(inbound?.fps, index);
  const freezes = value(inbound?.freezes, index);
  const down = value(inbound?.down, index);
  const limit = outbound?.limit[index] ?? null;
  const connected = state === 'connected' || state === 'completed' || (state === null && rtt !== null);
  const status = !connected && state ? 'bad' : cell.problem ? 'bad' : rtt !== null && rtt >= PROBLEM.rttMs ? 'warn' : 'ok';
  const label = !connected && state ? `Spojenie: ${state}` : cell.audioBad && cell.videoBad ? 'Seká zvuk aj obraz' : cell.audioBad ? 'Seká zvuk' : cell.videoBad ? 'Mrzne obraz' : status === 'warn' ? 'Vysoké RTT' : 'OK';
  return (
    <td className={`netcell netcell-${status}`}>
      <div className="netcell-status">{label}</div>
      <div className="netcell-path">
        {pathLabel(path)} · {formatMs(rtt)}
      </div>
      {inbound ? (
        <dl className="netcell-metrics">
          <dt>Prijíma</dt>
          <dd>{formatKbps(down)}</dd>
          <dt>Zvuk</dt>
          <dd>
            doplnené {formatPct(conceal)}, strata {formatPct(audioLoss)}
          </dd>
          <dt>Obraz</dt>
          <dd>{fps === null && videoLoss === null ? 'bez videa' : `${fps === null ? '–' : Math.round(fps)} fps, strata ${formatPct(videoLoss)}${freezes ? `, zamrzol ${freezes}×` : ''}`}</dd>
        </dl>
      ) : (
        <div className="netcell-missing">Prijímateľ nehlási dáta</div>
      )}
      {limit && limit !== 'none' && <div className="netcell-limit">Odosielateľ: {LIMIT_TEXT[limit]}</div>}
    </td>
  );
}

/** Kto komu ako posiela: riadok = odosielateľ, stĺpec = prijímateľ. Zlý celý riadok = upload odosielateľa, zlý stĺpec = sieť prijímateľa. */
export function LinkMatrix({ series, index }: Props) {
  const cells = netCells(series, index);
  const byPair = new Map(cells.map((cell) => [`${cell.sender}>${cell.receiver}`, cell]));
  const players = series.players;
  if (cells.length === 0) {
    return <p className="netstats-empty">V tomto čase nikto neposielal obraz ani zvuk.</p>;
  }
  return (
    <div className="netmatrix-scroll">
      <table className="netmatrix">
        <thead>
          <tr>
            <th scope="col" className="netmatrix-corner">
              Od ↓ / pre →
            </th>
            {players.map((player) => (
              <th key={player.id} scope="col">
                {player.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {players.map((sender) => (
            <tr key={sender.id}>
              <th scope="row">{sender.name}</th>
              {players.map((receiver) => {
                if (sender.id === receiver.id) {
                  return <td key={receiver.id} className="netcell netcell-self" />;
                }
                const cell = byPair.get(`${sender.id}>${receiver.id}`);
                return cell ? <Cell key={receiver.id} cell={cell} index={index} /> : <td key={receiver.id} className="netcell netcell-none">Bez spojenia</td>;
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
