import { useEffect, useRef } from "react";

/**
 * The ASCII take on Jev: the ring orb redrawn on a character grid, with a voice scope under it.
 * Frames are plain functions of time, written straight into a <pre> so nothing re-renders per frame.
 */

const ASPECT = 0.6; // a mono cell is ~0.6 as wide as it is tall at line-height 1
const TAU = Math.PI * 2;

// Tailwind classes per colour key, spelled out so the class scanner sees them.
const TONE = {
  c: "text-neon-cyan",
  m: "text-neon-magenta",
  d: "text-hud-ring",
  w: "text-hud-ink",
} as const;
type Tone = keyof typeof TONE;

type Grid = { w: number; h: number; ch: string[]; tone: Tone[] };

function grid(w: number, h: number): Grid {
  return { w, h, ch: Array<string>(w * h).fill(" "), tone: Array<Tone>(w * h).fill("c") };
}

function put(g: Grid, x: number, y: number, c: string, t: Tone) {
  if (x < 0 || x >= g.w || y < 0 || y >= g.h) return;
  g.ch[y * g.w + x] = c;
  g.tone[y * g.w + x] = t;
}

const esc = (c: string) => (c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === "&" ? "&amp;" : c);

/** Renders a grid to HTML, one span per run of same-coloured characters. */
function toHtml(g: Grid) {
  const rows: string[] = [];
  for (let y = 0; y < g.h; y++) {
    let out = "";
    let run = "";
    let tone: Tone | null = null;
    for (let x = 0; x < g.w; x++) {
      const i = y * g.w + x;
      const c = g.ch[i];
      const t: Tone | null = c === " " ? tone : g.tone[i];
      if (t !== tone && run) {
        out += tone ? `<span class="${TONE[tone]}">${run}</span>` : run;
        run = "";
      }
      tone = t;
      run += esc(c);
    }
    out += tone ? `<span class="${TONE[tone]}">${run}</span>` : run;
    rows.push(out);
  }
  return rows.join("\n");
}

/** Is fraction `f` of a circle on an "on" segment of `pat` ([on, off, on, off, ...])? */
function dash(f: number, pat: number[]) {
  const sum = pat.reduce((a, b) => a + b, 0);
  let p = (((f % 1) + 1) % 1) * sum;
  for (let i = 0; i < pat.length; i++) {
    if (p < pat[i]) return i % 2 === 0;
    p -= pat[i];
  }
  return false;
}

/** The line character closest to a circle's tangent at angle `th` (screen y points down). */
function tangentChar(th: number) {
  const a = (((-th + Math.PI / 2) % Math.PI) + Math.PI) % Math.PI;
  if (a < Math.PI / 8 || a >= (7 * Math.PI) / 8) return "-";
  if (a < (3 * Math.PI) / 8) return "/";
  if (a < (5 * Math.PI) / 8) return "|";
  return "\\";
}

// Same rings as the SVG orb, in row units: radius, dash pattern, repeats per turn, turn period.
const RINGS: { r: number; pat: number[]; n: number; period: number; ch?: string; tone: Tone }[] = [
  { r: 10.4, pat: [1, 1.6], n: 64, period: 40, ch: ".", tone: "d" },
  { r: 8.9, pat: [120, 40, 30, 40, 200, 30], n: 1, period: 22, tone: "c" },
  { r: 7.3, pat: [60, 24, 8, 24], n: 4, period: -14, tone: "m" },
  { r: 5.9, pat: [1, 3], n: 48, period: 22, ch: ":", tone: "c" },
];
const RAMP = " .:-=+*#%@";

export function orbFrame(t: number, hot: boolean) {
  const W = 44;
  const H = 22;
  const g = grid(W, H);
  const cx = W / 2;
  const cy = H / 2;
  const speed = hot ? 3.2 : 1;
  const pulse = 0.88 + 0.12 * (0.5 + 0.5 * Math.sin((t * TAU) / (hot ? 0.9 : 3.2)));
  const core = 3.6 * pulse;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const dx = (x + 0.5 - cx) * ASPECT;
      const dy = y + 0.5 - cy;
      const r = Math.hypot(dx, dy);
      const th = Math.atan2(dy, dx);
      for (const ring of RINGS) {
        if (Math.abs(r - ring.r) >= 0.5) continue;
        const f = (th + ((t * TAU) / ring.period) * speed) / TAU;
        if (dash(f * ring.n, ring.pat)) put(g, x, y, ring.ch ?? tangentChar(th), ring.tone);
      }
      if (r < core) {
        const idx = Math.min(RAMP.length - 1, Math.floor((1 - r / core) * (hot ? 13 : 10)));
        if (idx > 0) put(g, x, y, RAMP[idx], r < 1 ? "w" : "c");
      } else if (Math.abs(r - 4.6) < 0.4 && dash((th / TAU) * 90, [1, 2])) {
        put(g, x, y, ".", "d");
      }
    }
  }
  const mid = Math.floor(cy);
  for (let i = 0; i < 3; i++) {
    put(g, i, mid, "-", "c");
    put(g, W - 1 - i, mid, "-", "c");
  }
  put(g, Math.floor(cx), 0, "|", "m");
  put(g, Math.floor(cx), H - 1, "|", "m");
  return toHtml(g);
}

export function scopeFrame(t: number, hot: boolean) {
  const W = 44;
  const H = 7;
  const g = grid(W, H);
  const mid = Math.floor(H / 2);
  const amp = hot ? 3.4 : 0.9 + 0.4 * Math.sin(t * 1.6);
  const scroll = t * (hot ? 14 : 3);
  for (let x = 0; x < W; x++) {
    const env = Math.sin((Math.PI * (x + 0.5)) / W);
    const n =
      0.55 * Math.sin((x + scroll) * 0.42) +
      0.3 * Math.sin((x - scroll * 0.7) * 0.97 + 1.3) +
      0.15 * Math.sin((x + scroll * 1.9) * 2.3);
    const h = Math.abs(n) * amp * env;
    const tone: Tone = x % 7 === 3 ? "m" : "c";
    put(g, x, mid, h < 0.5 ? "-" : "|", h < 0.5 ? "d" : tone);
    const top = Math.round(h);
    for (let d = 1; d <= top; d++) {
      const c = d === top ? (h - Math.floor(h) > 0.5 ? ":" : ".") : "|";
      put(g, x, mid - d, c, tone);
      put(g, x, mid + d, c, tone);
    }
  }
  return toHtml(g);
}

/** Draws `frame` into a <pre> at ~30fps; with reduced motion, one still frame per state. */
function AsciiCanvas({
  frame,
  hot,
  label,
}: {
  frame: (t: number, hot: boolean) => string;
  hot: boolean;
  label: string;
}) {
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
      el.innerHTML = frame(4, hot);
      return;
    }
    let raf = 0;
    let last = 0;
    const tick = (now: number) => {
      if (now - last > 33) {
        el.innerHTML = frame(now / 1000, hot);
        last = now;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [frame, hot]);
  return (
    <pre
      ref={ref}
      role="img"
      aria-label={label}
      className="m-0 font-mono text-[11px] leading-none whitespace-pre text-neon-cyan select-none"
    />
  );
}

export function AsciiOrb({ hot }: { hot: boolean }) {
  return <AsciiCanvas frame={orbFrame} hot={hot} label="Jev status orb" />;
}

export function AsciiScope({ hot }: { hot: boolean }) {
  return <AsciiCanvas frame={scopeFrame} hot={hot} label="Jev voice waveform" />;
}
