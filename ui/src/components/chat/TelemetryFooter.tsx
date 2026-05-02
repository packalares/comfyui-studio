interface Props {
  model: string | null;
  tokensPerSec: number | null;
  msTotal: number | null;
  msToFirstToken: number | null;
  tokensIn: number | null;
  tokensOut: number | null;
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
}: Props) {
  const haveAny = model || tokensPerSec !== null || msTotal !== null || msToFirstToken !== null || tokensIn !== null || tokensOut !== null;
  if (!haveAny) return null;
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-400">
      {model && <span className="font-mono">{model}</span>}
      {tokensPerSec !== null && <span>{num(tokensPerSec)} tok/s</span>}
      {msTotal !== null && <span>{ms(msTotal)} total</span>}
      {msToFirstToken !== null && <span>{ms(msToFirstToken)} TTFT</span>}
      {(tokensIn !== null || tokensOut !== null) && (
        <span>{tokensIn ?? '?'} in / {tokensOut ?? '?'} out</span>
      )}
    </div>
  );
}
