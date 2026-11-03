import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import type { Series } from '../../../shared/netstats';
import { STATUS, formatTime, niceMax } from './format';

export interface ChartSeries {
  id: string;
  name: string;
  color: string;
  values: Series;
}

interface Props {
  title: string;
  hint?: string;
  times: number[];
  series: ChartSeries[];
  format: (value: number) => string;
  /** Pevné minimum hornej hranice osi (napr. 5 % pri strate, aby šum nevyzeral ako katastrofa). */
  minMax?: number;
  /** Prahová čiara — nad ňou je to už problém. */
  threshold?: number;
  /** Indexy intervalov s udalosťou (zamrznutie, sekanie, výpadok spojenia). */
  markers?: Set<number>;
  selected: number | null;
  onSelect: (index: number) => void;
}

const HEIGHT = 170;
const MARGIN = { top: 10, right: 10, bottom: 24, left: 52 };

function linePath(values: Series, x: (index: number) => number, y: (value: number) => number): string {
  let path = '';
  let open = false;
  values.forEach((value, index) => {
    if (value === null) {
      open = false;
      return;
    }
    path += `${open ? 'L' : 'M'}${x(index).toFixed(1)},${y(value).toFixed(1)}`;
    open = true;
  });
  return path;
}

/** Ojedinelé body (bez suseda) sa v čiare nezobrazia — nakreslia sa ako bodky. */
function isolated(values: Series): number[] {
  return values.flatMap((value, index) => (value !== null && values[index - 1] == null && values[index + 1] == null ? [index] : []));
}

export function LineChart({ title, hint, times, series, format, minMax = 0, threshold, markers, selected, onSelect }: Props) {
  const wrapper = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    const element = wrapper.current;
    if (!element) {
      return;
    }
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(240, Math.floor(entry.contentRect.width))));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const count = times.length;
  const plotWidth = width - MARGIN.left - MARGIN.right;
  const plotHeight = HEIGHT - MARGIN.top - MARGIN.bottom;
  const top = useMemo(() => {
    const values = series.flatMap((entry) => entry.values.filter((value): value is number => value !== null));
    return niceMax(Math.max(minMax, threshold ?? 0, ...values, 0));
  }, [series, minMax, threshold]);
  const x = (index: number) => MARGIN.left + (count <= 1 ? plotWidth / 2 : (index / (count - 1)) * plotWidth);
  const y = (value: number) => MARGIN.top + plotHeight - (Math.min(value, top) / top) * plotHeight;
  const indexAt = (clientX: number): number => {
    const rect = wrapper.current!.getBoundingClientRect();
    const ratio = (clientX - rect.left - MARGIN.left) / plotWidth;
    return Math.max(0, Math.min(count - 1, Math.round(ratio * (count - 1))));
  };

  const ticks = [0, 0.25, 0.5, 0.75, 1].map((ratio) => top * ratio);
  const timeTicks = useMemo(() => {
    if (count < 2) {
      return [];
    }
    const slots = Math.max(2, Math.min(6, Math.floor(plotWidth / 90)));
    return Array.from({ length: slots }, (_, slot) => Math.round((slot / (slots - 1)) * (count - 1)));
  }, [count, plotWidth]);
  const spanMs = count > 1 ? times[count - 1] - times[0] : 0;
  const active = hover ?? selected;
  const rows =
    active === null
      ? []
      : series
          .map((entry) => ({ entry, value: entry.values[active] ?? null }))
          .sort((left, right) => (right.value ?? -1) - (left.value ?? -1));

  const onKeyDown = (event: KeyboardEvent) => {
    if (count === 0) {
      return;
    }
    const current = selected ?? count - 1;
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      onSelect(Math.max(0, current - 1));
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      onSelect(Math.min(count - 1, current + 1));
    }
  };

  return (
    <section className="netchart">
      <header className="netchart-head">
        <h3>{title}</h3>
        {hint && <span className="netchart-hint">{hint}</span>}
      </header>
      {series.length > 1 && (
        <ul className="netchart-legend">
          {series.map((entry) => (
            <li key={entry.id}>
              <span className="netchart-key" style={{ background: entry.color }} />
              {entry.name}
            </li>
          ))}
        </ul>
      )}
      <div
        ref={wrapper}
        className="netchart-plot"
        tabIndex={0}
        role="img"
        aria-label={`${title} — šípkami vľavo/vpravo vyberieš čas`}
        onPointerMove={(event: PointerEvent) => count && setHover(indexAt(event.clientX))}
        onPointerLeave={() => setHover(null)}
        onClick={(event) => count && onSelect(indexAt(event.clientX))}
        onKeyDown={onKeyDown}
      >
        <svg width={width} height={HEIGHT} aria-hidden="true">
          {ticks.map((tick) => (
            <g key={tick}>
              <line className={tick === 0 ? 'netchart-base' : 'netchart-grid'} x1={MARGIN.left} x2={width - MARGIN.right} y1={y(tick)} y2={y(tick)} />
              <text className="netchart-axis" x={MARGIN.left - 6} y={y(tick) + 4} textAnchor="end">
                {format(tick)}
              </text>
            </g>
          ))}
          {timeTicks.map((index) => (
            <text key={index} className="netchart-axis" x={x(index)} y={HEIGHT - 6} textAnchor={index === 0 ? 'start' : index === count - 1 ? 'end' : 'middle'}>
              {formatTime(times[index], spanMs < 10 * 60_000)}
            </text>
          ))}
          {threshold !== undefined && <line className="netchart-threshold" x1={MARGIN.left} x2={width - MARGIN.right} y1={y(threshold)} y2={y(threshold)} />}
          {markers &&
            [...markers].map((index) => (
              <rect key={index} x={x(index) - 1.5} y={MARGIN.top + plotHeight + 1} width={3} height={5} rx={1} fill={STATUS.critical} />
            ))}
          {series.map((entry) => (
            <g key={entry.id}>
              <path d={linePath(entry.values, x, y)} fill="none" stroke={entry.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
              {isolated(entry.values).map((index) => (
                <circle key={index} cx={x(index)} cy={y(entry.values[index]!)} r={3} fill={entry.color} />
              ))}
            </g>
          ))}
          {selected !== null && selected < count && <line className="netchart-selected" x1={x(selected)} x2={x(selected)} y1={MARGIN.top} y2={MARGIN.top + plotHeight} />}
          {hover !== null && <line className="netchart-cross" x1={x(hover)} x2={x(hover)} y1={MARGIN.top} y2={MARGIN.top + plotHeight} />}
          {active !== null &&
            series.map((entry) => {
              const value = entry.values[active];
              return value === null || value === undefined ? null : <circle key={entry.id} cx={x(active)} cy={y(value)} r={4} fill={entry.color} stroke="var(--panel-solid)" strokeWidth={2} />;
            })}
        </svg>
        {hover !== null && (
          <div className="netchart-tooltip" style={{ left: Math.min(width - 190, Math.max(0, x(hover) + 12)) }}>
            <div className="netchart-tooltip-time">{formatTime(times[hover])}</div>
            {rows.map(({ entry, value }) => (
              <div key={entry.id} className="netchart-tooltip-row">
                <span className="netchart-key" style={{ background: entry.color }} />
                <strong>{value === null ? '–' : format(value)}</strong>
                <span>{entry.name}</span>
              </div>
            ))}
            {markers?.has(hover) && <div className="netchart-tooltip-event">Udalosť v tomto čase — pozri zoznam nižšie</div>}
          </div>
        )}
      </div>
    </section>
  );
}
