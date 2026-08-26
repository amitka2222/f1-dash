/**
 * Track Map — cars moving around the real circuit, replayed from position data.
 *
 * The circuit outline is pre-baked (its provider sends no CORS headers) and the
 * car coordinates come from the live timing feed. Both are in the same
 * coordinate space, so cars land on the traced track with no calibration.
 *
 * Position data is far too large to load a whole race up front — roughly 320 KB
 * per 30 seconds for the full field — so it streams in windows as playback
 * advances, with one window buffered ahead.
 */

import { live, raceSessions } from '../api.js';
import { archive } from '../api.js';
import { el, clear, loading, errorBox, select } from '../util.js';

const FIRST_YEAR = 2023;
const CURRENT_YEAR = new Date().getUTCFullYear();

// One request covers this much race time. Bigger windows mean fewer requests
// (the feed allows 30/min) but a longer wait before playback can start.
const WINDOW_MS = 30_000;
const BUFFER_AHEAD = 2;

// The feed samples ~3.8 Hz; 2 Hz is plenty to interpolate smooth motion and
// halves what we hold in memory.
const MIN_SAMPLE_GAP_MS = 500;

const SPEEDS = [1, 2, 4, 8];

// Longest delta we will ever advance in one frame. Covers a dropped frame or
// two without letting a backgrounded tab bank up unlimited race time.
const MAX_FRAME_MS = 250;

export async function render(root) {
  root.append(
    el(
      'div',
      { class: 'page-head' },
      el('h1', {}, 'Track Map'),
      el(
        'p',
        {},
        'Every car replayed around the real circuit, from the same position feed that drives ' +
          'the timing screens. Pick a race and press play.',
      ),
    ),
  );

  const toolbar = el('div', { class: 'toolbar' });
  const stage = el('div');
  root.append(toolbar, stage);

  const years = Array.from({ length: CURRENT_YEAR - FIRST_YEAR + 1 }, (_, i) => CURRENT_YEAR - i);
  let year = CURRENT_YEAR;

  const sessionSelect = el('select', { style: 'min-width:250px' });

  toolbar.append(
    el('label', {}, 'Season'),
    select(
      years.map((y) => ({ value: y, label: String(y) })),
      year,
      (v) => loadYear(Number(v)),
    ),
    el('label', {}, 'Race'),
    sessionSelect,
  );

  let player = null;

  async function loadYear(nextYear) {
    year = nextYear;
    player?.stop();
    clear(stage).append(loading('Finding sessions…'));
    clear(sessionSelect);

    try {
      const sessions = await raceSessions(year);
      if (!sessions.length) {
        clear(stage).append(el('div', { class: 'empty' }, `No races have run yet in ${year}.`));
        return;
      }

      sessionSelect.append(
        ...sessions.map((s) =>
          el(
            'option',
            { value: s.session_key },
            `${s.date_start.slice(0, 10)} · ${s.country_name}${s.isSprint ? ' (Sprint)' : ''}`,
          ),
        ),
      );
      sessionSelect.onchange = (e) =>
        loadSession(sessions.find((s) => String(s.session_key) === e.target.value));

      await loadSession(sessions[0]);
    } catch (err) {
      clear(stage).append(errorBox(err));
    }
  }

  async function loadSession(session) {
    player?.stop();
    clear(stage).append(loading('Loading circuit and drivers…'));

    try {
      const [circuits, drivers] = await Promise.all([
        archive('circuits-map'),
        live('drivers', { session_key: session.session_key }),
      ]);

      const circuit = circuits[session.circuit_key];
      if (!circuit) {
        clear(stage).append(
          el(
            'div',
            { class: 'empty' },
            `No track outline is published for ${session.location ?? 'this circuit'} yet.`,
          ),
        );
        return;
      }

      clear(stage);
      player = createPlayer({ session, circuit, drivers, mount: stage });
    } catch (err) {
      clear(stage).append(errorBox(err));
    }
  }

  await loadYear(year);
}

/* --- geometry ------------------------------------------------------------- */

const SVG_NS = 'http://www.w3.org/2000/svg';

function svg(tag, attrs = {}, children = []) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v != null) node.setAttribute(k, String(v));
  }
  for (const c of children) node.append(c);
  return node;
}

/**
 * Build the SVG frame for a circuit.
 *
 * Two coordinate quirks to reconcile: the source data has y increasing upwards
 * while SVG has it increasing downwards, and each circuit carries a rotation so
 * it appears the way broadcasts show it. Both are applied to one group, so the
 * track and the cars stay locked together.
 */
function buildStage(circuit) {
  const pts = circuit.path;
  const xs = [];
  const ys = [];
  for (let i = 0; i < pts.length; i += 2) {
    xs.push(pts[i]);
    ys.push(pts[i + 1]);
  }

  const pad = 400;
  const minX = Math.min(...xs) - pad;
  const maxX = Math.max(...xs) + pad;
  const minY = Math.min(...ys) - pad;
  const maxY = Math.max(...ys) + pad;
  const width = maxX - minX;
  const height = maxY - minY;

  let d = '';
  for (let i = 0; i < pts.length; i += 2) {
    d += `${i === 0 ? 'M' : 'L'} ${pts[i]} ${pts[i + 1]} `;
  }
  d += 'Z';

  // Rotate about the centre so the shape keeps its familiar orientation.
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const rotation = circuit.rotation ?? 0;

  const world = svg('g', {
    transform: `rotate(${rotation} ${cx} ${cy})`,
  });

  world.append(
    // A wide dark stroke under a thin light one reads as tarmac with an edge.
    svg('path', {
      d,
      fill: 'none',
      stroke: '#22272f',
      'stroke-width': 260,
      'stroke-linejoin': 'round',
      'stroke-linecap': 'round',
    }),
    svg('path', {
      d,
      fill: 'none',
      stroke: '#0a0c10',
      'stroke-width': 200,
      'stroke-linejoin': 'round',
      'stroke-linecap': 'round',
    }),
    svg('path', {
      d,
      fill: 'none',
      stroke: '#3a4150',
      'stroke-width': 6,
      'stroke-dasharray': '40 40',
      'stroke-linejoin': 'round',
    }),
  );

  const carLayer = svg('g', {});
  world.append(carLayer);

  const root = svg('svg', {
    viewBox: `${minX} ${minY} ${width} ${height}`,
    width: '100%',
    role: 'img',
    'aria-label': `${circuit.name} track map`,
    style: 'display:block;max-height:62vh',
  });

  // Flip the y axis for the whole scene, then flip it back for the group so
  // text and markers are not drawn upside down.
  const flip = svg('g', { transform: `translate(0 ${minY + maxY}) scale(1 -1)` });
  flip.append(world);
  root.append(flip);

  return { root, carLayer, bounds: { minX, minY, maxX, maxY } };
}

/* --- position buffer ------------------------------------------------------- */

/**
 * Streams position samples for a session and answers "where was each car at
 * time t", interpolating between samples.
 */
function createBuffer(sessionKey, startMs) {
  const byDriver = new Map(); // driver_number -> [{t, x, y}] sorted
  const windows = new Map(); // window index -> 'pending' | 'done' | 'empty'

  const indexFor = (ms) => Math.floor((ms - startMs) / WINDOW_MS);

  async function loadWindow(index) {
    if (windows.has(index)) return;
    windows.set(index, 'pending');

    const from = new Date(startMs + index * WINDOW_MS);
    const to = new Date(startMs + (index + 1) * WINDOW_MS);

    try {
      const rows = await live('location', {
        session_key: sessionKey,
        'date>': from.toISOString(),
        'date<': to.toISOString(),
      });

      for (const r of rows) {
        // The feed emits (0,0) when a car's position is unknown; plotting those
        // would fling cars into the middle of the map.
        if (!r.x && !r.y) continue;

        let list = byDriver.get(r.driver_number);
        if (!list) byDriver.set(r.driver_number, (list = []));

        const t = new Date(r.date).getTime();
        const last = list[list.length - 1];
        if (last && t - last.t < MIN_SAMPLE_GAP_MS) continue;
        list.push({ t, x: r.x, y: r.y });
      }

      for (const list of byDriver.values()) list.sort((a, b) => a.t - b.t);
      windows.set(index, rows.length ? 'done' : 'empty');
    } catch {
      // A failed window should not kill playback — drop it and let the next
      // request try again on the following pass.
      windows.delete(index);
    }
  }

  return {
    /** Ensure the window containing `ms`, plus a couple ahead, are loading. */
    prime(ms) {
      const base = indexFor(ms);
      for (let i = 0; i <= BUFFER_AHEAD; i++) {
        if (base + i >= 0) loadWindow(base + i);
      }
    },

    ready(ms) {
      const state = windows.get(indexFor(ms));
      return state === 'done' || state === 'empty';
    },

    /** Interpolated position of one car at time `ms`, or null. */
    at(driverNumber, ms) {
      const list = byDriver.get(driverNumber);
      if (!list?.length) return null;

      // Binary search for the last sample at or before ms.
      let lo = 0;
      let hi = list.length - 1;
      if (ms < list[0].t || ms > list[hi].t + 2000) return null;

      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (list[mid].t <= ms) lo = mid;
        else hi = mid - 1;
      }

      const a = list[lo];
      const b = list[lo + 1];
      if (!b) return a;

      const span = b.t - a.t;
      const f = span > 0 ? (ms - a.t) / span : 0;
      return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
    },

    drivers: () => [...byDriver.keys()],
  };
}

/* --- player ---------------------------------------------------------------- */

function createPlayer({ session, circuit, drivers, mount }) {
  const startMs = new Date(session.date_start).getTime();
  const endMs = new Date(session.date_end).getTime();
  const duration = endMs - startMs;

  const buffer = createBuffer(session.session_key, startMs);
  const byNumber = new Map(drivers.map((d) => [d.driver_number, d]));

  const { root, carLayer } = buildStage(circuit);

  // One marker per driver, created once and moved every frame.
  const markers = new Map();
  for (const d of drivers) {
    const colour = d.team_colour ? `#${d.team_colour}` : '#8b93a3';

    const group = svg('g', { opacity: 0 });
    group.append(
      svg('circle', { r: 130, fill: colour, stroke: '#0a0c10', 'stroke-width': 26 }),
      // Counter-flip so the label is not mirrored by the scene's y flip.
      svg(
        'g',
        { transform: 'scale(1 -1)' },
        [
          svg(
            'text',
            {
              x: 0,
              y: 250,
              fill: '#e8ebf0',
              'font-size': 200,
              'font-family': 'JetBrains Mono, monospace',
              'font-weight': 700,
              'text-anchor': 'middle',
              'paint-order': 'stroke',
              stroke: '#0a0c10',
              'stroke-width': 60,
            },
            [document.createTextNode(d.name_acronym ?? String(d.driver_number))],
          ),
        ],
      ),
    );

    carLayer.append(group);
    markers.set(d.driver_number, group);
  }

  /* controls */
  let playing = false;
  let speed = 1;
  let cursor = 0; // ms into the session
  let raf = null;
  let lastFrame = 0;

  const playButton = el('button', { class: 'primary', onclick: () => toggle() }, '▶ Play');
  const clock = el('span', { class: 'num', style: 'color:var(--muted);min-width:98px' }, '0:00');
  const statusText = el('span', { class: 'stat-sub' }, 'Ready');

  const scrubber = el('input', {
    type: 'range',
    min: '0',
    max: String(duration),
    value: '0',
    step: '1000',
    style: 'flex:1;min-width:180px;accent-color:var(--accent)',
    oninput: (e) => {
      cursor = Number(e.target.value);
      buffer.prime(startMs + cursor);
      paint();
    },
  });

  const speedButtons = SPEEDS.map((s) =>
    el(
      'button',
      {
        class: s === speed ? 'primary' : '',
        onclick: () => {
          speed = s;
          for (const [i, b] of speedButtons.entries()) {
            b.className = SPEEDS[i] === speed ? 'primary' : '';
          }
        },
      },
      `${s}×`,
    ),
  );

  function toggle() {
    playing = !playing;
    playButton.textContent = playing ? '⏸ Pause' : '▶ Play';
    if (playing) {
      lastFrame = performance.now();
      raf = requestAnimationFrame(tick);
    } else if (raf) {
      cancelAnimationFrame(raf);
      raf = null;
    }
  }

  function tick(now) {
    // Browsers pause requestAnimationFrame in hidden tabs, so returning to the
    // page hands us a gap of however long the visitor was away. Advancing the
    // cursor by that raw delta would leap minutes ahead of the buffered data
    // and strand playback; a frame is never legitimately longer than this.
    const dt = Math.min(now - lastFrame, MAX_FRAME_MS);
    lastFrame = now;

    if (buffer.ready(startMs + cursor)) {
      cursor = Math.min(cursor + dt * speed, duration);
      statusText.textContent = 'Playing';
    } else {
      // Hold position while the next window arrives rather than skipping ahead.
      statusText.textContent = 'Buffering…';
    }

    buffer.prime(startMs + cursor);
    scrubber.value = String(Math.round(cursor));
    paint();

    if (cursor >= duration) {
      toggle();
      return;
    }
    if (playing) raf = requestAnimationFrame(tick);
  }

  // Remembers where each car was a moment ago, purely to notice when the whole
  // field has stopped.
  let previous = new Map();
  let lastStationaryCheck = 0;
  let suspended = false;

  function paint() {
    const ms = startMs + cursor;
    clock.textContent = formatClock(cursor);

    const now = new Map();
    let shown = 0;

    for (const [number, group] of markers) {
      const pos = buffer.at(number, ms);
      if (!pos) {
        group.setAttribute('opacity', '0');
        continue;
      }
      group.setAttribute('opacity', '1');
      group.setAttribute('transform', `translate(${pos.x} ${pos.y})`);
      now.set(number, pos);
      shown++;
    }

    // A red flag parks the entire field, sometimes for hours of session clock.
    // Without saying so, a stopped map is indistinguishable from a broken one —
    // which is exactly how it reads the first time you see it.
    if (ms - lastStationaryCheck > 3000) {
      if (previous.size && shown >= 3) {
        let moving = 0;
        for (const [number, pos] of now) {
          const was = previous.get(number);
          if (was && Math.hypot(pos.x - was.x, pos.y - was.y) > 50) moving++;
        }
        suspended = moving === 0;
      }
      previous = now;
      lastStationaryCheck = ms;
    }

    if (shown === 0 && buffer.ready(ms)) {
      statusText.textContent = 'No position data at this point in the session';
    } else if (suspended && playing) {
      statusText.textContent = 'Field stationary — session suspended (red flag)';
    }
  }

  buffer.prime(startMs);
  paint();

  mount.append(
    el(
      'div',
      { class: 'card', style: 'margin-bottom:16px;padding:10px' },
      root,
    ),
    el(
      'div',
      { class: 'toolbar', style: 'margin-bottom:6px' },
      playButton,
      clock,
      scrubber,
      el('label', {}, 'Speed'),
      ...speedButtons,
    ),
    el(
      'div',
      { style: 'display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap' },
      statusText,
      el(
        'span',
        { class: 'stat-sub' },
        `${circuit.name}${circuit.country ? ` · ${circuit.country}` : ''} · ` +
          `${drivers.length} cars · position data streams as you play`,
      ),
    ),
  );

  return {
    stop() {
      playing = false;
      if (raf) cancelAnimationFrame(raf);
    },
  };
}

function formatClock(ms) {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}
