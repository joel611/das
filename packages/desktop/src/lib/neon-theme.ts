/**
 * The one place the HUD palette lives. A theme is a full set of named colours; `applyTheme`
 * writes them to `--theme-<key>` custom properties on the root element. Everything else reads
 * those properties:
 *  - Tailwind utilities (`text-neon-cyan`, `border-hud-line`) through the `@theme` block in index.css.
 *  - shadcn tokens (`--primary`, `--border`, ...) through the `.dark` block in index.css.
 *  - SVG and inline styles through `hud` below.
 *
 * To add a colour: add its key to `COLOR_KEYS`, give it a value in every theme (the compiler
 * enforces this), and add a `--color-<key>: var(--theme-<key>)` line to `@theme` in index.css.
 * To add a theme: write a `HudTheme` and add it to `THEMES`.
 */

export const COLOR_KEYS = [
  // Accents.
  "neon-cyan",
  "neon-magenta",
  "neon-pink",
  "neon-amber",
  "neon-green",
  // Text, brightest to faintest. `hud-idle` is the grey of an idle agent.
  "hud-ink",
  "hud-text",
  "hud-soft",
  "hud-dim",
  "hud-faint",
  "hud-idle",
  "hud-hot-ink",
  // Surfaces, darkest first.
  "hud-void",
  "hud-shade",
  "hud-surface",
  "hud-hover",
  "hud-panel",
  // Lines and tracks.
  "hud-line",
  "hud-rule",
  "hud-edge",
  "hud-track",
  "hud-ring",
  "hud-chip",
  "hud-chip-dim",
  "hud-ok-line",
  "hud-bad-line",
] as const;

export type ColorKey = (typeof COLOR_KEYS)[number];

export interface HudTheme {
  id: string;
  label: string;
  /** Every key is required, so a theme can never leave a colour undefined. */
  colors: Record<ColorKey, string>;
}

export const neonTheme: HudTheme = {
  id: "neon",
  label: "Neon",
  colors: {
    "neon-cyan": "#2ee9ff",
    "neon-magenta": "#ff3d8b",
    "neon-pink": "#ff6fa8",
    "neon-amber": "#ffb020",
    "neon-green": "#5cff9d",
    "hud-ink": "#e8fbff",
    "hud-text": "#d6f6ff",
    "hud-soft": "#9fc7d8",
    "hud-dim": "#7fa3b5",
    "hud-faint": "#5d7f90",
    "hud-idle": "#4d6676",
    "hud-hot-ink": "#fff0f6",
    "hud-void": "#04060b",
    "hud-shade": "#060a12",
    "hud-surface": "#070b13",
    "hud-hover": "#0f1726",
    "hud-panel": "rgb(9 14 24 / 0.88)",
    "hud-line": "#16273a",
    "hud-rule": "#13202f",
    "hud-edge": "#23465f",
    "hud-track": "#111c2a",
    "hud-ring": "#16314a",
    "hud-chip": "#1d3347",
    "hud-chip-dim": "#23384c",
    "hud-ok-line": "#1d4a3a",
    "hud-bad-line": "#5a1d3a",
  },
};

export const THEMES: Record<string, HudTheme> = { [neonTheme.id]: neonTheme };
export const DEFAULT_THEME_ID = neonTheme.id;

const cssVar = (key: ColorKey) => `--theme-${key}`;

/**
 * CSS references to the active theme's colours, for SVG attributes and inline styles
 * (`stroke={hud["neon-cyan"]}`). They follow `applyTheme`, so nothing re-renders on a switch.
 */
export const hud = Object.fromEntries(
  COLOR_KEYS.map((key) => [key, `var(${cssVar(key)})`]),
) as Record<ColorKey, string>;

/** Make `theme` the active theme. Call once before first render, and again to switch. */
export function applyTheme(
  theme: HudTheme = THEMES[DEFAULT_THEME_ID],
  root: HTMLElement = document.documentElement,
) {
  for (const key of COLOR_KEYS) root.style.setProperty(cssVar(key), theme.colors[key]);
  root.dataset.hudTheme = theme.id;
}
