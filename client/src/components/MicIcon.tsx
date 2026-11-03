/** Mikrofón ako SVG — emoji nemá preškrtnutý mikrofón (🔇 je reproduktor). */
export function MicIcon({ off = false, size = 20 }: { off?: boolean; size?: number }) {
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
      <rect x="9" y="2.5" width="6" height="11.5" rx="3" />
      <path d="M5.5 11a6.5 6.5 0 0 0 13 0" />
      <path d="M12 17.5V21" />
      <path d="M8.5 21h7" />
      {off && <path className="mic-icon-slash" d="M4 3.5l16 17" />}
    </svg>
  );
}
