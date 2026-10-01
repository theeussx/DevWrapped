/**
 * Standalone HTML export of the retrospective.
 *
 * The exported file is completely self contained: inline styles, no scripts,
 * no fonts and no images loaded from anywhere. That means it can be opened
 * offline, attached to a message or dropped on a website without ever making a
 * request — and it cannot leak anything that was not in the payload.
 *
 * Every dynamic value goes through `escapeHtml`.
 */

import type { WrappedPayload, WrappedSlide } from '../types/analytics';
import { escapeHtml } from '../security/Sanitization';

export interface WrappedHtmlOptions {
  /** Extension version, shown in the footer. */
  version: string;
  generatedAt: number;
  locale: string;
}

/** Builds the standalone retrospective document. */
export function buildWrappedHtml(payload: WrappedPayload, options: WrappedHtmlOptions): string {
  const slides = payload.slides.map((slide) => renderSlide(slide)).join('\n');
  const empty = payload.available ? '' : `<p class="empty">${escapeHtml(payload.message ?? 'No data recorded for this year yet.')}</p>`;

  return `<!doctype html>
<html lang="${escapeHtml(options.locale.slice(0, 5))}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; script-src 'none'; base-uri 'none'; form-action 'none'">
<title>${escapeHtml(`Code Wrapped ${payload.year}`)}</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 48px 20px 64px;
    background: #0d1117;
    color: #e6edf3;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    line-height: 1.5;
  }
  .page { max-width: 760px; margin: 0 auto; }
  header { text-align: center; margin-bottom: 40px; }
  .eyebrow { text-transform: uppercase; letter-spacing: .18em; font-size: 12px; color: #8b949e; }
  h1 { font-size: 40px; margin: 12px 0 8px; background: linear-gradient(90deg, #4d9fff, #a371f7); -webkit-background-clip: text; background-clip: text; color: transparent; }
  .subtitle { color: #8b949e; font-size: 14px; }
  section.slide {
    background: #161b22;
    border: 1px solid #21262d;
    border-radius: 16px;
    padding: 24px;
    margin-bottom: 20px;
  }
  .kicker { text-transform: uppercase; letter-spacing: .14em; font-size: 11px; color: #8b949e; }
  .slide h2 { font-size: 20px; margin: 8px 0 4px; }
  .value { font-size: 34px; font-weight: 600; margin: 4px 0; }
  .unit { color: #8b949e; font-size: 14px; }
  .caption { margin-top: 12px; color: #c9d1d9; font-size: 14px; }
  .footnote { margin-top: 10px; color: #6e7681; font-size: 12px; }
  ul.bars { list-style: none; margin: 16px 0 0; padding: 0; }
  ul.bars li { margin-bottom: 10px; }
  .bar-head { display: flex; justify-content: space-between; font-size: 13px; margin-bottom: 4px; }
  .bar-track { height: 8px; border-radius: 999px; background: #21262d; overflow: hidden; }
  .bar-fill { height: 100%; border-radius: 999px; background: linear-gradient(90deg, #4d9fff, #a371f7); }
  .leader .bar-head { color: #ffffff; font-weight: 600; }
  .empty { text-align: center; color: #8b949e; }
  footer { margin-top: 32px; text-align: center; color: #6e7681; font-size: 12px; }
  .privacy { margin-top: 8px; }
</style>
</head>
<body>
<div class="page">
  <header>
    <div class="eyebrow">Code Wrapped</div>
    <h1>${escapeHtml(String(payload.year))}</h1>
    <div class="subtitle">Your coding year, measured locally.</div>
  </header>
  ${empty}
  ${slides}
  <footer>
    Generated on ${escapeHtml(new Date(options.generatedAt).toISOString().slice(0, 10))} by Dev Wrapped ${escapeHtml(options.version)}.
    <div class="privacy">Local statistics only · no source code, file names, paths or telemetry.</div>
  </footer>
</div>
</body>
</html>
`;
}

/* --------------------------------- helpers -------------------------------- */

function renderSlide(slide: WrappedSlide): string {
  const bars =
    slide.bars.length > 0
      ? `<ul class="bars">${slide.bars.map((bar) => renderBar(bar)).join('')}</ul>`
      : '';
  return `<section class="slide">
  <div class="kicker">${escapeHtml(slide.kicker)}</div>
  <h2>${escapeHtml(slide.title)}</h2>
  <div class="value">${escapeHtml(slide.value)}</div>
  <div class="unit">${escapeHtml(slide.unit)}</div>
  <p class="caption">${escapeHtml(slide.caption)}</p>
  ${bars}
  <p class="footnote">${escapeHtml(slide.footnote)}</p>
</section>`;
}

function renderBar(bar: { label: string; detail: string; share: number; leader: boolean }): string {
  const width = Math.max(2, Math.min(100, Math.round(bar.share * 100)));
  return `<li class="${bar.leader ? 'leader' : ''}">
  <div class="bar-head"><span>${escapeHtml(bar.label)}</span><span>${escapeHtml(bar.detail)}</span></div>
  <div class="bar-track"><div class="bar-fill" style="width:${width}%"></div></div>
</li>`;
}
