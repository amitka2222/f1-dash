/** Small DOM + formatting helpers shared by every view. */

/**
 * Team colours, keyed by the upstream constructor id. Historical teams fall
 * back to a neutral grey rather than being guessed at.
 */
const TEAM_COLOURS = {
  mercedes: '#00d7b6',
  ferrari: '#e8002d',
  red_bull: '#3671c6',
  mclaren: '#ff8000',
  aston_martin: '#229971',
  alpine: '#00a1e8',
  williams: '#1868db',
  rb: '#6692ff',
  audi: '#00e701',
  sauber: '#00e701',
  haas: '#b6babd',
  cadillac: '#c8a24a',
  alphatauri: '#6692ff',
  alfa: '#a42134',
  racing_point: '#f596c8',
  force_india: '#f596c8',
  renault: '#c9a900',
  toro_rosso: '#469bff',
  lotus_f1: '#c9a900',
  brawn: '#93bd00',
  jordan: '#f5c518',
  benetton: '#00a1e8',
  tyrrell: '#1868db',
  brabham: '#2d5f9a',
  lotus: '#1a7d3c',
  team_lotus: '#1a7d3c',
  matra: '#1868db',
  cooper: '#1a7d3c',
  maserati: '#e8002d',
  vanwall: '#1a7d3c',
  bar: '#8d959e',
  jaguar: '#1a7d3c',
  stewart: '#8d959e',
  minardi: '#000000',
  ligier: '#1868db',
  march: '#b6babd',
  wolf: '#c8a24a',
  shadow: '#4a4a4a',
  hesketh: '#e8002d',
  surtees: '#e8002d',
  arrows: '#f5820d',
  footwork: '#f5820d',
  osella: '#e8002d',
  ags: '#b6babd',
  larrousse: '#1868db',
  simtek: '#4a4a4a',
  pacific: '#1868db',
  forti: '#f5c518',
  toyota: '#e8002d',
  honda: '#8d959e',
  super_aguri: '#e8002d',
  spyker: '#f5820d',
  midland: '#e8002d',
  virgin: '#e8002d',
  hrt: '#b6babd',
  caterham: '#1a7d3c',
  marussia: '#e8002d',
  manor: '#e8002d',
};

const NEUTRAL = '#5b6373';

export const teamColour = (constructorId) => TEAM_COLOURS[constructorId] ?? NEUTRAL;

/* --- DOM ----------------------------------------------------------------- */

/** Terse element factory: el('div', {class: 'card'}, child, 'text'). */
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);

  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === 'dataset') {
      Object.assign(node.dataset, value);
    } else {
      node.setAttribute(key, value === true ? '' : String(value));
    }
  }

  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }

  return node;
}

export function clear(node) {
  node.replaceChildren();
  return node;
}

/** Standard loading / empty / error placeholders. */
export const loading = (msg = 'Loading…') => el('div', { class: 'loading' }, msg);
export const empty = (msg) => el('div', { class: 'empty' }, msg);
export const errorBox = (err) =>
  el('div', { class: 'error' }, err?.friendly ?? 'Something went wrong loading this view.');

/** Build a <select> from options, preselecting `value`. */
export function select(options, value, onChange, attrs = {}) {
  const node = el(
    'select',
    { ...attrs, onchange: (e) => onChange(e.target.value) },
    options.map((o) =>
      el('option', { value: o.value, selected: String(o.value) === String(value) }, o.label),
    ),
  );
  return node;
}

/* --- formatting ---------------------------------------------------------- */

export const fmt = {
  /** 1 → "1st", 22 → "22nd" */
  ordinal(n) {
    const s = ['th', 'st', 'nd', 'rd'];
    const v = n % 100;
    return n + (s[(v - 20) % 10] ?? s[v] ?? s[0]);
  },

  /** Signed number for deltas: 12 → "+12", -3 → "−3" */
  signed(n) {
    if (n === 0) return '0';
    return n > 0 ? `+${n}` : `−${Math.abs(n)}`;
  },

  points: (n) => (Number.isInteger(n) ? String(n) : n.toFixed(1)),

  date(iso) {
    return new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      timeZone: 'UTC',
    });
  },

  /** Seconds → "1:23.456", the way lap times are read. */
  lapTime(seconds) {
    if (seconds == null || !Number.isFinite(seconds)) return '—';
    const m = Math.floor(seconds / 60);
    const s = seconds - m * 60;
    return m > 0 ? `${m}:${s.toFixed(3).padStart(6, '0')}` : s.toFixed(3);
  },

  /** Gap in seconds → "+1.234" or "+1 LAP" */
  gap(value) {
    if (value == null) return '—';
    if (typeof value === 'string') return value;
    return `+${value.toFixed(3)}`;
  },
};

/** Sum of a list under a projection. */
export const sumBy = (list, fn) => list.reduce((total, item) => total + fn(item), 0);

/** Group a list into a Map keyed by fn. */
export function groupBy(list, fn) {
  const out = new Map();
  for (const item of list) {
    const key = fn(item);
    const bucket = out.get(key);
    if (bucket) bucket.push(item);
    else out.set(key, [item]);
  }
  return out;
}

/** Debounce for search inputs. */
export function debounce(fn, ms = 200) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}
