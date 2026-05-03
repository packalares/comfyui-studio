import React from 'react';
import { Link } from 'react-router-dom';
import { Home } from 'lucide-react';

interface PageSubbarProps {
  title: string;
  description?: string;
  right?: React.ReactNode;
}

export default function PageSubbar({ title, description, right }: PageSubbarProps) {
  return (
    <div className="sticky top-14 z-40 border-b border-slate-200 bg-slate-50/90 backdrop-blur">
      <div className="max-w-[1400px] mx-auto px-4 sm:px-6 py-2.5 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <Link to="/" className="text-slate-400 hover:text-slate-600 transition-colors" aria-label="Home">
            <Home className="w-3.5 h-3.5" />
          </Link>
          <span className="text-slate-300">/</span>
          <span className="text-sm font-semibold text-slate-900">{title}</span>
          {description && (
            <>
              <span className="text-slate-300">/</span>
              <span className="text-xs text-slate-500 truncate">{description}</span>
            </>
          )}
        </div>
        {right && <div className="flex items-center gap-2 shrink-0">{right}</div>}
      </div>
    </div>
  );
}
