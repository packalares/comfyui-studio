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

// Generic "no preview" placeholder. Served by every /thumbnail mode when the
// source is missing (URL 404, DB row gone, template asset absent). The
// `transient` flag carries through to the route layer so the response is
// `Cache-Control: no-store` — the browser will refetch the real bytes on
// the next render once the upstream file appears.
// Card-sized placeholder: 320x180 (16:9) so it never gets cropped by
// `object-cover`. Dark zinc theme matching the studio's card surface.
// Includes a SMIL shimmer overlay (works inside <img src=…> SVGs in all
// modern browsers; CSS animations would not run in that mode).
const PLACEHOLDER_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 180" width="320" height="180" preserveAspectRatio="xMidYMid meet">
  <defs>
    <linearGradient id="ph-shimmer" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#71717a" stop-opacity="0">
        <animate attributeName="offset" values="-0.5;1.0" dur="2.2s" repeatCount="indefinite"/>
      </stop>
      <stop offset="50%" stop-color="#a1a1aa" stop-opacity="0.16">
        <animate attributeName="offset" values="-0.25;1.25" dur="2.2s" repeatCount="indefinite"/>
      </stop>
      <stop offset="100%" stop-color="#71717a" stop-opacity="0">
        <animate attributeName="offset" values="0;1.5" dur="2.2s" repeatCount="indefinite"/>
      </stop>
    </linearGradient>
  </defs>
  <rect width="320" height="180" fill="#27272a"/>
  <rect width="320" height="180" fill="url(#ph-shimmer)"/>
  <rect x="136" y="56" width="48" height="48" rx="12" fill="#3f3f46"/>
  <g transform="translate(148 68)" fill="none" stroke="#71717a" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
    <path d="M4 5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5Z"/>
    <path d="m4 16 4.5-4.5a2 2 0 0 1 2.8 0L20 20"/>
    <path d="m14 14 1.5-1.5a2 2 0 0 1 2.8 0L20 14"/>
    <circle cx="9" cy="8" r="1.5"/>
  </g>
  <text x="160" y="132" text-anchor="middle" font-family="system-ui, -apple-system, 'Segoe UI', sans-serif" font-size="13" fill="#71717a">Image unavailable</text>
</svg>`;

export function inlineBoxSvg(): ThumbInlineResult {
  return { kind: 'inline', body: BOX_SVG, contentType: 'image/svg+xml' };
}

export function inlineMusicSvg(): ThumbInlineResult {
  return { kind: 'inline', body: MUSIC_SVG, contentType: 'image/svg+xml' };
}

/**
 * Single source of truth for the "missing source" placeholder consumed by
 * URL mode, gallery DB mode, and template mode. `transient: true` makes the
 * route emit `Cache-Control: no-store` so the placeholder isn't cached past
 * the upstream becoming available.
 */
export function thumbnailPlaceholder(): ThumbInlineResult {
  return {
    kind: 'inline',
    body: PLACEHOLDER_SVG,
    contentType: 'image/svg+xml',
    transient: true,
  };
}
