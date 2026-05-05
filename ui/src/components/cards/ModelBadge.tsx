interface Props {
  name: string;
  installed?: boolean;
}

export default function ModelBadge({ name, installed }: Props) {
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium ${
      installed === false
        ? 'bg-destructive/10 text-destructive border border-destructive/30'
        : installed === true
        ? 'bg-success/10 text-success border border-success/30'
        : 'bg-muted text-muted-foreground border'
    }`}>
      {installed !== undefined && (
        <span className={`w-1.5 h-1.5 rounded-full ${installed ? 'bg-success' : 'bg-destructive'}`} />
      )}
      {name}
    </span>
  );
}
