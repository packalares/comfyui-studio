interface Props {
  model: string | null;
  tokensPerSec: number | null;
  msTotal: number | null;
  msToFirstToken: number | null;
  tokensIn: number | null;
  tokensOut: number | null;
  /** Time Ollama spent loading the model into VRAM for this turn (ms).
   *  Rendered only when nonzero — i.e. there was an actual cold load.
   *  Already-resident turns get tiny / zero values that we hide so the
   *  footer doesn't show "loaded in 0ms" on every message. */
  loadDurationMs?: number | null;
}

function num(n: number | null, digits = 1): string {
  if (n === null || !Number.isFinite(n)) return '-';
  return n.toFixed(digits);
}

function ms(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return '-';
  if (n < 1000) return `${Math.round(n)}ms`;
  return `${(n / 1000).toFixed(1)}s`;
}

export default function TelemetryFooter({
  model, tokensPerSec, msTotal, msToFirstToken, tokensIn, tokensOut,
  loadDurationMs,
}: Props) {
  // Only count load_duration when it's a real cold-load (>= 100ms). Below
  // that threshold Ollama reports trivial KV-cache reset times that aren't
  // useful to surface.
  const showLoad = typeof loadDurationMs === 'number' && loadDurationMs >= 100;
  const haveAny = model || tokensPerSec !== null || msTotal !== null
    || msToFirstToken !== null || tokensIn !== null || tokensOut !== null
    || showLoad;
  if (!haveAny) return null;
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
      {model && <span className="font-mono">{model}</span>}
      {tokensPerSec !== null && <span>{num(tokensPerSec)} tok/s</span>}
      {msTotal !== null && <span>{ms(msTotal)} total</span>}
      {msToFirstToken !== null && <span>{ms(msToFirstToken)} TTFT</span>}
      {showLoad && <span>loaded in {ms(loadDurationMs ?? null)}</span>}
      {(tokensIn !== null || tokensOut !== null) && (
        <span>{tokensIn ?? '?'} in / {tokensOut ?? '?'} out</span>
      )}
    </div>
  );
}
