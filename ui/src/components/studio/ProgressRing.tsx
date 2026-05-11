// Circular progress indicator shown in a running card's icon slot. With a
// numeric `value` it draws a fill arc + the percentage; without one it spins
// (nodes that don't emit sub-step progress, e.g. a loader).

const R = 10;
const C = 2 * Math.PI * R;

export default function ProgressRing({ value }: { value?: number }) {
  if (value == null) {
    return (
      <span className="wf-ring">
        <svg viewBox="0 0 28 28" className="absolute inset-0 animate-spin">
          <circle cx="14" cy="14" r={R} fill="none" stroke="var(--border)" strokeWidth="2.5" />
          <circle
            cx="14"
            cy="14"
            r={R}
            fill="none"
            stroke="var(--success)"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeDasharray={`${C * 0.28} ${C}`}
          />
        </svg>
      </span>
    );
  }
  const pct = Math.max(0, Math.min(1, value));
  return (
    <span className="wf-ring">
      <svg viewBox="0 0 28 28" className="absolute inset-0 -rotate-90">
        <circle cx="14" cy="14" r={R} fill="none" stroke="var(--border)" strokeWidth="2.5" />
        <circle
          cx="14"
          cy="14"
          r={R}
          fill="none"
          stroke="var(--success)"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeDasharray={C}
          strokeDashoffset={C * (1 - pct)}
          className="transition-[stroke-dashoffset] duration-300"
        />
      </svg>
      <span className="wf-ring-num">{Math.round(pct * 100)}</span>
    </span>
  );
}
