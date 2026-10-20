/*
 * AIsa charts — dependency-free SVG charts that follow the AIsa tokens and the house data-viz rules:
 * thin marks (bars ≤ 24px, 4px rounded data-end, 2px lines), 2px surface gaps and rings, hairline solid grid,
 * categorical colours in fixed slot order, a legend for ≥ 2 series, selective direct labels, a hover/focus
 * tooltip on every chart, and a table view as the accessible twin.
 *
 * Use as an ES module:   import { barChart } from './aisa-charts.js'; barChart(el, { ... })
 * or declaratively:      <div data-aisa-chart="bar" data-config='{"categories":[...],"series":[...]}'></div>
 *                        then AisaCharts.mountAll()  (also runs on DOMContentLoaded when loaded as a classic script)
 * Every chart returns { update(config), destroy() }.
 * Needs aisa-tokens.css (colours) and aisa-charts.css (chrome). Labels are inserted with textContent only.
 */

// ---------------------------------------------------------------- messages (extensible: add a locale with setMessages)
const MESSAGES = {
  en: {
    showTable: 'Table', showChart: 'Chart', total: 'Total', other: 'Other', vs: 'vs {period}', noData: 'No data yet',
    plan: 'Plan', actual: 'Actual', ofPlan: '{pct} of plan', target: 'Target', forecast: 'Forecast', today: 'Today',
    less: 'Less', more: 'More', conversion: '{pct} converted', progress: 'Progress', start: 'Start', end: 'End', count: 'Count',
  },
  'zh-CN': {
    showTable: '表格', showChart: '图表', total: '合计', other: '其他', vs: '较{period}', noData: '暂无数据',
    plan: '计划', actual: '实际', ofPlan: '完成计划 {pct}', target: '目标', forecast: '预测', today: '今天',
    less: '少', more: '多', conversion: '转化 {pct}', progress: '进度', start: '开始', end: '结束', count: '数量',
  },
};
export function setMessages(locale, messages) {
  MESSAGES[locale] = { ...(MESSAGES[locale] ?? {}), ...messages };
}
function locale() {
  return document.documentElement.lang || navigator.language || 'en';
}
function msg(key, params = {}) {
  const lang = locale();
  const chain = [lang, lang.split('-')[0], 'en'];
  let text;
  for (const code of chain) {
    const hit = Object.keys(MESSAGES).find((k) => k.toLowerCase() === code.toLowerCase() || k.split('-')[0] === code);
    if (hit && MESSAGES[hit][key] !== undefined) {
      text = MESSAGES[hit][key];
      break;
    }
  }
  return (text ?? key).replace(/\{(\w+)\}/g, (m, k) => (k in params ? String(params[k]) : m));
}

// ---------------------------------------------------------------- tokens
const FALLBACK = {
  '--aisa-series-1': '#f76918', '--aisa-series-2': '#2a78d6', '--aisa-series-3': '#1baf7a', '--aisa-series-4': '#eda100',
  '--aisa-series-5': '#e87ba4', '--aisa-series-6': '#008300', '--aisa-series-7': '#6250d6', '--aisa-series-8': '#e34948',
  '--aisa-chart-grid': '#e6e3dc', '--aisa-chart-axis': '#736f68', '--aisa-chart-muted': '#d6d1c7', '--aisa-surface': '#fdfcfa',
  '--aisa-text': '#1a1a18', '--aisa-text-secondary': '#6b6862', '--aisa-text-muted': '#736f68', '--aisa-accent': '#f76918',
  '--aisa-warning': '#fab219', '--aisa-danger': '#d03b3b', '--aisa-success-text': '#0b7a2b', '--aisa-danger-text': '#b42323',
  '--aisa-chart-single': '#2d2d2b', '--aisa-chart-emph': '#f76918', '--aisa-chart-track': '#f0eee9', '--aisa-line': '#e6e3dc',
  '--aisa-seq-1': '#f0eee9', '--aisa-seq-2': '#d6d1c7', '--aisa-seq-3': '#b3aea4', '--aisa-seq-4': '#8a867e',
  '--aisa-seq-5': '#6b6862', '--aisa-seq-6': '#48463f', '--aisa-seq-7': '#2d2d2b',
  '--aisa-ord-1': '#b3aea4', '--aisa-ord-2': '#8a867e', '--aisa-ord-3': '#6b6862', '--aisa-ord-4': '#48463f', '--aisa-ord-5': '#2d2d2b',
  '--aisa-div-neg': '#e8590c', '--aisa-div-pos': '#2a78d6', '--aisa-div-mid': '#ebe8e1', '--aisa-text-body': '#48463f',
};
function token(el, name) {
  return getComputedStyle(el).getPropertyValue(name).trim() || FALLBACK[name] || '#888';
}
const seriesColor = (el, i) => token(el, `--aisa-series-${(i % 8) + 1}`);
const rampColor = (el, kind, i) => token(el, `--aisa-${kind}-${i}`);
/** Theme roles: "ink" (default) draws one series in ink and the highlight in orange; data-aisa-chart-theme="brand" makes `single` orange. */
const singleColor = (el) => token(el, '--aisa-chart-single');
const emphColor = (el) => token(el, '--aisa-chart-emph');
const trackColor = (el) => token(el, '--aisa-chart-track');
const mutedColor = (el) => token(el, '--aisa-chart-muted');
/** Index of the mark to draw in the emphasis colour: accent: 'last' | index, or highlightLast: true. */
function accentIndex(c, n) {
  if (c.highlightLast || c.accent === 'last') return n - 1;
  if (typeof c.accent === 'number') return c.accent;
  return undefined;
}
/** Text that sits on a filled mark: white or ink, whichever reads on that fill. */
function onFill(hex) {
  const m = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex.trim());
  if (!m) return '#ffffff';
  const [r, g, b] = m.slice(1).map((x) => parseInt(x, 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.4 ? '#1a1a18' : '#ffffff';
}
const pct = (v, d = 0) => new Intl.NumberFormat(locale(), { style: 'percent', maximumFractionDigits: d }).format(v);

// ---------------------------------------------------------------- number formatting
function formatter(fmt = {}, compact = false) {
  const opts = { maximumFractionDigits: fmt.decimals ?? (compact ? 1 : 2) };
  if (fmt.style === 'percent') Object.assign(opts, { style: 'percent', maximumFractionDigits: fmt.decimals ?? 1 });
  if (fmt.style === 'currency') Object.assign(opts, { style: 'currency', currency: fmt.currency ?? 'USD' });
  if (compact && fmt.style !== 'percent') opts.notation = 'compact';
  if (fmt.notation) opts.notation = fmt.notation; // e.g. 'compact': 1.9M in en, 186万 in zh-CN
  const nf = new Intl.NumberFormat(locale(), opts);
  return (v) => (v === null || v === undefined || Number.isNaN(v) ? '–' : nf.format(v) + (fmt.unit ? `${fmt.unitSpace === false ? '' : ' '}${fmt.unit}` : ''));
}

/** "Nice" axis: 0-based (bars) or padded (lines), 3–6 ticks at 1/2/2.5/5 × 10^k. */
function niceScale(min, max, { zero = true, ticks = 5 } = {}) {
  if (zero) {
    min = Math.min(0, min);
    max = Math.max(0, max);
  }
  // a flat series: show it against zero (an honest "steady") instead of inventing a ±0.5 band with odd decimals
  if (min === max) {
    if (min > 0) min = 0;
    else if (max < 0) max = 0;
    else max = 1;
  }
  const raw = (max - min) / ticks;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const out = [];
  for (let v = lo; v <= hi + step / 2; v += step) out.push(Number(v.toPrecision(12)));
  return { min: lo, max: hi, ticks: out };
}

// ---------------------------------------------------------------- DOM helpers
const SVG = 'http://www.w3.org/2000/svg';
function svgEl(name, attrs = {}, parent) {
  const n = document.createElementNS(SVG, name);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) n.setAttribute(k, String(v));
  if (parent) parent.appendChild(n);
  return n;
}
function el(name, cls, parent, text) {
  const n = document.createElement(name);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  if (parent) parent.appendChild(n);
  return n;
}
let measureCtx;
function textWidth(text, size = 12, family = 'Inter, system-ui, sans-serif') {
  measureCtx ??= document.createElement('canvas').getContext('2d');
  measureCtx.font = `${size}px ${family}`;
  return measureCtx.measureText(text).width;
}
/** Shortens `text` with an ellipsis until it fits `max` px (the full text stays in tooltips and the data table). */
function fitText(text, max, size = 12) {
  const str = String(text ?? '');
  if (textWidth(str, size) <= max) return str;
  let n = str.length;
  while (n > 1 && textWidth(`${str.slice(0, n)}…`, size) > max) n--;
  return `${str.slice(0, n)}…`;
}
/** Bar with a 4px rounded data-end and a square baseline end. */
function barPath(x, y, w, h, dir) {
  const r = Math.min(4, Math.abs(w) / 2, Math.abs(h) / 2);
  if (h <= 0 || w <= 0) return '';
  switch (dir) {
    case 'up': return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
    case 'down': return `M${x},${y}V${y + h - r}Q${x},${y + h} ${x + r},${y + h}H${x + w - r}Q${x + w},${y + h} ${x + w},${y + h - r}V${y}Z`;
    case 'right': return `M${x},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h - r}Q${x + w},${y + h} ${x + w - r},${y + h}H${x}Z`;
    case 'left': return `M${x + w},${y}H${x + r}Q${x},${y} ${x},${y + r}V${y + h - r}Q${x},${y + h} ${x + r},${y + h}H${x + w}Z`;
    default: return `M${x},${y}h${w}v${h}h${-w}Z`;
  }
}

// ---------------------------------------------------------------- chart frame: figure, header, legend, tooltip, table toggle
function frame(host, cfg, kind) {
  host.innerHTML = '';
  const fig = el('figure', `aisa-chart aisa-chart--${kind}${cfg.animate ? ' aisa-chart--animate' : ''}`, host);
  if (cfg.title || cfg.subtitle || cfg.table !== false) {
    const head = el('div', 'aisa-chart__head', fig);
    const titles = el('div', 'aisa-chart__titles', head);
    if (cfg.title) el('figcaption', 'aisa-chart__title', titles, cfg.title);
    if (cfg.subtitle) el('div', 'aisa-chart__subtitle', titles, cfg.subtitle);
    if (cfg.table !== false && cfg.interactive !== false) {
      const btn = el('button', 'aisa-chart__toggle', head, msg('showTable'));
      btn.type = 'button';
      btn.setAttribute('aria-pressed', 'false');
      btn.addEventListener('click', () => {
        const on = fig.classList.toggle('aisa-chart--table');
        btn.textContent = on ? msg('showChart') : msg('showTable');
        btn.setAttribute('aria-pressed', String(on));
      });
    }
  }
  const legend = el('div', 'aisa-chart__legend', fig);
  const plot = el('div', 'aisa-chart__plot', fig);
  const tip = el('div', 'aisa-chart__tooltip', plot);
  tip.setAttribute('role', 'status');
  const tableWrap = el('div', 'aisa-chart__table', fig);
  return { fig, legend, plot, tip, tableWrap };
}

function renderTable(wrap, header, rows) {
  wrap.innerHTML = '';
  const table = el('table', '', wrap);
  const thead = el('thead', '', table);
  const tr = el('tr', '', thead);
  header.forEach((h) => el('th', '', tr, h));
  const tbody = el('tbody', '', table);
  for (const r of rows) {
    const row = el('tr', '', tbody);
    r.forEach((c, i) => el(i === 0 ? 'th' : 'td', '', row, c));
  }
}

function renderLegend(legend, items, { shape = 'rect', hidden, onToggle } = {}) {
  legend.innerHTML = '';
  if (items.length < 2) {
    legend.hidden = true;
    return;
  }
  legend.hidden = false;
  items.forEach((it, i) => {
    const b = el('button', 'aisa-chart__key', legend);
    b.type = 'button';
    const sw = el('span', `aisa-chart__swatch aisa-chart__swatch--${it.shape ?? shape}`, b);
    sw.style.background = it.color;
    if (it.outline) sw.style.boxShadow = `inset 0 0 0 1px ${it.outline}`;
    el('span', '', b, it.name);
    if (hidden?.has(i)) b.classList.add('is-off');
    b.setAttribute('aria-pressed', String(!hidden?.has(i)));
    if (onToggle) b.addEventListener('click', () => onToggle(i));
    else b.disabled = true;
  });
}

function showTip(tip, plot, x, y, title, rows) {
  tip.innerHTML = '';
  if (title) el('div', 'aisa-chart__tip-title', tip, title);
  for (const r of rows) {
    const row = el('div', 'aisa-chart__tip-row', tip);
    const key = el('span', `aisa-chart__tip-key aisa-chart__tip-key--${r.shape ?? 'line'}`, row);
    key.style.background = r.color;
    el('strong', '', row, r.value);
    el('span', 'aisa-chart__tip-name', row, r.name);
  }
  tip.classList.add('is-on');
  const pw = plot.clientWidth;
  const tw = tip.offsetWidth;
  const th = tip.offsetHeight;
  let left = x + 14;
  if (left + tw > pw) left = x - tw - 14;
  tip.style.left = `${Math.max(0, left)}px`;
  tip.style.top = `${Math.max(0, Math.min(y - th / 2, plot.clientHeight - th))}px`;
}
const hideTip = (tip) => tip.classList.remove('is-on');

// ---------------------------------------------------------------- lifecycle: re-render on resize and theme change
const live = new Set();
let themeWatch = false;
function watchTheme() {
  if (themeWatch) return;
  themeWatch = true;
  const rerender = () => live.forEach((c) => c.render());
  window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', rerender);
  new MutationObserver(rerender).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-aisa-chart-theme', 'lang'] });
}
function mount(host, cfg, draw) {
  const state = { cfg, hidden: new Set() };
  const rerender = () => draw(host, state, rerender);
  const chart = {
    render: rerender,
    update(next) {
      state.cfg = { ...state.cfg, ...next };
      chart.render();
    },
    destroy() {
      ro?.disconnect();
      live.delete(chart);
      host.innerHTML = '';
    },
  };
  let lastW = 0;
  const ro = typeof ResizeObserver !== 'undefined' && cfg.interactive !== false
    ? new ResizeObserver(() => {
      const w = host.clientWidth;
      if (Math.abs(w - lastW) > 2) {
        lastW = w;
        chart.render();
      }
    })
    : null;
  ro?.observe(host);
  live.add(chart);
  watchTheme();
  chart.render();
  lastW = host.clientWidth;
  return chart;
}

// ---------------------------------------------------------------- cartesian axes shared by bar/line
function axes(svg, host, g, { w, h, scale, fmtTick, categories, orientation, catPos, bandW }) {
  const grid = token(host, '--aisa-chart-grid');
  const axis = token(host, '--aisa-text-muted');
  for (const t of scale.ticks) {
    if (orientation === 'horizontal') {
      const x = ((t - scale.min) / (scale.max - scale.min)) * w;
      svgEl('line', { x1: x, x2: x, y1: 0, y2: h, stroke: grid, 'stroke-width': 1, 'shape-rendering': 'crispEdges' }, g);
      svgEl('text', { x, y: h + 16, 'text-anchor': 'middle', fill: axis, class: 'aisa-chart__tick' }, g).textContent = fmtTick(t);
    } else {
      const y = h - ((t - scale.min) / (scale.max - scale.min)) * h;
      svgEl('line', { x1: 0, x2: w, y1: y, y2: y, stroke: grid, 'stroke-width': 1, 'shape-rendering': 'crispEdges' }, g);
      svgEl('text', { x: -8, y: y + 3.5, 'text-anchor': 'end', fill: axis, class: 'aisa-chart__tick' }, g).textContent = fmtTick(t);
    }
  }
  // category labels: thin out when crowded
  const maxLabel = Math.max(...categories.map((c) => textWidth(String(c), 10.5)));
  const every = orientation === 'horizontal' ? 1 : Math.max(1, Math.ceil((maxLabel + 12) / Math.max(bandW, 1)));
  categories.forEach((c, i) => {
    if (i % every) return;
    const p = catPos(i);
    if (orientation === 'horizontal') {
      svgEl('text', { x: -8, y: p + 4, 'text-anchor': 'end', fill: axis, class: 'aisa-chart__tick' }, g).textContent = String(c);
    } else {
      svgEl('text', { x: p, y: h + 16, 'text-anchor': 'middle', fill: axis, class: 'aisa-chart__tick' }, g).textContent = String(c);
    }
  });
}

/** Solid thin reference rule (target / benchmark) with a small label at its end. */
function referenceLine(g, host, { value, label, w, h, toPos, horizontal }) {
  const ink = token(host, '--aisa-text-secondary');
  const p = toPos(value);
  const grp = svgEl('g', { class: 'aisa-chart__ref' }, g);
  if (horizontal) {
    svgEl('line', { x1: p, x2: p, y1: -4, y2: h, stroke: ink, 'stroke-width': 1, 'shape-rendering': 'crispEdges' }, grp);
    svgEl('text', { x: p + 4, y: 6, fill: ink, class: 'aisa-chart__ref-label' }, grp).textContent = label;
  } else {
    svgEl('line', { x1: 0, x2: w, y1: p, y2: p, stroke: ink, 'stroke-width': 1, 'shape-rendering': 'crispEdges' }, grp);
    // label sits at the start of the rule, away from end labels and the newest data
    const t = svgEl('text', { x: 4, y: p - 5, fill: ink, class: 'aisa-chart__ref-label' }, grp);
    t.textContent = label;
  }
}
const targetOf = (c) => (c.target === undefined || c.target === null ? null : typeof c.target === 'number' ? { value: c.target } : c.target);

function plotBox(host, cfg, leftLabels, defaultH = 220) {
  const width = cfg.width ?? Math.max(220, host.clientWidth || 600);
  const height = cfg.height ?? defaultH;
  const left = Math.ceil(Math.max(...leftLabels.map((t) => textWidth(t, 10.5)), 0)) + 12;
  const m = { top: 12, right: cfg.endLabels ? Math.min(96, Math.max(44, cfg.endLabelWidth ?? 72)) : 12, bottom: 24, left };
  return { width, height, m, w: width - m.left - m.right, h: height - m.top - m.bottom };
}

// ================================================================ BAR
/**
 * barChart(host, {
 *   categories: ['Jan', ...], series: [{ name, values: [...] }],
 *   orientation: 'vertical' | 'horizontal', stacked: false,
 *   highlight: categoryIndex   (emphasis: that bar in the accent, the rest muted grey),
 *   accent: 'last' | index, highlightLast: true   (one series: that bar in the accent, the rest in ink),
 *   plan: [...] (one series: plan-vs-actual — plan drawn as an outlined bar next to the solid actual),
 *   target: number | { value, label } (thin solid reference rule),
 *   format: { style: 'decimal'|'percent'|'currency', currency, unit, decimals, notation: 'compact'? }, title, subtitle, height,
 *   valueLabels: true | 'all' | false, interactive: true, animate: false, table: true })
 * One series draws in the theme's ink (or orange with data-aisa-chart-theme="brand"); several series use the categorical slots.
 */
export function barChart(host, cfg) {
  return mount(host, cfg, (host, state, rerender) => {
    const c = state.cfg;
    const { fig, legend, plot, tip, tableWrap } = frame(host, c, 'bar');
    const horiz = c.orientation === 'horizontal';
    if (horiz) fig.classList.add('aisa-chart--horizontal');
    const series = c.series ?? [];
    const visible = series.map((s, i) => i).filter((i) => !state.hidden.has(i));
    const cats = c.categories ?? [];
    const fmt = formatter(c.format);
    const fmtTick = formatter(c.format, true);
    const single = series.length === 1;
    const plan = single && Array.isArray(c.plan) ? c.plan.map(Number) : null;
    const target = targetOf(c);
    const totals = cats.map((_, ci) => visible.reduce((a, si) => a + (Number(series[si].values[ci]) || 0), 0));
    const flat = [...visible.flatMap((si) => series[si].values.map(Number)), ...(plan ?? []), ...(target ? [target.value] : [])];
    const ext = c.stacked ? [...totals, ...(target ? [target.value] : [])] : flat;
    const scale = niceScale(Math.min(0, ...ext), Math.max(0, ...ext));
    const ink = singleColor(host);
    const emph = emphColor(host);
    const muted = mutedColor(host);
    const colors = single ? [ink] : series.map((_, i) => seriesColor(host, i));
    const accent = accentIndex(c, cats.length);
    const markColor = (si, ci) => {
      if (c.highlight !== undefined) return ci === c.highlight ? emph : muted;
      if (single && accent === ci) return emph;
      return colors[si];
    };
    const textC = token(host, '--aisa-text-secondary');

    const legendItems = series.map((s, i) => ({ name: s.name, color: colors[i] }));
    if (plan) legendItems.push({ name: c.planLabel ?? msg('plan'), color: 'transparent', outline: ink });
    renderLegend(legend, legendItems, {
      hidden: state.hidden,
      onToggle: plan ? undefined : (i) => {
        if (state.hidden.has(i)) state.hidden.delete(i);
        else if (visible.length > 1) state.hidden.add(i);
        rerender();
      },
    });

    const leftLabels = horiz ? cats.map(String) : scale.ticks.map(fmtTick);
    const box = plotBox(host, { ...c, endLabels: false }, leftLabels, horiz ? Math.max(110, cats.length * 30 + 34) : 220);
    if (horiz) box.m.right = Math.max(box.m.right, 44);
    box.w = box.width - box.m.left - box.m.right;
    const svg = svgEl('svg', { width: box.width, height: box.height, viewBox: `0 0 ${box.width} ${box.height}`, role: 'img', class: 'aisa-chart__svg', tabindex: c.interactive === false ? undefined : 0 }, plot);
    svg.setAttribute('aria-label', [c.title, c.subtitle].filter(Boolean).join(' — ') || 'Bar chart');
    const g = svgEl('g', { transform: `translate(${box.m.left},${box.m.top})` }, svg);
    const len = horiz ? box.w : box.h;
    const band = (horiz ? box.h : box.w) / Math.max(1, cats.length);
    const groups = c.stacked ? 1 : Math.max(1, visible.length) + (plan ? 1 : 0);
    const thick = Math.max(2, Math.min(24, (band * 0.62 - (groups - 1) * 2) / groups));
    const groupW = thick * groups + (groups - 1) * 2;
    const toLen = (v) => (v - scale.min) / (scale.max - scale.min) * len;
    const zero = toLen(0);
    const catPos = (i) => band * i + band / 2;
    axes(svg, host, g, { w: box.w, h: box.h, scale, fmtTick, categories: cats, orientation: c.orientation, catPos, bandW: band });

    const marks = svgEl('g', { class: 'aisa-chart__marks' }, g);
    const hits = svgEl('g', {}, g);
    const peak = totals.indexOf(Math.max(...totals));
    cats.forEach((cat, ci) => {
      let acc = 0;
      const start = catPos(ci) - groupW / 2;
      // plan: outlined bar first (left of the actual)
      if (plan) {
        const pv = plan[ci] || 0;
        const a1 = toLen(pv);
        const lo = Math.min(zero, a1) + 0.5;
        const size = Math.max(0, Math.abs(a1 - zero) - 1);
        const d = horiz ? barPath(lo, start + 0.5, size, thick - 1, pv >= 0 ? 'right' : 'left') : barPath(start + 0.5, box.h - lo - size, thick - 1, size, pv >= 0 ? 'up' : 'down');
        if (d) svgEl('path', { d, fill: 'none', stroke: ink, 'stroke-width': 1, 'stroke-opacity': 0.55, class: 'aisa-chart__bar aisa-chart__bar--plan', style: `--i:${ci}` }, marks);
      }
      visible.forEach((si, k) => {
        const v = Number(series[si].values[ci]) || 0;
        const color = markColor(si, ci);
        let a0 = c.stacked ? toLen(acc) : zero;
        let a1 = c.stacked ? toLen(acc + v) : toLen(v);
        acc += v;
        const isTop = !c.stacked || k === visible.length - 1;
        // 2px surface gap between stacked segments
        if (c.stacked && k > 0) a0 += 1;
        if (c.stacked && !isTop) a1 -= 1;
        const lo = Math.min(a0, a1);
        const size = Math.abs(a1 - a0);
        const slot = (plan ? 1 : 0) + (c.stacked ? 0 : k);
        const off = c.stacked ? start : start + slot * (thick + 2);
        const dir = !isTop ? null : horiz ? (v >= 0 ? 'right' : 'left') : (v >= 0 ? 'up' : 'down');
        const d = horiz ? barPath(lo, off, size, thick, dir) : barPath(off, box.h - lo - size, thick, size, dir);
        if (d) svgEl('path', { d, fill: color, class: 'aisa-chart__bar', style: `--i:${ci}` }, marks);
      });
      // label selectively: every bar when there are few, otherwise only the peak, the latest and the accented one
      const labelThis = c.valueLabels === 'all' || cats.length <= 8 || ci === peak || ci === cats.length - 1 || ci === accent || ci === c.highlight;
      if (c.valueLabels !== false && labelThis && (visible.length === 1 || c.stacked)) {
        const total = c.stacked ? totals[ci] : Number(series[visible[0]]?.values[ci]) || 0;
        const label = fmt(total);
        const tipPos = toLen(Math.max(total, plan ? plan[ci] || 0 : total));
        const xCenter = plan ? start + thick + 2 + thick / 2 : catPos(ci);
        const t = horiz
          ? svgEl('text', { x: tipPos + 6, y: (plan ? start + thick + 2 + thick / 2 : catPos(ci)) + 3.5, fill: textC, class: 'aisa-chart__value' }, g)
          : svgEl('text', { x: xCenter, y: box.h - tipPos - 5, 'text-anchor': 'middle', fill: ci === accent || ci === c.highlight ? token(host, '--aisa-text') : textC, class: 'aisa-chart__value' }, g);
        if (!horiz && textWidth(label, 10.5) > band - 2) t.remove();
        else t.textContent = label;
      }
      // hit target: the whole band slot, bigger than the mark
      const hit = horiz
        ? svgEl('rect', { x: 0, y: band * ci, width: box.w, height: band, fill: 'transparent' }, hits)
        : svgEl('rect', { x: band * ci, y: 0, width: band, height: box.h, fill: 'transparent' }, hits);
      const show = (evt) => {
        hits.querySelectorAll('.is-hot').forEach((n) => n.classList.remove('is-hot'));
        hit.classList.add('is-hot');
        const rows = visible.map((si) => ({ name: series[si].name, value: fmt(Number(series[si].values[ci])), color: markColor(si, ci), shape: 'rect' }));
        if (plan) {
          rows.push({ name: c.planLabel ?? msg('plan'), value: fmt(plan[ci]), color: 'transparent', shape: 'rect' });
          if (plan[ci]) rows.push({ name: '', value: msg('ofPlan', { pct: pct((Number(series[0].values[ci]) || 0) / plan[ci]) }), color: 'transparent' });
        }
        if (c.stacked && visible.length > 1) rows.push({ name: msg('total'), value: fmt(totals[ci]), color: 'transparent' });
        const px = horiz ? box.m.left + toLen(c.stacked ? totals[ci] : Math.max(...visible.map((si) => Number(series[si].values[ci]) || 0))) : box.m.left + catPos(ci);
        const py = horiz || !evt ? box.m.top + (horiz ? catPos(ci) : box.h / 2) : evt.clientY - plot.getBoundingClientRect().top;
        showTip(tip, plot, px, py, String(cat), rows);
      };
      if (c.interactive !== false) {
        hit.addEventListener('pointermove', show);
        hit.addEventListener('pointerleave', () => hideTip(tip));
      }
      hit.__show = show;
    });
    if (target) referenceLine(g, host, { value: target.value, label: target.label ?? `${msg('target')} ${fmt(target.value)}`, w: box.w, h: box.h, horizontal: horiz, toPos: horiz ? toLen : (v) => box.h - toLen(v) });
    keyboardNav(svg, hits, tip);
    const header = ['', ...series.map((s) => s.name), ...(plan ? [c.planLabel ?? msg('plan')] : [])];
    renderTable(tableWrap, header, cats.map((cat, ci) => [String(cat), ...series.map((s) => fmt(Number(s.values[ci]))), ...(plan ? [fmt(plan[ci])] : [])]));
  });
}

function keyboardNav(svg, hits, tip) {
  let idx = -1;
  const items = () => [...hits.children];
  svg.addEventListener('keydown', (e) => {
    if (!['ArrowRight', 'ArrowLeft', 'ArrowUp', 'ArrowDown', 'Escape'].includes(e.key)) return;
    e.preventDefault();
    if (e.key === 'Escape') {
      hideTip(tip);
      return;
    }
    const n = items().length;
    idx = (idx + (e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1) + n) % n;
    items()[idx]?.__show?.();
  });
  svg.addEventListener('blur', () => hideTip(tip));
}

// ================================================================ LINE / AREA
/**
 * lineChart(host, { labels: ['W1', ...], series: [{ name, values, forecastFrom?: index }], area: false,
 *   highlight: seriesIndex (that line in the accent, the rest muted),
 *   target: number | { value, label } (thin solid reference rule),
 *   zero: false (start the y-axis at 0), format, title, subtitle, height, endLabels: true, interactive, animate })
 * forecastFrom: values from that index on are a projection, drawn dashed (dashing means projection only).
 * One series draws in the theme ink with its latest point in the accent.
 */
export function lineChart(host, cfg) {
  return mount(host, cfg, (host, state, rerender) => {
    const c = state.cfg;
    const { legend, plot, tip, tableWrap } = frame(host, c, 'line');
    const series = c.series ?? [];
    const labels = c.labels ?? [];
    const visible = series.map((_, i) => i).filter((i) => !state.hidden.has(i));
    const fmt = formatter(c.format);
    const fmtTick = formatter(c.format, true);
    const target = targetOf(c);
    const vals = [...visible.flatMap((si) => series[si].values.map(Number).filter((v) => !Number.isNaN(v))), ...(target ? [target.value] : [])];
    const scale = niceScale(Math.min(...vals), Math.max(...vals), { zero: c.zero ?? !!c.area, ticks: 4 });
    const single = series.length === 1;
    const colors = series.map((_, i) => {
      if (c.highlight !== undefined) return i === c.highlight ? emphColor(host) : mutedColor(host);
      return single ? singleColor(host) : seriesColor(host, i);
    });
    const endDot = (si) => (single && c.highlight === undefined && c.accentEnd !== false ? emphColor(host) : colors[si]);
    const surface = token(host, '--aisa-surface');
    const textC = token(host, '--aisa-text-secondary');
    renderLegend(legend, series.map((s, i) => ({ name: s.name, color: colors[i] })), {
      shape: 'line',
      hidden: state.hidden,
      onToggle: (i) => {
        if (state.hidden.has(i)) state.hidden.delete(i);
        else if (visible.length > 1) state.hidden.add(i);
        rerender();
      },
    });
    const wantEnd = c.endLabels !== false && visible.length <= 4 && visible.length > 0;
    const endW = Math.max(...visible.map((si) => textWidth(`${fmt(Number(series[si].values.at(-1)))}${visible.length > 1 ? ' ' + series[si].name : ''}`, 10.5)), 0) + 12;
    const box = plotBox(host, { ...c, endLabels: wantEnd, endLabelWidth: endW }, scale.ticks.map(fmtTick), 220);
    const svg = svgEl('svg', { width: box.width, height: box.height, viewBox: `0 0 ${box.width} ${box.height}`, role: 'img', class: 'aisa-chart__svg', tabindex: c.interactive === false ? undefined : 0 }, plot);
    svg.setAttribute('aria-label', [c.title, c.subtitle].filter(Boolean).join(' — ') || 'Line chart');
    const g = svgEl('g', { transform: `translate(${box.m.left},${box.m.top})` }, svg);
    const n = Math.max(1, labels.length - 1);
    const xAt = (i) => (labels.length === 1 ? box.w / 2 : (i / n) * box.w);
    const yAt = (v) => box.h - ((v - scale.min) / (scale.max - scale.min)) * box.h;
    axes(svg, host, g, { w: box.w, h: box.h, scale, fmtTick, categories: labels, orientation: 'vertical', catPos: xAt, bandW: box.w / Math.max(1, labels.length) });
    const marks = svgEl('g', { class: 'aisa-chart__marks' }, g);
    // draw highlighted series last so it sits on top
    const order = [...visible].sort((a, b) => (a === c.highlight) - (b === c.highlight));
    const ends = [];
    for (const si of order) {
      const raw = series[si].values.map((v, i) => [i, Number(v)]).filter(([, v]) => !Number.isNaN(v));
      const pts = raw.map(([i, v]) => [xAt(i), yAt(v), i]);
      if (!pts.length) continue;
      const ff = series[si].forecastFrom;
      const actual = ff === undefined ? pts : pts.filter((p) => p[2] <= ff);
      const proj = ff === undefined ? [] : pts.filter((p) => p[2] >= ff);
      const path = (ps) => 'M' + ps.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('L');
      if (c.area && actual.length) svgEl('path', { d: `${path(actual)}L${actual.at(-1)[0]},${box.h}L${actual[0][0]},${box.h}Z`, fill: colors[si], 'fill-opacity': 0.08, class: 'aisa-chart__area' }, marks);
      if (actual.length > 1) svgEl('path', { d: path(actual), fill: 'none', stroke: colors[si], 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round', class: 'aisa-chart__line', pathLength: 1 }, marks);
      if (proj.length > 1) svgEl('path', { d: path(proj), fill: 'none', stroke: colors[si], 'stroke-width': 2, 'stroke-dasharray': '4 4', 'stroke-opacity': 0.6, 'stroke-linecap': 'round', class: 'aisa-chart__forecast' }, marks);
      const [ex, ey] = pts.at(-1);
      svgEl('circle', { cx: ex, cy: ey, r: 4, fill: endDot(si), stroke: surface, 'stroke-width': 2 }, marks);
      ends.push({ si, y: ey, value: series[si].values.at(-1) });
    }
    if (target) referenceLine(g, host, { value: target.value, label: target.label ?? `${msg('target')} ${fmt(target.value)}`, w: box.w, h: box.h, toPos: yAt });
    // end labels only when they don't collide; otherwise legend + tooltip carry identity
    ends.sort((a, b) => a.y - b.y);
    const collide = ends.some((e, i) => i > 0 && e.y - ends[i - 1].y < 14);
    if (wantEnd && !collide) {
      for (const e of ends) {
        const t = svgEl('text', { x: box.w + 8, y: e.y + 4, fill: textC, class: 'aisa-chart__value' }, g);
        t.textContent = visible.length > 1 ? `${fmt(Number(e.value))} ${series[e.si].name}` : fmt(Number(e.value));
      }
    }
    // crosshair: snaps to the nearest label, one tooltip lists every series
    const cross = svgEl('line', { y1: 0, y2: box.h, stroke: token(host, '--aisa-chart-axis'), 'stroke-width': 1, class: 'aisa-chart__cross', 'shape-rendering': 'crispEdges' }, g);
    const dots = svgEl('g', {}, g);
    const hits = svgEl('g', {}, g);
    labels.forEach((lab, i) => {
      const x0 = i === 0 ? 0 : (xAt(i - 1) + xAt(i)) / 2;
      const x1 = i === labels.length - 1 ? box.w : (xAt(i) + xAt(i + 1)) / 2;
      const hit = svgEl('rect', { x: x0, y: 0, width: Math.max(1, x1 - x0), height: box.h, fill: 'transparent' }, hits);
      const show = () => {
        cross.setAttribute('x1', xAt(i));
        cross.setAttribute('x2', xAt(i));
        cross.classList.add('is-on');
        dots.innerHTML = '';
        const rows = [];
        for (const si of visible) {
          const v = Number(series[si].values[i]);
          if (Number.isNaN(v)) continue;
          svgEl('circle', { cx: xAt(i), cy: yAt(v), r: 4, fill: colors[si], stroke: surface, 'stroke-width': 2 }, dots);
          const isProj = series[si].forecastFrom !== undefined && i > series[si].forecastFrom;
          rows.push({ name: isProj ? `${series[si].name} · ${msg('forecast')}` : series[si].name, value: fmt(v), color: colors[si], y: yAt(v) });
        }
        rows.sort((a, b) => a.y - b.y);
        showTip(tip, plot, box.m.left + xAt(i), box.m.top + (rows[0]?.y ?? box.h / 2), String(lab), rows);
      };
      hit.__show = show;
      if (c.interactive !== false) {
        hit.addEventListener('pointermove', show);
        hit.addEventListener('pointerleave', () => {
          hideTip(tip);
          cross.classList.remove('is-on');
          dots.innerHTML = '';
        });
      }
    });
    keyboardNav(svg, hits, tip);
    renderTable(tableWrap, ['', ...series.map((s) => s.name)], labels.map((lab, i) => [String(lab), ...series.map((s) => fmt(Number(s.values[i])))]));
  });
}

// ================================================================ DONUT (part-to-whole at a glance, ≤ 6 segments)
/** donutChart(host, { items: [{ name, value }], centerLabel, format, title, subtitle, size: 180 }) */
export function donutChart(host, cfg) {
  return mount(host, cfg, (host, state) => {
    const c = state.cfg;
    const { legend, plot, tip, tableWrap } = frame(host, c, 'donut');
    const fmt = formatter(c.format);
    let items = [...(c.items ?? [])].sort((a, b) => b.value - a.value);
    if (items.length > 6) {
      const rest = items.slice(5).reduce((a, b) => a + Number(b.value), 0);
      items = [...items.slice(0, 5), { name: msg('other'), value: rest, other: true }];
    }
    const total = items.reduce((a, b) => a + Number(b.value), 0);
    const colors = items.map((it, i) => (it.other ? token(host, '--aisa-chart-muted') : seriesColor(host, i)));
    renderLegend(legend, items.map((it, i) => ({ name: `${it.name} · ${total ? Math.round((it.value / total) * 100) : 0}%`, color: colors[i] })));
    const size = c.size ?? 180;
    const r = size / 2;
    const inner = r * 0.68;
    const svg = svgEl('svg', { width: size, height: size, viewBox: `0 0 ${size} ${size}`, role: 'img', class: 'aisa-chart__svg', tabindex: c.interactive === false ? undefined : 0 }, plot);
    svg.setAttribute('aria-label', c.title || 'Donut chart');
    const surface = token(host, '--aisa-surface');
    const hits = svgEl('g', {}, svg);
    let a = -Math.PI / 2;
    items.forEach((it, i) => {
      const frac = total ? it.value / total : 0;
      const a2 = a + frac * Math.PI * 2;
      const large = a2 - a > Math.PI ? 1 : 0;
      const p = (ang, rad) => [r + rad * Math.cos(ang), r + rad * Math.sin(ang)].map((x) => x.toFixed(2)).join(',');
      const d = frac >= 0.9999
        ? `M${r},0A${r},${r} 0 1 1 ${r},${size}A${r},${r} 0 1 1 ${r},0ZM${r},${r - inner}A${inner},${inner} 0 1 0 ${r},${r + inner}A${inner},${inner} 0 1 0 ${r},${r - inner}Z`
        : `M${p(a, r)}A${r},${r} 0 ${large} 1 ${p(a2, r)}L${p(a2, inner)}A${inner},${inner} 0 ${large} 0 ${p(a, inner)}Z`;
      const seg = svgEl('path', { d, 'fill-rule': 'evenodd', fill: colors[i], stroke: surface, 'stroke-width': 2, 'stroke-linejoin': 'round', class: 'aisa-chart__seg' }, hits);
      const mid = (a + a2) / 2;
      seg.__show = () => showTip(tip, plot, r + Math.cos(mid) * r * 0.85, r + Math.sin(mid) * r * 0.85, it.name, [{ name: `${total ? ((it.value / total) * 100).toFixed(1) : 0}%`, value: fmt(it.value), color: colors[i], shape: 'rect' }]);
      if (c.interactive !== false) {
        seg.addEventListener('pointermove', seg.__show);
        seg.addEventListener('pointerleave', () => hideTip(tip));
      }
      a = a2;
    });
    const center = svgEl('text', { x: r, y: r - 2, 'text-anchor': 'middle', class: 'aisa-chart__center', fill: token(host, '--aisa-text') }, svg);
    center.textContent = c.centerValue ?? fmt(total);
    const sub = svgEl('text', { x: r, y: r + 16, 'text-anchor': 'middle', class: 'aisa-chart__center-sub', fill: token(host, '--aisa-text-muted') }, svg);
    sub.textContent = c.centerLabel ?? msg('total');
    keyboardNav(svg, hits, tip);
    renderTable(tableWrap, ['', '%', ''], items.map((it) => [it.name, total ? `${((it.value / total) * 100).toFixed(1)}%` : '–', fmt(it.value)]));
  });
}

// ================================================================ HEATMAP (sequential orange)
/** heatmap(host, { rows: ['Mon',...], cols: ['0h',...], values: [[...], ...], format, title, subtitle, cell: 18 }) */
export function heatmap(host, cfg) {
  return mount(host, cfg, (host, state) => {
    const c = state.cfg;
    const { plot, tip, tableWrap } = frame(host, c, 'heatmap');
    const fmt = formatter(c.format);
    const rows = c.rows ?? [];
    const cols = c.cols ?? [];
    const all = (c.values ?? []).flat().map(Number).filter((v) => !Number.isNaN(v));
    const lo = Math.min(...all);
    const hi = Math.max(...all);
    const steps = 7;
    const bucket = (v) => (hi === lo ? 4 : Math.min(steps, 1 + Math.floor(((v - lo) / (hi - lo)) * steps)));
    const left = Math.ceil(Math.max(...rows.map((r) => textWidth(String(r))), 0)) + 10;
    const avail = (c.width ?? host.clientWidth ?? 600) - left - 4;
    // columns stretch to the card width; rows stay at most `cell` tall so wide cards don't get huge
    const cw = Math.max(10, Math.floor(avail / Math.max(1, cols.length)));
    const cell = Math.max(10, Math.min(c.cell ?? 28, cw));
    const width = left + cols.length * cw + 4;
    const height = rows.length * cell + 24 + 36;
    const svg = svgEl('svg', { width, height, viewBox: `0 0 ${width} ${height}`, role: 'img', class: 'aisa-chart__svg', tabindex: c.interactive === false ? undefined : 0 }, plot);
    svg.setAttribute('aria-label', c.title || 'Heatmap');
    const axis = token(host, '--aisa-text-muted');
    const hits = svgEl('g', {}, svg);
    rows.forEach((r, ri) => {
      svgEl('text', { x: left - 8, y: ri * cell + cell / 2 + 4, 'text-anchor': 'end', fill: axis, class: 'aisa-chart__tick' }, svg).textContent = String(r);
      cols.forEach((col, ci) => {
        const v = Number(c.values?.[ri]?.[ci]);
        const rect = svgEl('rect', {
          x: left + ci * cw + 1, y: ri * cell + 1, width: cw - 2, height: cell - 2, rx: 3,
          fill: Number.isNaN(v) ? token(host, '--aisa-chart-grid') : rampColor(host, 'seq', bucket(v)), class: 'aisa-chart__cell',
        }, hits);
        rect.__show = () => showTip(tip, plot, left + ci * cw + cw, ri * cell + cell / 2, `${r} · ${col}`, [{ name: '', value: fmt(v), color: rect.getAttribute('fill'), shape: 'rect' }]);
        if (c.interactive !== false) {
          rect.addEventListener('pointermove', rect.__show);
          rect.addEventListener('pointerleave', () => hideTip(tip));
        }
      });
    });
    const every = Math.max(1, Math.ceil(28 / cw));
    cols.forEach((col, ci) => {
      if (ci % every) return;
      svgEl('text', { x: left + ci * cw + cw / 2, y: rows.length * cell + 16, 'text-anchor': 'middle', fill: axis, class: 'aisa-chart__tick' }, svg).textContent = String(col);
    });
    // scale legend
    const ly = rows.length * cell + 30;
    svgEl('text', { x: left, y: ly + 10, fill: axis, class: 'aisa-chart__tick' }, svg).textContent = fmt(lo);
    for (let s = 1; s <= steps; s++) svgEl('rect', { x: left + 40 + (s - 1) * 18, y: ly, width: 16, height: 10, rx: 2, fill: rampColor(host, 'seq', s) }, svg);
    svgEl('text', { x: left + 40 + steps * 18 + 6, y: ly + 10, fill: axis, class: 'aisa-chart__tick' }, svg).textContent = fmt(hi);
    keyboardNav(svg, hits, tip);
    renderTable(tableWrap, ['', ...cols.map(String)], rows.map((r, ri) => [String(r), ...cols.map((_, ci) => fmt(Number(c.values?.[ri]?.[ci])))]));
  });
}

// ================================================================ SPARKLINE, STAT TILE, METER
/** sparkline(values, { width, height }) → SVG element. De-emphasis grey line, current point in the accent. */
export function sparkline(values, { width = 96, height = 28, host = document.documentElement } = {}) {
  const v = values.map(Number);
  const lo = Math.min(...v);
  const hi = Math.max(...v);
  const x = (i) => (i / Math.max(1, v.length - 1)) * (width - 6) + 3;
  const y = (n) => height - 3 - (hi === lo ? (height - 6) / 2 : ((n - lo) / (hi - lo)) * (height - 6));
  const svg = svgEl('svg', { width, height, viewBox: `0 0 ${width} ${height}`, class: 'aisa-spark', 'aria-hidden': 'true' });
  svgEl('path', { d: 'M' + v.map((n, i) => `${x(i).toFixed(1)},${y(n).toFixed(1)}`).join('L'), fill: 'none', stroke: token(host, '--aisa-chart-axis'), 'stroke-width': 1.5, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }, svg);
  svgEl('circle', { cx: x(v.length - 1), cy: y(v.at(-1)), r: 3, fill: token(host, '--aisa-accent'), stroke: token(host, '--aisa-surface'), 'stroke-width': 1.5 }, svg);
  return svg;
}

/**
 * statTile(host, { label, value, format, delta: 0.124 (fraction or absolute), deltaFormat, period: 'last month',
 *   goodWhenUp: true, trend: [12 numbers] })
 */
export function statTile(host, cfg) {
  return mount(host, { ...cfg, interactive: false }, (host, state) => {
    const c = state.cfg;
    host.innerHTML = '';
    const tile = el('div', 'aisa-stat', host);
    el('div', 'aisa-stat__label', tile, c.label);
    const row = el('div', 'aisa-stat__row', tile);
    el('div', 'aisa-stat__value', row, typeof c.value === 'number' ? formatter({ ...c.format, decimals: c.format?.decimals ?? 1 }, c.compact !== false)(c.value) : String(c.value));
    if (c.trend?.length) row.appendChild(sparkline(c.trend, { host }));
    if (c.delta !== undefined && c.delta !== null) {
      const up = c.delta > 0;
      const good = c.delta === 0 ? null : up === (c.goodWhenUp !== false);
      const d = el('div', `aisa-stat__delta ${good === null ? '' : good ? 'is-good' : 'is-bad'}`, tile);
      const df = formatter(c.deltaFormat ?? { style: 'percent', decimals: 1 });
      el('span', 'aisa-stat__arrow', d, c.delta === 0 ? '→' : up ? '↑' : '↓');
      el('span', '', d, `${up ? '+' : ''}${df(c.delta)}`);
      if (c.period) el('span', 'aisa-stat__period', d, msg('vs', { period: c.period }));
    }
  });
}

/**
 * meter(host, { label, value, max, format, thresholds: { warning: 0.75, danger: 0.9 } (fractions of max),
 *   tone: 'ink' (default fill in the theme ink) | 'accent' (orange) })
 */
export function meter(host, cfg) {
  return mount(host, { ...cfg, interactive: false }, (host, state) => {
    const c = state.cfg;
    host.innerHTML = '';
    const max = c.max ?? 1;
    const frac = Math.max(0, Math.min(1, (c.value ?? 0) / max));
    const t = c.thresholds ?? {};
    const level = t.danger !== undefined && frac >= t.danger ? 'danger' : t.warning !== undefined && frac >= t.warning ? 'warning' : c.tone === 'accent' ? 'accent' : 'ink';
    const wrap = el('div', `aisa-meter aisa-meter--${level}`, host);
    const head = el('div', 'aisa-meter__head', wrap);
    el('span', 'aisa-meter__label', head, c.label ?? '');
    const f = formatter(c.format);
    el('span', 'aisa-meter__value', head, c.format?.style === 'percent' ? f(frac) : `${f(c.value)} / ${f(max)}`);
    const track = el('div', 'aisa-meter__track', wrap);
    track.setAttribute('role', 'meter');
    track.setAttribute('aria-valuenow', String(c.value));
    track.setAttribute('aria-valuemin', '0');
    track.setAttribute('aria-valuemax', String(max));
    if (c.label) track.setAttribute('aria-label', c.label);
    const fill = el('div', 'aisa-meter__fill', track);
    fill.style.width = `${frac * 100}%`;
  });
}

// ================================================================ RING GAUGE (KPI rings, alone or in a row)
/**
 * ringGauge(host, { value, max: 1 (or target), label, sub, centerValue, size: 120, inline: false,
 *   tone: 'ink' | 'accent' | 'warning' | 'danger', format }
 *   or { items: [{ value, max, label, sub, tone }, ...] } for a row of rings, e.g. three half-year KPIs)
 * The arc carries the share of the target; the unfilled part is the theme track.
 */
export function ringGauge(host, cfg) {
  return mount(host, cfg, (host, state) => {
    const c = state.cfg;
    const { legend, plot, tip, tableWrap } = frame(host, { ...c, table: c.table ?? (c.items ? true : false) }, 'ring');
    legend.hidden = true;
    const items = c.items ?? [c];
    const fmt = formatter(c.format);
    const row = el('div', `aisa-rings-row${c.inline ? ' aisa-rings-row--inline' : ''}`, plot);
    const hits = svgEl('g', {});
    items.forEach((it) => {
      const max = it.max ?? it.target ?? c.max ?? 1;
      const frac = max ? (Number(it.value) || 0) / max : 0;
      const size = it.size ?? c.size ?? (c.inline ? 36 : 112);
      const sw = Math.max(3.5, size * 0.07);
      const r = (size - sw) / 2;
      const circ = 2 * Math.PI * r;
      const tone = it.tone ?? c.tone ?? 'ink';
      const color = tone === 'accent' ? emphColor(host) : tone === 'warning' ? token(host, '--aisa-warning') : tone === 'danger' ? token(host, '--aisa-danger') : singleColor(host);
      const cell = el('div', 'aisa-ring-gauge', row);
      const svg = svgEl('svg', { width: size, height: size, viewBox: `0 0 ${size} ${size}`, role: 'img', class: 'aisa-ring__svg' }, cell);
      svg.setAttribute('aria-label', `${it.label ?? ''} ${pct(frac)}`.trim());
      svgEl('circle', { cx: size / 2, cy: size / 2, r, fill: 'none', stroke: trackColor(host), 'stroke-width': sw }, svg);
      const arc = svgEl('circle', {
        cx: size / 2, cy: size / 2, r, fill: 'none', stroke: color, 'stroke-width': sw, 'stroke-linecap': 'round',
        'stroke-dasharray': `${Math.max(0, Math.min(1, frac)) * circ} ${circ}`, transform: `rotate(-90 ${size / 2} ${size / 2})`, class: 'aisa-ring__arc',
      }, svg);
      void arc;
      if (!c.inline) {
        const t = svgEl('text', { x: size / 2, y: size / 2 + size * 0.07, 'text-anchor': 'middle', class: 'aisa-ring__value', fill: token(host, '--aisa-text'), style: `font-size:${Math.round(size * 0.2)}px` }, svg);
        t.textContent = it.centerValue ?? pct(frac);
      }
      const text = el('div', 'aisa-ring__text', cell);
      if (c.inline) el('div', 'aisa-ring__pct', text, it.centerValue ?? pct(frac));
      if (it.label) el('div', 'aisa-ring__label', text, it.label);
      if (it.sub) el('div', 'aisa-ring__sub', text, it.sub);
      cell.tabIndex = c.interactive === false ? -1 : 0;
      const show = () => showTip(tip, plot, cell.offsetLeft + cell.offsetWidth / 2, cell.offsetTop + size / 2, it.label ?? '', [{ name: '', value: `${fmt(it.value)} / ${fmt(max)} · ${pct(frac, 1)}`, color, shape: 'rect' }]);
      if (c.interactive !== false) {
        cell.addEventListener('pointerenter', show);
        cell.addEventListener('focus', show);
        cell.addEventListener('pointerleave', () => hideTip(tip));
        cell.addEventListener('blur', () => hideTip(tip));
      }
    });
    void hits;
    renderTable(tableWrap, ['', msg('actual'), msg('target'), '%'], items.map((it) => {
      const max = it.max ?? it.target ?? c.max ?? 1;
      return [it.label ?? '', fmt(it.value), fmt(max), pct((Number(it.value) || 0) / (max || 1), 1)];
    }));
  });
}

// ================================================================ WAFFLE (100 unit squares)
/**
 * waffleChart(host, { items: [{ name, value }] (1–4), total (defaults to the sum), format, title, subtitle,
 *   showValue: true (big share of the first item) , valueLabel })
 * One item: its share in the theme ink, the rest as track. Several items: categorical slots.
 */
export function waffleChart(host, cfg) {
  return mount(host, cfg, (host, state) => {
    const c = state.cfg;
    const { legend, plot, tip, tableWrap } = frame(host, c, 'waffle');
    const items = (c.items ?? []).slice(0, 4);
    const fmt = formatter(c.format);
    const sum = items.reduce((a, b) => a + (Number(b.value) || 0), 0);
    const total = c.total ?? sum;
    const single = items.length === 1;
    const colors = items.map((_, i) => (single ? (c.tone === 'accent' ? emphColor(host) : singleColor(host)) : seriesColor(host, i)));
    renderLegend(legend, items.map((it, i) => ({ name: `${it.name} · ${pct(total ? it.value / total : 0)}`, color: colors[i] })));
    // largest-remainder rounding so the squares add up to exactly 100 (or less when total > sum)
    const raw = items.map((it) => (total ? (it.value / total) * 100 : 0));
    const cells = raw.map(Math.floor);
    let left = Math.round(Math.min(100, (sum / (total || 1)) * 100)) - cells.reduce((a, b) => a + b, 0);
    raw.map((v, i) => [v - Math.floor(v), i]).sort((a, b) => b[0] - a[0]).forEach(([, i]) => {
      if (left > 0) {
        cells[i]++;
        left--;
      }
    });
    const avail = Math.min(c.width ?? host.clientWidth ?? 240, 260);
    const cell = Math.max(8, Math.min(c.cell ?? 16, Math.floor((avail + 2) / 10)));
    const side = cell * 10 - 2;
    const wrap = el('div', 'aisa-waffle', plot);
    const svg = svgEl('svg', { width: side, height: side, viewBox: `0 0 ${side} ${side}`, role: 'img', class: 'aisa-chart__svg', tabindex: c.interactive === false ? undefined : 0 }, wrap);
    svg.setAttribute('aria-label', c.title || 'Waffle chart');
    const hits = svgEl('g', {}, svg);
    let k = 0;
    const owner = [];
    cells.forEach((n, i) => {
      for (let j = 0; j < n; j++) owner[k++] = i;
    });
    for (let idx = 0; idx < 100; idx++) {
      const col = idx % 10;
      const rowI = Math.floor(idx / 10);
      const it = owner[idx];
      const rect = svgEl('rect', { x: col * cell, y: rowI * cell, width: cell - 2, height: cell - 2, rx: Math.min(3, cell / 5), fill: it === undefined ? trackColor(host) : colors[it], class: 'aisa-chart__cell' }, hits);
      if (it !== undefined) {
        rect.__show = () => showTip(tip, plot, col * cell + cell, rowI * cell, items[it].name, [{ name: pct(items[it].value / (total || 1), 1), value: fmt(items[it].value), color: colors[it], shape: 'rect' }]);
        if (c.interactive !== false) {
          rect.addEventListener('pointermove', rect.__show);
          rect.addEventListener('pointerleave', () => hideTip(tip));
        }
      }
    }
    if (c.showValue !== false && items.length) {
      const fig = el('div', 'aisa-waffle__figure', wrap);
      el('div', 'aisa-waffle__value', fig, pct(total ? items[0].value / total : 0));
      el('div', 'aisa-waffle__label', fig, c.valueLabel ?? items[0].name);
      if (c.valueSub) el('div', 'aisa-waffle__sub', fig, c.valueSub);
    }
    keyboardNav(svg, { get children() { return [...hits.children].filter((n) => n.__show); } }, tip);
    renderTable(tableWrap, ['', '', '%'], items.map((it) => [it.name, fmt(it.value), pct(total ? it.value / total : 0, 1)]));
  });
}

// ================================================================ FUNNEL
/** funnelChart(host, { stages: [{ name, value }], format, title, subtitle, showConversion: true }) — ordered stages in the ordinal ramp. */
export function funnelChart(host, cfg) {
  return mount(host, cfg, (host, state) => {
    const c = state.cfg;
    const { legend, plot, tip, tableWrap } = frame(host, c, 'funnel');
    legend.hidden = true;
    const stages = c.stages ?? [];
    const fmt = formatter(c.format);
    const max = Math.max(...stages.map((s) => Number(s.value) || 0), 1);
    const width = c.width ?? Math.max(220, host.clientWidth || 400);
    const labelW = Math.min(110, Math.ceil(Math.max(...stages.map((s) => textWidth(String(s.name), 11)), 0)) + 10);
    const valueW = Math.ceil(Math.max(...stages.map((s) => textWidth(fmt(s.value), 11)), 0)) + 10;
    const barW = width - labelW - valueW;
    const rowH = 26;
    const gapH = c.showConversion === false ? 4 : 16;
    const height = stages.length * rowH + Math.max(0, stages.length - 1) * gapH;
    const svg = svgEl('svg', { width, height, viewBox: `0 0 ${width} ${height}`, role: 'img', class: 'aisa-chart__svg', tabindex: c.interactive === false ? undefined : 0 }, plot);
    svg.setAttribute('aria-label', c.title || 'Funnel');
    const hits = svgEl('g', {}, svg);
    const text = token(host, '--aisa-text-body');
    const muted = token(host, '--aisa-text-muted');
    stages.forEach((st, i) => {
      const y = i * (rowH + gapH);
      // darkest step for the first (largest) stage
      const step = stages.length <= 1 ? 5 : Math.round(5 - (i / (stages.length - 1)) * 4);
      const fill = rampColor(host, 'ord', step);
      const w = Math.max(4, ((Number(st.value) || 0) / max) * barW);
      const x = labelW + (barW - w) / 2;
      svgEl('text', { x: labelW - 10, y: y + rowH / 2 + 4, 'text-anchor': 'end', fill: text, class: 'aisa-chart__tick' }, svg).textContent = String(st.name);
      const rect = svgEl('rect', { x, y: y + 3, width: w, height: rowH - 6, rx: 4, fill, class: 'aisa-chart__bar' }, hits);
      svgEl('text', { x: width - valueW + 8, y: y + rowH / 2 + 4, fill: text, class: 'aisa-chart__value' }, svg).textContent = fmt(st.value);
      if (i > 0 && c.showConversion !== false && stages[i - 1].value) {
        svgEl('text', { x: labelW + barW / 2, y: y - gapH / 2 + 4, 'text-anchor': 'middle', fill: muted, class: 'aisa-chart__ref-label' }, svg).textContent = msg('conversion', { pct: pct(st.value / stages[i - 1].value) });
      }
      rect.__show = () => showTip(tip, plot, x + w, y + rowH / 2, String(st.name), [
        { name: '', value: fmt(st.value), color: fill, shape: 'rect' },
        ...(i > 0 && stages[0].value ? [{ name: stages[0].name, value: pct(st.value / stages[0].value, 1), color: 'transparent' }] : []),
      ]);
      if (c.interactive !== false) {
        rect.addEventListener('pointermove', rect.__show);
        rect.addEventListener('pointerleave', () => hideTip(tip));
      }
    });
    keyboardNav(svg, hits, tip);
    renderTable(tableWrap, ['', '', '%'], stages.map((st, i) => [String(st.name), fmt(st.value), i === 0 || !stages[i - 1].value ? '–' : pct(st.value / stages[i - 1].value, 1)]));
  });
}

// ================================================================ RANK LIST (leaderboard)
/**
 * rankList(host, { items: [{ name, sub, value, avatar (image url), initial }], format, limit: 8, sort: true,
 *   highlight: 'top' | index | undefined (that row's bar in the accent), avatars: false, title, subtitle })
 */
export function rankList(host, cfg) {
  return mount(host, cfg, (host, state) => {
    const c = state.cfg;
    const { legend, plot, tableWrap } = frame(host, c, 'rank');
    legend.hidden = true;
    const fmt = formatter(c.format);
    let items = [...(c.items ?? [])];
    if (c.sort !== false) items.sort((a, b) => (Number(b.value) || 0) - (Number(a.value) || 0));
    items = items.slice(0, c.limit ?? 8);
    const max = Math.max(...items.map((i) => Number(i.value) || 0), 1);
    const hi = c.highlight === 'top' ? 0 : c.highlight;
    const list = el('ol', 'aisa-rank', plot);
    items.forEach((it, i) => {
      const li = el('li', `aisa-rank__row${i === hi ? ' is-emph' : ''}`, list);
      el('span', 'aisa-rank__no', li, String(i + 1).padStart(2, '0'));
      if (c.avatars || it.avatar || it.initial) {
        if (it.avatar) {
          const img = el('img', 'aisa-rank__avatar', li);
          img.src = it.avatar;
          img.alt = '';
        } else el('span', 'aisa-rank__avatar', li, (it.initial ?? String(it.name).slice(0, 1)).toUpperCase());
      }
      const main = el('span', 'aisa-rank__main', li);
      const top = el('span', 'aisa-rank__top', main);
      el('span', 'aisa-rank__name', top, String(it.name));
      el('span', 'aisa-rank__value', top, fmt(it.value));
      if (it.sub) el('span', 'aisa-rank__sub', main, it.sub);
      const bar = el('span', 'aisa-rank__bar', main);
      const fill = el('span', 'aisa-rank__fill', bar);
      fill.style.width = `${((Number(it.value) || 0) / max) * 100}%`;
      fill.style.background = i === hi ? emphColor(host) : singleColor(host);
    });
    renderTable(tableWrap, ['#', '', ''], items.map((it, i) => [String(i + 1), String(it.name), fmt(it.value)]));
  });
}

// ================================================================ SLOPE (start → end per series)
/**
 * slopeChart(host, { startLabel, endLabel, series: [{ name, start, end }], highlight: index (accent; rest muted),
 *   format, title, subtitle, height }) — for "who moved up or down" between two moments.
 */
export function slopeChart(host, cfg) {
  return mount(host, cfg, (host, state) => {
    const c = state.cfg;
    const { legend, plot, tip, tableWrap } = frame(host, c, 'slope');
    legend.hidden = true;
    const series = c.series ?? [];
    const fmt = formatter(c.format);
    const vals = series.flatMap((s) => [Number(s.start), Number(s.end)]);
    const scale = niceScale(Math.min(...vals), Math.max(...vals), { zero: false, ticks: 4 });
    const width = c.width ?? Math.max(240, host.clientWidth || 480);
    const height = c.height ?? Math.max(180, series.length * 22 + 60);
    const lab = (s, side) => (side === 'l' ? `${s.name} ${fmt(s.start)}` : `${fmt(s.end)} ${s.name}`);
    const lw = Math.min(width * 0.32, Math.max(...series.map((s) => textWidth(lab(s, 'l'), 10.5)), 0) + 12);
    const rw = Math.min(width * 0.32, Math.max(...series.map((s) => textWidth(lab(s, 'r'), 10.5)), 0) + 12);
    const top = 26;
    const bottom = 10;
    const x0 = lw;
    const x1 = width - rw;
    const y = (v) => top + (1 - (v - scale.min) / (scale.max - scale.min)) * (height - top - bottom);
    const svg = svgEl('svg', { width, height, viewBox: `0 0 ${width} ${height}`, role: 'img', class: 'aisa-chart__svg', tabindex: c.interactive === false ? undefined : 0 }, plot);
    svg.setAttribute('aria-label', c.title || 'Slope chart');
    const axisC = token(host, '--aisa-chart-grid');
    const muted = token(host, '--aisa-text-muted');
    const text = token(host, '--aisa-text-secondary');
    const surface = token(host, '--aisa-surface');
    for (const x of [x0, x1]) svgEl('line', { x1: x, x2: x, y1: top - 6, y2: height - bottom, stroke: axisC, 'stroke-width': 1, 'shape-rendering': 'crispEdges' }, svg);
    svgEl('text', { x: x0, y: 12, 'text-anchor': 'middle', fill: muted, class: 'aisa-chart__tick' }, svg).textContent = c.startLabel ?? msg('start');
    svgEl('text', { x: x1, y: 12, 'text-anchor': 'middle', fill: muted, class: 'aisa-chart__tick' }, svg).textContent = c.endLabel ?? msg('end');
    const color = (i) => (c.highlight === undefined ? singleColor(host) : i === c.highlight ? emphColor(host) : mutedColor(host));
    // spread labels that would overlap (min 12px apart), keeping order
    const spread = (ys) => {
      const order = ys.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
      for (let k = 1; k < order.length; k++) if (order[k][0] - order[k - 1][0] < 12) order[k][0] = order[k - 1][0] + 12;
      const out = [];
      order.forEach(([v, i]) => (out[i] = v));
      return out;
    };
    const ly = spread(series.map((s) => y(Number(s.start))));
    const ry = spread(series.map((s) => y(Number(s.end))));
    const hits = svgEl('g', {}, svg);
    const order = series.map((_, i) => i).sort((a, b) => (a === c.highlight) - (b === c.highlight));
    for (const i of order) {
      const s = series[i];
      const g = svgEl('g', {}, hits);
      svgEl('line', { x1: x0, y1: y(Number(s.start)), x2: x1, y2: y(Number(s.end)), stroke: color(i), 'stroke-width': 2, 'stroke-linecap': 'round' }, g);
      for (const [x, v] of [[x0, s.start], [x1, s.end]]) svgEl('circle', { cx: x, cy: y(Number(v)), r: 4, fill: color(i), stroke: surface, 'stroke-width': 2 }, g);
      const em = i === c.highlight;
      svgEl('text', { x: x0 - 8, y: ly[i] + 3.5, 'text-anchor': 'end', fill: em ? token(host, '--aisa-text') : text, class: 'aisa-chart__value' }, svg).textContent = lab(s, 'l');
      svgEl('text', { x: x1 + 8, y: ry[i] + 3.5, fill: em ? token(host, '--aisa-text') : text, class: 'aisa-chart__value' }, svg).textContent = lab(s, 'r');
      g.__show = () => showTip(tip, plot, x1, y(Number(s.end)), s.name, [
        { name: c.startLabel ?? msg('start'), value: fmt(s.start), color: color(i) },
        { name: c.endLabel ?? msg('end'), value: fmt(s.end), color: color(i) },
      ]);
      if (c.interactive !== false) {
        g.addEventListener('pointermove', g.__show);
        g.addEventListener('pointerleave', () => hideTip(tip));
      }
    }
    keyboardNav(svg, hits, tip);
    renderTable(tableWrap, ['', c.startLabel ?? msg('start'), c.endLabel ?? msg('end')], series.map((s) => [s.name, fmt(s.start), fmt(s.end)]));
  });
}

// ================================================================ SEGMENT BAR (100% part-to-whole in one bar)
/** segmentBar(host, { items: [{ name, value }] (≤ 6; more fold into Other), format, height: 12, labels: true, title, subtitle }) */
export function segmentBar(host, cfg) {
  return mount(host, cfg, (host, state) => {
    const c = state.cfg;
    const { legend, plot, tip, tableWrap } = frame(host, c, 'segment');
    const fmt = formatter(c.format);
    let items = [...(c.items ?? [])];
    if (items.length > 6) {
      const rest = items.slice(5).reduce((a, b) => a + (Number(b.value) || 0), 0);
      items = [...items.slice(0, 5), { name: msg('other'), value: rest, other: true }];
    }
    const total = items.reduce((a, b) => a + (Number(b.value) || 0), 0) || 1;
    const colors = items.map((it, i) => (it.other ? mutedColor(host) : seriesColor(host, i)));
    renderLegend(legend, items.map((it, i) => ({ name: `${it.name} · ${pct(it.value / total)}`, color: colors[i] })));
    const width = c.width ?? Math.max(200, host.clientWidth || 400);
    const h = c.height ?? 12;
    const svg = svgEl('svg', { width, height: h, viewBox: `0 0 ${width} ${h}`, role: 'img', class: 'aisa-chart__svg', tabindex: c.interactive === false ? undefined : 0 }, plot);
    svg.setAttribute('aria-label', c.title || 'Part-to-whole bar');
    const hits = svgEl('g', {}, svg);
    let x = 0;
    items.forEach((it, i) => {
      const w = ((Number(it.value) || 0) / total) * width;
      const first = i === 0;
      const last = i === items.length - 1;
      const x0 = x + (first ? 0 : 1);
      const ww = Math.max(0, w - (first ? 0 : 1) - (last ? 0 : 1));
      const r = Math.min(4, h / 2);
      let d;
      if (first && last) d = `M${x0 + r},0H${x0 + ww - r}Q${x0 + ww},0 ${x0 + ww},${r}V${h - r}Q${x0 + ww},${h} ${x0 + ww - r},${h}H${x0 + r}Q${x0},${h} ${x0},${h - r}V${r}Q${x0},0 ${x0 + r},0Z`;
      else if (first) d = `M${x0 + r},0H${x0 + ww}V${h}H${x0 + r}Q${x0},${h} ${x0},${h - r}V${r}Q${x0},0 ${x0 + r},0Z`;
      else if (last) d = `M${x0},0H${x0 + ww - r}Q${x0 + ww},0 ${x0 + ww},${r}V${h - r}Q${x0 + ww},${h} ${x0 + ww - r},${h}H${x0}Z`;
      else d = `M${x0},0h${ww}v${h}h${-ww}Z`;
      const seg = svgEl('path', { d, fill: colors[i], class: 'aisa-chart__seg' }, hits);
      const mid = x + w / 2;
      seg.__show = () => showTip(tip, plot, mid, h / 2, it.name, [{ name: pct(it.value / total, 1), value: fmt(it.value), color: colors[i], shape: 'rect' }]);
      if (c.interactive !== false) {
        seg.addEventListener('pointermove', seg.__show);
        seg.addEventListener('pointerleave', () => hideTip(tip));
      }
      x += w;
    });
    keyboardNav(svg, hits, tip);
    renderTable(tableWrap, ['', '', '%'], items.map((it) => [it.name, fmt(it.value), pct(it.value / total, 1)]));
  });
}

// ================================================================ DIVERGING BAR (above / below a baseline)
/** divergingBar(host, { categories, values (signed), format, negLabel, posLabel, title, subtitle }) — orange below, blue above, grey midline. */
export function divergingBar(host, cfg) {
  return mount(host, cfg, (host, state) => {
    const c = state.cfg;
    const { legend, plot, tip, tableWrap } = frame(host, c, 'diverging');
    const cats = c.categories ?? [];
    const vals = (c.values ?? []).map(Number);
    const fmt = formatter(c.format);
    const neg = token(host, '--aisa-div-neg');
    const pos = token(host, '--aisa-div-pos');
    renderLegend(legend, [{ name: c.negLabel ?? '−', color: neg }, { name: c.posLabel ?? '+', color: pos }]);
    if (!c.negLabel && !c.posLabel) legend.hidden = true;
    const m = Math.max(...vals.map(Math.abs), 1);
    const width = c.width ?? Math.max(240, host.clientWidth || 480);
    const labelW = Math.min(width * 0.3, Math.ceil(Math.max(...cats.map((x) => textWidth(String(x), 10.5)), 0)) + 12);
    const valW = Math.ceil(Math.max(...vals.map((v) => textWidth(fmt(v), 10.5)), 0)) + 8;
    const rowH = 24;
    const height = cats.length * rowH + 6;
    const plotW = width - labelW - valW * 2;
    const mid = labelW + valW + plotW / 2;
    const svg = svgEl('svg', { width, height, viewBox: `0 0 ${width} ${height}`, role: 'img', class: 'aisa-chart__svg', tabindex: c.interactive === false ? undefined : 0 }, plot);
    svg.setAttribute('aria-label', c.title || 'Diverging bar chart');
    const text = token(host, '--aisa-text-secondary');
    svgEl('line', { x1: mid, x2: mid, y1: 0, y2: height, stroke: token(host, '--aisa-chart-axis'), 'stroke-width': 1, 'shape-rendering': 'crispEdges' }, svg);
    const hits = svgEl('g', {}, svg);
    cats.forEach((cat, i) => {
      const v = vals[i] || 0;
      const y = i * rowH + 3;
      const len = (Math.abs(v) / m) * (plotW / 2);
      const th = Math.min(14, rowH - 8);
      const yy = y + (rowH - th) / 2;
      svgEl('text', { x: labelW - 10, y: y + rowH / 2 + 3.5, 'text-anchor': 'end', fill: text, class: 'aisa-chart__tick' }, svg).textContent = String(cat);
      const d = v >= 0 ? barPath(mid + 1, yy, len, th, 'right') : barPath(mid - 1 - len, yy, len, th, 'left');
      const bar = d ? svgEl('path', { d, fill: v >= 0 ? pos : neg, class: 'aisa-chart__bar' }, hits) : svgEl('rect', { x: mid, y: yy, width: 0, height: th }, hits);
      svgEl('text', { x: v >= 0 ? mid + len + 6 : mid - len - 6, y: y + rowH / 2 + 3.5, 'text-anchor': v >= 0 ? 'start' : 'end', fill: text, class: 'aisa-chart__value' }, svg).textContent = `${v > 0 ? '+' : ''}${fmt(v)}`;
      bar.__show = () => showTip(tip, plot, v >= 0 ? mid + len : mid - len, y + rowH / 2, String(cat), [{ name: '', value: `${v > 0 ? '+' : ''}${fmt(v)}`, color: v >= 0 ? pos : neg, shape: 'rect' }]);
      if (c.interactive !== false) {
        bar.addEventListener('pointermove', bar.__show);
        bar.addEventListener('pointerleave', () => hideTip(tip));
      }
    });
    keyboardNav(svg, hits, tip);
    renderTable(tableWrap, ['', ''], cats.map((cat, i) => [String(cat), fmt(vals[i])]));
  });
}

// ---------------------------------------------------------------- dates (UTC, 'YYYY-MM-DD')
const DAY = 86400000;
const parseDay = (s) => {
  if (s instanceof Date) return Date.UTC(s.getFullYear(), s.getMonth(), s.getDate());
  const [y, mo, d] = String(s).slice(0, 10).split('-').map(Number);
  return Date.UTC(y, (mo || 1) - 1, d || 1);
};
const isoDay = (t) => new Date(t).toISOString().slice(0, 10);
const fmtDay = (t, opts = { month: 'short', day: 'numeric' }) => new Intl.DateTimeFormat(locale(), { ...opts, timeZone: 'UTC' }).format(new Date(t));

// ================================================================ CALENDAR HEATMAP (GitHub-style)
/**
 * calendarHeatmap(host, { data: [{ date: 'YYYY-MM-DD', value }] | { 'YYYY-MM-DD': value }, start, end (default: last 52 weeks),
 *   weekStart: 1 (Monday), format, title, subtitle, cell })
 * Zero/missing days use the lightest step; more is darker (sequential ramp of the chart theme).
 */
export function calendarHeatmap(host, cfg) {
  return mount(host, cfg, (host, state) => {
    const c = state.cfg;
    const { legend, plot, tip, tableWrap } = frame(host, c, 'calendar');
    legend.hidden = true;
    const fmt = formatter(c.format);
    const map = new Map();
    const src = Array.isArray(c.data) ? c.data.map((d) => [d.date, d.value]) : Object.entries(c.data ?? {});
    for (const [d, v] of src) map.set(isoDay(parseDay(d)), Number(v) || 0);
    const end = c.end ? parseDay(c.end) : parseDay(new Date());
    let start = c.start ? parseDay(c.start) : end - 364 * DAY;
    const ws = c.weekStart ?? 1;
    const dow = (t) => (new Date(t).getUTCDay() - ws + 7) % 7;
    start -= dow(start) * DAY;
    const weeks = Math.ceil((end - start + DAY) / (7 * DAY));
    const dayName = (r) => new Intl.DateTimeFormat(locale(), { weekday: 'short', timeZone: 'UTC' }).format(new Date(start + r * DAY));
    const labelW = Math.ceil(Math.max(...[0, 2, 4].map((r) => textWidth(dayName(r), 11)))) + 8;
    const avail = (c.width ?? host.clientWidth ?? 700) - labelW - 4;
    const cell = Math.max(7, Math.min(c.cell ?? 22, Math.floor(avail / weeks)));
    const width = labelW + weeks * cell + 2;
    const top = 16;
    const height = top + 7 * cell + 26;
    const svg = svgEl('svg', { width, height, viewBox: `0 0 ${width} ${height}`, role: 'img', class: 'aisa-chart__svg', tabindex: c.interactive === false ? undefined : 0 }, plot);
    svg.setAttribute('aria-label', c.title || 'Calendar heatmap');
    const muted = token(host, '--aisa-text-muted');
    const max = Math.max(...map.values(), 0);
    const level = (v) => (!v || v <= 0 ? 1 : Math.min(7, 2 + Math.floor((v / (max || 1)) * 5.999)));
    // weekday labels: 2nd, 4th, 6th row (e.g. Tue Thu Sat when weeks start Monday)
    for (const r of [0, 2, 4]) {
      svgEl('text', { x: 0, y: top + r * cell + cell / 2 + 4, fill: muted, class: 'aisa-chart__tick' }, svg).textContent = dayName(r);
    }
    const hits = svgEl('g', {}, svg);
    let lastMonth = -1;
    const monthTotals = new Map();
    for (let w = 0; w < weeks; w++) {
      for (let d = 0; d < 7; d++) {
        const t = start + (w * 7 + d) * DAY;
        if (t > end) continue;
        const key = isoDay(t);
        const v = map.get(key) ?? 0;
        const mk = key.slice(0, 7);
        monthTotals.set(mk, (monthTotals.get(mk) ?? 0) + v);
        const rect = svgEl('rect', { x: labelW + w * cell, y: top + d * cell, width: cell - 2, height: cell - 2, rx: Math.min(2.5, cell / 5), fill: rampColor(host, 'seq', level(v)), class: 'aisa-chart__cell' }, hits);
        rect.__show = () => showTip(tip, plot, labelW + w * cell + cell, top + d * cell, fmtDay(t, { year: 'numeric', month: 'short', day: 'numeric', weekday: 'short' }), [{ name: '', value: fmt(v), color: rect.getAttribute('fill'), shape: 'rect' }]);
        if (c.interactive !== false) {
          rect.addEventListener('pointermove', rect.__show);
          rect.addEventListener('pointerleave', () => hideTip(tip));
        }
      }
      const firstOfWeek = start + w * 7 * DAY;
      const month = new Date(firstOfWeek).getUTCMonth();
      if (month !== lastMonth && w < weeks - 1) {
        if (lastMonth !== -1 || new Date(firstOfWeek).getUTCDate() <= 7) {
          svgEl('text', { x: labelW + w * cell, y: 10, fill: muted, class: 'aisa-chart__tick' }, svg).textContent = fmtDay(firstOfWeek, { month: 'short' });
        }
        lastMonth = month;
      }
    }
    // scale: less ▢▢▢ more
    const ly = top + 7 * cell + 10;
    const lx = width - 7 * 12 - textWidth(msg('more'), 10.5) - 10;
    svgEl('text', { x: lx - 6, y: ly + 9, 'text-anchor': 'end', fill: muted, class: 'aisa-chart__tick' }, svg).textContent = msg('less');
    for (let s = 1; s <= 7; s++) svgEl('rect', { x: lx + (s - 1) * 12, y: ly, width: 10, height: 10, rx: 2, fill: rampColor(host, 'seq', s) }, svg);
    svgEl('text', { x: lx + 7 * 12 + 4, y: ly + 9, fill: muted, class: 'aisa-chart__tick' }, svg).textContent = msg('more');
    keyboardNav(svg, hits, tip);
    renderTable(tableWrap, ['', msg('total')], [...monthTotals].map(([mk, v]) => [fmtDay(parseDay(`${mk}-01`), { year: 'numeric', month: 'short' }), fmt(v)]));
  });
}

// ================================================================ GANTT
/**
 * ganttChart(host, { tasks: [{ name, owner, start: 'YYYY-MM-DD', end, progress: 0..1, milestone: false }],
 *   today: 'YYYY-MM-DD' | false (default: now), start, end (visible range), title, subtitle })
 * Done part solid in the theme ink, the rest outlined; milestones as diamonds; "today" as a thin accent rule.
 */
export function ganttChart(host, cfg) {
  return mount(host, cfg, (host, state) => {
    const c = state.cfg;
    const { legend, plot, tip, tableWrap } = frame(host, c, 'gantt');
    legend.hidden = true;
    const tasks = c.tasks ?? [];
    const ink = singleColor(host);
    const emph = emphColor(host);
    const line = token(host, '--aisa-line-strong') || token(host, '--aisa-line');
    const grid = token(host, '--aisa-chart-grid');
    const muted = token(host, '--aisa-text-muted');
    const text = token(host, '--aisa-text');
    const surface = token(host, '--aisa-surface');
    const t0 = c.start ? parseDay(c.start) : Math.min(...tasks.map((t) => parseDay(t.start)));
    const t1 = c.end ? parseDay(c.end) : Math.max(...tasks.map((t) => parseDay(t.end ?? t.start))) + DAY;
    const pad = Math.max(DAY, (t1 - t0) * 0.02);
    const a = t0 - pad;
    const b = t1 + pad;
    const width = c.width ?? Math.max(320, host.clientWidth || 700);
    const hasOwner = tasks.some((t) => t.owner);
    const labelW = Math.max(120, Math.min(width * 0.24, Math.ceil(Math.max(...tasks.map((t) => Math.max(textWidth(t.name, 12.5), textWidth(t.owner ?? '', 11))), 0)) + 28));
    const rowH = hasOwner ? 46 : 36;
    const top = 30;
    const plotW = width - labelW - 44;
    const height = top + tasks.length * rowH + 8;
    const x = (t) => labelW + ((t - a) / (b - a)) * plotW;
    const svg = svgEl('svg', { width, height, viewBox: `0 0 ${width} ${height}`, role: 'img', class: 'aisa-chart__svg', tabindex: c.interactive === false ? undefined : 0 }, plot);
    svg.setAttribute('aria-label', c.title || 'Gantt chart');
    // time axis: months when the span is long, weeks otherwise
    const span = (b - a) / DAY;
    const ticks = [];
    if (span > 75) {
      const d = new Date(a);
      let t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
      while (t < b) {
        ticks.push([t, fmtDay(t, { month: 'short' })]);
        const n = new Date(t);
        t = Date.UTC(n.getUTCFullYear(), n.getUTCMonth() + 1, 1);
      }
    } else {
      let t = a + ((8 - new Date(a).getUTCDay()) % 7) * DAY; // next Monday
      while (t < b) {
        ticks.push([t, fmtDay(t)]);
        t += (span > 35 ? 14 : 7) * DAY;
      }
    }
    const todayX = c.today === false ? null : x(c.today ? parseDay(c.today) : parseDay(new Date()));
    for (const [t, label] of ticks) {
      svgEl('line', { x1: x(t), x2: x(t), y1: top - 6, y2: height - 4, stroke: grid, 'stroke-width': 1, 'shape-rendering': 'crispEdges' }, svg);
      const covered = todayX !== null && Math.abs(x(t) + 3 + textWidth(label, 11) / 2 - todayX) < textWidth(label, 11) / 2 + textWidth(msg('today'), 11) / 2 + 12;
      if (!covered) svgEl('text', { x: x(t) + 3, y: 14, fill: muted, class: 'aisa-chart__tick' }, svg).textContent = label;
    }
    svgEl('line', { x1: labelW, x2: labelW + plotW, y1: top - 6, y2: top - 6, stroke: grid, 'stroke-width': 1, 'shape-rendering': 'crispEdges' }, svg);
    const hits = svgEl('g', {}, svg);
    tasks.forEach((tk, i) => {
      const y = top + i * rowH;
      const s = parseDay(tk.start);
      const e = tk.milestone ? s : parseDay(tk.end ?? tk.start) + DAY;
      const nm = svgEl('text', { x: 0, y: y + (tk.owner ? 13 : 19), fill: text, class: 'aisa-gantt__name' }, svg);
      nm.textContent = fitText(tk.name, labelW - 10, 12.5);
      if (tk.owner) svgEl('text', { x: 0, y: y + 27, fill: muted, class: 'aisa-chart__tick' }, svg).textContent = fitText(tk.owner, labelW - 10, 11);
      const g = svgEl('g', { class: 'aisa-gantt__task' }, hits);
      const cy = y + rowH / 2 - 2;
      if (tk.milestone) {
        const r = 6;
        svgEl('path', { d: `M${x(s)},${cy - r}L${x(s) + r},${cy}L${x(s)},${cy + r}L${x(s) - r},${cy}Z`, fill: emph, stroke: surface, 'stroke-width': 2 }, g);
        svgEl('text', { x: x(s) + r + 6, y: cy + 3.5, fill: muted, class: 'aisa-chart__value' }, g).textContent = fmtDay(s);
      } else {
        const bh = 10;
        const x0 = x(s);
        const w = Math.max(4, x(e) - x0);
        const p = Math.max(0, Math.min(1, Number(tk.progress) || 0));
        svgEl('rect', { x: x0 + 0.5, y: cy - bh / 2 + 0.5, width: w - 1, height: bh - 1, rx: 3, fill: surface, stroke: line, 'stroke-width': 1 }, g);
        if (p > 0) svgEl('path', { d: barPath(x0, cy - bh / 2, Math.max(4, w * p), bh, p >= 0.999 ? null : 'right').replace(/^$/, `M${x0},${cy - bh / 2}h${w}v${bh}h${-w}Z`), fill: ink, class: 'aisa-chart__bar' }, g);
        svgEl('text', { x: x0 + w + 6, y: cy + 3.5, fill: muted, class: 'aisa-chart__value' }, g).textContent = pct(p);
      }
      svgEl('rect', { x: 0, y, width, height: rowH, fill: 'transparent' }, g);
      g.__show = () => showTip(tip, plot, tk.milestone ? x(s) : x(e), cy, tk.name, [
        ...(tk.owner ? [{ name: '', value: tk.owner, color: 'transparent' }] : []),
        { name: tk.milestone ? '' : `→ ${fmtDay(e - DAY)}`, value: fmtDay(s), color: 'transparent' },
        ...(tk.milestone ? [] : [{ name: msg('progress'), value: pct(Number(tk.progress) || 0), color: ink, shape: 'rect' }]),
      ]);
      if (c.interactive !== false) {
        g.addEventListener('pointermove', g.__show);
        g.addEventListener('pointerleave', () => hideTip(tip));
      }
    });
    if (c.today !== false) {
      const t = c.today ? parseDay(c.today) : parseDay(new Date());
      if (t >= a && t <= b) {
        svgEl('line', { x1: x(t), x2: x(t), y1: top - 10, y2: height - 4, stroke: emph, 'stroke-width': 1, 'shape-rendering': 'crispEdges' }, svg);
        const label = msg('today');
        const lw = textWidth(label, 10) + 10;
        svgEl('rect', { x: x(t) - lw / 2, y: top - 22, width: lw, height: 14, rx: 7, fill: emph }, svg);
        svgEl('text', { x: x(t), y: top - 12, 'text-anchor': 'middle', fill: onFill(emph), class: 'aisa-gantt__today' }, svg).textContent = label;
      }
    }
    keyboardNav(svg, hits, tip);
    renderTable(tableWrap, ['', '', msg('start'), msg('end'), msg('progress')], tasks.map((tk) => [tk.name, tk.owner ?? '', fmtDay(parseDay(tk.start)), tk.milestone ? '–' : fmtDay(parseDay(tk.end ?? tk.start)), tk.milestone ? '◆' : pct(Number(tk.progress) || 0)]));
  });
}

// ================================================================ PROGRESS LIST (key results)
/**
 * progressList(host, { items: [{ label, sub, value, target (omit when value is already 0..1), tone: 'ink'|'accent'|'warning'|'danger' }],
 *   format, title, subtitle })
 */
export function progressList(host, cfg) {
  return mount(host, cfg, (host, state) => {
    const c = state.cfg;
    const { legend, plot, tableWrap } = frame(host, c, 'progress');
    legend.hidden = true;
    const fmt = formatter(c.format);
    const list = el('ul', 'aisa-progress-list', plot);
    const rows = [];
    for (const it of c.items ?? []) {
      const frac = it.target ? (Number(it.value) || 0) / it.target : Number(it.value) || 0;
      const li = el('li', `aisa-progress-list__row aisa-progress-list__row--${it.tone ?? 'ink'}`, list);
      const head = el('div', 'aisa-progress-list__head', li);
      const name = el('div', 'aisa-progress-list__label', head);
      el('span', '', name, it.label);
      if (it.sub) el('small', '', name, it.sub);
      const f = it.format ? formatter(it.format) : fmt;
      if (it.target) el('span', 'aisa-progress-list__value', head, `${f(it.value)} / ${f(it.target)}`);
      el('strong', 'aisa-progress-list__pct', head, pct(frac));
      const track = el('div', 'aisa-progress-list__track', li);
      track.setAttribute('role', 'meter');
      track.setAttribute('aria-valuemin', '0');
      track.setAttribute('aria-valuemax', '100');
      track.setAttribute('aria-valuenow', String(Math.round(frac * 100)));
      track.setAttribute('aria-label', it.label);
      el('div', 'aisa-progress-list__fill', track).style.width = `${Math.max(0, Math.min(1, frac)) * 100}%`;
      rows.push([it.label, it.target ? `${f(it.value)} / ${f(it.target)}` : '', pct(frac, 1)]);
    }
    renderTable(tableWrap, ['', '', '%'], rows);
  });
}

// ================================================================ HISTOGRAM
/** histogram(host, { values: [...], bins: 10, format, name, title, subtitle, height }) — counts per bin, drawn as touching thin columns. */
export function histogram(host, cfg) {
  const vals = (cfg.values ?? []).map(Number).filter((v) => !Number.isNaN(v));
  const n = Math.max(2, cfg.bins ?? 10);
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  const step = (hi - lo) / n || 1;
  const counts = Array(n).fill(0);
  for (const v of vals) counts[Math.min(n - 1, Math.floor((v - lo) / step))]++;
  // bin edges rounded to the precision the bin width needs
  const decimals = step >= 10 ? 0 : step >= 1 ? 1 : 2;
  const f = formatter({ ...cfg.format, decimals, unit: undefined }, true);
  const categories = counts.map((_, i) => `${f(lo + i * step)}–${f(lo + (i + 1) * step)}`);
  return barChart(host, { ...cfg, categories, series: [{ name: cfg.name ?? msg('count'), values: counts }], format: { decimals: 0 }, valueLabels: cfg.valueLabels ?? false });
}

// ---------------------------------------------------------------- declarative mounting
const KINDS = {
  bar: barChart, line: lineChart, area: (h, c) => lineChart(h, { ...c, area: true }), donut: donutChart, heatmap, stat: statTile, meter,
  ring: ringGauge, waffle: waffleChart, funnel: funnelChart, rank: rankList, slope: slopeChart, segment: segmentBar,
  diverging: divergingBar, calendar: calendarHeatmap, gantt: ganttChart, progress: progressList, histogram,
};
export function mountAll(root = document) {
  return [...root.querySelectorAll('[data-aisa-chart]')].map((node) => {
    if (node.__aisaChart) return node.__aisaChart;
    const kind = node.getAttribute('data-aisa-chart');
    let cfg = {};
    try {
      cfg = JSON.parse(node.getAttribute('data-config') || node.querySelector('script[type="application/json"]')?.textContent || '{}');
    } catch (e) {
      console.warn('[aisa-charts] bad data-config on', node, e);
    }
    const fn = KINDS[kind];
    if (!fn) return null;
    node.__aisaChart = fn(node, cfg);
    return node.__aisaChart;
  });
}

const AisaCharts = {
  barChart, lineChart, donutChart, heatmap, sparkline, statTile, meter, ringGauge, waffleChart, funnelChart, rankList, slopeChart,
  segmentBar, divergingBar, calendarHeatmap, ganttChart, progressList, histogram, mountAll, setMessages,
};
if (typeof window !== 'undefined') {
  window.AisaCharts = AisaCharts;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => mountAll());
  else queueMicrotask(() => mountAll());
}
export default AisaCharts;
