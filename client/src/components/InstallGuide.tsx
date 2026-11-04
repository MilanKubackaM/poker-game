import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useMediaQuery } from '../hooks/useMediaQuery';
import { INSTALL_GUIDES, type BarItem, type Glyph, type GuidePointer, type GuideScene, type InstallGuideId } from '../installGuide';
import '../installGuide.css';

const STEP_MS = 3600;
const LAST_STEP_MS = 5000;

const POINTER_CLASS: Record<GuidePointer, string> = {
  'top-right': 'install-pointer install-pointer-top-right',
  'bottom-right': 'install-pointer install-pointer-bottom-right',
  'bottom-center': 'install-pointer install-pointer-bottom-center',
};

const svg = (children: ReactNode) => (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    {children}
  </svg>
);

const GLYPHS: Record<Glyph, ReactNode> = {
  back: svg(<path d="M15 5l-7 7 7 7" />),
  forward: svg(<path d="M9 5l7 7-7 7" />),
  more: <span className="pg-glyph-text">•••</span>,
  'more-vertical': <span className="pg-glyph-text">⋮</span>,
  menu: svg(<path d="M4 7h16M4 12h16M4 17h16" />),
  share: svg(
    <>
      <path d="M12 3v12M7.5 7.5L12 3l4.5 4.5" />
      <path d="M8 11H6v9h12v-9h-2" />
    </>,
  ),
  tabs: svg(<rect x="5" y="5" width="14" height="14" rx="3" />),
  book: svg(<path d="M4 5.5C6.5 4.5 9.5 4.5 12 6c2.5-1.5 5.5-1.5 8-.5V19c-2.5-1-5.5-1-8 .5-2.5-1.5-5.5-1.5-8-.5z M12 6v13.5" />),
  home: svg(<path d="M4 11l8-7 8 7v9h-5v-6H9v6H4z" />),
  star: svg(<path d="M12 4l2.5 5.2 5.5.7-4 3.9 1 5.6-5-2.7-5 2.7 1-5.6-4-3.9 5.5-.7z" />),
  plus: svg(<path d="M12 5v14M5 12h14" />),
  close: svg(<path d="M6 6l12 12M18 6L6 18" />),
  sidebar: svg(
    <>
      <rect x="3.5" y="5" width="17" height="14" rx="2.5" />
      <path d="M9 5v14" />
    </>,
  ),
  apple: <span className="pg-glyph-text"></span>,
};

const ADD_TO_HOME_ICON = svg(
  <>
    <rect x="4" y="4" width="16" height="16" rx="4" />
    <path d="M12 8.5v7M8.5 12h7" />
  </>,
);

function targetClass(base: string, isTarget: boolean): string {
  return isTarget ? `${base} pg-target` : base;
}

function PageSkeleton() {
  return (
    <div className="pg-page" aria-hidden>
      <span className="pg-line pg-line-wide" />
      <span className="pg-line" />
      <span className="pg-line pg-line-short" />
    </div>
  );
}

function AppIdentity({ host }: { host: string }) {
  return (
    <div className="pg-identity">
      <img src="/icons/icon-192.png" alt="" width={40} height={40} />
      <div>
        <strong>Poker Night</strong>
        <span>{host}</span>
      </div>
    </div>
  );
}

function BarControl({ item, target, host }: { item: BarItem; target: string; host: string }) {
  if (item.kind === 'url') {
    return <span className="pg-url">{host}</span>;
  }
  return (
    <span className={targetClass('pg-btn', item.id === target)}>
      {GLYPHS[item.glyph]}
      {item.label && <span className="pg-btn-label">{item.label}</span>}
    </span>
  );
}

function Scene({ scene, host }: { scene: GuideScene; host: string }) {
  switch (scene.kind) {
    case 'bar': {
      const bar = (
        <div className="pg-bar">
          {scene.rows.map((row, rowIndex) => (
            <div className="pg-bar-row" key={rowIndex}>
              {row.map((item) => (
                <BarControl key={item.id} item={item} target={scene.target} host={host} />
              ))}
            </div>
          ))}
        </div>
      );
      return (
        <div className={scene.edge === 'top' ? 'pg-screen pg-screen-top' : 'pg-screen pg-screen-bottom'}>
          {scene.edge === 'top' && bar}
          <PageSkeleton />
          {scene.edge === 'bottom' && bar}
        </div>
      );
    }
    case 'menu':
      return (
        <div className={scene.edge === 'top' ? 'pg-screen pg-screen-top pg-dimmed' : 'pg-screen pg-screen-bottom pg-dimmed'}>
          <PageSkeleton />
          <ul className={scene.edge === 'top' ? 'pg-menu pg-menu-top' : 'pg-menu pg-menu-bottom'}>
            {scene.items.map((item) => (
              <li key={item} className={targetClass('pg-menu-item', item === scene.target)}>
                {item}
              </li>
            ))}
          </ul>
        </div>
      );
    case 'share-sheet':
      return (
        <div className="pg-screen pg-screen-bottom pg-dimmed">
          <PageSkeleton />
          <div className="pg-sheet">
            <AppIdentity host={host} />
            <div className="pg-sheet-apps" aria-hidden>
              <span />
              <span />
              <span />
              <span />
            </div>
            <ul className="pg-sheet-actions">
              <li className="pg-menu-item">Kopírovať</li>
              <li className="pg-menu-item">Pridať do záložiek</li>
              <li className={targetClass('pg-menu-item', true)}>
                Pridať na plochu
                {ADD_TO_HOME_ICON}
              </li>
            </ul>
          </div>
        </div>
      );
    case 'confirm-ios':
      return (
        <div className="pg-screen pg-screen-top">
          <div className="pg-confirm-ios">
            <div className="pg-confirm-nav">
              <span>Zrušiť</span>
              <strong>{scene.title ?? 'Pridať na plochu'}</strong>
              <span className={targetClass('pg-confirm-add', true)}>Pridať</span>
            </div>
            <AppIdentity host={host} />
          </div>
          <PageSkeleton />
        </div>
      );
    case 'confirm-android':
      return (
        <div className="pg-screen pg-screen-center pg-dimmed">
          <PageSkeleton />
          <div className="pg-dialog">
            <strong>Inštalovať aplikáciu</strong>
            <AppIdentity host={host} />
            <div className="pg-dialog-actions">
              <span>Zrušiť</span>
              <span className={targetClass('pg-dialog-action', true)}>{scene.action}</span>
            </div>
          </div>
        </div>
      );
    case 'mac-menu':
      return (
        <div className="pg-screen pg-screen-top pg-mac">
          <div className="pg-menubar">
            <span>{GLYPHS.apple}</span>
            <strong>Safari</strong>
            <span className={targetClass(scene.open ? 'pg-menubar-item pg-menubar-open' : 'pg-menubar-item', !scene.open)}>Súbor</span>
            <span>Úpravy</span>
            <span>Zobraziť</span>
          </div>
          {scene.open ? (
            <ul className="pg-menu pg-mac-dropdown">
              <li className="pg-menu-item">Nové okno</li>
              <li className="pg-menu-item">Nová karta</li>
              <li className={targetClass('pg-menu-item', true)}>Pridať do Docku…</li>
              <li className="pg-menu-item">Zavrieť okno</li>
            </ul>
          ) : (
            <PageSkeleton />
          )}
        </div>
      );
  }
}

interface InstallGuideProps {
  guide: InstallGuideId;
  onClose: () => void;
}

/** Animovaný návod „pridať na plochu“: výsek obrazovky telefónu s ovládačmi prehliadača, krok po kroku. */
export function InstallGuideDialog({ guide, onClose }: InstallGuideProps) {
  const { title, steps } = INSTALL_GUIDES[guide];
  const [index, setIndex] = useState(0);
  const [autoplay, setAutoplay] = useState(true);
  const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)');
  const nextRef = useRef<HTMLButtonElement>(null);
  const host = window.location.host;
  const step = steps[index];
  const last = index === steps.length - 1;

  useEffect(() => {
    nextRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    if (!autoplay || reducedMotion) {
      return;
    }
    const timer = window.setTimeout(() => setIndex((current) => (current + 1) % steps.length), last ? LAST_STEP_MS : STEP_MS);
    return () => window.clearTimeout(timer);
  }, [autoplay, reducedMotion, index, last, steps.length]);

  const goTo = (next: number) => {
    setAutoplay(false);
    setIndex(next);
  };

  return (
    <div className="modal-backdrop install-guide-backdrop" onClick={onClose}>
      {step.pointer && (
        <div className={POINTER_CLASS[step.pointer]} aria-hidden>
          <span className="install-pointer-label">tu</span>
          <span className="install-pointer-arrow" />
        </div>
      )}
      <div className="modal install-guide" role="dialog" aria-modal="true" aria-labelledby="install-guide-title" onClick={(event) => event.stopPropagation()}>
        <button type="button" className="icon-btn install-guide-close" onClick={onClose} aria-label="Zavrieť návod">
          ✕
        </button>
        <h2 id="install-guide-title">{title}</h2>
        <div className="pg-phone" key={index} aria-hidden>
          <Scene scene={step.scene} host={host} />
        </div>
        <p className="install-guide-text" aria-live="polite">
          <span className="install-guide-count">
            Krok {index + 1} z {steps.length}
          </span>
          {step.text}
        </p>
        <div className="install-guide-dots">
          {steps.map((_, dotIndex) => (
            <button
              key={dotIndex}
              type="button"
              className={dotIndex === index ? 'install-guide-dot install-guide-dot-active' : 'install-guide-dot'}
              aria-label={`Krok ${dotIndex + 1}`}
              aria-current={dotIndex === index ? 'step' : undefined}
              onClick={() => goTo(dotIndex)}
            />
          ))}
        </div>
        <div className="install-guide-actions">
          <button type="button" className="btn btn-secondary" disabled={index === 0} onClick={() => goTo(index - 1)}>
            Späť
          </button>
          {last ? (
            <button type="button" ref={nextRef} className="btn btn-primary" onClick={onClose}>
              Rozumiem
            </button>
          ) : (
            <button type="button" ref={nextRef} className="btn btn-primary" onClick={() => goTo(index + 1)}>
              Ďalej
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
