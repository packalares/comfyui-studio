interface Props {
  name: string;
  installed?: boolean;
}

export default function ModelBadge({ name, installed }: Props) {
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium ${
      installed === false
        ? 'bg-red-50 text-red-600 border border-red-200'
        : installed === true
        ? 'bg-green-50 text-green-700 border border-green-200'
        : 'bg-blue-50 text-blue-700 border border-blue-200'
    }`}>
      {installed !== undefined && (
        <span className={`w-1.5 h-1.5 rounded-full ${installed ? 'bg-green-500' : 'bg-red-400'}`} />
      )}
      {name}
    </span>
  );
}
