/*
 * AIsa report charts — the report series: marks you can count (cells, ticks, dots, one hairline per day), ink by
 * importance, one orange mark per chart (ringed with the brand's turned hexagons), the finding as the title, how to
 * read it underneath and where the numbers come from at the foot. Charts draw in reading order the first time they
 * are seen (charts already on screen at load draw at once; the rest rest finished, readable in thumbnails and print,
 * and draw again as they scroll in). Click "Replay" or the empty plot to draw again. Reduced motion: no drawing.
 *
 * import { strokeChart } from './aisa-report.js'; strokeChart(el, { title, read, values, ... })
 * or <script src="aisa-report.global.js"> → window.AisaReport.strokeChart(el, {...})
 * Every chart returns { update(partialConfig), replay(), destroy() }. Needs aisa-tokens.css and aisa-report.css.
 * Dashboards keep using aisa-charts.js (compact); these are for reports, articles, launch pages and READMEs.
 */

// ---------------------------------------------------------------- messages (add a language with setMessages)
const MESSAGES = {
  en: {
    replay: 'Replay', rank: 'Rank', map: 'Map', source: 'Source: {source}', crossed: '{label} · crossed {goal}', goal: 'Goal {value}',
    over: '{pct} over goal', under: '{pct} short of goal', total: 'Total', average: '{n}-day average {value}', time: 'Time {pct}', behind: 'behind',
    better: '↑ better', cells: '{n} cells', part: ' + {part}', ofAll: '{pct} of all', ofGroup: '{pct} of {name}', stay: '{pct} stay',
    dropped: 'about {n} dropped here', change: 'Change', rankFromTo: 'No. {from} → No. {to}', bestRank: 'best No. {n}', share: '{pct}',
    requests: '{n} samples', over2: '{n} over {limit}', links: '{n} links', drag: 'drag a node', of: '{a} of {b}', more: '+{n} more',
    perUnit: 'one cell = {unit}', running: 'Running total', perRung: 'one rung = {unit}',
  },
  'zh-CN': {
    replay: '重播', rank: '排名', map: '关系', source: '来源：{source}', crossed: '{label} · 越过 {goal}', goal: '目标 {value}',
    over: '超目标 {pct}', under: '离目标还差 {pct}', total: '合计', average: '{n} 天平均 {value}', time: '时间 {pct}', behind: '落后',
    better: '↑ 越往上越好', cells: '{n} 格', part: ' + {part}', ofAll: '占全部 {pct}', ofGroup: '占{name} {pct}', stay: '{pct} 留下',
    dropped: '这一步掉队约 {n}', change: '变化', rankFromTo: '第 {from} → 第 {to} 名', bestRank: '最好到过第 {n}', share: '{pct}',
    requests: '{n} 个样本', over2: '超过 {limit} 的 {n} 个', links: '{n} 条连线', drag: '可拖动', of: '{a} / {b}', more: '另 {n} 个',
    perUnit: '一格 = {unit}', running: '累计', perRung: '一格横档 = {unit}',
  },
};
export function setMessages(locale, messages) {
  MESSAGES[locale] = { ...(MESSAGES[locale] ?? {}), ...messages };
}
const lang = () => document.documentElement.lang || navigator.language || 'en';
function msg(key, params = {}) {
  const l = lang();
  let text;
  for (const code of [l, l.split('-')[0], 'en']) {
    const hit = Object.keys(MESSAGES).find((k) => k.toLowerCase() === code.toLowerCase() || k.split('-')[0] === code);
    if (hit && MESSAGES[hit][key] !== undefined) { text = MESSAGES[hit][key]; break; }
  }
  return (text ?? key).replace(/\{(\w+)\}/g, (m, k) => (k in params ? String(params[k]) : m));
}

// ---------------------------------------------------------------- numbers (Intl, in the page language)
/** format: { style: 'decimal'|'percent'|'currency', currency, decimals, unit, unitSpace, notation: 'compact' } */
function formatter(fmt = {}) {
  // compact numbers round the short form (15.6K, 1.56万), so they keep three significant digits rather than
  // `decimals` places: decimals 0 would turn 15,583 into "2万"
  const compact = fmt.notation === 'compact';
  const o = compact ? { maximumSignificantDigits: fmt.significant ?? 3 } : { maximumFractionDigits: fmt.decimals ?? 1 };
  if (!compact && fmt.decimals !== undefined) o.minimumFractionDigits = Math.min(fmt.decimals, fmt.minDecimals ?? fmt.decimals);
  if (fmt.style === 'percent') Object.assign(o, { style: 'percent', maximumFractionDigits: fmt.decimals ?? 0 });
  if (fmt.style === 'currency') Object.assign(o, { style: 'currency', currency: fmt.currency ?? 'USD' });
  if (fmt.notation) o.notation = fmt.notation;
  const nf = new Intl.NumberFormat(lang(), o);
  return (v) => (v === null || v === undefined || Number.isNaN(v) ? '–' : nf.format(v) + (fmt.unit ? `${fmt.unitSpace === false ? '' : ' '}${fmt.unit}` : ''));
}
const pct = (v, d = 0) => new Intl.NumberFormat(lang(), { style: 'percent', maximumFractionDigits: d }).format(v);
const signed = (f, v) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${f(Math.abs(v))}`;

// ---------------------------------------------------------------- drawing helpers
const NS = 'http://www.w3.org/2000/svg';
function S(tag, attrs = {}, parent) {
  const n = document.createElementNS(NS, tag);
  for (const k in attrs) if (attrs[k] !== undefined && attrs[k] !== null) n.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(n);
  return n;
}
/** SVG text; `kind` picks the type role: 'mono' (units, axes, notes), 'num' (display numbers), 'label' (names) */
function T(parent, x, y, text, attrs = {}, kind = 'label') {
  const { class: extra, ...rest } = attrs;
  const t = S('text', { x, y, ...rest, class: `ar-t ar-t--${kind}${extra ? ` ${extra}` : ''}` }, parent);
  t.textContent = text;
  return t;
}
function el(tag, cls, parent, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  if (parent) parent.appendChild(n);
  return n;
}
const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
const outCubic = (t) => 1 - (1 - t) ** 3;
const inOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const seg = (e, start, len) => (e === Infinity ? 1 : clamp((e - start) / len));
/** deterministic jitter, so a refresh draws the same picture */
const rnd = (i, k = 1) => { const x = Math.sin(i * 12.9898 + k * 78.233) * 43758.5453; return x - Math.floor(x); };
const gauss = (i, k) => Math.sqrt(-2 * Math.log(Math.max(1e-6, rnd(i, k)))) * Math.cos(2 * Math.PI * rnd(i, k + 17));
let measure;
function textWidth(text, size = 12, family = 'Inter, system-ui, sans-serif') {
  measure ??= document.createElement('canvas').getContext('2d');
  measure.font = `${size}px ${family}`;
  return measure.measureText(String(text)).width;
}
const hexPath = (r, rot = 0) => 'M' + Array.from({ length: 6 }, (_, k) => {
  const a = ((-90 + 60 * k + rot) * Math.PI) / 180;
  return `${(r * Math.cos(a)).toFixed(2)},${(r * Math.sin(a)).toFixed(2)}`;
}).join('L') + 'Z';
/** "this one": two hexagons, the outer one turned, as in the brand's hex rings */
function hexRing(parent, x, y, r, color, extra = {}) {
  const g = S('g', { transform: `translate(${x},${y})`, ...extra }, parent);
  S('path', { d: hexPath(r), fill: 'none', stroke: color, 'stroke-width': 1.4, 'stroke-linejoin': 'round' }, g);
  S('path', { d: hexPath(r * 1.42, 14), fill: 'none', stroke: color, 'stroke-width': 1, 'stroke-linejoin': 'round', opacity: 0.5 }, g);
  return g;
}
/** smooth path through points (Catmull-Rom as cubic Béziers) */
function smooth(pts) {
  if (pts.length < 2) return '';
  let d = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] ?? p2;
    d += `C${(p1[0] + (p2[0] - p0[0]) / 6).toFixed(1)},${(p1[1] + (p2[1] - p0[1]) / 6).toFixed(1)} ${(p2[0] - (p3[0] - p1[0]) / 6).toFixed(1)},${(p2[1] - (p3[1] - p1[1]) / 6).toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
  }
  return d;
}
let clipSeq = 0;
/** a clip rectangle that reveals a drawing from the left; animate its width */
function revealClip(svg, H) {
  const id = `ar-clip-${++clipSeq}`;
  const cp = S('clipPath', { id }, S('defs', {}, svg));
  return { id, rect: S('rect', { x: -20, y: -60, width: 0, height: H + 120 }, cp) };
}
/** spread label positions apart by at least `gap`, keeping their order */
function spread(ys, gap) {
  const order = ys.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  for (let k = 1; k < order.length; k++) if (order[k][0] - order[k - 1][0] < gap) order[k][0] = order[k - 1][0] + gap;
  const out = [];
  order.forEach(([v, i]) => (out[i] = v));
  return out;
}
/** whole units that add up to `total` (largest remainder), e.g. shares as 100 cells */
function apportion(values, total) {
  const sum = values.reduce((a, b) => a + b, 0) || 1;
  const raw = values.map((v) => (v / sum) * total);
  const out = raw.map(Math.floor);
  let left = total - out.reduce((a, b) => a + b, 0);
  raw.map((v, i) => [v - Math.floor(v), i]).sort((a, b) => b[0] - a[0]).forEach(([, i]) => { if (left-- > 0) out[i]++; });
  return out;
}

// ---------------------------------------------------------------- colours from the tokens
function tok(node, name) { return getComputedStyle(node).getPropertyValue(name).trim(); }
function palette(fig) {
  const ink = fig.classList.contains('ar-fig--ink');
  const t = (n) => tok(fig, n);
  return ink ? {
    ink: true, text: t('--aisa-ink-0'), body: t('--aisa-ink-300'), sec: t('--aisa-ink-400'), muted: t('--aisa-ink-500'),
    faint: 'rgba(255,255,255,.07)', soft: t('--aisa-ink-600'), mid: t('--aisa-ink-400'), strong: t('--aisa-ink-200'),
    accent: t('--aisa-orange-400'), paper: t('--aisa-ink-900'), onDark: t('--aisa-ink-0'), onLight: t('--aisa-ink-900'),
    ramp: [t('--aisa-ink-700'), t('--aisa-ink-600'), t('--aisa-ink-500'), t('--aisa-ink-400'), t('--aisa-ink-300'), t('--aisa-ink-200'), t('--aisa-ink-100')],
  } : {
    ink: false, text: t('--aisa-text'), body: t('--aisa-text-body'), sec: t('--aisa-text-secondary'), muted: t('--aisa-text-muted'),
    faint: t('--aisa-line'), soft: t('--aisa-line-strong'), mid: t('--aisa-ink-400'), strong: t('--aisa-chart-single'),
    accent: t('--aisa-accent'), paper: t('--aisa-bg-report') || t('--aisa-bg'), onDark: t('--aisa-ink-0'), onLight: t('--aisa-ink-900'),
    ramp: [1, 2, 3, 4, 5, 6, 7].map((k) => t(`--aisa-seq-${k}`)),
  };
}
/** a fill for rank k of n (0 = most important = darkest), never the accent */
const ladder = (P, k, n) => {
  const steps = P.ink ? [P.strong, P.body, P.mid, P.muted, P.soft] : [P.ramp[6], P.ramp[5], P.ramp[3], P.ramp[2], P.ramp[1]];
  return steps[Math.min(steps.length - 1, Math.round((k / Math.max(1, n - 1)) * (Math.min(n, steps.length) - 1)))];
};

// ---------------------------------------------------------------- tooltip
function tagFor(plot) {
  let t = plot.querySelector(':scope > .ar-tag');
  if (!t) { t = el('div', 'ar-tag', plot); t.setAttribute('role', 'status'); }
  return {
    /** rows: [[label, value?, note?], …] built with textContent */
    show(x, y, title, rows = [], side = 'right') {
      t.textContent = '';
      el('div', 'ar-tag__title', t, title);
      for (const [label, value, note] of rows) {
        const r = el('div', 'ar-tag__row', t);
        if (label) el('span', 'ar-tag__label', r, label);
        if (value !== undefined && value !== '') el('b', '', r, value);
        if (note) el('span', 'ar-tag__note', r, note);
      }
      t.classList.add('is-on');
      const w = t.offsetWidth, h = t.offsetHeight, pw = plot.clientWidth;
      let left = side === 'right' ? x + 14 : x - w - 14;
      if (left + w > pw) left = x - w - 14;
      if (left < 0) left = Math.min(pw - w, x + 14);
      t.style.left = `${Math.max(0, left)}px`;
      t.style.top = `${clamp(y - h / 2, -8, plot.clientHeight - h + 8)}px`;
    },
    hide() { t.classList.remove('is-on'); },
  };
}
/** dim every member of `groups` except `keep` (null: none dimmed) */
function spotlight(groups, keep) { groups.forEach((g, i) => g.classList.toggle('is-dim', keep !== null && keep !== undefined && i !== keep)); }

// ---------------------------------------------------------------- the figure and its lifecycle
const live = new Set();
let watching = false;
const reduced = () => !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
function watch() {
  if (watching) return;
  watching = true;
  const redraw = () => live.forEach((c) => c.render());
  window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', redraw);
  new MutationObserver(redraw).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'lang'] });
}
const io = typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver((entries) => entries.forEach((en) => {
  if (!en.isIntersecting) return;
  io.unobserve(en.target);
  en.target.__arChart?.play();
}), { rootMargin: '0px 0px -12% 0px' });

/**
 * Mounts one chart: the figure (kicker, title, how to read it, plot, foot with unit note and source, replay) and its
 * drawing. `build(plot, cfg, ctx)` draws at the plot's width and returns { dur, frame(elapsedMs | Infinity) }.
 */
function mount(host, cfg, build, kind) {
  const state = { cfg, played: false, raf: 0, frame: () => {}, dur: 0 };
  host.innerHTML = '';
  const fig = el('figure', `ar-fig ar-fig--${kind}${cfg.ink ? ' ar-fig--ink' : ''}`, host);
  const head = el('figcaption', 'ar-fig__head', fig);
  if (cfg.kicker) el('div', 'ar-fig__kicker', head, cfg.kicker);
  if (cfg.title) el('div', 'ar-fig__title', head, cfg.title);
  if (cfg.read) el('p', 'ar-fig__read', head, cfg.read);
  const controls = el('div', 'ar-fig__controls', fig);
  const plot = el('div', 'ar-fig__plot', fig);
  const foot = el('div', 'ar-fig__foot', fig);
  const replayBtn = el('button', 'ar-fig__replay', fig, `${msg('replay')} ↻`);
  replayBtn.type = 'button';
  const ctx = {
    fig, plot, controls,
    get played() { return state.played; },
    onReplay: null,
  };
  const render = () => {
    cancelAnimationFrame(state.raf);
    const c = state.cfg;
    fig.classList.toggle('ar-fig--ink', !!c.ink);
    replayBtn.textContent = `${msg('replay')} ↻`;
    foot.textContent = '';
    if (c.note) el('span', '', foot, c.note);
    if (c.source) el('span', '', foot, msg('source', { source: c.source }));
    foot.hidden = !c.note && !c.source;
    plot.querySelectorAll(':scope > :not(.ar-tag)').forEach((n) => n.remove());
    controls.textContent = '';
    const r = build(plot, c, ctx);
    state.frame = r.frame;
    state.dur = r.dur;
    state.frame(state.played || reduced() || c.animate === false ? Infinity : 0);
  };
  const play = () => {
    if (reduced() || state.cfg.animate === false) { state.played = true; state.frame(Infinity); return; }
    cancelAnimationFrame(state.raf);
    ctx.onReplay?.();
    const t0 = performance.now();
    const step = (now) => {
      const e = now - t0;
      state.frame(e);
      if (e < state.dur) state.raf = requestAnimationFrame(step);
      else { state.played = true; state.frame(Infinity); }
    };
    state.raf = requestAnimationFrame(step);
  };
  replayBtn.addEventListener('click', play);
  plot.addEventListener('click', (e) => { if (e.target === plot || e.target.dataset?.bg) play(); });
  let lastW = 0;
  const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => {
    const w = plot.clientWidth;
    if (Math.abs(w - lastW) > 3) { lastW = w; render(); }
  });
  const chart = {
    render,
    play,
    replay: play,
    update(next) { state.cfg = { ...state.cfg, ...next }; render(); },
    destroy() { cancelAnimationFrame(state.raf); ro?.disconnect(); io?.unobserve(host); live.delete(chart); host.innerHTML = ''; delete host.__arChart; },
  };
  host.__arChart = chart;
  live.add(chart);
  watch();
  // on screen now: draw in at once; further down: rest finished, draw in when it scrolls into view
  const onScreen = host.getBoundingClientRect().top < innerHeight * 0.9;
  state.played = !onScreen;
  render();
  lastW = plot.clientWidth;
  ro?.observe(plot);
  if (onScreen) play();
  else io?.observe(host);
  return chart;
}
/** the svg every chart draws into, with a transparent background that replays on click */
function canvas(plot, W, H) {
  const svg = S('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, class: 'ar-svg', role: 'img' }, plot);
  S('rect', { x: 0, y: 0, width: W, height: H, fill: 'transparent', 'data-bg': 1 }, svg);
  return svg;
}
const widthOf = (plot, cfg, min = 260) => Math.max(min, cfg.width ?? (plot.clientWidth || 600));

// ================================================================ STROKE: a running total drawn in one stroke, the number counting with it
/**
 * strokeChart(el, { title, read, note, source, values: [per period], cumulative: true, labels: [per period],
 *   tickLabels: [per period, '' to skip] (default: every few labels), goal: number | { value, label }, format,
 *   heroFormat, heroLabel, ticks: 6, height: 330 })
 * One hairline per period stands under the line; the big number counts as the line arrives; the period that crosses
 * the goal and the end are annotated, the end with the orange mark.
 */
export function strokeChart(host, cfg) {
  return mount(host, cfg, (plot, c, ctx) => {
    const P = palette(ctx.fig);
    const W = widthOf(plot, c), H = c.height ?? 330;
    const raw = (c.values ?? []).map(Number);
    const n = raw.length;
    const cum = c.cumulative === false ? raw : raw.reduce((a, v, i) => (a.push((a[i - 1] ?? 0) + v), a), []);
    const labels = c.labels ?? cum.map((_, i) => String(i + 1));
    const fmt = formatter(c.format), heroFmt = formatter(c.heroFormat ?? c.format);
    const goal = c.goal === undefined || c.goal === null ? null : typeof c.goal === 'number' ? { value: c.goal } : c.goal;
    const top = Math.max(...cum, goal?.value ?? 0) * 1.08 || 1;
    const narrow = W < 560;
    const m = { l: 2, r: narrow ? 8 : Math.min(170, W * 0.2), t: 104, b: 40 };
    const x = (i) => m.l + (i / Math.max(1, n - 1)) * (W - m.l - m.r);
    const y = (v) => m.t + (1 - v / top) * (H - m.t - m.b);
    const floor = H - m.b;
    const svg = canvas(plot, W, H);
    svg.setAttribute('aria-label', c.title ?? '');
    S('line', { x1: 0, x2: narrow ? W : W - m.r + 24, y1: floor, y2: floor, stroke: P.soft }, svg);
    const every = Math.max(1, Math.round(n / (c.ticks ?? 6)));
    const tickAt = (i) => (c.tickLabels ? c.tickLabels[i] : i % every === 0 ? labels[i] : '');
    for (let i = 0; i < n; i++) {
      const tl = tickAt(i);
      S('line', { x1: x(i), x2: x(i), y1: floor, y2: floor + (tl ? 7 : 4), stroke: P.soft }, svg);
      if (tl) T(svg, x(i), floor + 22, tl, { 'font-size': 10.5, fill: P.muted }, 'mono');
    }
    if (goal) {
      const gl = goal.label ?? msg('goal', { value: fmt(goal.value) });
      const crowded = n && Math.abs(y(cum[n - 1]) - y(goal.value)) < 34;
      S('line', { x1: 0, x2: narrow ? W : W - m.r + 24, y1: y(goal.value), y2: y(goal.value), stroke: P.mid }, svg);
      if (narrow || crowded) T(svg, 0, y(goal.value) - 6, gl, { 'font-size': 10.5, fill: P.sec }, 'mono');
      else T(svg, W - m.r + 30, y(goal.value) + 3.5, gl, { 'font-size': 10.5, fill: P.sec }, 'mono');
    }
    const combs = cum.map((_, i) => S('line', { x1: x(i), x2: x(i), y1: floor, y2: floor, stroke: P.soft }, svg));
    const line = S('path', { fill: 'none', stroke: P.text, 'stroke-width': 2.2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }, svg);
    const head = S('circle', { r: 3.6, fill: P.text }, svg);
    const notes = S('g', { opacity: 0 }, svg);
    const crossI = goal ? cum.findIndex((v) => v >= goal.value) : -1;
    if (crossI > 0) {
      const cx = x(crossI), cy = y(cum[crossI]);
      S('circle', { cx, cy, r: 4.5, fill: P.paper, stroke: P.text, 'stroke-width': 1.5 }, notes);
      const left = cx > W * 0.45;
      const tx = left ? cx - 70 : cx + 70;
      S('path', { d: `M${cx},${cy - 8} C${cx},${cy - 40} ${(cx + tx) / 2},${cy - 56} ${tx},${cy - 58}`, fill: 'none', stroke: P.mid }, notes);
      T(notes, left ? tx - 6 : tx + 6, cy - 54, msg('crossed', { label: labels[crossI], goal: goal.label ?? fmt(goal.value) }), { 'font-size': 10.5, fill: P.sec, 'text-anchor': left ? 'end' : 'start' }, 'mono');
    }
    const end = S('g', { opacity: 0 }, svg);
    if (n) {
      hexRing(end, x(n - 1), y(cum[n - 1]), 7, P.accent);
      S('circle', { cx: x(n - 1), cy: y(cum[n - 1]), r: 4, fill: P.accent }, end);
      // narrow: no right gutter, so the label stands at the foot of the last day's hairline; a running
      // total is highest at its end, which leaves the bottom right clear of the curve
      const ex = narrow ? x(n - 1) - 4 : x(n - 1) + 18, anchor = narrow ? 'end' : 'start', ey = narrow ? floor - 30 : y(cum[n - 1]);
      const halo = { 'paint-order': 'stroke', stroke: P.paper, 'stroke-width': 4 };
      T(end, ex, ey - 2, fmt(cum[n - 1]), { 'font-size': 15, fill: P.text, 'text-anchor': anchor, ...halo }, 'num');
      if (goal) {
        const r = cum[n - 1] / goal.value - 1;
        T(end, ex, ey + 14, `${labels[n - 1]} · ${msg(r >= 0 ? 'over' : 'under', { pct: pct(Math.abs(r)) })}`, { 'font-size': 10.5, fill: P.muted, 'text-anchor': anchor, ...halo }, 'mono');
      }
    }
    const hero = el('div', 'ar-hero', plot);
    const heroB = el('b', '', hero);
    if (c.heroLabel) el('span', '', hero, c.heroLabel);
    const cross = S('line', { y1: m.t - 10, y2: floor, stroke: P.text, opacity: 0 }, svg);
    const tag = tagFor(plot);
    svg.addEventListener('pointermove', (ev) => {
      if (!ctx.played) return;
      const r = svg.getBoundingClientRect();
      const i = clamp(Math.round(((ev.clientX - r.left - m.l) / (W - m.l - m.r)) * (n - 1)), 0, n - 1);
      cross.setAttribute('x1', x(i)); cross.setAttribute('x2', x(i)); cross.setAttribute('opacity', 0.35);
      tag.show(x(i), y(cum[i]), labels[i], [[msg('running'), fmt(cum[i])], ...(c.cumulative === false ? [] : [['', signed(fmt, raw[i])]])]);
    });
    svg.addEventListener('pointerleave', () => { cross.setAttribute('opacity', 0); tag.hide(); });
    const DUR = 2400;
    return {
      dur: DUR + 700,
      frame(e) {
        const f = (e === Infinity ? 1 : inOut(seg(e, 0, DUR))) * Math.max(0, n - 1);
        const k = Math.floor(f), fr = f - k;
        const pts = [];
        for (let i = 0; i <= Math.min(k, n - 1); i++) pts.push([x(i), y(cum[i])]);
        const v = k < n - 1 ? cum[k] + (cum[k + 1] - cum[k]) * fr : cum[n - 1];
        if (k < n - 1) pts.push([x(k) + (x(k + 1) - x(k)) * fr, y(v)]);
        line.setAttribute('d', pts.length ? 'M' + pts.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('L') : '');
        const [hx, hy] = pts.at(-1) ?? [0, floor];
        head.setAttribute('cx', hx); head.setAttribute('cy', hy); head.setAttribute('opacity', f >= n - 1 ? 0 : 1);
        combs.forEach((ln, i) => ln.setAttribute('y2', floor - (floor - y(cum[i])) * outCubic(clamp((f - i + 0.6) * 1.4))));
        heroB.textContent = heroFmt(e === 0 ? 0 : v);
        const a = seg(e, DUR - 100, 500);
        notes.setAttribute('opacity', a); end.setAttribute('opacity', a);
      },
    };
  }, 'stroke');
}

// ================================================================ DAY STRIP: one hairline a day, scanned left to right
/**
 * dayStrip(el, { title, read, note, source, days: [{ date: 'YYYY-MM-DD', value }], average: 7 (0: none),
 *   highlight: 'max' | index, highlightNote, peaks: 2, format, height: 280, ink: true })
 * Weekdays end in a solid dot, weekends in a hollow one; a cursor scans day by day.
 */
export function dayStrip(host, cfg) {
  return mount(host, cfg, (plot, c, ctx) => {
    const P = palette(ctx.fig);
    const W = widthOf(plot, c), H = c.height ?? 280;
    const fmt = formatter(c.format);
    const days = (c.days ?? []).map((d) => {
      const t = Date.parse(`${String(d.date).slice(0, 10)}T00:00:00Z`);
      const wd = new Date(t).getUTCDay();
      return { t, v: Number(d.value) || 0, weekend: wd === 0 || wd === 6 };
    });
    const n = days.length;
    const avgN = c.average ?? 7;
    const avg = days.map((_, i) => { const s = days.slice(Math.max(0, i - avgN + 1), i + 1); return s.reduce((a, d) => a + d.v, 0) / s.length; });
    const top = Math.max(...days.map((d) => d.v), 1) * 1.15;
    const m = { t: 26, b: 34 };
    const x = (i) => 3 + (i / Math.max(1, n - 1)) * (W - 6);
    const floor = H - m.b;
    const y = (v) => floor - (v / top) * (floor - m.t);
    const svg = canvas(plot, W, H);
    for (let i = 0; i < n; i++) S('line', { x1: x(i), x2: x(i), y1: m.t - 6, y2: floor, stroke: P.faint }, svg);
    S('line', { x1: 0, x2: W, y1: floor, y2: floor, stroke: P.soft }, svg);
    const monthF = new Intl.DateTimeFormat(lang(), { month: 'short', timeZone: 'UTC' });
    const dayF = new Intl.DateTimeFormat(lang(), { month: 'short', day: 'numeric', weekday: 'short', timeZone: 'UTC' });
    days.forEach((d, i) => {
      const dt = new Date(d.t);
      if (dt.getUTCDate() === 1 || i === 0) {
        S('line', { x1: x(i), x2: x(i), y1: floor, y2: floor + 8, stroke: P.muted }, svg);
        T(svg, x(i), floor + 22, monthF.format(dt), { 'font-size': 10.5, fill: P.muted }, 'mono');
      }
    });
    const stems = [], caps = [];
    days.forEach((d, i) => {
      stems.push(S('line', { x1: x(i), x2: x(i), y1: floor, y2: floor, stroke: d.weekend ? P.soft : P.mid, 'stroke-width': 1.3 }, svg));
      caps.push(d.weekend ? S('circle', { cx: x(i), cy: floor, r: 2.3, fill: P.paper, stroke: P.sec, 'stroke-width': 1.1 }, svg) : S('circle', { cx: x(i), cy: floor, r: 2.4, fill: P.strong }, svg));
    });
    const avgLine = S('path', { fill: 'none', stroke: P.text, 'stroke-width': 1.4, opacity: avgN ? 0.85 : 0, 'stroke-linejoin': 'round' }, svg);
    const order = days.map((_, i) => i).sort((a, b) => days[b].v - days[a].v);
    const peak = typeof c.highlight === 'number' ? c.highlight : order[0];
    const labels = S('g', { opacity: 0 }, svg);
    const picked = [peak];
    const room = (i) => textWidth(i === peak ? [fmt(days[i].v), c.highlightNote].filter(Boolean).join(' · ') : fmt(days[i].v), 10.5) / 2 + 8;
    for (const i of order) { if (picked.length > (c.peaks ?? 2)) break; if (picked.every((j) => Math.abs(x(i) - x(j)) > room(i) + room(j))) picked.push(i); }
    picked.slice(1).forEach((i) => T(labels, x(i), y(days[i].v) - 10, fmt(days[i].v), { 'font-size': 10.5, fill: P.body, 'text-anchor': 'middle' }, 'mono'));
    if (n) {
      hexRing(labels, x(peak), y(days[peak].v), 6, P.accent);
      const pl = [fmt(days[peak].v), c.highlightNote].filter(Boolean).join(' · ');
      const right = x(peak) > W - 160;
      T(labels, x(peak) + (right ? 6 : 0), y(days[peak].v) - 16, pl, { 'font-size': 10.5, fill: P.accent, 'text-anchor': right ? 'end' : 'middle' }, 'mono');
    }
    const cursor = S('g', { opacity: 0 }, svg);
    S('line', { x1: 0, x2: 0, y1: m.t - 18, y2: floor, stroke: P.accent }, cursor);
    const cursorT = T(cursor, 6, m.t - 10, '', { 'font-size': 10.5, fill: P.accent }, 'mono');
    const tag = tagFor(plot);
    const hover = S('line', { y1: m.t - 6, y2: floor, stroke: P.text, opacity: 0 }, svg);
    svg.addEventListener('pointermove', (ev) => {
      if (!ctx.played || !n) return;
      const r = svg.getBoundingClientRect();
      const i = clamp(Math.round(((ev.clientX - r.left - 3) / (W - 6)) * (n - 1)), 0, n - 1);
      hover.setAttribute('x1', x(i)); hover.setAttribute('x2', x(i)); hover.setAttribute('opacity', 0.5);
      tag.show(x(i), y(days[i].v), dayF.format(new Date(days[i].t)), [['', fmt(days[i].v)], ...(avgN ? [['', '', msg('average', { n: avgN, value: fmt(avg[i]) })]] : [])]);
    });
    svg.addEventListener('pointerleave', () => { hover.setAttribute('opacity', 0); tag.hide(); });
    const DUR = 2600;
    return {
      dur: DUR + 600,
      frame(e) {
        const f = e === Infinity ? n + 4 : inOut(seg(e, 0, DUR)) * (n + 4);
        days.forEach((d, i) => {
          const r = outCubic(clamp((f - i) / 4));
          const yy = floor - (floor - y(d.v)) * r;
          stems[i].setAttribute('y2', yy); caps[i].setAttribute('cy', yy); caps[i].setAttribute('opacity', r > 0.05 ? 1 : 0);
        });
        const k = Math.min(n - 1, Math.floor(f));
        avgLine.setAttribute('d', f < 1 || !avgN ? '' : 'M' + avg.slice(0, k + 1).map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('L'));
        const scanning = e !== Infinity && e > 0 && f < n;
        cursor.setAttribute('opacity', scanning ? 1 : 0);
        if (scanning) {
          const cx = x(Math.min(n - 1, f));
          cursor.setAttribute('transform', `translate(${cx},0)`);
          cursorT.textContent = dayF.format(new Date(days[Math.min(n - 1, Math.floor(f))].t));
          cursorT.setAttribute('text-anchor', cx > W - 160 ? 'end' : 'start');
          cursorT.setAttribute('x', cx > W - 160 ? -6 : 6);
        }
        labels.setAttribute('opacity', seg(e, DUR - 100, 500));
      },
    };
  }, 'strip');
}

// ================================================================ HIVE COLUMNS: one hexagon per unit
/**
 * hiveColumns(el, { items: [{ name, value, parts: [{ name, value }] }], unit (value per cell; default: about 20 cells for the largest),
 *   perRow: 3, highlight: i, highlightPart: partName, format })
 * With parts, each column stacks its parts from the bottom (same part order in every column), darker = first part.
 */
export function hiveColumns(host, cfg) {
  return mount(host, cfg, (plot, c, ctx) => {
    const P = palette(ctx.fig);
    const W = widthOf(plot, c);
    const items = (c.items ?? []).map((it) => {
      const parts = (it.parts ?? []).map((p) => ({ name: String(p.name), v: Number(p.value) || 0 }));
      return { name: String(it.name), v: parts.length ? parts.reduce((a, p) => a + p.v, 0) : Number(it.value) || 0, parts };
    });
    const partNames = [...new Set(items.flatMap((i) => i.parts.map((p) => p.name)))];
    const partFill = (k) => (partNames[k] === c.highlightPart ? P.accent : ladder(P, k, partNames.length));
    if (partNames.length) {
      const legend = el('div', 'ar-legend', ctx.controls);
      partNames.forEach((name, k) => { const it = el('span', '', legend); el('i', '', it).style.background = partFill(k); it.append(name); });
    }
    const fmt = formatter(c.format);
    const max = Math.max(...items.map((i) => i.v), 1);
    const unit = c.unit ?? niceUnit(max / 20);
    const per = c.perRow ?? 3;
    const colW = (W - 10) / Math.max(1, items.length);
    const r = Math.min(9, (colW * 0.8) / per / Math.sqrt(3) - 0.4);
    const hw = Math.sqrt(3) * r, rowH = 1.5 * r + 1.4;
    const maxRows = Math.ceil(Math.ceil(max / unit) / per);
    const H = maxRows * rowH + 96, floor = H - 40;
    const total = items.reduce((a, i) => a + i.v, 0);
    const svg = canvas(plot, W, H);
    S('line', { x1: 0, x2: W, y1: floor + 6, y2: floor + 6, stroke: P.soft }, svg);
    const cells = [], cols = [];
    const tag = tagFor(plot);
    items.forEach((it, ci) => {
      const g = S('g', { class: 'ar-dimmable' }, svg);
      const cx = colW * ci + colW / 2;
      const full = Math.floor(it.v / unit), part = it.v / unit - full;
      const count = full + (part > 0.05 ? 1 : 0);
      const hero = ci === c.highlight;
      // with parts: which part each whole cell belongs to (largest remainder within the column)
      const owner = [];
      if (it.parts.length) apportion(partNames.map((pn) => it.parts.find((p) => p.name === pn)?.v ?? 0), full).forEach((cnt, k) => { for (let i = 0; i < cnt; i++) owner.push(k); });
      for (let k = 0; k < count; k++) {
        const row = Math.floor(k / per), j = k % per;
        const px = cx + (j - (per - 1) / 2) * (hw + 1.6) + (row % 2 ? hw / 4 : -hw / 4), py = floor - r - row * rowH;
        const isPart = k === full;
        const fill = isPart ? 'none' : it.parts.length ? partFill(owner[k] ?? 0) : hero ? P.accent : P.strong;
        cells.push({ el: S('path', { d: hexPath(r), fill, stroke: isPart ? P.mid : 'none', 'stroke-width': 1.1 }, g), px, py, t: ci * 140 + k * 34 });
      }
      const rows = Math.ceil(count / per);
      const lab = S('g', {}, g);
      T(lab, cx, floor - r - Math.max(0, rows - 1) * rowH - r - 12, fmt(it.v), { 'font-size': 16, 'text-anchor': 'middle', fill: P.text }, 'num');
      T(lab, cx, floor + 24, it.name, { 'font-size': 10.5, 'text-anchor': 'middle', fill: hero ? P.text : P.muted }, 'mono');
      cols.push({ g, lab });
      const hit = S('rect', { x: colW * ci, y: 0, width: colW, height: H, fill: 'transparent' }, svg);
      hit.addEventListener('pointerenter', () => {
        if (!ctx.played) return;
        spotlight(cols.map((o) => o.g), ci);
        tag.show(cx + 18, floor - (rows * rowH) / 2, it.name, [['', fmt(it.v)], ...it.parts.map((p) => [p.name, fmt(p.v)]), ['', '', `${msg('cells', { n: full })}${part > 0.05 ? msg('part', { part: part.toFixed(1) }) : ''} · ${msg('ofAll', { pct: pct(it.v / (total || 1)) })}`]]);
      });
      hit.addEventListener('pointerleave', () => { spotlight(cols.map((o) => o.g), null); tag.hide(); });
    });
    const last = Math.max(0, ...cells.map((o) => o.t));
    return {
      dur: last + 500,
      frame(e) {
        cells.forEach((o) => {
          const p = outCubic(seg(e, o.t, 260));
          o.el.setAttribute('transform', `translate(${o.px.toFixed(1)},${(o.py - (1 - p) * 10).toFixed(1)}) scale(${(0.35 + 0.65 * p).toFixed(3)})`);
          o.el.setAttribute('opacity', p);
        });
        cols.forEach((o) => o.lab.setAttribute('opacity', seg(e, 600, 500)));
      },
    };
  }, 'hive');
}
/** 1, 2, 2.5, 5 × 10^k, at least `raw` */
function niceUnit(raw) {
  if (raw <= 0) return 1;
  const mag = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
}

// ================================================================ TICK DIAL: one objective as 100 ticks, key results as tick rows
/** tickDial(el, { value: 0..1, time: 0..1 (how much of the period has passed), label, sub, items: [{ label, value: 0..1, code }] }) */
export function tickDial(host, cfg) {
  return mount(host, cfg, (plot, c, ctx) => {
    const P = palette(ctx.fig);
    const W = widthOf(plot, c);
    const items = c.items ?? [];
    const side = W >= 560 && items.length;
    const D = 230, R = 92;
    const done = clamp(Number(c.value) || 0), time = c.time === undefined ? null : clamp(c.time);
    const H = side || !items.length ? Math.max(270, 34 + items.length * 52) : D + 40 + items.length * 52;
    const svg = canvas(plot, W, H);
    const cx = side ? D / 2 + 4 : W / 2, cy = 130;
    const ang = (p) => ((-225 + 270 * p) * Math.PI) / 180;
    const ticks = [];
    for (let i = 0; i < 100; i++) {
      const a = ang(i / 99), long = i % 10 === 0, r1 = R - (long ? 16 : 10);
      ticks.push(S('line', { x1: cx + r1 * Math.cos(a), y1: cy + r1 * Math.sin(a), x2: cx + R * Math.cos(a), y2: cy + R * Math.sin(a), stroke: P.soft, 'stroke-width': long ? 1.6 : 1.2, 'stroke-linecap': 'round' }, svg));
    }
    if (time !== null) {
      const at = ang(time);
      S('line', { x1: cx + (R + 5) * Math.cos(at), y1: cy + (R + 5) * Math.sin(at), x2: cx + (R + 16) * Math.cos(at), y2: cy + (R + 16) * Math.sin(at), stroke: P.text, 'stroke-width': 1.4 }, svg);
      T(svg, cx + (R + 22) * Math.cos(at), cy + (R + 22) * Math.sin(at), msg('time', { pct: pct(time) }), { 'font-size': 10.5, fill: P.sec, 'text-anchor': time < 0.5 ? 'end' : 'start' }, 'mono');
    }
    const ha = ang(Math.max(0, done - 0.01));
    const headMark = hexRing(svg, cx + (R + 8) * Math.cos(ha), cy + (R + 8) * Math.sin(ha), 4.5, P.text, { opacity: 0 });
    const big = T(svg, cx, cy + 8, pct(0), { 'font-size': 40, 'text-anchor': 'middle', fill: P.text, style: 'letter-spacing:-.03em' }, 'num');
    if (c.label) T(svg, cx, cy + 30, c.label, { 'font-size': 10.5, 'text-anchor': 'middle', fill: P.muted }, 'mono');
    if (c.sub) T(svg, cx, cy + 46, fitLabel(c.sub, (R - 24) * 2, 11.5), { 'font-size': 11.5, 'text-anchor': 'middle', fill: P.sec });
    const x0 = side ? D + 34 : 6, x1 = W - 6, rowsTop = side ? 34 : D + 26, step = (x1 - x0) / 50;
    const rows = items.map((it, k) => {
      const p = clamp(Number(it.value) || 0);
      const g = S('g', { class: 'ar-dimmable' }, svg);
      const yy = rowsTop + k * 52;
      const behind = time !== null && p < time;
      if (it.code) T(g, x0, yy, it.code, { 'font-size': 10.5, fill: P.muted }, 'mono');
      T(g, x0 + (it.code ? 34 : 0), yy, it.label, { 'font-size': 13, fill: P.body });
      T(g, x1, yy, `${pct(p)}${behind ? ` · ${msg('behind')}` : ''}`, { 'font-size': 10.5, 'text-anchor': 'end', fill: behind ? P.accent : P.sec }, 'mono');
      const ts = [];
      for (let i = 0; i < 50; i++) ts.push(S('line', { x1: x0 + i * step + 1, x2: x0 + i * step + 1, y1: yy + 10, y2: yy + 24, stroke: P.soft, 'stroke-width': 1.5, 'stroke-linecap': 'round' }, g));
      const hit = S('rect', { x: x0 - 4, y: yy - 14, width: x1 - x0 + 8, height: 44, fill: 'transparent' }, svg);
      hit.addEventListener('pointerenter', () => { if (ctx.played) spotlight(rows.map((o) => o.g), k); });
      hit.addEventListener('pointerleave', () => spotlight(rows.map((o) => o.g), null));
      return { g, ts, n: Math.round(p * 50), color: behind ? P.accent : P.strong };
    });
    if (time !== null && items.length) {
      const tx = x0 + time * 50 * step;
      const tl = S('line', { x1: tx, x2: tx, y1: rowsTop + 8, y2: rowsTop + items.length * 52 - 22, stroke: P.text, opacity: 0.55 }, svg);
      if (rows[0]) svg.insertBefore(tl, rows[0].g);
      T(svg, tx + 4, rowsTop + items.length * 52 - 16, msg('time', { pct: pct(time) }), { 'font-size': 10, fill: P.muted }, 'mono');
    }
    const DIAL = 1300;
    return {
      dur: DIAL + items.length * 160 + 700,
      frame(e) {
        const p = outCubic(seg(e, 0, DIAL)) * done;
        const inked = Math.round(p * 99);
        ticks.forEach((t, i) => t.setAttribute('stroke', i < inked ? P.strong : P.soft));
        big.textContent = pct(p);
        headMark.setAttribute('opacity', seg(e, DIAL - 100, 300));
        rows.forEach((row, k) => {
          const on = Math.round(row.n * outCubic(seg(e, 300 + k * 160, 700)));
          row.ts.forEach((t, i) => t.setAttribute('stroke', i < on ? row.color : P.soft));
        });
      },
    };
  }, 'dial');
}

// ================================================================ POUR: a funnel of countable dots
/** pourFunnel(el, { stages: [{ name, value }], unit (value per dot; default: about 60 dots on top), format, highlight: 'last' | i }) */
export function pourFunnel(host, cfg) {
  return mount(host, cfg, (plot, c, ctx) => {
    const P = palette(ctx.fig);
    const W = widthOf(plot, c);
    const stages = (c.stages ?? []).map((s) => ({ name: String(s.name), v: Number(s.value) || 0 }));
    const fmt = formatter(c.format);
    const unit = c.unit ?? Math.max(1, Math.ceil((stages[0]?.v ?? 1) / 62));
    const dots = stages.map((s) => Math.round(s.v / unit));
    const hero = c.highlight === undefined || c.highlight === 'last' ? stages.length - 1 : c.highlight;
    const perLine = 31, rowH = 54;
    const H = stages.length * rowH + 10;
    const labelW = Math.min(110, Math.max(...stages.map((s) => textWidth(s.name, 13)), 40) + 16), valW = 110;
    const mid = labelW + (W - labelW - valW) / 2;
    const gap = Math.min(8.6, (W - labelW - valW - 8) / perLine), r = Math.max(1.2, Math.min(3, gap * 0.36));
    const svg = canvas(plot, W, H);
    const all = [];
    const tag = tagFor(plot);
    const rows = stages.map((st, s) => {
      const g = S('g', { class: 'ar-dimmable' }, svg);
      const yy = s * rowH + 18;
      T(g, 0, yy + 8, st.name, { 'font-size': 13, fill: P.body });
      T(g, W, yy + 4, fmt(st.v), { 'font-size': 16, 'text-anchor': 'end', fill: P.text }, 'num');
      if (s > 0 && stages[s - 1].v) T(g, W, yy + 20, msg('stay', { pct: pct(st.v / stages[s - 1].v) }), { 'font-size': 10, 'text-anchor': 'end', fill: P.muted }, 'mono');
      const filled = dots[s], lost = s ? Math.max(0, dots[s - 1] - dots[s]) : 0;
      const slots = filled + lost;
      const lines = Math.max(1, Math.ceil(slots / perLine));
      const per = Math.ceil(slots / lines);
      const leftLost = Math.floor(lost / 2);
      for (let k = 0; k < slots; k++) {
        const line = Math.floor(k / per), j = k % per;
        const inLine = Math.min(per, slots - line * per);
        const px = mid + (j - (inLine - 1) / 2) * gap, py = yy + line * gap + 4;
        const isLost = k < leftLost || k >= leftLost + filled;
        const d = S('circle', { cx: px, cy: py, r: isLost ? Math.max(0.8, r - 0.4) : r, fill: isLost ? 'none' : s === hero ? P.accent : P.strong, stroke: isLost ? P.mid : 'none', 'stroke-width': 1 }, g);
        all.push({ el: d, py, t: s * 420 + Math.abs(j - (inLine - 1) / 2) * 9 + line * 30 + (isLost ? 160 : 0) });
      }
      const hit = S('rect', { x: 0, y: yy - 12, width: W, height: rowH - 4, fill: 'transparent' }, svg);
      hit.addEventListener('pointerenter', () => {
        if (!ctx.played) return;
        spotlight(rows, s);
        tag.show(mid + (per * gap) / 2, yy + 6, st.name, [['', fmt(st.v)], ...(lost ? [['', '', msg('dropped', { n: fmt(lost * unit) })]] : [])]);
      });
      hit.addEventListener('pointerleave', () => { spotlight(rows, null); tag.hide(); });
      return g;
    });
    const last = Math.max(0, ...all.map((d) => d.t));
    return {
      dur: last + 500,
      frame(e) {
        all.forEach((d) => { const p = outCubic(seg(e, d.t, 380)); d.el.setAttribute('cy', (d.py - (1 - p) * 16).toFixed(1)); d.el.setAttribute('opacity', p); });
      },
    };
  }, 'pour');
}

// ================================================================ TAPE: before → after per category, one tick per unit in between
/** tapeDumbbell(el, { items: [{ name, from, to }], fromLabel, toLabel, goodWhen: 'down' | 'up', step (units per tick), sort: 'change' | false, format }) */
export function tapeDumbbell(host, cfg) {
  return mount(host, cfg, (plot, c, ctx) => {
    const P = palette(ctx.fig);
    const W = widthOf(plot, c);
    const fmt = formatter(c.format);
    let items = (c.items ?? []).map((it) => ({ name: String(it.name), a: Number(it.from), b: Number(it.to) }));
    const goodDown = c.goodWhen !== 'up';
    if (c.sort !== false) items.sort((p, q) => (goodDown ? (q.a - q.b) - (p.a - p.b) : (q.b - q.a) - (p.b - p.a)));
    const vals = items.flatMap((i) => [i.a, i.b]);
    const span = Math.max(...vals) - Math.min(...vals) || 1;
    const stepT = niceUnit(span / 18);
    const lo = Math.floor((Math.min(...vals) - span * 0.08) / stepT) * stepT, hi = Math.ceil((Math.max(...vals) + span * 0.08) / stepT) * stepT;
    const tick = c.step ?? niceUnit(Math.max(...items.map((i) => Math.abs(i.b - i.a))) / 8);
    const rowH = 50;
    const labelW = Math.min(110, Math.max(...items.map((i) => textWidth(i.name, 13)), 30) + 14), endW = 74;
    const H = items.length * rowH + 40;
    const x = (v) => labelW + ((v - lo) / (hi - lo)) * (W - labelW - endW);
    const svg = canvas(plot, W, H);
    const floor = items.length * rowH + 4;
    const axisStep = niceUnit((hi - lo) / Math.max(3, Math.floor((W - labelW - endW) / 70)));
    for (let v = Math.ceil(lo / axisStep) * axisStep; v <= hi; v += axisStep) {
      S('line', { x1: x(v), x2: x(v), y1: 6, y2: floor, stroke: P.faint }, svg);
      T(svg, x(v), floor + 18, fmt(v), { 'font-size': 10.5, 'text-anchor': 'middle', fill: P.muted }, 'mono');
    }
    const tag = tagFor(plot);
    const rows = items.map((it, k) => {
      const g = S('g', { class: 'ar-dimmable' }, svg);
      const yy = k * rowH + 26;
      const worse = goodDown ? it.b > it.a : it.b < it.a;
      T(g, 0, yy + 4, it.name, { 'font-size': 13, fill: worse ? P.text : P.body, 'font-weight': worse ? 600 : 400 });
      S('line', { x1: labelW, x2: W - endW + 10, y1: yy, y2: yy, stroke: P.faint }, g);
      const ticks = [];
      const nT = Math.floor(Math.abs(it.b - it.a) / tick + 1e-9);
      for (let i = 1; i <= nT; i++) { const v = it.a + Math.sign(it.b - it.a) * i * tick; ticks.push(S('line', { x1: x(v), x2: x(v), y1: yy - 5, y2: yy + 5, stroke: worse ? P.accent : P.mid, 'stroke-width': 1.2, opacity: 0 }, g)); }
      const spanL = S('line', { x1: x(it.a), x2: x(it.a), y1: yy, y2: yy, stroke: worse ? P.accent : P.strong, 'stroke-width': 1.6 }, g);
      S('circle', { cx: x(it.a), cy: yy, r: 5, fill: P.paper, stroke: P.strong, 'stroke-width': 1.5 }, g);
      const after = S('g', {}, g);
      S('circle', { cx: 0, cy: 0, r: 5.2, fill: worse ? P.accent : P.strong }, after);
      if (worse) hexRing(after, 0, 0, 7.5, P.accent);
      const lab = T(g, x(Math.max(it.a, it.b)) + 14, yy + 4, signed(fmt, it.b - it.a), { 'font-size': 10.5, fill: worse ? P.accent : P.sec, opacity: 0 }, 'mono');
      const hit = S('rect', { x: 0, y: yy - rowH / 2, width: W, height: rowH, fill: 'transparent' }, svg);
      hit.addEventListener('pointerenter', () => {
        if (!ctx.played) return;
        spotlight(rows.map((o) => o.g), k);
        tag.show(x(Math.max(it.a, it.b)) + 60, yy, it.name, [[c.fromLabel ?? '', fmt(it.a)], [c.toLabel ?? '', fmt(it.b)], [msg('change'), signed(fmt, it.b - it.a)]]);
      });
      hit.addEventListener('pointerleave', () => { spotlight(rows.map((o) => o.g), null); tag.hide(); });
      return { g, it, after, spanL, ticks, lab, yy, t: k * 170 };
    });
    return {
      dur: rows.length * 170 + 1100,
      frame(e) {
        rows.forEach((r) => {
          const p = inOut(seg(e, r.t, 900));
          const v = r.it.a + (r.it.b - r.it.a) * p;
          r.after.setAttribute('transform', `translate(${x(v)},${r.yy})`);
          r.spanL.setAttribute('x2', x(v));
          r.ticks.forEach((t, i) => t.setAttribute('opacity', Math.abs(v - r.it.a) >= (i + 1) * tick - 1e-6 ? 1 : 0));
          r.lab.setAttribute('opacity', seg(e, r.t + 800, 300));
        });
      },
    };
  }, 'tape');
}

// ================================================================ DOT HEAT: area = value on a grid
/** dotHeat(el, { rows: [...], cols: [...], values: [[...]], format, highlight: 'max' | [row, col] | false, colEvery }) */
export function dotHeat(host, cfg) {
  return mount(host, cfg, (plot, c, ctx) => {
    const P = palette(ctx.fig);
    const W = widthOf(plot, c);
    const rows = (c.rows ?? []).map(String), cols = (c.cols ?? []).map(String);
    const grid = rows.map((_, r) => cols.map((__, k) => Number(c.values?.[r]?.[k]) || 0));
    const fmt = formatter(c.format);
    const max = Math.max(...grid.flat(), 1);
    const left = Math.max(...rows.map((r) => textWidth(r, 10.5)), 20) + 14;
    const cw = Math.min(40, (W - left - 6) / Math.max(1, cols.length)), ch = Math.min(40, cw);
    const H = rows.length * ch + 40;
    const svg = canvas(plot, W, H);
    rows.forEach((r, i) => T(svg, 0, i * ch + ch / 2 + 4, r, { 'font-size': 10.5, fill: P.muted }, 'mono'));
    const every = c.colEvery ?? Math.max(1, Math.ceil(Math.max(...cols.map((k) => textWidth(k, 10)), 10) / (cw - 4)));
    cols.forEach((k, i) => { if (i % every === 0) T(svg, left + i * cw + cw / 2, rows.length * ch + 18, k, { 'font-size': 10, 'text-anchor': 'middle', fill: P.muted }, 'mono'); });
    let peak = [0, 0];
    grid.forEach((row, r) => row.forEach((v, k) => { if (v > grid[peak[0]][peak[1]]) peak = [r, k]; }));
    if (Array.isArray(c.highlight)) peak = c.highlight;
    const showPeak = c.highlight !== false;
    const cells = [];
    const tag = tagFor(plot);
    grid.forEach((row, r) => row.forEach((v, k) => {
      const rr = Math.max(1.3, Math.sqrt(v / max) * (Math.min(cw, ch) * 0.46));
      const isPeak = showPeak && r === peak[0] && k === peak[1];
      const fill = isPeak ? P.accent : P.ramp[Math.min(6, 1 + Math.floor((v / max) * 6))];
      const cx = left + k * cw + cw / 2, cy = r * ch + ch / 2;
      const dot = S('circle', { cx, cy, r: rr, fill, class: 'ar-dimmable' }, svg);
      cells.push({ el: dot, r: rr, t: (r + k) * 28, row: r, col: k, cx, cy });
      const hit = S('rect', { x: cx - cw / 2, y: cy - ch / 2, width: cw, height: ch, fill: 'transparent' }, svg);
      hit.addEventListener('pointerenter', () => {
        if (!ctx.played) return;
        cells.forEach((o) => o.el.classList.toggle('is-dim', o.row !== r && o.col !== k));
        tag.show(cx + rr, cy, `${rows[r]} · ${cols[k]}`, [['', fmt(v)]]);
      });
      hit.addEventListener('pointerleave', () => { cells.forEach((o) => o.el.classList.remove('is-dim')); tag.hide(); });
    }));
    const ring = S('g', { opacity: 0 }, svg);
    if (showPeak && cells.length) { const pc = cells.find((o) => o.row === peak[0] && o.col === peak[1]); hexRing(ring, pc.cx, pc.cy, pc.r + 5, P.accent); }
    const last = Math.max(0, ...cells.map((o) => o.t));
    return {
      dur: last + 600,
      frame(e) {
        cells.forEach((o) => o.el.setAttribute('r', (o.r * outCubic(seg(e, o.t, 340))).toFixed(2)));
        ring.setAttribute('opacity', seg(e, last + 100, 400));
      },
    };
  }, 'heat');
}

// ================================================================ RANK ↔ MAP: the same dots, ranked and then spread on two measures
/**
 * rankMap(el, { items: [{ name, x, y }], xLabel, yLabel, xFormat, yFormat, rank: 'asc' | 'desc' (by y),
 *   highlight: name, view: 'rank' | 'map', autoMorph: true, mapNote })
 */
export function rankMap(host, cfg) {
  return mount(host, cfg, (plot, c, ctx) => {
    const P = palette(ctx.fig);
    const W = widthOf(plot, c), H = c.height ?? 330;
    const data = (c.items ?? []).map((it) => ({ name: String(it.name), x: Number(it.x), y: Number(it.y) }));
    const fx = formatter(c.xFormat ?? c.format), fy = formatter(c.yFormat ?? c.format);
    const avgX = data.reduce((a, d) => a + d.x, 0) / (data.length || 1), avgY = data.reduce((a, d) => a + d.y, 0) / (data.length || 1);
    const sorted = [...data].sort((a, b) => (c.rank === 'desc' ? b.y - a.y : a.y - b.y));
    const m = { l: 6, r: 100, t: 22, b: 40 };
    const svg = canvas(plot, W, H);
    // controls: two views of the same data
    const seg2 = el('div', 'ar-seg', ctx.controls);
    seg2.setAttribute('role', 'group');
    const btns = ['rank', 'map'].map((v) => { const b = el('button', '', seg2, msg(v)); b.type = 'button'; b.dataset.view = v; return b; });
    const rowH = (H - m.t - m.b) / Math.max(1, data.length - 1);
    const maxY = Math.max(...data.map((d) => d.y)) * 1.08 || 1;
    const rx = (v) => m.l + 64 + (v / maxY) * (W - m.l - m.r - 64);
    const rankG = S('g', { class: 'ar-fade' }, svg);
    const stems = sorted.map((d, k) => {
      T(rankG, m.l, m.t + k * rowH + 4, String(k + 1).padStart(2, '0'), { 'font-size': 10, fill: P.muted }, 'mono');
      return S('line', { x1: rx(0), x2: rx(0), y1: m.t + k * rowH, y2: m.t + k * rowH, stroke: d.name === c.highlight ? P.accent : P.soft, 'stroke-width': 1.2, 'data-to': rx(d.y) }, rankG);
    });
    S('line', { x1: rx(avgY), x2: rx(avgY), y1: m.t - 10, y2: H - m.b + 6, stroke: P.mid }, rankG);
    T(rankG, rx(avgY) + 4, H - m.b + 18, fy(avgY), { 'font-size': 10, fill: P.muted }, 'mono');
    const xs = data.map((d) => d.x), ys = data.map((d) => d.y);
    const sxMax = Math.max(...xs) * 1.08 || 1, syMin = Math.min(...ys) * 0.8, syMax = Math.max(...ys) * 1.06;
    const yStep = niceUnit((syMax - syMin) / 4);
    const yTicks = [];
    for (let v = Math.ceil(syMin / yStep) * yStep; v <= syMax; v += yStep) yTicks.push(v);
    const yw = Math.max(...yTicks.map((v) => textWidth(fy(v), 10)), 20) + 12;
    const sx = (v) => m.l + yw + (v / sxMax) * (W - m.l - m.r - yw);
    const sy = (v) => H - m.b - ((v - syMin) / (syMax - syMin || 1)) * (H - m.t - m.b);
    const mapG = S('g', { class: 'ar-fade', opacity: 0 }, svg);
    S('line', { x1: sx(0), x2: sx(sxMax), y1: H - m.b, y2: H - m.b, stroke: P.soft }, mapG);
    const xStep = niceUnit(sxMax / (W < 560 ? 3 : 6));
    for (let v = 0; v <= sxMax; v += xStep) T(mapG, sx(v), H - m.b + 18, fx(v), { 'font-size': 10, 'text-anchor': 'middle', fill: P.muted }, 'mono');
    for (const v of yTicks) T(mapG, sx(0) - 6, sy(v) + 3, fy(v), { 'font-size': 10, 'text-anchor': 'end', fill: P.muted }, 'mono');
    S('line', { x1: sx(0), x2: sx(sxMax), y1: sy(avgY), y2: sy(avgY), stroke: P.mid }, mapG);
    S('line', { x1: sx(avgX), x2: sx(avgX), y1: m.t - 6, y2: H - m.b, stroke: P.mid }, mapG);
    if (c.yLabel) T(mapG, sx(0) - 6, m.t - 10, c.yLabel, { 'font-size': 10, fill: P.sec, 'text-anchor': 'start' }, 'mono');
    if (c.xLabel) T(mapG, sx(sxMax), H - m.b - 8, c.xLabel, { 'font-size': 10, fill: P.sec, 'text-anchor': 'end' }, 'mono');
    if (c.mapNote) T(mapG, sx(sxMax), m.t + 8, c.mapNote, { 'font-size': 10, 'text-anchor': 'end', fill: P.mid }, 'mono');
    const tag = tagFor(plot);
    const items = data.map((d) => {
      const k = sorted.indexOf(d);
      const g = S('g', { class: 'ar-morph', style: `transition-delay:${k * 45}ms` }, svg);
      const hero = d.name === c.highlight;
      if (hero) hexRing(g, 0, 0, 8, P.accent);
      S('circle', { cx: 0, cy: 0, r: 5, fill: hero ? P.accent : P.strong }, g);
      T(g, 11, 4, d.name, { 'font-size': 12.5, fill: hero ? P.text : P.body, 'font-weight': hero ? 600 : 400 });
      const val = T(g, 11 + textWidth(d.name, 12.5) + 8, 4, fy(d.y), { 'font-size': 10, fill: P.muted, class: 'ar-fade' }, 'mono');
      const hit = S('circle', { cx: 0, cy: 0, r: 12, fill: 'transparent' }, g);
      hit.addEventListener('pointerenter', () => { const t = g.getCTM(); tag.show(t.e + 8, t.f, d.name, [[c.yLabel ?? '', fy(d.y)], [c.xLabel ?? '', fx(d.x)]]); });
      hit.addEventListener('pointerleave', () => tag.hide());
      return { g, val, rank: [rx(d.y), m.t + k * rowH], map: [sx(d.x), sy(d.y)], k };
    });
    let view = ctx.view ?? c.view ?? 'rank';
    const setView = (v, instant = false) => {
      view = v; ctx.view = v;
      btns.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === v)));
      items.forEach((it) => {
        if (instant) it.g.style.transition = 'none';
        it.g.style.transform = `translate(${it[v][0]}px, ${it[v][1]}px)`;
        it.val.setAttribute('opacity', v === 'rank' ? 1 : 0);
        if (instant) { void it.g.getBoundingClientRect(); it.g.style.transition = ''; }
      });
      rankG.setAttribute('opacity', v === 'rank' ? 1 : 0);
      mapG.setAttribute('opacity', v === 'map' ? 1 : 0);
    };
    btns.forEach((b) => b.addEventListener('click', () => { ctx.auto = false; setView(b.dataset.view); }));
    ctx.onReplay = () => { ctx.auto = c.autoMorph !== false; };
    setView(view, true);
    return {
      dur: 1400 + (c.autoMorph === false ? 0 : 3200),
      frame(e) {
        if (e === Infinity) { stems.forEach((s) => s.setAttribute('x2', s.dataset.to)); items.forEach((it) => it.g.setAttribute('opacity', 1)); return; }
        if (e === 0) setView('rank', true);
        stems.forEach((s, k) => s.setAttribute('x2', rx(0) + (Number(s.dataset.to) - rx(0)) * outCubic(seg(e, k * 70, 700))));
        items.forEach((it) => it.g.setAttribute('opacity', seg(e, it.k * 70 + 450, 300)));
        if (ctx.auto && e > 2600 && view === 'rank') { ctx.auto = false; setView('map'); }
      },
    };
  }, 'morph');
}

// ================================================================ BUMP: rank by period; lines hold a rank, then cross
/** bumpChart(el, { periods: [...], series: [{ name, values }] (larger = higher rank), highlight: name | i }) */
export function bumpChart(host, cfg) {
  return mount(host, cfg, (plot, c, ctx) => {
    const P = palette(ctx.fig);
    const W = widthOf(plot, c);
    const series = (c.series ?? []).map((s) => ({ name: String(s.name), v: s.values.map(Number) }));
    const periods = (c.periods ?? []).map(String);
    const n = periods.length;
    const ranks = series.map(() => []);
    periods.forEach((_, m) => [...series.keys()].sort((a, b) => series[b].v[m] - series[a].v[m]).forEach((i, r) => (ranks[i][m] = r + 1)));
    const hero = typeof c.highlight === 'number' ? c.highlight : series.findIndex((s) => s.name === c.highlight);
    const narrow = W < 560;
    const lw = Math.min(narrow ? 70 : 110, Math.max(...series.map((s) => textWidth(s.name, 12.5)), 20) + 14);
    const m = { l: lw, r: lw, t: 14, b: 34 };
    const rowH = 32;
    const H = m.t + rowH * Math.max(1, series.length - 1) + m.b + 8;
    const x = (k) => m.l + (k / Math.max(1, n - 1)) * (W - m.l - m.r);
    const y = (r) => m.t + (r - 1) * rowH;
    const svg = canvas(plot, W, H);
    const every = narrow ? Math.ceil(n / 4) : Math.max(1, Math.ceil(n / 12));
    periods.forEach((p, k) => {
      S('line', { x1: x(k), x2: x(k), y1: m.t - 6, y2: y(series.length) + 6, stroke: P.faint }, svg);
      if (k % every === 0 || k === n - 1) T(svg, x(k), H - 10, p, { 'font-size': 10.5, 'text-anchor': 'middle', fill: P.muted }, 'mono');
    });
    const clip = revealClip(svg, H);
    const lines = S('g', { 'clip-path': `url(#${clip.id})` }, svg);
    const tag = tagFor(plot);
    const groups = [], labels = [];
    const order = [...series.keys()].sort((a, b) => (a === hero) - (b === hero));
    for (const i of order) {
      const isHero = i === hero;
      const g = S('g', { class: 'ar-dimmable' }, lines);
      const pts = periods.map((_, k) => [x(k), y(ranks[i][k])]);
      let d = `M${pts[0][0]},${pts[0][1]}`;
      for (let k = 1; k < pts.length; k++) { const mx = (pts[k - 1][0] + pts[k][0]) / 2; d += `C${mx},${pts[k - 1][1]} ${mx},${pts[k][1]} ${pts[k][0]},${pts[k][1]}`; }
      S('path', { d, fill: 'none', stroke: isHero ? P.accent : P.soft, 'stroke-width': isHero ? 2.4 : 1.6, 'stroke-linecap': 'round' }, g);
      pts.forEach(([px, py], k) => S('circle', { cx: px, cy: py, r: isHero ? 3.6 : 3, fill: k === n - 1 ? (isHero ? P.accent : P.strong) : P.paper, stroke: isHero ? P.accent : P.mid, 'stroke-width': 1.3 }, g));
      const hit = S('path', { d, fill: 'none', stroke: 'transparent', 'stroke-width': 14 }, g);
      hit.addEventListener('pointerenter', () => {
        if (!ctx.played) return;
        groups.forEach((o) => o.g.classList.toggle('is-dim', o.i !== i));
        labels.forEach((o) => o.el.classList.toggle('is-dim', o.i !== i));
        tag.show(x(n - 1) - 40, y(ranks[i][n - 1]), series[i].name, [['', msg('rankFromTo', { from: ranks[i][0], to: ranks[i][n - 1] })], ['', '', msg('bestRank', { n: Math.min(...ranks[i]) })]], 'left');
      });
      hit.addEventListener('pointerleave', () => { groups.forEach((o) => o.g.classList.remove('is-dim')); labels.forEach((o) => o.el.classList.remove('is-dim')); tag.hide(); });
      groups.push({ g, i });
    }
    const endLabels = S('g', {}, svg);
    series.forEach((s, i) => {
      const isHero = i === hero;
      const a = { 'font-size': 12.5, fill: isHero ? P.text : P.sec, 'font-weight': isHero ? 600 : 400, class: 'ar-dimmable' };
      labels.push({ el: T(svg, m.l - 12, y(ranks[i][0]) + 4, s.name, { ...a, 'text-anchor': 'end' }), i });
      labels.push({ el: T(endLabels, W - m.r + 12, y(ranks[i][n - 1]) + 4, s.name, a), i });
    });
    const endMark = hero >= 0 ? hexRing(svg, x(n - 1), y(ranks[hero][n - 1]), 7, P.accent, { opacity: 0 }) : null;
    const DUR = 1900;
    return {
      dur: DUR + 500,
      frame(e) {
        clip.rect.setAttribute('width', (W + 40) * inOut(seg(e, 0, DUR)));
        endLabels.setAttribute('opacity', seg(e, DUR - 200, 400));
        endMark?.setAttribute('opacity', seg(e, DUR - 100, 400));
      },
    };
  }, 'bump');
}

// ================================================================ STREAM: composition over time, stacked from zero
/** streamChart(el, { labels: [...], tickLabels: [...] ('' to skip), series: [{ name, values }], highlight: i | name (drawn at the bottom), format, axisLabel, ticks: 6, height: 320 }) */
export function streamChart(host, cfg) {
  return mount(host, cfg, (plot, c, ctx) => {
    const P = palette(ctx.fig);
    const W = widthOf(plot, c), H = c.height ?? 320;
    const fmt = formatter(c.format);
    let series = (c.series ?? []).map((s, i) => ({ name: String(s.name), v: s.values.map(Number), i }));
    // highlight: an index, or a layer's name (a live data source does not promise an order)
    const at = typeof c.highlight === 'string' ? series.findIndex((s) => s.name === c.highlight) : c.highlight;
    const hero = at !== undefined && at !== null && series[at] ? at : undefined;
    if (hero !== undefined) series = [series[hero], ...series.filter((s) => s.i !== hero)];
    const labels = (c.labels ?? []).map(String);
    const n = labels.length;
    const totals = labels.map((_, w) => series.reduce((a, s) => a + (s.v[w] || 0), 0));
    const top = niceUnit(Math.max(...totals, 1) / 3) * 3 >= Math.max(...totals) ? niceUnit(Math.max(...totals, 1) / 3) * 3 : Math.max(...totals) * 1.1;
    const m = { l: 4, r: 58, t: c.axisLabel ? 30 : 14, b: 34 };
    const x = (w) => m.l + (w / Math.max(1, n - 1)) * (W - m.l - m.r);
    const y = (v) => H - m.b - (v / top) * (H - m.t - m.b);
    const svg = canvas(plot, W, H);
    for (let k = 0; k <= 3; k++) {
      const v = (top / 3) * k;
      S('line', { x1: m.l, x2: W - m.r + 6, y1: y(v), y2: y(v), stroke: k ? P.faint : P.soft }, svg);
      T(svg, W - m.r + 12, y(v) + 3.5, formatter({ ...c.format, unit: undefined, notation: c.format?.notation })(v), { 'font-size': 10, fill: P.muted }, 'mono');
    }
    if (c.axisLabel) T(svg, W - m.r + 12, m.t - 14, c.axisLabel, { 'font-size': 10, fill: P.muted }, 'mono');
    const every = Math.max(1, Math.round(n / (c.ticks ?? 6)));
    // labels never touch: on a narrow chart every other (or every third…) one is left out
    let freeFrom = -Infinity;
    labels.forEach((l, w) => {
      const tl = c.tickLabels ? c.tickLabels[w] : w % every === 0 ? l : '';
      if (!tl || x(w) < freeFrom) return;
      T(svg, x(w), H - 12, tl, { 'font-size': 10.5, fill: P.muted }, 'mono');
      freeFrom = x(w) + String(tl).length * 6.4 + 10;
    });
    const clip = revealClip(svg, H);
    const layers = S('g', { 'clip-path': `url(#${clip.id})` }, svg);
    const lows = Array(n).fill(0);
    const bands = series.map((s, k) => {
      const lo = lows.slice(), hi = lo.map((v, w) => v + (s.v[w] || 0));
      hi.forEach((v, w) => (lows[w] = v));
      const isHero = hero !== undefined && k === 0;
      const fill = isHero ? P.accent : ladder(P, k - (hero !== undefined ? 1 : 0), series.length - (hero !== undefined ? 1 : 0));
      const up = smooth(hi.map((v, w) => [x(w), y(v)]));
      const down = smooth(lo.map((v, w) => [x(w), y(v)]).reverse()).replace(/^M/, 'L');
      S('path', { d: `${up}${down}Z`, fill, stroke: P.paper, 'stroke-width': 1 }, layers);
      return { s, lo, hi, fill, isHero };
    });
    const labelG = S('g', { opacity: 0 }, svg);
    // a band is named where the whole label fits inside it (the band stays at least 15px thick under every letter),
    // preferring the later, thicker part, and never on top of a name already placed
    const placed = [];
    bands.forEach((b) => {
      const share = (b.hi[n - 1] - b.lo[n - 1]) / (totals[n - 1] || 1);
      const text = `${b.s.name} ${pct(share)}`;
      const half = [...text].reduce((a, ch) => a + (/[\u2e80-\uffff]/.test(ch) ? 10.5 : 6.4), 0) / 2 + 6;  // CJK glyphs are full width
      const step = n > 1 ? x(1) - x(0) : W;
      let best = -1, bestScore = 0;
      for (let w = 1; w < n - 1; w++) {
        const cx = x(w);
        if (cx - half < x(0) || cx + half > x(n - 1)) continue;
        const span = Math.ceil(half / step) + 1;  // the smoothed edge can dip between two sampled days
        // the label's own box (± 6px around the band's middle under it) has to stay inside the band under every letter
        const vs = [];
        for (let v = Math.max(0, w - span); v <= Math.min(n - 1, w + span); v++) vs.push(v);
        const mid = vs.reduce((a, v) => a + (y(b.lo[v]) + y(b.hi[v])) / 2, 0) / vs.length;
        const room = Math.min(...vs.map((v) => Math.min(y(b.lo[v]) - (mid + 6), mid - 6 - y(b.hi[v]))));
        if (room < 0 || placed.some((p) => Math.abs(p.x - cx) < p.half + half && Math.abs(p.y - mid) < 14)) continue;
        const score = room + (w / n) * 6;
        if (score > bestScore) { bestScore = score; best = w; }
      }
      if (best < 0) return;
      const around = [];
      for (let v = Math.max(0, best - Math.ceil(half / step) - 1); v <= Math.min(n - 1, best + Math.ceil(half / step) + 1); v++) around.push(v);
      const ly = around.reduce((a, v) => a + (y(b.lo[v]) + y(b.hi[v])) / 2, 0) / around.length;
      placed.push({ x: x(best), y: ly, half });
      const dark = luminance(b.fill) < 0.45;
      T(labelG, x(best), ly + 4, text, { 'font-size': 10.5, 'text-anchor': 'middle', fill: dark ? P.onDark : P.onLight }, 'mono');
      b.named = true;
    });
    // a band too thin to carry its name still needs one: then every band goes in a legend, top layer first
    if (bands.some((b) => !b.named)) {
      const legend = el('div', 'ar-legend', ctx.controls);
      [...bands].reverse().forEach((b) => { const it = el('span', '', legend); el('i', '', it).style.background = b.fill; it.append(b.s.name); });
    }
    const cross = S('line', { y1: m.t, y2: H - m.b, stroke: P.text, opacity: 0 }, svg);
    const tag = tagFor(plot);
    svg.addEventListener('pointermove', (ev) => {
      if (!ctx.played || !n) return;
      const r = svg.getBoundingClientRect();
      const w = clamp(Math.round(((ev.clientX - r.left - m.l) / (W - m.l - m.r)) * (n - 1)), 0, n - 1);
      cross.setAttribute('x1', x(w)); cross.setAttribute('x2', x(w)); cross.setAttribute('opacity', 0.4);
      tag.show(x(w), y(totals[w]) + 60, `${labels[w]} · ${msg('total')} ${fmt(totals[w])}`, [...bands].reverse().map((b) => [b.s.name, fmt(b.hi[w] - b.lo[w]), pct((b.hi[w] - b.lo[w]) / (totals[w] || 1))]));
    });
    svg.addEventListener('pointerleave', () => { cross.setAttribute('opacity', 0); tag.hide(); });
    const DUR = 1800;
    return {
      dur: DUR + 500,
      frame(e) {
        clip.rect.setAttribute('width', (W + 40) * inOut(seg(e, 0, DUR)));
        labelG.setAttribute('opacity', seg(e, DUR - 100, 400));
      },
    };
  }, 'stream');
}
function luminance(color) {
  const m = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(String(color).trim());
  if (!m) return 0.5;
  const [r, g, b] = m.slice(1).map((h) => parseInt(h, 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// ================================================================ PARALLEL: one line per thing across a few measures
/** parallelChart(el, { dims: [{ name, unit, better: 'high' | 'low', format }], items: [{ name, values }], highlight: name | i }) */
export function parallelChart(host, cfg) {
  return mount(host, cfg, (plot, c, ctx) => {
    const P = palette(ctx.fig);
    const W = widthOf(plot, c), H = c.height ?? 320;
    const dims = c.dims ?? [];
    const items = (c.items ?? []).map((it) => ({ name: String(it.name), v: it.values.map(Number) }));
    const hero = typeof c.highlight === 'number' ? c.highlight : items.findIndex((it) => it.name === c.highlight);
    const lw = Math.min(90, Math.max(...items.map((it) => textWidth(it.name, 12)), 20) + 16);
    const m = { l: 12, r: lw, t: 46, b: 30 };
    const ax = (k) => m.l + (k / Math.max(1, dims.length - 1)) * (W - m.l - m.r);
    const scales = dims.map((d, k) => {
      const vs = items.map((it) => it.v[k]);
      const lo = Math.min(...vs), hi = Math.max(...vs);
      return (v) => { const t = (v - lo) / (hi - lo || 1); return H - m.b - (d.better === 'low' ? 1 - t : t) * (H - m.t - m.b); };
    });
    const svg = canvas(plot, W, H);
    T(svg, 0, 10, msg('better'), { 'font-size': 10, fill: P.muted }, 'mono');
    dims.forEach((d, k) => {
      const f = formatter(d.format ?? c.format);
      S('line', { x1: ax(k), x2: ax(k), y1: m.t, y2: H - m.b, stroke: P.soft }, svg);
      const anchor = k === 0 ? 'start' : k === dims.length - 1 ? 'end' : 'middle';
      T(svg, ax(k), m.t - 20, d.name, { 'font-size': 12, 'font-weight': 600, fill: P.text, 'text-anchor': anchor });
      if (d.unit) T(svg, ax(k), m.t - 7, d.unit, { 'font-size': 9.5, fill: P.muted, 'text-anchor': anchor }, 'mono');
      const vs = items.map((it) => it.v[k]);
      const best = d.better === 'low' ? Math.min(...vs) : Math.max(...vs), worst = d.better === 'low' ? Math.max(...vs) : Math.min(...vs);
      const lastAxis = k === dims.length - 1;
      const vx = lastAxis ? ax(k) - 4 : ax(k) + 4, va = lastAxis ? 'end' : 'start';
      T(svg, vx, m.t + 10, f(best), { 'font-size': 9.5, fill: P.muted, 'text-anchor': va }, 'mono');
      T(svg, vx, H - m.b + 14, f(worst), { 'font-size': 9.5, fill: P.muted, 'text-anchor': va }, 'mono');
    });
    const tag = tagFor(plot);
    const lines = [];
    const order = [...items.keys()].sort((a, b) => (a === hero) - (b === hero));
    for (const i of order) {
      const isHero = i === hero;
      const pts = dims.map((_, k) => [ax(k), scales[k](items[i].v[k])]);
      const g = S('g', { class: 'ar-dimmable' }, svg);
      const d = 'M' + pts.map((p) => p.map((q) => q.toFixed(1)).join(',')).join('L');
      const path = S('path', { d, fill: 'none', stroke: isHero ? P.accent : P.mid, 'stroke-width': isHero ? 2.4 : 1.3, 'stroke-linejoin': 'round', pathLength: 1, 'stroke-dasharray': 1, 'stroke-dashoffset': 1 }, g);
      pts.forEach(([px, py]) => S('circle', { cx: px, cy: py, r: isHero ? 3.4 : 2.4, fill: isHero ? P.accent : P.mid }, g));
      const hit = S('path', { d, fill: 'none', stroke: 'transparent', 'stroke-width': 14 }, g);
      hit.addEventListener('pointerenter', (ev) => {
        if (!ctx.played) return;
        lines.forEach((o) => o.g.classList.toggle('is-dim', o.i !== i));
        names.forEach((o) => o.el.classList.toggle('is-dim', o.i !== i));
        const r = svg.getBoundingClientRect();
        tag.show(ev.clientX - r.left, ev.clientY - r.top, items[i].name, dims.map((dm, k) => [dm.name, formatter(dm.format ?? c.format)(items[i].v[k])]));
      });
      hit.addEventListener('pointerleave', () => { lines.forEach((o) => o.g.classList.remove('is-dim')); names.forEach((o) => o.el.classList.remove('is-dim')); tag.hide(); });
      lines.push({ g, path, i });
    }
    const last = dims.length - 1;
    const ly = spread(items.map((it) => scales[last](it.v[last])), 13);
    const names = items.map((it, i) => ({ i, el: T(svg, ax(last) + 10, ly[i] + 4, it.name, { 'font-size': 12, fill: i === hero ? P.text : P.sec, 'font-weight': i === hero ? 600 : 400, class: 'ar-dimmable' }) }));
    return {
      dur: items.length * 90 + 1300,
      frame(e) {
        lines.forEach((o, k) => o.path.setAttribute('stroke-dashoffset', 1 - inOut(seg(e, k * 90, 1000))));
        names.forEach((o) => o.el.setAttribute('opacity', seg(e, 900, 500)));
      },
    };
  }, 'parallel');
}

// ================================================================ STRIP: every record a dot, per group, with p50 and p95
/** stripChart(el, { groups: [{ name, values }], max, threshold: { value, label }, highlight: i, format }) */
export function stripChart(host, cfg) {
  return mount(host, cfg, (plot, c, ctx) => {
    const P = palette(ctx.fig);
    const W = widthOf(plot, c);
    const fmt = formatter(c.format);
    const q = (s, f) => s[Math.floor(f * (s.length - 1))];
    const groups = (c.groups ?? []).map((g) => { const v = g.values.map(Number); const s = [...v].sort((a, b) => a - b); return { name: String(g.name), v, p50: q(s, 0.5), p95: q(s, 0.95) }; });
    const cap = c.max ?? niceUnit(Math.max(...groups.map((g) => g.p95)) * 1.6 / 6) * 6;
    const lw = Math.min(110, Math.max(...groups.map((g) => textWidth(g.name, 12.5)), 30) + 14);
    const rowH = 72, m = { l: lw, r: 14, t: 18, b: 30 };
    const H = m.t + groups.length * rowH + m.b;
    const x = (v) => m.l + (Math.min(v, cap) / cap) * (W - m.l - m.r);
    const svg = canvas(plot, W, H);
    const step = niceUnit(cap / (W < 560 ? 3 : 6));
    for (let v = 0; v <= cap + 1e-9; v += step) {
      S('line', { x1: x(v), x2: x(v), y1: m.t - 6, y2: H - m.b, stroke: P.faint }, svg);
      T(svg, x(v), H - 10, fmt(v), { 'font-size': 10, 'text-anchor': 'middle', fill: P.muted }, 'mono');
    }
    const th = c.threshold === undefined ? null : typeof c.threshold === 'number' ? { value: c.threshold } : c.threshold;
    if (th) { S('line', { x1: x(th.value), x2: x(th.value), y1: m.t - 6, y2: H - m.b, stroke: P.mid }, svg); T(svg, x(th.value) + 4, m.t - 6, th.label ?? fmt(th.value), { 'font-size': 10, fill: P.sec }, 'mono'); }
    const tag = tagFor(plot);
    const dots = [];
    const rows = groups.map((g, p) => {
      const row = S('g', { class: 'ar-dimmable' }, svg);
      const cy = m.t + p * rowH + rowH / 2;
      T(row, 0, cy + 4, g.name, { 'font-size': 12.5, fill: P.body });
      g.v.forEach((v, i) => { const jy = cy + (rnd(i + p * 500, 6) - 0.5) * 30; dots.push({ el: S('circle', { cx: x(v), cy: jy, r: 1.8, fill: P.mid, opacity: 0 }, row), jy, t: rnd(i + p * 700, 8) * 900 + p * 120 }); });
      const hero = p === c.highlight;
      const marks = S('g', { opacity: 0 }, row);
      S('line', { x1: x(g.p50), x2: x(g.p50), y1: cy - 20, y2: cy + 20, stroke: P.text, 'stroke-width': 2 }, marks);
      T(marks, x(g.p50), cy - 25, `p50 ${fmt(g.p50)}`, { 'font-size': 10, 'text-anchor': 'middle', fill: P.text }, 'mono');
      S('line', { x1: x(g.p95), x2: x(g.p95), y1: cy - 20, y2: cy + 20, stroke: hero ? P.accent : P.text, 'stroke-width': 1.4 }, marks);
      T(marks, x(g.p95), cy + 32, `p95 ${fmt(g.p95)}`, { 'font-size': 10, 'text-anchor': 'middle', fill: hero ? P.accent : P.sec }, 'mono');
      if (hero) hexRing(marks, x(g.p95), cy - 20, 4, P.accent);
      const hit = S('rect', { x: 0, y: cy - rowH / 2, width: W, height: rowH, fill: 'transparent' }, svg);
      hit.addEventListener('pointerenter', () => {
        if (!ctx.played) return;
        spotlight(rows.map((o) => o.row), p);
        const over = th ? g.v.filter((v) => v >= th.value).length : null;
        tag.show(x(g.p95) + 10, cy, `${g.name} · ${msg('requests', { n: g.v.length })}`, [['p50', fmt(g.p50)], ['p95', fmt(g.p95)], ...(over !== null ? [['', '', msg('over2', { n: over, limit: th.label ?? fmt(th.value) })]] : [])]);
      });
      hit.addEventListener('pointerleave', () => { spotlight(rows.map((o) => o.row), null); tag.hide(); });
      return { row, marks };
    });
    return {
      dur: 1500,
      frame(e) {
        dots.forEach((d) => { const p = outCubic(seg(e, d.t, 300)); d.el.setAttribute('opacity', (p * 0.6).toFixed(2)); d.el.setAttribute('cy', (d.jy - (1 - p) * 12).toFixed(1)); });
        rows.forEach((r) => r.marks.setAttribute('opacity', seg(e, 1000, 400)));
      },
    };
  }, 'strip');
}

// ================================================================ FLOW: from one set of categories to another, band width = amount
/** flowChart(el, { left: [...], right: [...], flows: [[...per right] per left], highlight: [leftIndex, rightIndex], format, height }) */
export function flowChart(host, cfg) {
  return mount(host, cfg, (plot, c, ctx) => {
    const P = palette(ctx.fig);
    const W = widthOf(plot, c), H = c.height ?? 330;
    const L = (c.left ?? []).map(String), R = (c.right ?? []).map(String), F = (c.flows ?? []).map((r) => r.map(Number));
    const fmt = formatter(c.format);
    const lt = F.map((r) => r.reduce((a, b) => a + b, 0)), rt = R.map((_, j) => F.reduce((a, r) => a + (r[j] || 0), 0));
    const total = lt.reduce((a, b) => a + b, 0) || 1;
    const gap = 10, bw = 6;
    const k = (H - 20 - gap * Math.max(L.length, R.length - 1)) / total;
    const lw = Math.min(W * 0.28, Math.max(...L.map((s) => textWidth(s, 12)), 40) + 14), rw = Math.min(W * 0.28, Math.max(...R.map((s) => textWidth(s, 12)), 40) + 24);
    const lx = lw, rx = W - rw;
    const ly = [], ry = [];
    let acc = 10;
    L.forEach((_, i) => { ly[i] = acc; acc += lt[i] * k + (gap * Math.max(1, R.length - 1)) / Math.max(1, L.length - 1); });
    acc = 10;
    R.forEach((_, j) => { ry[j] = acc; acc += rt[j] * k + gap; });
    const svg = canvas(plot, W, H);
    const clip = revealClip(svg, H);
    const bandsG = S('g', { 'clip-path': `url(#${clip.id})` }, svg);
    const lOff = ly.slice(), rOff = ry.slice();
    const tag = tagFor(plot);
    const bands = [];
    F.forEach((row, i) => row.forEach((v, j) => {
      const h = v * k, y0 = lOff[i], y1 = rOff[j];
      lOff[i] += h; rOff[j] += h;
      if (!v) return;
      const mx = (lx + bw + rx) / 2;
      const d = `M${lx + bw},${y0}C${mx},${y0} ${mx},${y1} ${rx},${y1}L${rx},${y1 + h}C${mx},${y1 + h} ${mx},${y0 + h} ${lx + bw},${y0 + h}Z`;
      const hero = c.highlight && c.highlight[0] === i && c.highlight[1] === j;
      const band = { i, j, el: S('path', { d, fill: hero ? P.accent : P.mid, 'fill-opacity': hero ? 0.78 : 0.26, class: 'ar-dimmable' }, bandsG) };
      band.el.addEventListener('pointerenter', () => {
        if (!ctx.played) return;
        bands.forEach((o) => o.el.classList.toggle('is-dim', o !== band));
        tag.show(mx, (y0 + y1) / 2 + h / 2, `${L[i]} → ${R[j]}`, [['', fmt(v)], ['', '', msg('ofGroup', { name: L[i], pct: pct(v / (lt[i] || 1)) })]]);
      });
      band.el.addEventListener('pointerleave', () => { bands.forEach((o) => o.el.classList.remove('is-dim')); tag.hide(); });
      bands.push(band);
    }));
    const nodeG = S('g', {}, svg);
    const node = (x0, y0, h, name, v, side, key, idx) => {
      S('rect', { x: x0, y: y0, width: bw, height: Math.max(1, h), fill: P.strong, rx: 1 }, nodeG);
      const tx = side === 'l' ? x0 - 8 : x0 + bw + 8, anchor = side === 'l' ? 'end' : 'start';
      T(nodeG, tx, y0 + h / 2 - 1, name, { 'font-size': 12, fill: P.text, 'text-anchor': anchor });
      T(nodeG, tx, y0 + h / 2 + 12, fmt(v), { 'font-size': 9.5, fill: P.muted, 'text-anchor': anchor }, 'mono');
      const hit = S('rect', { x: side === 'l' ? 0 : x0 - 4, y: y0, width: side === 'l' ? x0 + bw + 4 : W - x0 + 4, height: Math.max(12, h), fill: 'transparent' }, nodeG);
      hit.addEventListener('pointerenter', () => { if (ctx.played) bands.forEach((o) => o.el.classList.toggle('is-dim', o[key] !== idx)); });
      hit.addEventListener('pointerleave', () => bands.forEach((o) => o.el.classList.remove('is-dim')));
    };
    L.forEach((nm, i) => node(lx, ly[i], lt[i] * k, nm, lt[i], 'l', 'i', i));
    R.forEach((nm, j) => node(rx, ry[j], rt[j] * k, nm, rt[j], 'r', 'j', j));
    const DUR = 1400;
    return {
      dur: DUR + 300,
      frame(e) {
        clip.rect.setAttribute('width', (W + 40) * inOut(seg(e, 200, DUR)));
        nodeG.setAttribute('opacity', seg(e, 0, 300));
      },
    };
  }, 'flow');
}

// ================================================================ TREEMAP: two levels, area = amount
function squarify(items, x, y, w, h) {
  const total = items.reduce((a, b) => a + b.value, 0) || 1;
  const nodes = items.map((it) => ({ ...it, a: (it.value / total) * w * h })).sort((a, b) => b.a - a.a);
  const out = [];
  let rx = x, ry = y, rw = w, rh = h, row = [];
  const worst = (r, side) => { const s = r.reduce((a, b) => a + b.a, 0); const mx = Math.max(...r.map((n) => n.a)), mn = Math.min(...r.map((n) => n.a)); return Math.max((side * side * mx) / (s * s), (s * s) / (side * side * mn)); };
  const lay = (r) => {
    const s = r.reduce((a, b) => a + b.a, 0);
    if (rw >= rh) { const cw = s / rh; let yy = ry; r.forEach((n) => { const hh = n.a / cw; out.push({ ...n, x: rx, y: yy, w: cw, h: hh }); yy += hh; }); rx += cw; rw -= cw; }
    else { const ch = s / rw; let xx = rx; r.forEach((n) => { const ww = n.a / ch; out.push({ ...n, x: xx, y: ry, w: ww, h: ch }); xx += ww; }); ry += ch; rh -= ch; }
  };
  for (const n of nodes) { const side = Math.min(rw, rh); if (!row.length || worst([...row, n], side) <= worst(row, side)) row.push(n); else { lay(row); row = [n]; } }
  if (row.length) lay(row);
  return out;
}
/** treemapChart(el, { groups: [{ name, items: [{ name, value }] }], highlight: itemName, format, height }) */
export function treemapChart(host, cfg) {
  return mount(host, cfg, (plot, c, ctx) => {
    const P = palette(ctx.fig);
    const W = widthOf(plot, c), H = c.height ?? 320;
    const fmt = formatter(c.format);
    const groups = (c.groups ?? []).map((g) => ({ name: String(g.name), items: g.items.map((it) => ({ name: String(it.name), value: Number(it.value) || 0 })) }));
    groups.forEach((g) => (g.value = g.items.reduce((a, it) => a + it.value, 0)));
    const total = groups.reduce((a, g) => a + g.value, 0) || 1;
    const maxLeaf = Math.max(...groups.flatMap((g) => g.items.map((it) => it.value)), 1);
    const svg = canvas(plot, W, H);
    const tag = tagFor(plot);
    const leaves = [];
    squarify(groups.map((g) => ({ name: g.name, value: g.value, g })), 0, 0, W, H).forEach((p, pi) => {
      const head = 20;
      T(svg, p.x + 2, p.y + 13, `${p.name} · ${fmt(p.value)}`, { 'font-size': 10, fill: P.sec }, 'mono');
      squarify(p.g.items, p.x + 1, p.y + head, p.w - 2, Math.max(0, p.h - head - 3)).forEach((k, ki) => {
        const hero = k.name === c.highlight;
        const g = S('g', { class: 'ar-dimmable' }, svg);
        const fill = hero ? P.accent : P.ramp[Math.min(6, 1 + Math.round((k.value / maxLeaf) * 5))];
        S('rect', { x: k.x + 1, y: k.y + 1, width: Math.max(0, k.w - 2), height: Math.max(0, k.h - 2), rx: 3, fill }, g);
        const dark = hero || luminance(fill) < 0.45;
        // labels only where they fit; the tooltip always has the full numbers
        const sub = `${fmt(k.value)} · ${pct(k.value / total)}`;
        if (k.h > 24 && textWidth(k.name, 12.5) < k.w - 14) T(g, k.x + 9, k.y + 19, k.name, { 'font-size': 12.5, 'font-weight': 600, fill: dark ? P.onDark : P.onLight });
        if (k.h > 40 && textWidth(sub, 10) * 1.1 < k.w - 14) T(g, k.x + 9, k.y + 34, sub, { 'font-size': 10, fill: dark ? P.onDark : P.onLight, opacity: 0.75 }, 'mono');
        g.addEventListener('pointerenter', () => {
          if (!ctx.played) return;
          leaves.forEach((o) => o.g.classList.toggle('is-dim', o.g !== g));
          tag.show(k.x + k.w / 2, k.y + k.h / 2, `${p.name} › ${k.name}`, [['', fmt(k.value)], ['', '', `${msg('ofAll', { pct: pct(k.value / total) })} · ${msg('ofGroup', { name: p.name, pct: pct(k.value / (p.value || 1)) })}`]]);
        });
        g.addEventListener('pointerleave', () => { leaves.forEach((o) => o.g.classList.remove('is-dim')); tag.hide(); });
        leaves.push({ g, t: pi * 160 + ki * 70 });
      });
    });
    return {
      dur: Math.max(0, ...leaves.map((o) => o.t)) + 500,
      frame(e) {
        leaves.forEach((o) => { const p = outCubic(seg(e, o.t, 420)); o.g.setAttribute('opacity', p); o.g.setAttribute('transform', `translate(0,${((1 - p) * 8).toFixed(1)})`); });
      },
    };
  }, 'tree');
}

// ================================================================ NETWORK: hubs (hexagons) and the nodes that reach for them; drag anything
/** networkChart(el, { hubs: [{ name }], nodes: [{ name }], links: [{ node, hub, value }], highlight: hubName, format, height }) */
export function networkChart(host, cfg) {
  return mount(host, cfg, (plot, c, ctx) => {
    const P = palette(ctx.fig);
    const W = widthOf(plot, c), H = c.height ?? (W < 560 ? 420 : 460);
    const fmt = formatter(c.format);
    const hubs = (c.hubs ?? []).map((h) => String(h.name ?? h)), others = (c.nodes ?? []).map((n) => String(n.name ?? n));
    const hubIdx = new Map(hubs.map((h, i) => [h, i])), nodeIdx = new Map(others.map((n, i) => [n, i]));
    const links = (c.links ?? []).map((l) => ({ s: hubs.length + (typeof l.node === 'number' ? l.node : nodeIdx.get(String(l.node))), d: typeof l.hub === 'number' ? l.hub : hubIdx.get(String(l.hub)), w: Number(l.value) || 1 })).filter((l) => l.s >= hubs.length && l.d !== undefined);
    const sums = hubs.map((_, t) => links.filter((l) => l.d === t).reduce((a, l) => a + l.w, 0));
    const maxSum = Math.max(...sums, 1), maxW = Math.max(...links.map((l) => l.w), 1);
    const nodes = [...hubs.map((name, t) => ({ name, hub: true, r: 9 + Math.sqrt(sums[t] / maxSum) * 15, t })), ...others.map((name) => ({ name, hub: false, r: 4.5 }))];
    const svg = canvas(plot, W, H);
    const linkG = S('g', {}, svg), nodeG = S('g', {}, svg);
    const lineEls = links.map((l) => S('line', { stroke: P.body, 'stroke-opacity': 0.16, 'stroke-width': 0.6 + (l.w / maxW) * 2.2 }, linkG));
    const nodeEls = nodes.map((n) => {
      const g = S('g', { class: 'ar-drag' }, nodeG);
      const hero = n.hub && n.name === c.highlight;
      if (n.hub) {
        S('path', { d: hexPath(n.r), fill: hero ? P.accent : P.strong, stroke: P.paper, 'stroke-width': 1.5 }, g);
        if (hero) hexRing(g, 0, 0, n.r + 5, P.accent);
        T(g, 0, n.r + 15, n.name, { 'font-size': 11.5, 'text-anchor': 'middle', fill: hero ? P.accent : P.text, 'font-weight': 600, 'paint-order': 'stroke', stroke: P.paper, 'stroke-width': 3 });
      } else S('circle', { r: n.r, fill: P.sec, stroke: P.paper, 'stroke-width': 1.2 }, g);
      return g;
    });
    const tag = tagFor(plot);
    const reset = () => nodes.forEach((n, i) => { n.x = W / 2 + (rnd(i, 21) - 0.5) * 40; n.y = H / 2 + (rnd(i, 22) - 0.5) * 40; n.vx = 0; n.vy = 0; });
    let alpha = 1;
    const want = Math.min(W, H * 1.6) * 0.16;
    const tick = () => {
      for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i], b = nodes[j];
        let dx = b.x - a.x, dy = b.y - a.y;
        const d2 = dx * dx + dy * dy || 1, d = Math.sqrt(d2);
        const min = a.r + b.r + (a.hub && b.hub ? 90 : 18);
        const f = ((a.hub && b.hub ? 22000 : a.hub || b.hub ? 2400 : 900) / d2) * alpha;
        dx /= d; dy /= d;
        a.vx -= dx * f; a.vy -= dy * f; b.vx += dx * f; b.vy += dy * f;
        if (d < min) { const push = (min - d) * 0.25; a.vx -= dx * push; a.vy -= dy * push; b.vx += dx * push; b.vy += dy * push; }
      }
      for (const l of links) {
        const a = nodes[l.s], b = nodes[l.d];
        const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 1;
        const f = ((d - (want + b.r * 1.8)) / d) * 0.045 * alpha;
        a.vx += dx * f; a.vy += dy * f; b.vx -= dx * f * 0.25; b.vy -= dy * f * 0.25;
      }
      for (const n of nodes) {
        n.vx += (W / 2 - n.x) * 0.0025 * alpha; n.vy += (H / 2 - n.y) * 0.006 * alpha;
        if (n.fixed) { n.x = n.fx; n.y = n.fy; n.vx = n.vy = 0; continue; }
        n.vx *= 0.62; n.vy *= 0.62;
        n.x = clamp(n.x + n.vx, n.r + 6, W - n.r - 6); n.y = clamp(n.y + n.vy, n.r + 6, H - n.r - 22);
      }
      alpha = Math.max(0.02, alpha * 0.985);
    };
    const draw = () => {
      links.forEach((l, k) => { const a = nodes[l.s], b = nodes[l.d], e = lineEls[k]; e.setAttribute('x1', a.x.toFixed(1)); e.setAttribute('y1', a.y.toFixed(1)); e.setAttribute('x2', b.x.toFixed(1)); e.setAttribute('y2', b.y.toFixed(1)); });
      nodes.forEach((n, i) => nodeEls[i].setAttribute('transform', `translate(${n.x.toFixed(1)},${n.y.toFixed(1)})`));
    };
    const focus = (i) => {
      const near = new Set([i]);
      links.forEach((l) => { if (l.s === i) near.add(l.d); if (l.d === i) near.add(l.s); });
      nodeEls.forEach((e, k) => e.setAttribute('opacity', i === null || near.has(k) ? 1 : 0.15));
      lineEls.forEach((e, k) => { const on = i !== null && (links[k].s === i || links[k].d === i); e.setAttribute('stroke-opacity', i === null ? 0.16 : on ? 0.7 : 0.04); e.setAttribute('stroke', on && nodes[i].hub && nodes[i].name === c.highlight ? P.accent : P.body); });
    };
    let loop = 0, dragging = null;
    const run = () => { cancelAnimationFrame(loop); const step = () => { tick(); draw(); if (alpha > 0.03 || dragging) loop = requestAnimationFrame(step); }; loop = requestAnimationFrame(step); };
    nodeEls.forEach((g, i) => {
      g.addEventListener('pointerenter', () => {
        if (!ctx.played || dragging) return;
        focus(i);
        const n = nodes[i], mine = links.filter((l) => l.s === i || l.d === i);
        tag.show(n.x + n.r, n.y, n.name, [['', fmt(mine.reduce((a, l) => a + l.w, 0))], ['', '', msg('links', { n: mine.length })]]);
      });
      g.addEventListener('pointerleave', () => { if (!dragging) { focus(null); tag.hide(); } });
      g.addEventListener('pointerdown', (ev) => {
        if (!ctx.played) return;
        ev.preventDefault();
        g.setPointerCapture(ev.pointerId);
        dragging = nodes[i]; dragging.fixed = true; dragging.fx = dragging.x; dragging.fy = dragging.y;
        alpha = Math.max(alpha, 0.5);
        tag.hide();
        run();
      });
      g.addEventListener('pointermove', (ev) => {
        if (dragging !== nodes[i]) return;
        const r = svg.getBoundingClientRect();
        dragging.fx = clamp(ev.clientX - r.left, 10, W - 10); dragging.fy = clamp(ev.clientY - r.top, 10, H - 10);
      });
      const drop = () => { if (dragging === nodes[i]) { dragging.fixed = false; dragging = null; alpha = Math.max(alpha, 0.3); run(); } };
      g.addEventListener('pointerup', drop);
      g.addEventListener('pointercancel', drop);
    });
    ctx.onReplay = () => { cancelAnimationFrame(loop); reset(); alpha = 1; };
    reset();
    return {
      dur: 2600,
      frame(e) {
        if (e === Infinity) { if (alpha > 0.05) for (let k = 0; k < 320; k++) tick(); draw(); linkG.setAttribute('opacity', 1); return; }
        if (e === 0) { reset(); alpha = 1; }
        tick(); draw();
        linkG.setAttribute('opacity', seg(e, 300, 900));
      },
    };
  }, 'network');
}

// ================================================================ HUNDRED: a whole as 100 hexagons
/** hundredChart(el, { items: [{ name, value }] (any amounts; shown as whole cells out of 100), highlight: i, format }) */
export function hundredChart(host, cfg) {
  return mount(host, cfg, (plot, c, ctx) => {
    const P = palette(ctx.fig);
    const W = widthOf(plot, c);
    const items = (c.items ?? []).map((it) => ({ name: String(it.name), v: Number(it.value) || 0 }));
    const cells = apportion(items.map((i) => i.v), 100);
    const fmt = formatter(c.format);
    const fills = items.map((_, k) => (k === c.highlight ? P.accent : ladder(P, k - (c.highlight !== undefined && k > c.highlight ? 1 : 0), items.length)));
    const side = W >= 480;
    const r = Math.min(13, (side ? W * 0.56 : W - 20) / 10 / Math.sqrt(3) - 0.6);
    const hw = Math.sqrt(3) * r, rowH = 1.5 * r + 1.4;
    const gridW = hw * 10 + hw / 2 + 14, gridH = rowH * 9 + 2 * r;
    const H = side ? Math.max(gridH + 16, items.length * 46 + 20) : gridH + 30 + items.length * 30;
    const svg = canvas(plot, W, H);
    const owner = [];
    cells.forEach((n, k) => { for (let i = 0; i < n; i++) owner.push(k); });
    const groups = items.map(() => S('g', { class: 'ar-dimmable' }, svg));
    const hexes = [];
    owner.forEach((k, idx) => {
      const row = Math.floor(idx / 10), col = idx % 10;
      const cx = r + 2 + col * (hw + 1.4) + (row % 2 ? hw / 2 : 0), cy = r + 4 + row * rowH;
      hexes.push({ el: S('path', { d: hexPath(r), fill: fills[k] }, groups[k]), cx, cy, t: idx * 11 });
    });
    const lx = side ? gridW + 28 : 4, ly0 = side ? 14 : gridH + 26;
    items.forEach((it, k) => {
      const yy = ly0 + k * (side ? 46 : 30);
      const g = S('g', {}, svg);
      S('path', { d: hexPath(5.5), transform: `translate(${lx + 6},${yy + 8})`, fill: fills[k] }, g);
      T(g, lx + 20, yy + 12, it.name, { 'font-size': 12.5, fill: P.body });
      T(g, side ? lx + 20 : W - 4, side ? yy + 32 : yy + 12, `${cells[k]}%`, { 'font-size': side ? 18 : 14, fill: P.text, 'text-anchor': side ? 'start' : 'end' }, 'num');
      if (c.format) T(g, side ? lx + 72 : W - 50, side ? yy + 32 : yy + 12, fmt(it.v), { 'font-size': 10, fill: P.muted, 'text-anchor': side ? 'start' : 'end' }, 'mono');
      const hit = S('rect', { x: lx, y: yy - 4, width: W - lx, height: side ? 44 : 28, fill: 'transparent' }, svg);
      const on = () => { if (ctx.played) spotlight(groups, k); };
      const off = () => spotlight(groups, null);
      hit.addEventListener('pointerenter', on); hit.addEventListener('pointerleave', off);
      groups[k].addEventListener('pointerenter', on); groups[k].addEventListener('pointerleave', off);
    });
    return {
      dur: 100 * 11 + 400,
      frame(e) {
        hexes.forEach((o) => { const p = outCubic(seg(e, o.t, 280)); o.el.setAttribute('transform', `translate(${o.cx.toFixed(1)},${o.cy.toFixed(1)}) scale(${(0.3 + 0.7 * p).toFixed(3)})`); o.el.setAttribute('opacity', p); });
      },
    };
  }, 'hundred');
}

// ================================================================ BRIDGE: from one total to the next in cells; added cells solid, removed hollow
/** bridgeChart(el, { start: { label, value }, steps: [{ name, value }], end: { label }, unit (value per cell), perRow: 4, highlight: stepName, format }) */
export function bridgeChart(host, cfg) {
  return mount(host, cfg, (plot, c, ctx) => {
    const P = palette(ctx.fig);
    const W = widthOf(plot, c);
    const fmt = formatter(c.format);
    let run = Number(c.start?.value) || 0;
    const cols = [{ name: c.start?.label ?? '', from: 0, to: run, v: run, total: true }];
    for (const s of c.steps ?? []) { const v = Number(s.value) || 0; cols.push({ name: String(s.name), from: run, to: run + v, v }); run += v; }
    if (c.end !== false) cols.push({ name: c.end?.label ?? '', from: 0, to: run, v: run, total: true });
    const per = c.perRow ?? 4;
    // a running total can cross zero (a month that lost money): cells above the zero line count up, cells below count down
    const top = Math.max(0, ...cols.map((o) => Math.max(o.from, o.to)));
    const bottom = Math.max(0, ...cols.map((o) => -Math.min(o.from, o.to)));
    const unit = c.unit ?? niceUnit((top + bottom) / 64);
    const colW = (W - 8) / cols.length;
    const r = Math.min(6.4, (colW * 0.78) / per / Math.sqrt(3) - 0.3);
    const hw = Math.sqrt(3) * r, rowH = 1.5 * r + 1;
    const upRows = Math.ceil(Math.round(top / unit) / per), downRows = Math.ceil(Math.round(bottom / unit) / per);
    const y0 = 44 + upRows * rowH;
    const H = y0 + downRows * rowH + (downRows ? 30 : 8) + 32;
    // cell k (k ≥ 0 above zero, k < 0 below) → its centre; edge(v) → the y just past the cells that reach value v
    const rowOf = (k) => (k >= 0 ? Math.floor(k / per) : Math.floor((-k - 1) / per));
    const cy = (k) => (k >= 0 ? y0 - r - 2 - rowOf(k) * rowH : y0 + r + 2 + rowOf(k) * rowH);
    const edge = (cells) => (cells > 0 ? cy(cells - 1) - r : cells < 0 ? cy(cells) + r : y0);
    const svg = canvas(plot, W, H);
    S('line', { x1: 0, x2: W, y1: y0, y2: y0, stroke: P.soft }, svg);
    const all = [];
    cols.forEach((col, ci) => {
      const cx = colW * ci + colW / 2;
      const lo = Math.round(Math.min(col.from, col.to) / unit), hi = Math.round(Math.max(col.from, col.to) / unit);
      const fall = !col.total && col.v < 0, hero = col.name === c.highlight;
      for (let k = lo; k < hi; k++) {
        const j = k >= 0 ? k % per : (-k - 1) % per, row = rowOf(k);
        const px = cx + (j - (per - 1) / 2) * (hw + 1.2) + (row % 2 ? hw / 4 : -hw / 4), py = cy(k);
        // cells appear in the direction the step moves: up from the start, or down from it
        const order = col.v < 0 ? hi - 1 - k : k - lo;
        all.push({ el: S('path', { d: hexPath(r), fill: fall ? 'none' : hero ? P.accent : col.total ? P.strong : P.ramp[3], stroke: fall ? P.mid : 'none', 'stroke-width': 1 }, svg), px, py, t: ci * 260 + order * (col.total ? 9 : 40) });
      }
      const label = col.total ? fmt(col.v) : signed(fmt, col.v);
      // the number sits past the column's outer end: above it, or below it when the whole column is under zero
      const ly = hi > 0 ? edge(hi) - 8 : edge(lo) + 18;
      all.push({ label: T(svg, cx, ly, label, { 'font-size': col.total ? 15 : 13, 'text-anchor': 'middle', fill: hero ? P.accent : P.text, opacity: 0 }, 'num'), t: ci * 260 + 300 });
      T(svg, cx, H - 12, col.name, { 'font-size': 10.5, 'text-anchor': 'middle', fill: P.muted }, 'mono');
      if (ci < cols.length - 1) { const at = edge(Math.round(col.to / unit)) + (col.to >= 0 ? 2 : -2); S('line', { x1: cx + colW * 0.32, x2: cx + colW * 0.68, y1: at, y2: at, stroke: P.mid }, svg); }
    });
    return {
      dur: cols.length * 260 + 900,
      frame(e) {
        all.forEach((o) => {
          const p = outCubic(seg(e, o.t, 260));
          if (o.label) { o.label.setAttribute('opacity', p); return; }
          o.el.setAttribute('transform', `translate(${o.px.toFixed(1)},${(o.py - (1 - p) * 8).toFixed(1)}) scale(${(0.4 + 0.6 * p).toFixed(3)})`);
          o.el.setAttribute('opacity', p);
        });
      },
    };
  }, 'bridge');
}

// ================================================================ LAUNCH FAN: when each thing launched, and how big it is now
/**
 * launchFan(el, { items: [{ name, weeks (age in weeks), value (size today) }], ringEvery: 5, highlight: name, format, height: 380 })
 * One spoke per item, oldest first; a small dot for every week it has existed; the big dot at its launch is sized by today's value.
 */
export function launchFan(host, cfg) {
  return mount(host, cfg, (plot, c, ctx) => {
    const P = palette(ctx.fig);
    const W = widthOf(plot, c), H = c.height ?? 420;
    const fmt = formatter(c.format);
    const items = (c.items ?? []).map((it) => ({ name: String(it.name), weeks: Math.max(0, Math.round(Number(it.weeks) || 0)), v: Number(it.value) || 0 })).sort((a, b) => b.weeks - a.weeks);
    const nameW = Math.max(...items.map((i) => textWidth(i.name, 11.5)), 30) + 18;
    const n = items.length;
    const maxW = Math.max(...items.map((i) => i.weeks), 1), maxV = Math.max(...items.map((i) => i.v), 1);
    const ox = Math.min(W * 0.22, 140), oy = H - 40;
    const R = Math.max(80, Math.min(W - ox - nameW, oy - nameW));
    const a0 = -95, a1 = -5;
    const ang = (k) => ((a0 + (a1 - a0) * (n === 1 ? 0.5 : k / (n - 1))) * Math.PI) / 180;
    const rOf = (w) => 34 + (w / maxW) * (R - 34);
    const svg = canvas(plot, W, H);
    const every = c.ringEvery ?? niceUnit(maxW / 4);
    for (let w = every; w <= maxW; w += every) {
      const r = rOf(w);
      const p = (a) => [ox + r * Math.cos((a * Math.PI) / 180), oy + r * Math.sin((a * Math.PI) / 180)];
      const [sx, sy] = p(a0 - 4), [ex, ey] = p(a1 + 4);
      S('path', { d: `M${sx},${sy}A${r},${r} 0 0 1 ${ex},${ey}`, fill: 'none', stroke: P.soft, 'stroke-dasharray': '2 4' }, svg);
      T(svg, sx - 4, sy + 3, `W${w}`, { 'font-size': 9.5, fill: P.muted, 'text-anchor': 'end' }, 'mono');
    }
    const tag = tagFor(plot);
    const spokes = items.map((it, k) => {
      const a = ang(k), ca = Math.cos(a), sa = Math.sin(a);
      const hero = it.name === c.highlight;
      const g = S('g', { class: 'ar-dimmable' }, svg);
      const dots = [];
      for (let w = 1; w <= it.weeks; w++) { const r = rOf(w); dots.push(S('circle', { cx: ox + r * ca, cy: oy + r * sa, r: 1.5, fill: hero ? P.accent : P.mid, opacity: 0 }, g)); }
      const big = 3 + Math.sqrt(it.v / maxV) * 12;
      const r0 = rOf(it.weeks);
      const head = S('circle', { cx: ox + 30 * ca, cy: oy + 30 * sa, r: 0, fill: hero ? P.accent : ladder(P, Math.round((1 - it.v / maxV) * 3), 4), stroke: P.paper, 'stroke-width': 1.5 }, g);
      const lx = ox + (R + 14) * ca, ly = oy + (R + 14) * sa;
      const label = T(g, lx, ly, it.name, { 'font-size': 11.5, fill: hero ? P.text : P.sec, 'font-weight': hero ? 600 : 400, transform: `rotate(${(a * 180) / Math.PI} ${lx} ${ly})`, opacity: 0 });
      // the launch end of the spoke is at the outer radius (older = longer); the big dot sits where it launched
      head.dataset.r = big;
      const hit = S('line', { x1: ox, y1: oy, x2: ox + (R + 60) * ca, y2: oy + (R + 60) * sa, stroke: 'transparent', 'stroke-width': 14 }, svg);
      hit.addEventListener('pointerenter', () => {
        if (!ctx.played) return;
        spotlight(spokes.map((o) => o.g), k);
        tag.show(ox + r0 * ca, oy + r0 * sa, it.name, [['', fmt(it.v)], ['', '', `W${it.weeks}`]]);
      });
      hit.addEventListener('pointerleave', () => { spotlight(spokes.map((o) => o.g), null); tag.hide(); });
      return { g, dots, head, label, r0, ca, sa, big, t: k * 110 };
    });
    S('circle', { cx: ox, cy: oy, r: 3, fill: P.text }, svg);
    return {
      dur: n * 110 + 1400,
      frame(e) {
        spokes.forEach((s) => {
          const p = outCubic(seg(e, s.t, 900));
          const shown = Math.round(s.dots.length * p);
          s.dots.forEach((d, i) => d.setAttribute('opacity', i < shown ? 0.9 : 0));
          const r = 30 + (s.r0 - 30) * p;
          s.head.setAttribute('cx', ox + r * s.ca); s.head.setAttribute('cy', oy + r * s.sa);
          s.head.setAttribute('r', (s.big * outCubic(seg(e, s.t + 700, 400))).toFixed(2));
          s.label.setAttribute('opacity', seg(e, s.t + 600, 400));
        });
      },
    };
  }, 'fan');
}

// ================================================================ DOT CASCADE: many categories ranked, one dot per unit
/** dotCascade(el, { items: [{ name, value }], unit: 1, sort: 'asc' | 'desc' | false, highlight: 'max' | name | false, format, ink }) */
export function dotCascade(host, cfg) {
  return mount(host, cfg, (plot, c, ctx) => {
    const P = palette(ctx.fig);
    const W = widthOf(plot, c);
    const fmt = formatter(c.format);
    let items = (c.items ?? []).map((it) => ({ name: String(it.name), v: Number(it.value) || 0 }));
    if (c.sort !== false) items.sort((a, b) => (c.sort === 'desc' ? b.v - a.v : a.v - b.v));
    const unit = c.unit ?? Math.max(1, niceUnit(Math.max(...items.map((i) => i.v), 1) / 14));
    const n = items.length;
    const maxDots = Math.max(...items.map((i) => Math.round(i.v / unit)), 1);
    const colW = Math.min(36, (W - 40) / Math.max(1, n));
    const gap = Math.min(9, Math.max(5, colW * 0.36));
    const rise = Math.min(colW * 0.42, 12);
    const H = maxDots * gap + n * rise * 0.6 + 110;
    const base0 = H - 64;
    const x = (k) => 20 + colW * k + colW / 2;
    const baseY = (k) => base0 - k * rise * 0.6;
    const hero = c.highlight === false ? -1 : c.highlight && c.highlight !== 'max' ? items.findIndex((i) => i.name === c.highlight) : items.reduce((b, it, k) => (it.v > items[b].v ? k : b), 0);
    const svg = canvas(plot, W, H);
    S('line', { x1: x(0) - colW / 2, y1: baseY(0) + 8, x2: x(n - 1) + colW / 2, y2: baseY(n - 1) + 8, stroke: P.soft, 'stroke-dasharray': '2 3' }, svg);
    const tag = tagFor(plot);
    const cols = items.map((it, k) => {
      const g = S('g', { class: 'ar-dimmable' }, svg);
      const count = Math.round(it.v / unit);
      const isHero = k === hero;
      const dots = [];
      for (let i = 0; i < count; i++) {
        const top = i === count - 1;
        dots.push({ el: S('circle', { cx: x(k), cy: baseY(k) - i * gap, r: top ? 4.6 : 2, fill: isHero ? P.accent : top ? P.strong : P.mid, opacity: 0 }, g), t: k * 70 + i * 28 });
      }
      const topY = baseY(k) - Math.max(0, count - 1) * gap;
      const val = T(g, x(k), topY - 10, fmt(it.v), { 'font-size': 11.5, 'text-anchor': 'middle', fill: isHero ? P.accent : P.text, opacity: 0 }, 'num');
      const ly = baseY(k) + 18;
      T(g, x(k), ly, it.name, { 'font-size': 9.5, fill: P.muted, 'text-anchor': 'end', transform: `rotate(-90 ${x(k)} ${ly})` }, 'mono');
      const hit = S('rect', { x: x(k) - colW / 2, y: 0, width: colW, height: H, fill: 'transparent' }, svg);
      hit.addEventListener('pointerenter', () => {
        if (!ctx.played) return;
        spotlight(cols.map((o) => o.g), k);
        tag.show(x(k) + 8, topY, it.name, [['', fmt(it.v)], ['', '', msg('cells', { n: count })]]);
      });
      hit.addEventListener('pointerleave', () => { spotlight(cols.map((o) => o.g), null); tag.hide(); });
      return { g, dots, val, t: k * 70 + count * 28 };
    });
    const last = Math.max(0, ...cols.map((o) => o.t));
    return {
      dur: last + 500,
      frame(e) {
        cols.forEach((col) => {
          col.dots.forEach((d) => d.el.setAttribute('opacity', outCubic(seg(e, d.t, 180))));
          col.val.setAttribute('opacity', seg(e, col.t, 300));
        });
      },
    };
  }, 'cascade');
}

// ================================================================ ALMANAC: periods × categories, bubbles with a core, a status and the year's events
/**
 * almanacChart(el, { rows: [period labels], cols: [category labels], values: [[…]], cores: [[…]] (a part of each value, drawn dark),
 *   status: [[…]] ('new' draws a dashed hexagon), events: [{ row, label }], highlight: [row, col] | 'max', coreLabel, format })
 */
export function almanacChart(host, cfg) {
  return mount(host, cfg, (plot, c, ctx) => {
    const P = palette(ctx.fig);
    const W = widthOf(plot, c);
    const fmt = formatter(c.format);
    const rows = (c.rows ?? []).map(String), cols = (c.cols ?? []).map(String);
    const val = rows.map((_, r) => cols.map((__, k) => Number(c.values?.[r]?.[k]) || 0));
    const core = rows.map((_, r) => cols.map((__, k) => Number(c.cores?.[r]?.[k]) || 0));
    const events = new Map((c.events ?? []).map((ev) => [typeof ev.row === 'number' ? ev.row : rows.indexOf(String(ev.row)), ev.label]));
    const max = Math.max(...val.flat(), 1);
    const left = Math.max(...rows.map((r) => textWidth(r, 10.5)), 24) + 14;
    const narrowEv = W < 560;
    const evW = events.size && !narrowEv ? Math.min(180, W * 0.26) : 10;
    const cw = Math.min(56, (W - left - evW) / Math.max(1, cols.length));
    const ch = Math.min(46, Math.max(30, cw * 0.82));
    const top = 46;
    const H = top + rows.length * ch + 16 + (narrowEv ? events.size * 18 + 8 : 0);
    const svg = canvas(plot, W, H);
    if (narrowEv) [...events].sort((a, b) => a[0] - b[0]).forEach(([r, label], i) => T(svg, 0, top + rows.length * ch + 22 + i * 18, `${rows[r]} · ${label}`, { 'font-size': 10.5, fill: P.sec }, 'mono'));
    cols.forEach((k, i) => { const lx = left + i * cw + cw / 2; T(svg, lx, top - 14, k, { 'font-size': 9.5, fill: P.muted, transform: `rotate(-32 ${lx} ${top - 14})` }, 'mono'); });
    let peak = [0, 0];
    val.forEach((row, r) => row.forEach((v, k) => { if (v > val[peak[0]][peak[1]]) peak = [r, k]; }));
    if (Array.isArray(c.highlight)) peak = c.highlight;
    const tag = tagFor(plot);
    const cells = [];
    rows.forEach((rl, r) => {
      const cy = top + r * ch + ch / 2;
      T(svg, 0, cy + 4, rl, { 'font-size': 10.5, fill: P.muted }, 'mono');
      S('line', { x1: left, x2: left + cols.length * cw, y1: cy, y2: cy, stroke: P.faint }, svg);
      if (events.has(r) && narrowEv) S('circle', { cx: left + cols.length * cw + 4, cy, r: 2, fill: P.mid }, svg);
      if (events.has(r) && !narrowEv) {
        const ex = left + cols.length * cw + 12;
        S('line', { x1: ex - 6, x2: ex, y1: cy, y2: cy, stroke: P.mid }, svg);
        T(svg, ex + 4, cy + 4, events.get(r), { 'font-size': 10.5, fill: P.sec }, 'mono');
      }
      cols.forEach((_, k) => {
        const v = val[r][k], co = core[r][k], st = c.status?.[r]?.[k];
        const cx = left + k * cw + cw / 2;
        const R = Math.sqrt(v / max) * Math.min(cw, ch * 1.25) * 0.62;
        const isPeak = c.highlight !== false && r === peak[0] && k === peak[1];
        const g = S('g', { transform: `translate(${cx},${cy})`, class: 'ar-dimmable' }, svg);
        const inner = S('g', {}, g);
        if (st === 'new') S('path', { d: hexPath(Math.max(R, 6)), fill: 'none', stroke: P.mid, 'stroke-dasharray': '2 2' }, inner);
        else if (v) S('circle', { r: Math.max(1.4, R), fill: isPeak ? P.accent : P.ink ? 'rgba(255,255,255,.08)' : P.faint, stroke: isPeak ? P.accent : P.mid, 'stroke-width': 1, 'fill-opacity': isPeak ? 0.25 : 1 }, inner);
        if (co) S('circle', { r: Math.max(1.2, Math.sqrt(co / max) * Math.min(cw, ch * 1.25) * 0.62), fill: isPeak ? P.accent : P.strong }, inner);
        if (isPeak) { hexRing(inner, 0, 0, R + 5, P.accent); T(inner, 0, -R - 10, fmt(v), { 'font-size': 10.5, 'text-anchor': 'middle', fill: P.accent }, 'mono'); }
        cells.push({ g: inner, r, k, t: r * 90 + k * 30 });
        const hit = S('rect', { x: cx - cw / 2, y: cy - ch / 2, width: cw, height: ch, fill: 'transparent' }, svg);
        hit.addEventListener('pointerenter', () => {
          if (!ctx.played) return;
          cells.forEach((o) => o.g.parentNode.classList.toggle('is-dim', o.r !== r && o.k !== k));
          tag.show(cx + R, cy, `${rl} · ${cols[k]}`, [['', fmt(v)], ...(co ? [[c.coreLabel ?? '', fmt(co)]] : []), ...(st === 'new' ? [['', '', c.newLabel ?? 'new']] : [])]);
        });
        hit.addEventListener('pointerleave', () => { cells.forEach((o) => o.g.parentNode.classList.remove('is-dim')); tag.hide(); });
      });
    });
    const last = Math.max(0, ...cells.map((o) => o.t));
    return {
      dur: last + 500,
      frame(e) {
        cells.forEach((o) => { const p = outCubic(seg(e, o.t, 380)); o.g.setAttribute('transform', `scale(${p.toFixed(3)})`); });
      },
    };
  }, 'almanac');
}

// ================================================================ DAY CLOCK: every event of a period overlaid on a 24-hour face
/**
 * dayClock(el, { events: [{ time: 'HH:MM' | hours, size, flag }], sizeLabel, flagLabel, format, height: 380 })
 * Each event is a wedge: angle = time of day, reach = size. Wedges are translucent, so ink builds where events pile up;
 * flagged events (incidents) are outlined in orange.
 */
export function dayClock(host, cfg) {
  return mount(host, cfg, (plot, c, ctx) => {
    const P = palette(ctx.fig);
    const W = widthOf(plot, c), H = c.height ?? 380;
    const fmt = formatter(c.format);
    const hourOf = (t) => (typeof t === 'number' ? t : (([h, m]) => Number(h) + (Number(m) || 0) / 60)(String(t).split(':')));
    const events = (c.events ?? []).map((ev) => ({ h: hourOf(ev.time) % 24, s: Number(ev.size) || 0, flag: !!ev.flag })).sort((a, b) => a.h - b.h);
    const maxS = Math.max(...events.map((e) => e.s), 1);
    const cx = W / 2, cy = H / 2 + 6;
    const R = Math.min(W / 2 - 40, H / 2 - 34), r0 = 12;
    const svg = canvas(plot, W, H);
    for (let i = 0; i < 96; i++) {
      const a = (i / 96) * 2 * Math.PI - Math.PI / 2, long = i % 4 === 0;
      S('line', { x1: cx + (R + 6) * Math.cos(a), y1: cy + (R + 6) * Math.sin(a), x2: cx + (R + (long ? 12 : 9)) * Math.cos(a), y2: cy + (R + (long ? 12 : 9)) * Math.sin(a), stroke: long ? P.mid : P.soft }, svg);
    }
    [0, 6, 12, 18].forEach((h) => {
      const a = (h / 24) * 2 * Math.PI - Math.PI / 2;
      T(svg, cx + (R + 24) * Math.cos(a), cy + (R + 24) * Math.sin(a) + 4, String(h).padStart(2, '0'), { 'font-size': 10.5, 'text-anchor': 'middle', fill: P.sec }, 'mono');
    });
    const span = (c.wedgeMinutes ?? 24) / 60;
    const wedges = events.map((ev, i) => {
      const a1 = ((ev.h - span / 2) / 24) * 2 * Math.PI - Math.PI / 2, a2 = ((ev.h + span / 2) / 24) * 2 * Math.PI - Math.PI / 2;
      const r = r0 + Math.sqrt(ev.s / maxS) * (R - r0);
      const p = (a, rr) => `${(cx + rr * Math.cos(a)).toFixed(1)},${(cy + rr * Math.sin(a)).toFixed(1)}`;
      const d = `M${p(a1, r0)}L${p(a1, r)}A${r},${r} 0 0 1 ${p(a2, r)}L${p(a2, r0)}A${r0},${r0} 0 0 0 ${p(a1, r0)}Z`;
      const el = S('path', { d, fill: P.strong, 'fill-opacity': 0, stroke: ev.flag ? P.accent : 'none', 'stroke-width': 1.4, 'stroke-opacity': 0 }, svg);
      return { el, ev, t: (ev.h / 24) * 1600 };
    });
    // flagged wedges on top so their outline reads
    wedges.filter((w) => w.ev.flag).forEach((w) => svg.appendChild(w.el));
    S('circle', { cx, cy, r: 3, fill: P.text }, svg);
    const flagged = events.filter((e) => e.flag).length;
    if (flagged && c.flagLabel) T(svg, 0, 12, c.flagLabel, { 'font-size': 10, fill: P.accent }, 'mono');
    const tag = tagFor(plot);
    const hand = S('line', { x1: cx, y1: cy, x2: cx, y2: cy - R, stroke: P.text, opacity: 0 }, svg);
    svg.addEventListener('pointermove', (ev) => {
      if (!ctx.played) return;
      const b = svg.getBoundingClientRect();
      const dx = ev.clientX - b.left - cx, dy = ev.clientY - b.top - cy;
      if (Math.hypot(dx, dy) > R + 30) { hand.setAttribute('opacity', 0); tag.hide(); return; }
      const h = Math.floor((((Math.atan2(dy, dx) + Math.PI / 2 + 2 * Math.PI) % (2 * Math.PI)) / (2 * Math.PI)) * 24);
      const a = ((h + 0.5) / 24) * 2 * Math.PI - Math.PI / 2;
      hand.setAttribute('x2', cx + R * Math.cos(a)); hand.setAttribute('y2', cy + R * Math.sin(a)); hand.setAttribute('opacity', 0.4);
      const inHour = events.filter((e) => Math.floor(e.h) === h);
      tag.show(cx + (R * 0.6) * Math.cos(a), cy + (R * 0.6) * Math.sin(a), `${String(h).padStart(2, '0')}:00–${String(h + 1).padStart(2, '0')}:00`,
        [['', String(inHour.length)], ...(inHour.length ? [[c.sizeLabel ?? '', fmt(inHour.reduce((s, e) => s + e.s, 0) / inHour.length)]] : []), ...(inHour.some((e) => e.flag) ? [['', '', `${c.flagLabel ?? '!'} ${inHour.filter((e) => e.flag).length}`]] : [])]);
    });
    svg.addEventListener('pointerleave', () => { hand.setAttribute('opacity', 0); tag.hide(); });
    return {
      dur: 2100,
      frame(e) {
        wedges.forEach((w) => {
          const p = seg(e, w.t, 260);
          w.el.setAttribute('fill-opacity', (0.13 * p).toFixed(3));
          w.el.setAttribute('stroke-opacity', w.ev.flag ? seg(e, 1700, 300) : 0);
        });
      },
    };
  }, 'clock');
}

// ================================================================ HOURGLASS: a funnel of threads; each strip is a stage, each thread a few people
/** hourglassChart(el, { stages: [{ name, value }], threads: 60, highlight: 'last' | i, format, height }) */
export function hourglassChart(host, cfg) {
  return mount(host, cfg, (plot, c, ctx) => {
    const P = palette(ctx.fig);
    const W = widthOf(plot, c);
    const fmt = formatter(c.format);
    const stages = (c.stages ?? []).map((s) => ({ name: String(s.name), v: Number(s.value) || 0 }));
    const n = stages.length;
    const hero = c.highlight === undefined || c.highlight === 'last' ? n - 1 : c.highlight;
    const rowH = 64, H = c.height ?? n * rowH + 24;
    const leftW = 80, rightW = Math.min(150, W * 0.26);
    const mid = leftW + (W - leftW - rightW) / 2;
    const maxHalf = (W - leftW - rightW) / 2 - 6;
    const half = (v) => (v / (stages[0]?.v || 1)) * maxHalf;
    const y = (s) => 16 + s * rowH;
    const svg = canvas(plot, W, H);
    const total = c.threads ?? 60;
    const threadsG = S('g', {}, svg);
    // threads: each starts at the top strip; it continues while it is among the survivors of a stage
    const threads = [];
    const keep = (s) => stages[s].v / (stages[0].v || 1);
    // thread u in (0, 1): the middle ones survive longest (|u - .5| * 2 < keep); at each strip a thread sits near its
    // place among the survivors, nudged a little so the bundle crosses like poured threads
    const at = (u, s, t) => {
      const q = (u - 0.5) / keep(s) + 0.5 + (s ? (rnd(t * 7 + s, 41) - 0.5) * 0.3 : 0);
      return mid + (clamp(q, 0.02, 0.98) - 0.5) * 2 * half(stages[s].v);
    };
    const survives = (u, s) => Math.abs(u - 0.5) * 2 < keep(s);
    for (let t = 0; t < total; t++) {
      const u = (t + 0.5) / total;
      let d = `M${at(u, 0, t).toFixed(1)},${y(0) + 6}`, lastS = 0;
      for (let s = 0; s < n - 1; s++) {
        const x0 = at(u, s, t);
        if (!survives(u, s + 1)) {
          const out = x0 > mid ? 1 : -1;
          d += `C${x0.toFixed(1)},${y(s) + 28} ${(x0 + out * 14).toFixed(1)},${y(s) + 34} ${(x0 + out * 24).toFixed(1)},${y(s) + 42}`;
          break;
        }
        const x1 = at(u, s + 1, t);
        d += `C${x0.toFixed(1)},${y(s) + rowH * 0.55} ${x1.toFixed(1)},${y(s + 1) - rowH * 0.55} ${x1.toFixed(1)},${y(s + 1) - 6}`;
        lastS = s + 1;
      }
      const reached = lastS === n - 1;
      threads.push({ el: S('path', { d, fill: 'none', stroke: reached && hero === n - 1 ? P.accent : P.mid, 'stroke-width': 0.9, 'stroke-opacity': reached ? 0.6 : 0.3, pathLength: 1, 'stroke-dasharray': 1, 'stroke-dashoffset': 1 }, threadsG), t: (t % 12) * 40 });
    }
    const tag = tagFor(plot);
    const strips = stages.map((st, s) => {
      const g = S('g', { class: 'ar-dimmable' }, svg);
      const hw = half(st.v), yy = y(s);
      const ticks = Math.max(3, Math.round((hw * 2) / 3.2));
      for (let i = 0; i < ticks; i++) {
        const tx = mid - hw + (i + 0.5) * ((hw * 2) / ticks);
        S('line', { x1: tx, x2: tx, y1: yy - 6, y2: yy + 6, stroke: s === hero ? P.accent : P.strong, 'stroke-width': rnd(i + s * 97, 31) > 0.7 ? 1.6 : 0.9 }, g);
      }
      const lx = W - rightW + 12;
      S('line', { x1: mid + hw + 6, x2: lx - 4, y1: yy, y2: yy, stroke: P.soft }, g);
      T(g, lx, yy - 2, st.name, { 'font-size': 10.5, fill: P.sec }, 'mono');
      T(g, lx, yy + 13, fmt(st.v), { 'font-size': 13, fill: P.text }, 'num');
      if (s > 0 && stages[s - 1].v) {
        const k = st.v / stages[s - 1].v;
        T(g, 0, yy - rowH / 2 + 2, pct(k), { 'font-size': 13, fill: s === hero ? P.accent : P.text }, 'num');
        T(g, 0, yy - rowH / 2 + 15, msg('stay', { pct: '' }).trim(), { 'font-size': 9.5, fill: P.muted }, 'mono');
      }
      const hit = S('rect', { x: 0, y: yy - rowH / 2, width: W, height: rowH, fill: 'transparent' }, svg);
      hit.addEventListener('pointerenter', () => {
        if (!ctx.played) return;
        spotlight(strips.map((o) => o.g), s);
        tag.show(mid + hw, yy, st.name, [['', fmt(st.v)], ...(s ? [['', '', msg('ofGroup', { name: stages[0].name, pct: pct(st.v / (stages[0].v || 1)) })]] : [])]);
      });
      hit.addEventListener('pointerleave', () => { spotlight(strips.map((o) => o.g), null); tag.hide(); });
      return { g, t: s * 360 };
    });
    return {
      dur: n * 360 + 1500,
      frame(e) {
        strips.forEach((o) => o.g.setAttribute('opacity', seg(e, o.t, 300)));
        threads.forEach((th) => th.el.setAttribute('stroke-dashoffset', 1 - inOut(seg(e, 300 + th.t, 1300))));
      },
    };
  }, 'hourglass');
}

// ================================================================ DAY LINE: a month of daily values, every day a dot
/** dayLine(el, { days: [{ date: 'YYYY-MM-DD', value }], highlight: 'last' | 'max' | index, format, height: 300 }) */
export function dayLine(host, cfg) {
  return mount(host, cfg, (plot, c, ctx) => {
    const P = palette(ctx.fig);
    const W = widthOf(plot, c), H = c.height ?? 300;
    const fmt = formatter(c.format);
    const days = (c.days ?? []).map((d) => { const t = Date.parse(`${String(d.date).slice(0, 10)}T00:00:00Z`); const wd = new Date(t).getUTCDay(); return { t, v: Number(d.value) || 0, weekend: wd === 0 || wd === 6 }; });
    const n = days.length;
    const lo = Math.min(...days.map((d) => d.v)), hi = Math.max(...days.map((d) => d.v));
    const pad = (hi - lo || 1) * 0.15;
    const m = { l: 10, r: 40, t: 34, b: 44 };
    const x = (i) => m.l + (i / Math.max(1, n - 1)) * (W - m.l - m.r);
    const y = (v) => m.t + (1 - (v - (lo - pad)) / (hi - lo + pad * 2 || 1)) * (H - m.t - m.b);
    const floor = H - m.b + 10;
    const svg = canvas(plot, W, H);
    const dayF = new Intl.DateTimeFormat(lang(), { month: 'short', day: 'numeric', timeZone: 'UTC' });
    const dayW = new Intl.DateTimeFormat(lang(), { month: 'short', day: 'numeric', weekday: 'short', timeZone: 'UTC' });
    S('line', { x1: m.l - 4, x2: W - m.r + 4, y1: floor, y2: floor, stroke: P.soft }, svg);
    const labelEvery = Math.max(1, Math.round(n / (W < 560 ? 3 : 5)));
    days.forEach((d, i) => {
      S('line', { x1: x(i), x2: x(i), y1: floor, y2: floor + (i % 7 === 0 ? 7 : 4), stroke: d.weekend ? P.soft : P.mid }, svg);
      if (i % labelEvery === 0 || i === n - 1) T(svg, x(i), floor + 20, dayF.format(new Date(d.t)), { 'font-size': 10.5, 'text-anchor': i === n - 1 ? 'end' : i === 0 ? 'start' : 'middle', fill: P.muted }, 'mono');
    });
    const line = S('path', { fill: 'none', stroke: P.text, 'stroke-width': 1.6, 'stroke-linejoin': 'round' }, svg);
    const dots = days.map((d, i) => S('circle', { cx: x(i), cy: y(d.v), r: 3, fill: d.weekend ? P.paper : P.text, stroke: P.text, 'stroke-width': 1.2, opacity: 0 }, svg));
    const peak = days.reduce((b, d, i) => (d.v > days[b].v ? i : b), 0);
    const hero = c.highlight === 'max' ? peak : typeof c.highlight === 'number' ? c.highlight : n - 1;
    const marks = S('g', { opacity: 0 }, svg);
    [...new Set([peak, hero])].forEach((i) => {
      const isHero = i === hero;
      if (isHero) { hexRing(marks, x(i), y(days[i].v), 6, P.accent); S('circle', { cx: x(i), cy: y(days[i].v), r: 4, fill: P.accent }, marks); }
      else S('circle', { cx: x(i), cy: y(days[i].v), r: 4.2, fill: P.text }, marks);
      T(marks, x(i), y(days[i].v) - 14, fmt(days[i].v), { 'font-size': 12, 'text-anchor': i === n - 1 ? 'end' : 'middle', fill: isHero ? P.accent : P.text }, 'num');
    });
    // there is no axis, so the lowest day is named too: with the peak it gives the range
    const low = days.reduce((b, d, i) => (d.v < days[b].v ? i : b), 0);
    if (n > 2 && low !== peak && low !== hero && days[low].v !== days[peak].v) {
      T(marks, x(low), y(days[low].v) + 19, fmt(days[low].v), { 'font-size': 11, 'text-anchor': low === n - 1 ? 'end' : low === 0 ? 'start' : 'middle', fill: P.sec }, 'num');
    }
    const tag = tagFor(plot);
    const cross = S('line', { y1: m.t - 10, y2: floor, stroke: P.text, opacity: 0 }, svg);
    svg.addEventListener('pointermove', (ev) => {
      if (!ctx.played || !n) return;
      const b = svg.getBoundingClientRect();
      const i = clamp(Math.round(((ev.clientX - b.left - m.l) / (W - m.l - m.r)) * (n - 1)), 0, n - 1);
      cross.setAttribute('x1', x(i)); cross.setAttribute('x2', x(i)); cross.setAttribute('opacity', 0.35);
      tag.show(x(i), y(days[i].v), dayW.format(new Date(days[i].t)), [['', fmt(days[i].v)]]);
    });
    svg.addEventListener('pointerleave', () => { cross.setAttribute('opacity', 0); tag.hide(); });
    const DUR = 1800;
    return {
      dur: DUR + 500,
      frame(e) {
        const f = inOut(seg(e, 0, DUR)) * Math.max(0, n - 1);
        const k = Math.floor(f), fr = f - k;
        const pts = days.slice(0, k + 1).map((d, i) => [x(i), y(d.v)]);
        if (k < n - 1) pts.push([x(k) + (x(k + 1) - x(k)) * fr, y(days[k].v + (days[k + 1].v - days[k].v) * fr)]);
        line.setAttribute('d', pts.length ? 'M' + pts.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('L') : '');
        dots.forEach((d, i) => d.setAttribute('opacity', i <= f + 0.01 ? 1 : 0));
        marks.setAttribute('opacity', seg(e, DUR - 100, 400));
      },
    };
  }, 'dayline');
}

// ================================================================ TICK RING: a whole as 100 ticks around a dial
/** tickRing(el, { items: [{ name, value }], highlight: i, centerValue, centerLabel, format }) */
export function tickRing(host, cfg) {
  return mount(host, cfg, (plot, c, ctx) => {
    const P = palette(ctx.fig);
    const W = widthOf(plot, c);
    const items = (c.items ?? []).map((it) => ({ name: String(it.name), v: Number(it.value) || 0 }));
    const cells = apportion(items.map((i) => i.v), 100);
    const fmt = formatter(c.format);
    const total = items.reduce((a, i) => a + i.v, 0);
    const narrow = W < 480;
    const ringH = c.height ?? 320;
    const H = ringH + (narrow ? items.length * 22 + 10 : 0);
    const cx = W / 2, cy = ringH / 2, R = narrow ? Math.min(W / 2 - 16, ringH / 2 - 20) : Math.min(W / 2 - 110, ringH / 2 - 30);
    const fills = items.map((_, k) => (k === c.highlight ? P.accent : ladder(P, k - (c.highlight !== undefined && k > c.highlight ? 1 : 0), items.length)));
    const svg = canvas(plot, W, H);
    const owner = [];
    cells.forEach((n2, k) => { for (let i = 0; i < n2; i++) owner.push(k); });
    const groups = items.map(() => S('g', { class: 'ar-dimmable' }, svg));
    const ticks = owner.map((k, i) => {
      const a = (i / 100) * 2 * Math.PI - Math.PI / 2, long = i % 10 === 0;
      const r1 = R - (long ? 20 : 14);
      return { el: S('line', { x1: cx + r1 * Math.cos(a), y1: cy + r1 * Math.sin(a), x2: cx + R * Math.cos(a), y2: cy + R * Math.sin(a), stroke: P.soft, 'stroke-width': 2, 'stroke-linecap': 'round' }, groups[k]), k, t: i * 13 };
    });
    let acc = 0;
    const labels = S('g', { opacity: 0 }, svg);
    items.forEach((it, k) => {
      const midA = ((acc + cells[k] / 2) / 100) * 2 * Math.PI - Math.PI / 2;
      acc += cells[k];
      if (narrow) {
        const ly = ringH + 6 + k * 22;
        S('rect', { x: 0, y: ly - 8, width: 10, height: 3, fill: fills[k] }, labels);
        T(labels, 16, ly - 2, it.name, { 'font-size': 12, fill: P.body }, 'label');
        T(labels, W, ly - 2, `${cells[k]}%`, { 'font-size': 12, fill: k === c.highlight ? P.accent : P.text, 'text-anchor': 'end' }, 'num');
        return;
      }
      const ex = cx + (R + 10) * Math.cos(midA), ey = cy + (R + 10) * Math.sin(midA);
      const right = Math.cos(midA) >= 0;
      const lx = cx + (R + 34) * Math.cos(midA) + (right ? 8 : -8);
      S('path', { d: `M${ex.toFixed(1)},${ey.toFixed(1)}L${(cx + (R + 30) * Math.cos(midA)).toFixed(1)},${(cy + (R + 30) * Math.sin(midA)).toFixed(1)}L${lx.toFixed(1)},${(cy + (R + 30) * Math.sin(midA)).toFixed(1)}`, fill: 'none', stroke: P.soft }, labels);
      T(labels, lx + (right ? 4 : -4), cy + (R + 30) * Math.sin(midA) + 4, `${it.name} · ${cells[k]}`, { 'font-size': 10.5, fill: k === c.highlight ? P.text : P.sec, 'text-anchor': right ? 'start' : 'end', 'font-weight': k === c.highlight ? 600 : 400 }, 'mono');
    });
    const big = T(svg, cx, cy + 6, c.centerValue ?? fmt(total), { 'font-size': 32, 'text-anchor': 'middle', fill: P.text, style: 'letter-spacing:-.03em' }, 'num');
    if (c.centerLabel) T(svg, cx, cy + 26, c.centerLabel, { 'font-size': 10, 'text-anchor': 'middle', fill: P.muted }, 'mono');
    void big;
    const tag = tagFor(plot);
    items.forEach((it, k) => {
      groups[k].addEventListener('pointerenter', () => { if (!ctx.played) return; spotlight(groups, k); tag.show(cx + R, cy, it.name, [['', `${cells[k]}%`], ['', '', fmt(it.v)]]); });
      groups[k].addEventListener('pointerleave', () => { spotlight(groups, null); tag.hide(); });
    });
    return {
      dur: 100 * 13 + 600,
      frame(e) {
        ticks.forEach((o) => o.el.setAttribute('stroke', seg(e, o.t, 120) >= 1 ? fills[o.k] : P.soft));
        labels.setAttribute('opacity', seg(e, 1200, 400));
      },
    };
  }, 'ring');
}

// ================================================================ CONVERGE: many items pulled toward a few themes, every item kept
/** convergeChart(el, { items: [{ name, group }], groups: [names] (order), highlight: groupName, height }) */
export function convergeChart(host, cfg) {
  return mount(host, cfg, (plot, c, ctx) => {
    const P = palette(ctx.fig);
    const W = widthOf(plot, c), H = c.height ?? Math.min(520, Math.max(360, W * 0.7));
    const items = (c.items ?? []).map((it) => ({ name: String(it.name), group: String(it.group) }));
    const groups = c.groups ?? [...new Set(items.map((i) => i.group))];
    // rim order: grouped, so each theme's lines leave from one arc
    items.sort((a, b) => groups.indexOf(a.group) - groups.indexOf(b.group));
    const n = items.length;
    const cx = W / 2, cy = H / 2, R = Math.min(W, H) / 2 - 46, hubR = R * 0.32;
    const svg = canvas(plot, W, H);
    const counts = groups.map((g) => items.filter((i) => i.group === g).length);
    // each hub sits toward the middle of its arc
    let acc = 0;
    const hubs = groups.map((g, k) => {
      const midA = ((acc + counts[k] / 2) / n) * 2 * Math.PI - Math.PI / 2;
      acc += counts[k];
      return { g, a: midA, x: cx + hubR * Math.cos(midA), y: cy + hubR * Math.sin(midA) };
    });
    const tag = tagFor(plot);
    const lineG = S('g', {}, svg), rimG = S('g', {}, svg), hubG = S('g', {}, svg);
    const lines = items.map((it, i) => {
      const a = (i / n) * 2 * Math.PI - Math.PI / 2;
      const px = cx + R * Math.cos(a), py = cy + R * Math.sin(a);
      const h = hubs[groups.indexOf(it.group)];
      const hero = it.group === c.highlight;
      const el = S('path', { d: `M${px.toFixed(1)},${py.toFixed(1)}Q${((px + cx) / 2).toFixed(1)},${((py + cy) / 2).toFixed(1)} ${h.x.toFixed(1)},${h.y.toFixed(1)}`, fill: 'none', stroke: hero ? P.accent : P.mid, 'stroke-width': hero ? 1.1 : 0.8, 'stroke-opacity': hero ? 0.8 : 0.45, pathLength: 1, 'stroke-dasharray': 1, 'stroke-dashoffset': 1, class: 'ar-dimmable' }, lineG);
      const dot = S('circle', { cx: px, cy: py, r: 2.4, fill: hero ? P.accent : P.strong, class: 'ar-dimmable' }, rimG);
      const deg = (a * 180) / Math.PI, flip = Math.cos(a) < 0;
      const lx = cx + (R + 7) * Math.cos(a), ly = cy + (R + 7) * Math.sin(a);
      const label = T(rimG, lx, ly + 3, it.name, { 'font-size': 9, fill: P.muted, 'text-anchor': flip ? 'end' : 'start', transform: `rotate(${flip ? deg + 180 : deg} ${lx} ${ly})`, class: 'ar-dimmable' }, 'mono');
      const hit = S('circle', { cx: px, cy: py, r: 7, fill: 'transparent' }, rimG);
      hit.addEventListener('pointerenter', () => { if (ctx.played) tag.show(px, py, it.name, [['', it.group]]); });
      hit.addEventListener('pointerleave', () => tag.hide());
      return { el, dot, label, k: groups.indexOf(it.group), t: groups.indexOf(it.group) * 260 + (i % 12) * 30 };
    });
    const hubEls = hubs.map((h, k) => {
      const hero = h.g === c.highlight;
      const g = S('g', { opacity: 0 }, hubG);
      S('path', { d: hexPath(5 + Math.sqrt(counts[k]) * 1.6), transform: `translate(${h.x},${h.y})`, fill: hero ? P.accent : P.strong, stroke: P.paper, 'stroke-width': 1.5 }, g);
      const out = Math.cos(h.a) >= 0;
      T(g, h.x + (out ? 14 : -14), h.y + 4, `${h.g} · ${counts[k]}`, { 'font-size': 11, 'font-weight': 600, fill: hero ? P.accent : P.text, 'text-anchor': out ? 'start' : 'end', 'paint-order': 'stroke', stroke: P.paper, 'stroke-width': 3 }, 'mono');
      const hit = S('circle', { cx: h.x, cy: h.y, r: 18, fill: 'transparent' }, g);
      const on = () => { if (!ctx.played) return; lines.forEach((l) => [l.el, l.dot, l.label].forEach((e) => e.classList.toggle('is-dim', l.k !== k))); };
      const off = () => lines.forEach((l) => [l.el, l.dot, l.label].forEach((e) => e.classList.remove('is-dim')));
      hit.addEventListener('pointerenter', on); hit.addEventListener('pointerleave', off);
      return g;
    });
    return {
      dur: groups.length * 260 + 1400,
      frame(e) {
        lines.forEach((l) => l.el.setAttribute('stroke-dashoffset', 1 - inOut(seg(e, l.t, 800))));
        hubEls.forEach((g, k) => g.setAttribute('opacity', seg(e, k * 260 + 600, 300)));
      },
    };
  }, 'converge');
}

// ================================================================ COLONNADE: who owns what, with every name listed
/** colonnadeChart(el, { groups: [{ name, items: [names] }], highlight: groupName, sort: true }) */
export function colonnadeChart(host, cfg) {
  return mount(host, cfg, (plot, c, ctx) => {
    const P = palette(ctx.fig);
    const W = widthOf(plot, c);
    let groups = (c.groups ?? []).map((g) => ({ name: String(g.name), items: g.items.map(String) }));
    if (c.sort !== false) groups.sort((a, b) => b.items.length - a.items.length);
    const n = groups.length;
    const colW = Math.max(64, (W - 4) / Math.max(1, n));
    const perRow = Math.max(1, Math.floor(W / colW));
    const rowsOfCols = Math.ceil(n / perRow);
    const lineH = 15, headH = 44;
    const maxItems = (from) => Math.max(...groups.slice(from, from + perRow).map((g) => g.items.length), 1);
    const bands = Array.from({ length: rowsOfCols }, (_, r) => headH + maxItems(r * perRow) * lineH + 24);
    const H = bands.reduce((a, b) => a + b, 0) + 6;
    const svg = canvas(plot, W, H);
    const tag = tagFor(plot);
    const all = [];
    const cols = groups.map((g, k) => {
      const r = Math.floor(k / perRow), cpos = k % perRow;
      const x0 = cpos * colW + 2, y0 = bands.slice(0, r).reduce((a, b) => a + b, 0);
      const hero = g.name === c.highlight;
      const col = S('g', { class: 'ar-dimmable' }, svg);
      T(col, x0, y0 + 16, String(g.items.length), { 'font-size': 18, fill: hero ? P.accent : P.text }, 'num');
      T(col, x0, y0 + 32, g.name, { 'font-size': 11.5, fill: hero ? P.text : P.sec, 'font-weight': hero ? 600 : 400 });
      S('line', { x1: x0, x2: x0 + colW - 12, y1: y0 + 40, y2: y0 + 40, stroke: hero ? P.accent : P.soft }, col);
      g.items.forEach((name, i) => {
        const ry = y0 + headH + 6 + i * lineH;
        const row = S('g', { opacity: 0 }, col);
        S('path', { d: hexPath(2.6), transform: `translate(${x0 + 3},${ry - 3.5})`, fill: hero ? P.accent : P.mid }, row);
        T(row, x0 + 10, ry, fitLabel(name, colW - 22, 10.5), { 'font-size': 10.5, fill: P.body });
        all.push({ el: row, t: k * 90 + i * 45 });
        const hit = S('rect', { x: x0, y: ry - 11, width: colW - 8, height: lineH, fill: 'transparent' }, col);
        hit.addEventListener('pointerenter', () => { if (ctx.played) tag.show(x0 + colW - 10, ry - 4, name, [['', g.name]]); });
        hit.addEventListener('pointerleave', () => tag.hide());
      });
      return col;
    });
    cols.forEach((col, k) => {
      col.addEventListener('pointerenter', () => { if (ctx.played) spotlight(cols, k); });
      col.addEventListener('pointerleave', () => spotlight(cols, null));
    });
    const last = Math.max(0, ...all.map((o) => o.t));
    return {
      dur: last + 400,
      frame(e) { all.forEach((o) => { const p = outCubic(seg(e, o.t, 260)); o.el.setAttribute('opacity', p); o.el.setAttribute('transform', `translate(0,${((1 - p) * -6).toFixed(1)})`); }); },
    };
  }, 'colonnade');
}
function fitLabel(text, max, size) {
  if (textWidth(text, size) <= max) return text;
  let k = text.length;
  while (k > 1 && textWidth(`${text.slice(0, k)}…`, size) > max) k--;
  return `${text.slice(0, k)}…`;
}

// ================================================================ BALLOT: multiple-choice shares as tally marks (five to a group)
/** ballotChart(el, { items: [{ name, value: 0..1 }], respondents, highlight: i | name, sort: true, tally: 'zheng' | 'gate' (default: 正 on Chinese pages) }) */
export function ballotChart(host, cfg) {
  return mount(host, cfg, (plot, c, ctx) => {
    const P = palette(ctx.fig);
    const W = widthOf(plot, c);
    let items = (c.items ?? []).map((it) => ({ name: String(it.name), v: clamp(Number(it.value) || 0) }));
    if (c.sort !== false) items.sort((a, b) => b.v - a.v);
    const hero = typeof c.highlight === 'number' ? c.highlight : items.findIndex((i) => i.name === c.highlight);
    const nameW = Math.min(150, Math.max(...items.map((i) => textWidth(i.name, 13)), 40) + 16), valW = 54;
  // a group (one 正 or one gate) is at least 14px wide; on narrow screens the groups wrap onto a second line
    const maxGroups = Math.max(1, Math.ceil(Math.max(...items.map((i) => Math.round(i.v * 100))) / 5));
    const perLine = Math.max(4, Math.min(maxGroups, Math.floor((W - nameW - valW) / 16)));
    const groupW = Math.min(24, (W - nameW - valW) / perLine);
    const markGap = groupW / 6;
    const lines = Math.ceil(maxGroups / perLine);
    const rowH = 16 + lines * 22;
    const H = items.length * rowH + 10;
    const svg = canvas(plot, W, H);
    const tag = tagFor(plot);
    const strokes = [];
    const rows = items.map((it, k) => {
      const g = S('g', { class: 'ar-dimmable' }, svg);
      const y = 8 + k * rowH, isHero = k === hero;
      const color = isHero ? P.accent : P.strong;
      T(g, 0, y + 17, it.name, { 'font-size': 13, fill: isHero ? P.text : P.body, 'font-weight': isHero ? 600 : 400 });
      const marks = Math.round(it.v * 100);
      const zheng = (c.tally ?? (lang().startsWith('zh') ? 'zheng' : 'gate')) === 'zheng';
      for (let m = 0; m < marks; m++) {
        const grpAll = Math.floor(m / 5), j = m % 5, grp = grpAll % perLine, ln = Math.floor(grpAll / perLine), gx = nameW + grp * groupW;
        const y0 = y + ln * 22;
        let seg5;
        if (zheng) {
          // 正, stroke by stroke: top bar, middle upright, short bar right, left upright, bottom bar
          const w = groupW - 6, l = gx + 1, r2 = l + w, mx = l + w / 2, t = y0 + 6, b = y0 + 22, mid2 = y0 + 14;
          seg5 = [[l, t, r2, t], [mx, t, mx, b], [mx, mid2, r2 - 1, mid2], [l + 2, mid2 - 1, l + 2, b], [l - 1, b, r2 + 1, b]][j];
        } else {
          // four uprights, then a slash across them
          seg5 = j < 4 ? [gx + (j + 0.5) * markGap, y0 + 6, gx + (j + 0.5) * markGap, y0 + 22] : [gx - 0.5, y0 + 19, gx + 4.5 * markGap, y0 + 9];
        }
        const el = S('line', { x1: seg5[0], y1: seg5[1], x2: seg5[2], y2: seg5[3], stroke: color, 'stroke-width': 1.3, 'stroke-linecap': 'round', opacity: 0 }, g);
        strokes.push({ el, t: k * 120 + m * 14 });
      }
      T(g, W, y + 18, pct(it.v), { 'font-size': 15, fill: isHero ? P.accent : P.text, 'text-anchor': 'end' }, 'num');
      const hit = S('rect', { x: 0, y, width: W, height: rowH, fill: 'transparent' }, svg);
      hit.addEventListener('pointerenter', () => {
        if (!ctx.played) return;
        spotlight(rows, k);
        tag.show(nameW + Math.min(perLine, marks / 5) * groupW, y + 14, it.name, [['', pct(it.v)], ...(c.respondents ? [['', '', msg('of', { a: Math.round(it.v * c.respondents), b: c.respondents })]] : [])]);
      });
      hit.addEventListener('pointerleave', () => { spotlight(rows, null); tag.hide(); });
      return g;
    });
    const last = Math.max(0, ...strokes.map((s) => s.t));
    return {
      dur: last + 300,
      frame(e) { strokes.forEach((s) => s.el.setAttribute('opacity', seg(e, s.t, 90))); },
    };
  }, 'ballot');
}

// ================================================================ RAIN: what goes in hangs from the top, what comes out rises from the floor
/**
 * rainChart(el, { labels: [...], tickLabels, input: { name, values, format }, output: { name, values, format }, highlight: index (an input), lag: 0 (periods until the output answers), height: 340 })
 * Two measures on one time axis without a second y-axis: two bands, each with its own scale.
 */
export function rainChart(host, cfg) {
  return mount(host, cfg, (plot, c, ctx) => {
    const P = palette(ctx.fig);
    const W = widthOf(plot, c), H = c.height ?? 340;
    const labels = (c.labels ?? []).map(String);
    const n = labels.length;
    const inp = (c.input?.values ?? []).map(Number), out = (c.output?.values ?? []).map(Number);
    const fi = formatter(c.input?.format ?? c.format), fo = formatter(c.output?.format ?? c.format);
    const m = { l: 6, r: 70, t: 18, b: 34 };
    const band = (H - m.t - m.b - 30) / 2;
    const x = (i) => m.l + ((i + 0.5) / Math.max(1, n)) * (W - m.l - m.r);
    const bw = Math.max(2, ((W - m.l - m.r) / Math.max(1, n)) * 0.42);
    const maxI = Math.max(...inp, 1), maxO = Math.max(...out, 1) * 1.1;
    const yi = (v) => m.t + (v / maxI) * band;
    const floor = H - m.b;
    const yo = (v) => floor - (v / maxO) * band;
    const svg = canvas(plot, W, H);
    S('line', { x1: m.l, x2: W - m.r + 6, y1: m.t, y2: m.t, stroke: P.soft }, svg);
    S('line', { x1: m.l, x2: W - m.r + 6, y1: floor, y2: floor, stroke: P.soft }, svg);
    T(svg, W - m.r + 12, m.t + 4, c.input?.name ?? '', { 'font-size': 10.5, fill: P.sec }, 'mono');
    T(svg, W - m.r + 12, m.t + 18, `↓ ${fi(maxI)}`, { 'font-size': 10, fill: P.muted }, 'mono');
    T(svg, W - m.r + 12, floor - 18, c.output?.name ?? '', { 'font-size': 10.5, fill: P.sec }, 'mono');
    T(svg, W - m.r + 12, floor - 4, `↑ ${fo(maxO / 1.1)}`, { 'font-size': 10, fill: P.muted }, 'mono');
    const every = Math.max(1, Math.round(n / 6));
    labels.forEach((l, i) => { const tl = c.tickLabels ? c.tickLabels[i] : i % every === 0 ? l : ''; if (tl) T(svg, x(i), H - 12, tl, { 'font-size': 10.5, 'text-anchor': 'middle', fill: P.muted }, 'mono'); });
    const drops = inp.map((v, i) => S('rect', { x: x(i) - bw / 2, y: m.t, width: bw, height: 0, rx: Math.min(2, bw / 2), fill: i === c.highlight ? P.accent : P.mid }, svg));
    const clip = revealClip(svg, H);
    const area = S('path', { d: `${smooth(out.map((v, i) => [x(i), yo(v)]))}L${x(n - 1)},${floor}L${x(0)},${floor}Z`, fill: P.strong, 'fill-opacity': 0.12, 'clip-path': `url(#${clip.id})` }, svg);
    S('path', { d: smooth(out.map((v, i) => [x(i), yo(v)])), fill: 'none', stroke: P.text, 'stroke-width': 2, 'clip-path': `url(#${clip.id})` }, svg);
    void area;
    const marks = S('g', { opacity: 0 }, svg);
    if (typeof c.highlight === 'number' && out[c.highlight + (c.lag ?? 0)] !== undefined) {
      const h = c.highlight, o = h + (c.lag ?? 0);
      hexRing(marks, x(o), yo(out[o]), 6, P.accent);
      S('path', { d: `M${x(h)},${yi(inp[h]) + 4}C${x(h)},${(yi(inp[h]) + yo(out[o])) / 2} ${x(o)},${(yi(inp[h]) + yo(out[o])) / 2} ${x(o)},${yo(out[o]) - 10}`, fill: 'none', stroke: P.accent, 'stroke-dasharray': '1 3' }, marks);
    }
    const tag = tagFor(plot);
    const cross = S('line', { y1: m.t, y2: floor, stroke: P.text, opacity: 0 }, svg);
    svg.addEventListener('pointermove', (ev) => {
      if (!ctx.played || !n) return;
      const b = svg.getBoundingClientRect();
      const i = clamp(Math.floor(((ev.clientX - b.left - m.l) / (W - m.l - m.r)) * n), 0, n - 1);
      cross.setAttribute('x1', x(i)); cross.setAttribute('x2', x(i)); cross.setAttribute('opacity', 0.3);
      tag.show(x(i), H / 2, labels[i], [[c.input?.name ?? '', fi(inp[i])], [c.output?.name ?? '', fo(out[i])]]);
    });
    svg.addEventListener('pointerleave', () => { cross.setAttribute('opacity', 0); tag.hide(); });
    const DUR = 1800;
    return {
      dur: DUR + 500,
      frame(e) {
        drops.forEach((d, i) => d.setAttribute('height', ((yi(inp[i]) - m.t) * outCubic(seg(e, (i / Math.max(1, n)) * DUR * 0.8, 360))).toFixed(1)));
        clip.rect.setAttribute('width', (W + 40) * inOut(seg(e, 200, DUR)));
        marks.setAttribute('opacity', seg(e, DUR, 400));
      },
    };
  }, 'rain');
}

// ================================================================ TREE: a hierarchy left to right
/** treeChart(el, { root: { name, children: [...] }, highlight: nodeName, height }) — leaves are spaced evenly; a node's value, if given, sizes its dot */
export function treeChart(host, cfg) {
  return mount(host, cfg, (plot, c, ctx) => {
    const P = palette(ctx.fig);
    const W = widthOf(plot, c);
    const nodes = [];
    const walk = (node, depth, parent) => {
      const me = { name: String(node.name), depth, parent, kids: [], v: node.value };
      nodes.push(me);
      (node.children ?? []).forEach((ch) => me.kids.push(walk(ch, depth + 1, me)));
      return me;
    };
    const root = walk(c.root ?? { name: '' }, 0, null);
    const leaves = nodes.filter((n) => !n.kids.length);
    const depth = Math.max(...nodes.map((n) => n.depth));
    const rowH = 21, H = c.height ?? Math.max(160, leaves.length * rowH + 20);
    leaves.forEach((l, i) => (l.y = 10 + i * ((H - 20) / Math.max(1, leaves.length - 1))));
    const setY = (n) => { if (n.kids.length) { n.kids.forEach(setY); n.y = (n.kids[0].y + n.kids.at(-1).y) / 2; } };
    setY(root);
    const leafW = Math.max(...leaves.map((l) => textWidth(l.name, 11.5)), 30) + 16;
    const rootW = textWidth(root.name, 13) + 20;
    const x = (d) => rootW + (d / Math.max(1, depth)) * (W - rootW - leafW);
    const svg = canvas(plot, W, H);
    const heroNode = nodes.find((n) => n.name === c.highlight);
    const onPath = new Set();
    for (let n = heroNode; n; n = n.parent) onPath.add(n);
    const sub = (n, set = new Set()) => { set.add(n); n.kids.forEach((k) => sub(k, set)); return set; };
    const links = nodes.filter((n) => n.parent).map((n) => {
      const p = n.parent, mx = (x(p.depth) + x(n.depth)) / 2;
      const hero = heroNode && onPath.has(n) || (heroNode && sub(heroNode).has(n));
      return { n, el: S('path', { d: `M${x(p.depth)},${p.y}C${mx},${p.y} ${mx},${n.y} ${x(n.depth)},${n.y}`, fill: 'none', stroke: hero ? P.accent : P.depthInk?.[n.depth] ?? ladder(P, n.depth - 1, depth + 1), 'stroke-width': hero ? 1.6 : 1.2, pathLength: 1, 'stroke-dasharray': 1, 'stroke-dashoffset': 1, class: 'ar-dimmable' }, svg) };
    });
    const tag = tagFor(plot);
    const dots = nodes.map((n) => {
      const hero = heroNode && (onPath.has(n) || sub(heroNode).has(n));
      const g = S('g', { opacity: 0, class: 'ar-dimmable' }, svg);
      S('circle', { cx: x(n.depth), cy: n.y, r: n.depth === 0 ? 4.5 : n.kids.length ? 3.6 : 3, fill: hero ? P.accent : n.kids.length ? P.text : P.mid, stroke: P.paper, 'stroke-width': 1.5 }, g);
      const leaf = !n.kids.length;
      T(g, x(n.depth) + (leaf ? 8 : n.depth === 0 ? -9 : -7), n.y + (leaf || n.depth === 0 ? 4 : -7), n.name, { 'font-size': n.depth === 0 ? 13 : 11.5, 'text-anchor': leaf ? 'start' : 'end', fill: hero ? P.text : leaf ? P.sec : P.text, 'font-weight': leaf ? 400 : 600, 'paint-order': 'stroke', stroke: P.paper, 'stroke-width': 3 });
      const hit = S('circle', { cx: x(n.depth), cy: n.y, r: 10, fill: 'transparent' }, g);
      hit.addEventListener('pointerenter', () => {
        if (!ctx.played) return;
        const keep = sub(n); for (let p = n.parent; p; p = p.parent) keep.add(p);
        links.forEach((l) => l.el.classList.toggle('is-dim', !keep.has(l.n)));
        dots.forEach((d) => d.g.classList.toggle('is-dim', !keep.has(d.n)));
        const leavesUnder = [...sub(n)].filter((k) => !k.kids.length).length;
        tag.show(x(n.depth), n.y, n.name, n.kids.length ? [['', String(leavesUnder)]] : []);
      });
      hit.addEventListener('pointerleave', () => { links.forEach((l) => l.el.classList.remove('is-dim')); dots.forEach((d) => d.g.classList.remove('is-dim')); tag.hide(); });
      return { g, n };
    });
    const step = 520;
    return {
      dur: (depth + 1) * step + 500,
      frame(e) {
        links.forEach((l) => l.el.setAttribute('stroke-dashoffset', 1 - inOut(seg(e, (l.n.depth - 1) * step + 100, step))));
        dots.forEach((d) => d.g.setAttribute('opacity', seg(e, d.n.depth * step, 300)));
      },
    };
  }, 'tree-lr');
}

// ================================================================ TICK ROWS: a ranking you can count, one tick per unit, names on the left
/** tickRows(el, { items: [{ name, value }], unit: 1, sort: true, highlight: 'max' | name | false, format }) */
export function tickRows(host, cfg) {
  return mount(host, cfg, (plot, c, ctx) => {
    const P = palette(ctx.fig);
    const W = widthOf(plot, c);
    const fmt = formatter(c.format);
    let items = (c.items ?? []).map((it) => ({ name: String(it.name), v: Number(it.value) || 0 }));
    if (c.sort !== false) items.sort((a, b) => b.v - a.v);
    const nameW = Math.min(160, Math.max(...items.map((i) => textWidth(i.name, 12.5)), 40) + 16), valW = 64;
    const maxN = Math.max(...items.map((i) => i.v), 1);
    const unit = c.unit ?? Math.max(1, niceUnit(maxN / 60));
    const step = Math.min(7, (W - nameW - valW) / Math.max(1, Math.ceil(maxN / unit)));
    const rowH = 30;
    const H = items.length * rowH + 8;
    const hero = c.highlight === false ? -1 : c.highlight && c.highlight !== 'max' ? items.findIndex((i) => i.name === c.highlight) : 0;
    const svg = canvas(plot, W, H);
    const tag = tagFor(plot);
    const all = [];
    const rows = items.map((it, k) => {
      const g = S('g', { class: 'ar-dimmable' }, svg);
      const y = 6 + k * rowH, isHero = k === hero;
      T(g, nameW - 12, y + 15, it.name, { 'font-size': 12.5, 'text-anchor': 'end', fill: isHero ? P.text : P.body, 'font-weight': isHero ? 600 : 400 });
      const count = Math.round(it.v / unit);
      for (let i = 0; i < count; i++) {
        const tall = (i + 1) % 5 === 0;
        all.push({ el: S('line', { x1: nameW + i * step + 1, x2: nameW + i * step + 1, y1: y + (tall ? 3 : 6), y2: y + 20, stroke: isHero ? P.accent : P.strong, 'stroke-width': 1.4, 'stroke-linecap': 'round', opacity: 0 }, g), t: k * 80 + i * 16 });
      }
      T(g, nameW + count * step + 8, y + 16, fmt(it.v), { 'font-size': 13, fill: isHero ? P.accent : P.text }, 'num');
      const hit = S('rect', { x: 0, y, width: W, height: rowH, fill: 'transparent' }, svg);
      hit.addEventListener('pointerenter', () => { if (!ctx.played) return; spotlight(rows, k); tag.show(nameW + count * step + 40, y + 12, it.name, [['', fmt(it.v)], ['', '', msg('cells', { n: count })]]); });
      hit.addEventListener('pointerleave', () => { spotlight(rows, null); tag.hide(); });
      return g;
    });
    const last = Math.max(0, ...all.map((o) => o.t));
    return { dur: last + 300, frame(e) { all.forEach((o) => o.el.setAttribute('opacity', seg(e, o.t, 100))); } };
  }, 'tickrows');
}

// ================================================================ PAIRED RUNGS: two ladders per period, one rung = one unit
/**
 * pairedRungs(el, { labels: [...], tickLabels?: [...] ('' to skip), series: [{ name, values }, { name, values }],
 *   unit (value per rung), highlight: 'last' | 'max' | index, format, height: 240 })
 * Two measures per period, side by side: the first (the comparison: last year, the cost, day 1) as a faint ladder, the
 * second (the one the page is about) in ink. Each rung is one unit, so both can be counted; every fifth is drawn darker.
 * The highlighted period's ink ladder turns orange.
 */
export function pairedRungs(host, cfg) {
  return mount(host, cfg, (plot, c, ctx) => {
    const P = palette(ctx.fig);
    const W = widthOf(plot, c), H = c.height ?? 240;
    const fmt = formatter(c.format);
    const labels = (c.labels ?? c.categories ?? []).map(String);
    const n = labels.length;
    const pair = (c.series ?? []).slice(0, 2).map((s) => ({ name: String(s.name), v: labels.map((_, i) => Math.max(0, Number(s.values?.[i]) || 0)) }));
    if (pair.length === 1) pair.unshift({ name: '', v: labels.map(() => 0) });
    const [base, main] = pair;
    const m = { t: 30, b: 30 };
    const plotH = H - m.t - m.b, floor = H - m.b;
    const max = Math.max(1, ...base.v, ...main.v);
    // a rung needs at least 3px of its own, so the unit grows until the tallest ladder fits
    const unit = c.unit ?? niceUnit(max / Math.max(8, Math.floor(plotH / 3.2)));
    const gap = Math.min(6, plotH / Math.max(1, Math.ceil(max / unit)));
    const colW = W / Math.max(1, n);
    const lw = Math.max(3, Math.min(16, colW * 0.3)), between = Math.max(1.5, Math.min(4, colW * 0.06));
    const peak = main.v.reduce((b, v, i) => (v > main.v[b] ? i : b), 0);
    const hero = c.highlight === 'last' ? n - 1 : c.highlight === 'max' ? peak : typeof c.highlight === 'number' ? c.highlight : -1;
    const legend = el('div', 'ar-legend', ctx.controls);
    for (const [s, fill] of [[base, P.ramp[2]], [main, P.strong]]) if (s.name) { const it = el('span', '', legend); el('i', '', it).style.background = fill; it.append(s.name); }
    const svg = canvas(plot, W, H);
    S('line', { x1: 0, x2: W, y1: floor + 0.5, y2: floor + 0.5, stroke: P.soft }, svg);
    const tag = tagFor(plot);
    const all = [];
    // names on the floor never touch: on a narrow chart some are left out
    let freeFrom = -Infinity;
    const cols = labels.map((label, i) => {
      const g = S('g', { class: 'ar-dimmable' }, svg);
      const cx = colW * i + colW / 2;
      const ladders = [[base, cx - between / 2 - lw, P.ramp[2], P.ramp[3]], [main, cx + between / 2, i === hero ? P.accent : P.strong, i === hero ? P.accent : P.text]];
      ladders.forEach(([s, x0, fill, fifth], li) => {
        const count = Math.round(s.v[i] / unit);
        for (let r = 0; r < count; r++) {
          const y = floor - 2 - r * gap;
          all.push({ el: S('line', { x1: x0, x2: x0 + lw, y1: y, y2: y, stroke: (r + 1) % 5 === 0 ? fifth : fill, 'stroke-width': Math.min(1.6, gap * 0.55), opacity: 0 }, g), t: i * 45 + li * 120 + r * 10 });
        }
      });
      const top = floor - 2 - Math.round(main.v[i] / unit) * gap;
      const labelled = i === hero || i === peak || colW >= 44;
      if (labelled) all.push({ el: T(g, cx + between / 2 + lw / 2, top - 7, fmt(main.v[i]), { 'font-size': i === hero ? 12 : 10.5, 'text-anchor': 'middle', fill: i === hero ? P.accent : P.text, opacity: 0 }, 'num'), t: i * 45 + 260 });
      const tl = c.tickLabels ? c.tickLabels[i] : label;
      const tw = String(tl ?? '').length * 6.4;
      if (tl && cx - tw / 2 >= freeFrom) { T(svg, cx, H - 10, tl, { 'font-size': 10.5, 'text-anchor': 'middle', fill: P.muted }, 'mono'); freeFrom = cx + tw / 2 + 10; }
      const hit = S('rect', { x: colW * i, y: 0, width: colW, height: H, fill: 'transparent' }, svg);
      hit.addEventListener('pointerenter', () => {
        if (!ctx.played) return;
        spotlight(cols, i);
        const d = main.v[i] - base.v[i];
        tag.show(cx + lw + 10, top, label, [
          ...(base.name ? [[base.name, fmt(base.v[i])]] : []),
          [main.name, fmt(main.v[i])],
          ...(base.name ? [['', '', `${msg('change')} ${signed(fmt, d)}`]] : []),
        ]);
      });
      hit.addEventListener('pointerleave', () => { spotlight(cols, null); tag.hide(); });
      return g;
    });
    if (!c.note) {
      const foot = ctx.fig.querySelector('.ar-fig__foot');
      if (foot) { const sp = el('span', '', foot, msg('perRung', { unit: fmt(unit) })); foot.prepend(sp); foot.hidden = false; }
    }
    const last = Math.max(0, ...all.map((o) => o.t));
    return { dur: last + 300, frame(e) { all.forEach((o) => o.el.setAttribute('opacity', seg(e, o.t, 120))); } };
  }, 'rungs');
}

// ---------------------------------------------------------------- declarative mounting
const KINDS = {
  stroke: strokeChart, days: dayStrip, hive: hiveColumns, dial: tickDial, pour: pourFunnel, tape: tapeDumbbell, heat: dotHeat,
  morph: rankMap, bump: bumpChart, stream: streamChart, parallel: parallelChart, strip: stripChart, flow: flowChart,
  tree: treemapChart, network: networkChart, hundred: hundredChart, bridge: bridgeChart,
  fan: launchFan, cascade: dotCascade, almanac: almanacChart, clock: dayClock, hourglass: hourglassChart, dayline: dayLine, ring: tickRing,
  converge: convergeChart, colonnade: colonnadeChart, ballot: ballotChart, rain: rainChart, 'tree-lr': treeChart, ticks: tickRows,
  rungs: pairedRungs,
};
/** <div data-aisa-report="hive" data-config='{"items":[…]}'></div> → AisaReport.mountAll(root) (runs on load) */
export function mountAll(root = document) {
  return [...root.querySelectorAll('[data-aisa-report]')].map((node) => {
    if (node.__arChart) return node.__arChart;
    let cfg = {};
    try { cfg = JSON.parse(node.getAttribute('data-config') || node.querySelector('script[type="application/json"]')?.textContent || '{}'); }
    catch (e) { console.warn('[aisa-report] bad data-config on', node, e); }
    const fn = KINDS[node.getAttribute('data-aisa-report')];
    return fn ? fn(node, cfg) : null;
  });
}
const AisaReport = {
  strokeChart, dayStrip, hiveColumns, tickDial, pourFunnel, tapeDumbbell, dotHeat, rankMap, bumpChart, streamChart, parallelChart,
  stripChart, flowChart, treemapChart, networkChart, hundredChart, bridgeChart, launchFan, dotCascade, almanacChart, dayClock,
  hourglassChart, dayLine, tickRing, convergeChart, colonnadeChart, ballotChart, rainChart, treeChart, tickRows, pairedRungs, mountAll, setMessages,
};
if (typeof window !== 'undefined') {
  window.AisaReport = AisaReport;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => mountAll());
  else queueMicrotask(() => mountAll());
}
export default AisaReport;
