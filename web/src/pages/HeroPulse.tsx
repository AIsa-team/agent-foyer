import { useEffect, useRef, useState } from 'react';
import { useI18n, type MessageKey } from '../i18n';

export interface PulseEvent { kind: 'appNew' | 'appUpdated' | 'skillNew' | 'skillUpdated'; name: string; who: string; at: number; url: string }
export interface PulsePerson { id: string; name: string; at: number }
export interface Pulse { people: number; who: PulsePerson[]; count: number; events: PulseEvent[] }

interface Fly { r: number; a: number; speed: number; wobble: number; f1: number; f2: number; p1: number; p2: number; blink: number; phase: number; person: PulsePerson }

/** Small deterministic random numbers, so each firefly keeps its path across reloads. */
function seeded(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const hash = (s: string) => [...s].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) | 0, 7);

/** One firefly for each colleague who used the hub today, each on its own path. */
function makeFlies(pulse: Pulse): Fly[] {
  return pulse.who.map((person) => {
    const rnd = seeded(hash(person.id));
    return {
      r: 22 + rnd() * 62,
      a: rnd() * Math.PI * 2,
      speed: (0.035 + rnd() * 0.06) * (rnd() < 0.5 ? -1 : 1),
      wobble: 4 + rnd() * 6,
      f1: 0.25 + rnd() * 0.35, f2: 0.2 + rnd() * 0.35, p1: rnd() * 6.3, p2: rnd() * 6.3,
      blink: 0.12 + rnd() * 0.16, phase: rnd(),
      person,
    };
  });
}

/** At most this many rings, however busy the day. */
const MAX_RINGS = 8;
const RING_PERIOD = 11;   // seconds for a ring to travel from the core to the edge

/**
 * The home page's top-right art. Twisting hexagons ripple outwards from a small core, one ring for each new thing on
 * the hub today (up to MAX_RINGS). Over them drift fireflies, one for each colleague who used the hub today; hover
 * one to see who.
 */
export function HeroPulse({ pulse }: { pulse?: Pulse }) {
  const { t, locale } = useI18n();
  const canvas = useRef<HTMLCanvasElement>(null);
  const flies = useRef<Fly[]>([]);
  const spots = useRef<{ x: number; y: number; fly: Fly }[]>([]);
  const [hover, setHover] = useState<PulsePerson | null>(null);
  const hoverRef = useRef<PulsePerson | null>(null);

  useEffect(() => {
    flies.current = pulse ? makeFlies(pulse) : [];
    const c = canvas.current;
    if (!c) return;
    const ctx = c.getContext('2d')!;
    const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const fit = () => {
      const d = Math.min(devicePixelRatio || 1, 2);
      c.width = c.clientWidth * d;
      c.height = c.clientHeight * d;
      ctx.setTransform(d, 0, 0, d, 0, 0);
    };
    fit();
    addEventListener('resize', fit);
    // only draw while the art is on screen
    let visible = true;
    const seen = new IntersectionObserver(([e]) => { visible = e.isIntersecting; });
    seen.observe(c);
    // reading styles forces layout, so the theme's colours are looked up about once a second, not every frame
    let colours = { accent: '', ink: '', dark: false, at: -Infinity };
    const theme = (ms: number) => {
      if (ms - colours.at < 1000) return colours;
      const style = getComputedStyle(c);
      ctx.fillStyle = style.getPropertyValue('--accent').trim() || '#f76918';   // normalised by the canvas itself
      const accent = String(ctx.fillStyle);
      colours = { accent, ink: style.color, dark: luminance(getComputedStyle(document.body).backgroundColor) < 0.35, at: ms };
      return colours;
    };
    let raf = 0;
    const draw = (ms: number) => {
      if (!visible && !still) { raf = requestAnimationFrame(draw); return; }
      const t = still ? 0 : ms / 1000;
      const w = c.clientWidth, h = c.clientHeight;
      const { accent, ink, dark } = theme(ms);
      ctx.clearRect(0, 0, w, h);
      drawRings(ctx, w, h, t, Math.min(pulse?.count ?? 0, MAX_RINGS), ink, still);
      ctx.globalCompositeOperation = dark ? 'lighter' : 'source-over';
      spots.current = [];
      for (const f of flies.current) {
        const a = f.a + t * f.speed;
        const x = w / 2 + Math.cos(a) * f.r + Math.sin(t * f.f1 + f.p1) * f.wobble;
        const y = h / 2 + Math.sin(a) * f.r * 0.82 + Math.cos(t * f.f2 + f.p2) * f.wobble;
        // a firefly glows faintly, flashes now and then, and fades again
        const ph = (t * f.blink + f.phase) % 1;
        const flash = ph < 0.22 ? Math.sin((Math.PI * ph) / 0.22) ** 2 : 0;
        const lit = f.person === hoverRef.current ? 1 : still ? 0.7 : 0.38 + 0.62 * flash;
        const halo = 11;
        const g = ctx.createRadialGradient(x, y, 0, x, y, halo);
        g.addColorStop(0, withAlpha(accent, 0.5 * lit));
        g.addColorStop(1, withAlpha(accent, 0));
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(x, y, halo, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = withAlpha(accent, 0.55 + 0.45 * lit);
        ctx.beginPath(); ctx.arc(x, y, 1.9, 0, Math.PI * 2); ctx.fill();
        spots.current.push({ x, y, fly: f });
      }
      if (!still) raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => { cancelAnimationFrame(raf); seen.disconnect(); removeEventListener('resize', fit); };
  }, [pulse]);

  const at = (e: React.PointerEvent) => {
    const b = canvas.current!.getBoundingClientRect();
    const x = e.clientX - b.left, y = e.clientY - b.top;
    return spots.current.find((s) => Math.hypot(s.x - x, s.y - y) < 12)?.fly.person ?? null;
  };
  const move = (e: React.PointerEvent) => {
    const hit = at(e);
    hoverRef.current = hit;
    if (hit !== hover) setHover(hit);
  };

  const time = (ms: number) => new Date(ms).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
  const say = (e: PulseEvent) => t(`home.pulse.${e.kind}` as MessageKey, { name: e.name, who: e.who });
  const summary = !pulse ? '' : pulse.count
    ? t('home.pulse.summary', { people: pulse.people, n: pulse.count })
    : t('home.pulse.quiet', { people: pulse.people });

  return (
    <div className="hero-art">
      <canvas
        ref={canvas} className="hero-art__flies" aria-hidden="true"
        onPointerMove={move} onPointerLeave={() => { hoverRef.current = null; setHover(null); }}
      />
      <div className="hero-art__cap" aria-live="polite">{hover ? t('home.pulse.person', { name: hover.name, time: time(hover.at) }) : summary}</div>
      {pulse && pulse.events.length > 0 && (
        <ul className="visually-hidden">
          {pulse.events.map((e) => <li key={e.url + e.kind}><a href={e.url}>{say(e)}</a></li>)}
        </ul>
      )}
    </div>
  );
}

/**
 * The rings: a faint core hexagon, and `n` hexagons growing out of it in turn, each turning a little as it grows (the
 * twist of the brand motif) and fading in near the core and out towards the edge.
 */
function drawRings(ctx: CanvasRenderingContext2D, w: number, h: number, t: number, n: number, ink: string, still: boolean) {
  const cx = w / 2, cy = h / 2;
  const R0 = 14, R1 = Math.min(w, h) / 2 - 4;
  ctx.fillStyle = ink;
  const color = String(ctx.fillStyle);
  const hexagon = (r: number, alpha: number) => {
    const turn = -Math.PI / 2 + r * 0.0095;   // about 6° more for every 11px outwards
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
      const a = turn + (i * Math.PI) / 3;
      i ? ctx.lineTo(cx + r * Math.cos(a), cy + r * Math.sin(a)) : ctx.moveTo(cx + r * Math.cos(a), cy + r * Math.sin(a));
    }
    ctx.closePath();
    ctx.strokeStyle = withAlpha(color, alpha);
    ctx.lineWidth = 1;
    ctx.stroke();
  };
  ctx.globalCompositeOperation = 'source-over';
  hexagon(R0, 0.28);
  for (let i = 0; i < n; i++) {
    // evenly spaced in time, so the rings keep an even rhythm; at rest they sit evenly spaced in radius
    const p = still ? (i + 1) / (n + 1) : (t / RING_PERIOD + i / n) % 1;
    const fade = Math.min(1, p / 0.12) * (1 - p) ** 1.3;
    hexagon(R0 + (R1 - R0) * p, 0.34 * fade);
  }
}

/** A canvas colour (#rrggbb or rgb/rgba, as the canvas reports it) with another alpha. */
function withAlpha(color: string, a: number): string {
  const alpha = Math.max(0, Math.min(1, a)).toFixed(3);
  const hex = color.match(/^#([0-9a-f]{6})$/i);
  if (hex) {
    const n = parseInt(hex[1], 16);
    return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
  }
  const rgb = color.match(/rgba?\(([^,]+),([^,]+),([^,)]+)/);
  return rgb ? `rgba(${rgb[1]},${rgb[2]},${rgb[3]}, ${alpha})` : color;
}

function luminance(css: string): number {
  const m = css.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  return m ? (0.2126 * +m[1] + 0.7152 * +m[2] + 0.0722 * +m[3]) / 255 : 1;
}
