// Inline-SVG fallbacks for 3D assets and the audio last-resort. The tile
// grid already renders a lucide Box / Music icon on these rows; the route
// serving the same icon shape keeps image-src swaps visually consistent.
// Deterministic content => not written to disk.

import type { ThumbInlineResult } from '../types.js';

const BOX_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="320" height="240" preserveAspectRatio="xMidYMid meet" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="background:linear-gradient(135deg,#f1f5f9,#cbd5e1);color:#94a3b8">
  <path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/>
  <polyline points="3.29 7 12 12 20.71 7"/>
  <line x1="12" y1="22" x2="12" y2="12"/>
</svg>`;

const MUSIC_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="320" height="240" preserveAspectRatio="xMidYMid meet" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="background:linear-gradient(135deg,#f8fafc,#cbd5e1);color:#94a3b8">
  <path d="M9 18V5l12-2v13"/>
  <circle cx="6" cy="18" r="3"/>
  <circle cx="18" cy="16" r="3"/>
</svg>`;

export function inlineBoxSvg(): ThumbInlineResult {
  return { kind: 'inline', body: BOX_SVG, contentType: 'image/svg+xml' };
}

export function inlineMusicSvg(): ThumbInlineResult {
  return { kind: 'inline', body: MUSIC_SVG, contentType: 'image/svg+xml' };
}
