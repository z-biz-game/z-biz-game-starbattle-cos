// Single source of truth for colour, spacing and motion. The stylesheet reads these as custom
// properties (applyThemeVars) and the canvas reads the same objects, so a token change cannot
// land on one side only — which is how "one border width" turns into forty.
//
// The tokens are the family's: spacing 20/16/12, radii 20/12/8/6, one spring, three shadow
// layers, digits in SF Mono. Touch targets are 44 CSS px minimum and that number is a law, not a
// preference: `layoutFor` in js/render/board.js refuses to shrink a cell below Cell.min so a
// 9×9 board on a phone scrolls instead of becoming untappable.

export const Palette = {
  bgTop: '#080B16',
  bgBottom: '#131A2E',
  surface: '#101627',
  surfaceLift: '#182036',
  line: '#243050',
  lineHeavy: '#3A4A72',
  ink: '#F2F5FB',
  inkDim: 'rgba(242,245,251,0.62)',
  inkFaint: 'rgba(242,245,251,0.34)',

  // Amber is the player's own hand: the star just placed, the cell a hint named and the win
  // banner all borrow it, so "this is what you are doing" reads as one idea.
  accent: '#FFC85C',
  accentEdge: '#FFE3A6',
  accentSoft: 'rgba(255,200,92,0.14)',

  info: '#7BB8FF',
  success: '#3DDC91',
  error: '#FF5C7A',
  warn: '#FFB05C',
  focus: 'rgba(123,184,255,0.16)',
  hint: '#7BB8FF',

  // A grey mark is a *conclusion*, so it is drawn as a dot rather than as an X-shaped scratch:
  // these two tokens are the dot and the ring it sits in.
  mark: 'rgba(242,245,251,0.30)',
  markEdge: 'rgba(242,245,251,0.14)',
  regionBorder: '#8FA6CC',
};

// Region fills carry the only information colour has to carry in this game — which cells belong
// together — so they vary in *two* channels (hue and lightness), not one. A board is cut into N
// regions with N up to 9, hence nine stops; index by region id, never by hash, so two regions of
// the same board can never collide.
export const RegionTints = [
  'rgba(123,184,255,0.13)',
  'rgba(61,220,145,0.13)',
  'rgba(255,200,92,0.12)',
  'rgba(255,92,122,0.12)',
  'rgba(176,120,255,0.13)',
  'rgba(255,176,92,0.12)',
  'rgba(120,220,235,0.13)',
  'rgba(235,140,220,0.12)',
  'rgba(190,215,120,0.13)',
];

export const Space = { page: 20, card: 16, inner: 12, gutter: 10 };
export const Radius = { card: 20, button: 12, chip: 8, cell: 6 };

export const Font = {
  title: "700 24px/1.25 -apple-system, 'SF Pro Display', system-ui, sans-serif",
  mono: "'SF Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
  sans: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'PingFang SC', system-ui, sans-serif",
};

// Durations obey the 150–350 ms discipline; anything longer blocks the next move.
export const Motion = {
  tap: 150,
  base: 220,
  pop: 260,
  line: 300,
  win: 900,
  spring: 'cubic-bezier(0.34, 1.45, 0.64, 1)',
  ease: 'cubic-bezier(0.22, 0.61, 0.36, 1)',
};

// Three stacked transparent blacks: the family's elevation, so a card, a button and the board
// all lift off the page the same way.
export const Shadow = {
  card: '0 1px 2px rgba(3,6,16,0.34), 0 6px 16px rgba(3,6,16,0.28), 0 18px 40px rgba(3,6,16,0.22)',
  pop: '0 1px 1px rgba(3,6,16,0.30), 0 3px 8px rgba(3,6,16,0.26), 0 10px 24px rgba(3,6,16,0.20)',
  inset: 'inset 0 1px 0 rgba(242,245,251,0.05), 0 1px 2px rgba(3,6,16,0.30), 0 4px 12px rgba(3,6,16,0.22)',
};

export const Cell = { min: 44, max: 62, starScale: 0.62, dotScale: 0.15 };

export function applyThemeVars() {
  const root = document.documentElement.style;
  const kebab = (s) => s.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase());
  for (const [k, v] of Object.entries(Palette)) {
    if (Array.isArray(v)) continue;
    root.setProperty('--' + kebab(k), v);
  }
  RegionTints.forEach((c, i) => root.setProperty(`--region-${i}`, c));
  for (const [k, v] of Object.entries(Space)) root.setProperty('--space-' + k, v + 'px');
  for (const [k, v] of Object.entries(Radius)) root.setProperty('--radius-' + k, v + 'px');
  for (const [k, v] of Object.entries(Shadow)) root.setProperty('--shadow-' + k, v);
  for (const [k, v] of Object.entries(Motion)) {
    if (typeof v === 'number') root.setProperty('--dur-' + kebab(k), v + 'ms');
    else root.setProperty('--ease-' + kebab(k), v);
  }
  root.setProperty('--font-mono', Font.mono);
  root.setProperty('--font-sans', Font.sans);
}

// The system preference is the floor, and the in-game toggle can only add to it — a player who
// asks for less motion should not be overruled by an OS set to "no preference".
let motionReduced = false;

export function setReduceMotion(v) {
  motionReduced = !!v;
}

export const systemPrefersReducedMotion = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

export const prefersReducedMotion = () => motionReduced || systemPrefersReducedMotion();
