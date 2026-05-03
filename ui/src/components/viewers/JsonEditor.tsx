import { useState, useEffect } from 'react';

interface Props {
  values: Record<string, unknown>;
  onChange: (values: Record<string, unknown>) => void;
}

export default function JsonEditor({ values, onChange }: Props) {
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setText(JSON.stringify(values, null, 2));
  }, [values]);

  const handleChange = (newText: string) => {
    setText(newText);
    try {
      const parsed = JSON.parse(newText);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        setError(null);
        onChange(parsed);
      } else {
        setError('Must be a JSON object');
      }
    } catch {
      setError('Invalid JSON');
    }
  };

  return (
    <div className="relative">
      <textarea
        value={text}
        onChange={e => handleChange(e.target.value)}
        spellCheck={false}
        className="w-full h-80 px-3 py-3 text-sm font-mono text-green-700 bg-white border border-gray-300 rounded-lg resize-none focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-teal-500 leading-relaxed"
        style={{ tabSize: 2 }}
      />
      {error && (
        <p className="mt-1.5 text-xs text-red-500">{error}</p>
      )}
    </div>
  );
}
