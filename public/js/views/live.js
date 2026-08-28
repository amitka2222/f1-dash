/**
 * Race Replay — session dashboard built on telemetry-grade data.
 *
 * The free data tier covers everything outside a session's live window (30 min
 * either side of running), which is why this ships as a replay. The rendering
 * is deliberately identical to what a live view needs: swap the one-shot loads
 * below for a poll and this becomes live timing, no redesign required.
 */

import { live, raceSessions } from '../api.js';
import { el, clear, fmt, loading, errorBox, groupBy } from '../util.js';

// Telemetry coverage begins in 2023.
const FIRST_YEAR = 2023;
const CURRENT_YEAR = new Date().getUTCFullYear();

const TYRE_COLOURS = {
  SOFT: '#e10600',
  MEDIUM: '#eab308',
  HARD: '#94a3b8',
  INTERMEDIATE: '#16a34a',
  WET: '#2563eb',
};

export async function render(root) {
  root.append(
    el(
      'div',
      { class: 'page-head' },
      el('h1', {}, 'Race Replay'),
      el(
        'p',
        {},
        'Position changes, final classification and tyre strategy for any race since 2023, ' +
          'rebuilt from the same feed that drives live timing.',
      ),
    ),
  );

  const toolbar = el('div', { class: 'toolbar' });
  const panel = el('div');
  root.append(toolbar, panel);

  const years = Array.from({ length: CURRENT_YEAR - FIRST_YEAR + 1 }, (_, i) => CURRENT_YEAR - i);
  let year = CURRENT_YEAR;

  const yearSelect = el(
    'select',
    { onchange: (e) => loadYear(Number(e.target.value)) },
    years.map((y) => el('option', { value: y, selected: y === year }, String(y))),
  );

  const sessionSelect = el('select', { style: 'min-width:240px' });

  toolbar.append(
    el('label', {}, 'Season'),
    yearSelect,
    el('label', {}, 'Race'),
    sessionSelect,
  );

  async function loadYear(nextYear) {
    year = nextYear;
    clear(panel).append(loading('Finding sessions…'));
    clear(sessionSelect);

    try {
      const sessions = await raceSessions(year);

      if (!sessions.length) {
        clear(panel).append(
          el('div', { class: 'empty' }, `No races have run yet in ${year}.`),
        );
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
      sessionSelect.onchange = (e) => loadSession(Number(e.target.value));

      await loadSession(sessions[0].session_key);
    } catch (err) {
      clear(panel).append(errorBox(err));
    }
  }

  async function loadSession(sessionKey) {
    clear(panel).append(loading('Replaying session…'));

    try {
      // Three parallel calls, each returning every driver at once — far cheaper
      // than looping per driver against a 30 req/min budget.
      const [drivers, positions, stints] = await Promise.all([
        live('drivers', { session_key: sessionKey }),
        live('position', { session_key: sessionKey }),
        live('stints', { session_key: sessionKey }),
      ]);

      const byNumber = new Map(drivers.map((d) => [d.driver_number, d]));
      clear(panel).append(
        renderClassification(byNumber, positions),
        renderProgression(byNumber, positions),
        renderStints(byNumber, stints),
      );
    } catch (err) {
      clear(panel).append(errorBox(err));
    }
  }

  await loadYear(year);
}

const colourOf = (driver) => (driver?.team_colour ? `#${driver.team_colour}` : '#6b7280');

/** Last recorded position per driver is the finishing order. */
function finalOrder(positions) {
  const latest = new Map();
  for (const p of positions) {
    const current = latest.get(p.driver_number);
    if (!current || new Date(p.date) > new Date(current.date)) latest.set(p.driver_number, p);
  }
  return [...latest.values()].sort((a, b) => a.position - b.position);
}

/* --- classification ------------------------------------------------------- */

function renderClassification(byNumber, positions) {
  const order = finalOrder(positions);
  if (!order.length) return el('div', { class: 'empty' }, 'No position data for this session.');

  // A driver's starting position is their first recorded entry.
  const starts = new Map();
  for (const p of [...positions].sort((a, b) => new Date(a.date) - new Date(b.date))) {
    if (!starts.has(p.driver_number)) starts.set(p.driver_number, p.position);
  }

  const rows = order.map((p) => {
    const driver = byNumber.get(p.driver_number);
    const start = starts.get(p.driver_number);
    const change = start != null ? start - p.position : 0;

    return el(
      'tr',
      {},
      el('td', { class: `pos ${p.position === 1 ? 'pos-1' : ''}` }, String(p.position)),
      el(
        'td',
        {},
        el(
          'span',
          { class: 'driver-cell' },
          el('span', { class: 'team-strip', style: `background:${colourOf(driver)}` }),
          el('span', { class: 'driver-name' }, driver?.full_name ?? `#${p.driver_number}`),
          el('span', { class: 'driver-team' }, driver?.team_name ?? ''),
        ),
      ),
      el('td', { class: 'num' }, String(driver?.driver_number ?? '—')),
      el('td', { class: 'num' }, start != null ? String(start) : '—'),
      el(
        'td',
        {
          class: 'num',
          style: `color:${change > 0 ? 'var(--green)' : change < 0 ? 'var(--accent)' : 'var(--muted)'}`,
        },
        change === 0 ? '—' : fmt.signed(change),
      ),
    );
  });

  return el(
    'div',
    { class: 'table-wrap', style: 'margin-bottom:20px' },
    el(
      'table',
      {},
      el(
        'thead',
        {},
        el(
          'tr',
          {},
          el('th', {}, ''),
          el('th', {}, 'Driver'),
          el('th', {}, 'No.'),
          el('th', {}, 'Started'),
          el('th', {}, 'Gained'),
        ),
      ),
      el('tbody', {}, rows),
    ),
  );
}

/* --- position progression chart ------------------------------------------- */

function renderProgression(byNumber, positions) {
  if (positions.length < 2) return el('span');

  const sorted = [...positions].sort((a, b) => new Date(a.date) - new Date(b.date));
  const t0 = new Date(sorted[0].date).getTime();
  const t1 = new Date(sorted.at(-1).date).getTime();
  const span = Math.max(t1 - t0, 1);

  const maxPos = Math.max(...positions.map((p) => p.position));
  const byDriver = groupBy(sorted, (p) => p.driver_number);

  const W = 1000;
  const H = 380;
  const PAD = { top: 14, right: 130, bottom: 24, left: 34 };
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;

  const x = (date) => PAD.left + ((new Date(date).getTime() - t0) / span) * plotW;
  const y = (pos) => PAD.top + ((pos - 1) / Math.max(maxPos - 1, 1)) * plotH;

  const svg = (tag, attrs = {}, children = []) => {
    const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
    for (const c of children) node.append(c);
    return node;
  };

  const layers = [];

  // Horizontal gridline per position.
  for (let pos = 1; pos <= maxPos; pos += 2) {
    layers.push(
      svg('line', {
        x1: PAD.left,
        x2: PAD.left + plotW,
        y1: y(pos),
        y2: y(pos),
        stroke: '#dce1e8',
        'stroke-width': 1,
      }),
      svg(
        'text',
        { x: PAD.left - 8, y: y(pos) + 4, fill: '#6b7280', 'font-size': 10, 'text-anchor': 'end' },
        [document.createTextNode(String(pos))],
      ),
    );
  }

  for (const [number, points] of byDriver) {
    const driver = byNumber.get(number);
    // Step lines: a position is held until the next change, so straight
    // interpolation would invent gradual moves that never happened.
    let d = '';
    let prevY = null;
    for (const p of points) {
      const px = x(p.date);
      const py = y(p.position);
      if (d === '') d = `M ${px.toFixed(1)} ${py.toFixed(1)}`;
      else d += ` L ${px.toFixed(1)} ${prevY.toFixed(1)} L ${px.toFixed(1)} ${py.toFixed(1)}`;
      prevY = py;
    }
    d += ` L ${(PAD.left + plotW).toFixed(1)} ${prevY.toFixed(1)}`;

    layers.push(
      svg('path', {
        d,
        fill: 'none',
        stroke: colourOf(driver),
        'stroke-width': 1.8,
        'stroke-linejoin': 'round',
        opacity: 0.9,
      }),
    );

    layers.push(
      svg(
        'text',
        {
          x: PAD.left + plotW + 6,
          y: prevY + 3.5,
          fill: colourOf(driver),
          'font-size': 10,
          'font-family': 'JetBrains Mono, monospace',
        },
        [document.createTextNode(driver?.name_acronym ?? `#${number}`)],
      ),
    );
  }

  const chart = svg(
    'svg',
    {
      viewBox: `0 0 ${W} ${H}`,
      width: '100%',
      role: 'img',
      'aria-label': 'Position changes through the race',
    },
    layers,
  );

  return el(
    'div',
    { class: 'card', style: 'margin-bottom:20px' },
    el('h2', { class: 'card-title' }, 'Position changes'),
    el('div', { style: 'overflow-x:auto' }, chart),
  );
}

/* --- tyre strategy -------------------------------------------------------- */

function renderStints(byNumber, stints) {
  if (!stints.length) return el('span');

  const byDriver = groupBy(stints, (s) => s.driver_number);
  const lastLap = Math.max(...stints.map((s) => s.lap_end ?? 0), 1);

  const rows = [...byDriver.entries()]
    .sort((a, b) => (byNumber.get(a[0])?.name_acronym ?? '').localeCompare(byNumber.get(b[0])?.name_acronym ?? ''))
    .map(([number, list]) => {
      const driver = byNumber.get(number);

      const bars = list
        .sort((a, b) => (a.lap_start ?? 0) - (b.lap_start ?? 0))
        .map((s) => {
          const start = s.lap_start ?? 0;
          const end = s.lap_end ?? start;
          const width = ((end - start + 1) / lastLap) * 100;
          const compound = (s.compound ?? '').toUpperCase();
          return el('div', {
            style:
              `width:${width}%;background:${TYRE_COLOURS[compound] ?? '#6b7280'};` +
              'height:14px;border-radius:2px;margin-right:2px;flex-shrink:0',
            title: `${compound || 'unknown'} · laps ${start}–${end}`,
          });
        });

      return el(
        'div',
        { style: 'display:flex;align-items:center;gap:10px;margin-bottom:6px' },
        el(
          'div',
          {
            class: 'num',
            style: `width:46px;color:${colourOf(driver)};font-weight:700;font-size:12px`,
          },
          driver?.name_acronym ?? `#${number}`,
        ),
        el('div', { style: 'display:flex;flex:1;min-width:0' }, bars),
      );
    });

  const legend = Object.entries(TYRE_COLOURS).map(([name, colour]) =>
    el(
      'span',
      { style: 'display:inline-flex;align-items:center;gap:5px;margin-right:14px' },
      el('span', { style: `width:9px;height:9px;border-radius:50%;background:${colour}` }),
      el('span', { class: 'stat-sub' }, name),
    ),
  );

  return el(
    'div',
    { class: 'card' },
    el('h2', { class: 'card-title' }, 'Tyre strategy'),
    el('div', { style: 'margin-bottom:12px' }, legend),
    rows,
  );
}
