// Deterministic gradient "cover art" for songs that have no `coverUrl` yet.
// Ported from ace-step-ui's `components/AlbumCover.tsx` — same seeded-RNG +
// curated-palette approach (trimmed to fewer pattern variants to keep this
// file small), just re-skinned as a plain `<div style={...}>` so it drops
// into comfy's grid/list layouts without any ace-specific classes.

import { useMemo } from 'react';
import { cn } from '../../lib/utils';

interface AlbumCoverProps {
  seed: string;
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl' | 'full';
  className?: string;
}

class SeededRandom {
  private seed: number;
  constructor(seed: string) { this.seed = this.hash(seed); }
  private hash(str: string): number {
    let h = 0;
    for (let i = 0; i < str.length; i += 1) {
      h = ((h << 5) - h) + str.charCodeAt(i);
      h &= h;
    }
    return Math.abs(h) || 1;
  }
  next(): number {
    this.seed = (this.seed * 1103515245 + 12345) & 0x7fffffff;
    return this.seed / 0x7fffffff;
  }
  int(min: number, max: number): number { return Math.floor(min + this.next() * (max - min)); }
  pick<T>(arr: T[]): T { return arr[this.int(0, arr.length)]; }
}

const PALETTES: { colors: [string, string, string, string]; bg: string }[] = [
  { colors: ['#FF6B6B', '#FEC89A', '#FFD93D', '#C9184A'], bg: '#1a1a2e' },
  { colors: ['#0077B6', '#00B4D8', '#90E0EF', '#CAF0F8'], bg: '#03045E' },
  { colors: ['#2D6A4F', '#40916C', '#52B788', '#95D5B2'], bg: '#1B4332' },
  { colors: ['#F72585', '#7209B7', '#3A0CA3', '#4CC9F0'], bg: '#10002B' },
  { colors: ['#FF9500', '#FF5400', '#FFBD00', '#FFE066'], bg: '#2D1B00' },
  { colors: ['#E0AAFF', '#C77DFF', '#9D4EDD', '#7B2CBF'], bg: '#240046' },
  { colors: ['#00FF87', '#60EFFF', '#FF00E5', '#FFE500'], bg: '#0D0D0D' },
  { colors: ['#7400B8', '#5E60CE', '#4EA8DE', '#56CFE1'], bg: '#03071E' },
  { colors: ['#9D174D', '#BE185D', '#DB2777', '#EC4899'], bg: '#1C0A14' },
  { colors: ['#84CC16', '#A3E635', '#BEF264', '#ECFCCB'], bg: '#1A2E05' },
];

function generateStyle(seed: string): React.CSSProperties {
  const rng = new SeededRandom(seed);
  const { colors: c, bg } = rng.pick(PALETTES);
  const variant = rng.int(0, 4);
  switch (variant) {
    case 0: // orbs
      return {
        background: [
          `radial-gradient(circle ${rng.int(30, 70)}% at ${rng.int(10, 90)}% ${rng.int(10, 90)}%, ${c[0]}99 0%, transparent 65%)`,
          `radial-gradient(circle ${rng.int(30, 70)}% at ${rng.int(10, 90)}% ${rng.int(10, 90)}%, ${c[1]}99 0%, transparent 65%)`,
          `radial-gradient(circle ${rng.int(30, 70)}% at ${rng.int(10, 90)}% ${rng.int(10, 90)}%, ${c[2]}88 0%, transparent 65%)`,
          `linear-gradient(135deg, ${bg} 0%, ${c[0]}11 100%)`,
        ].join(', '),
        backgroundColor: bg,
      };
    case 1: // mesh
      return {
        background: [
          `radial-gradient(at ${rng.int(0, 40)}% ${rng.int(0, 40)}%, ${c[0]} 0%, transparent 50%)`,
          `radial-gradient(at ${rng.int(60, 100)}% ${rng.int(0, 40)}%, ${c[1]} 0%, transparent 50%)`,
          `radial-gradient(at ${rng.int(0, 40)}% ${rng.int(60, 100)}%, ${c[2]} 0%, transparent 50%)`,
          `radial-gradient(at ${rng.int(60, 100)}% ${rng.int(60, 100)}%, ${c[3]} 0%, transparent 50%)`,
        ].join(', '),
        backgroundColor: bg,
      };
    case 2: // rays
      return {
        background: [
          `radial-gradient(circle at ${rng.int(30, 70)}% ${rng.int(30, 70)}%, ${c[0]} 0%, transparent 30%)`,
          ...Array.from({ length: rng.int(6, 10) }, (_, i) => {
            const angle = (360 / 8) * i;
            return `linear-gradient(${angle}deg, transparent 0%, transparent 45%, ${c[i % 4]}66 48%, ${c[i % 4]}66 52%, transparent 55%, transparent 100%)`;
          }),
        ].join(', '),
        backgroundColor: bg,
      };
    default: // simple diagonal gradient
      return { background: `linear-gradient(${rng.int(0, 360)}deg, ${c[0]} 0%, ${c[1]} 33%, ${c[2]} 66%, ${c[3]} 100%)` };
  }
}

const SIZE_CLASS: Record<NonNullable<AlbumCoverProps['size']>, string> = {
  xs: 'w-8 h-8',
  sm: 'w-10 h-10',
  md: 'w-12 h-12',
  lg: 'w-14 h-14',
  xl: 'w-48 h-48',
  full: 'w-full h-full',
};

export function AlbumCover({ seed, size = 'md', className }: AlbumCoverProps) {
  const style = useMemo(() => generateStyle(seed), [seed]);
  return (
    <div
      aria-hidden
      className={cn('relative shrink-0 overflow-hidden rounded-md shadow-sm', SIZE_CLASS[size], className)}
      style={style}
    />
  );
}

export default AlbumCover;
