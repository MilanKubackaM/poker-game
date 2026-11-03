/** Kamera ako SVG — vypnutá je červená a preškrtnutá rovnako ako mikrofón. */
export function CameraIcon({ off = false, size = 20 }: { off?: boolean; size?: number }) {
  return (
    <svg
      className={off ? 'mic-icon off' : 'mic-icon'}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="2.5" y="6.5" width="13" height="11" rx="2.5" />
      <path d="M15.5 10.5l6-3.5v10l-6-3.5" />
      {off && <path className="mic-icon-slash" d="M3 3.5l18 17" />}
    </svg>
  );
}

/** Reproduktor ako SVG — stlmený je červený a preškrtnutý. */
export function SpeakerIcon({ off = false, size = 20 }: { off?: boolean; size?: number }) {
  return (
    <svg
      className={off ? 'mic-icon off' : 'mic-icon'}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" />
      {!off && <path d="M15.5 9a4.5 4.5 0 0 1 0 6" />}
      {!off && <path d="M18 6.5a8 8 0 0 1 0 11" />}
      {off && <path className="mic-icon-slash" d="M3 3.5l18 17" />}
    </svg>
  );
}
