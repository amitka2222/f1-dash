/**
 * Head to Head — compare any two drivers across their whole careers.
 *
 * Career totals come from the pre-baked archive (free, instant). The
 * season-by-season breakdown is fetched per driver, so only two API calls are
 * made no matter how much the user clicks around.
 */

import { archive, driverSeasons } from '../api.js';
import { el, clear, teamColour, fmt, loading, errorBox } from '../util.js';

// Two evenly matched, era-defining careers make a better first impression than
// an empty form.
const DEFAULT_PAIR = ['hamilton', 'michael_schumacher'];

const SIDE_COLOURS = ['#1d63d8', '#e10600'];

export async function render(root, args) {
  root.append(loading('Loading driver index…'));

  const drivers = await archive('drivers');
  clear(root);

  const byId = new Map(drivers.map((d) => [d.id, d]));
  const selected = [
    byId.has(args[0]) ? args[0] : DEFAULT_PAIR[0],
    byId.has(args[1]) ? args[1] : DEFAULT_PAIR[1],
  ];

  root.append(
    el(
      'div',
      { class: 'page-head' },
      el('h1', {}, 'Head to Head'),
      el('p', {}, 'Compare any two drivers from 1950 onwards — careers, titles and season form.'),
    ),
  );

  // Drivers who never won sort last but are still selectable; label them so the
  // list stays readable.
  const options = drivers.map((d) => ({
    value: d.id,
    label: `${d.name}${d.wins ? ` — ${d.wins} win${d.wins === 1 ? '' : 's'}` : ''}`,
  }));

  const pickers = el('div', { class: 'grid grid-2', style: 'margin-bottom:20px' });
  const output = el('div');

  selected.forEach((id, side) => {
    pickers.append(
      el(
        'div',
        {},
        el(
          'label',
          { class: 'stat-label', style: `color:${SIDE_COLOURS[side]}` },
          side === 0 ? 'Driver A' : 'Driver B',
        ),
        el(
          'select',
          {
            style: 'width:100%;margin-top:6px',
            onchange: (e) => {
              selected[side] = e.target.value;
              history.replaceState(null, '', `#/h2h/${selected[0]}/${selected[1]}`);
              update();
            },
          },
          options.map((o) =>
            el('option', { value: o.value, selected: o.value === id }, o.label),
          ),
        ),
      ),
    );
  });

  root.append(pickers, output);

  async function update() {
    clear(output).append(loading('Crunching careers…'));
    try {
      const [a, b] = selected.map((id) => byId.get(id));
      const [seasonsA, seasonsB] = await Promise.all(selected.map(driverSeasons));
      clear(output).append(
        renderCareer(a, b, seasonsA, seasonsB),
        renderSeasonTable(a, b, seasonsA, seasonsB),
      );
    } catch (err) {
      clear(output).append(errorBox(err));
    }
  }

  await update();
}

/* --- career comparison ---------------------------------------------------- */

function renderCareer(a, b, seasonsA, seasonsB) {
  const stats = [
    ['Race wins', a.wins, b.wins],
    ['World titles', a.titles, b.titles],
    ['Seasons contested', seasonsA.length, seasonsB.length],
    ['Podium seasons (top 3)', topThreeSeasons(seasonsA), topThreeSeasons(seasonsB)],
    ['Best championship finish', bestFinish(seasonsA), bestFinish(seasonsB), 'lower'],
    ['Career points', careerPoints(seasonsA), careerPoints(seasonsB)],
  ];

  return el(
    'div',
    { class: 'card', style: 'margin-bottom:18px' },
    el('h2', { class: 'card-title' }, 'Career comparison'),
    el(
      'div',
      { style: 'display:flex;justify-content:space-between;margin-bottom:16px;gap:12px' },
      nameplate(a, 0),
      nameplate(b, 1),
    ),
    stats.map(([label, va, vb, direction]) => comparisonRow(label, va, vb, direction)),
  );
}

function nameplate(driver, side) {
  return el(
    'div',
    { style: side === 1 ? 'text-align:right' : '' },
    el(
      'div',
      { style: `font-size:19px;font-weight:800;color:${SIDE_COLOURS[side]}` },
      driver.name,
    ),
    el(
      'div',
      { class: 'stat-sub' },
      `${driver.nationality}${driver.firstWin ? ` · winner ${driver.firstWin}–${driver.lastWin}` : ''}`,
    ),
  );
}

/**
 * One stat as a mirrored bar. `direction: 'lower'` marks stats where a smaller
 * number is better (championship finishing position).
 */
function comparisonRow(label, va, vb, direction) {
  const lowerWins = direction === 'lower';
  const total = va + vb;
  // Guard the divide when neither driver has any of this stat.
  const pctA = total === 0 ? 50 : (va / total) * 100;

  const aWins = lowerWins ? va < vb : va > vb;
  const bWins = lowerWins ? vb < va : vb > va;

  const value = (v, isWinner, side) =>
    el(
      'div',
      {
        class: 'num',
        style: `font-weight:700;font-size:16px;min-width:56px;color:${
          isWinner ? SIDE_COLOURS[side] : 'var(--muted)'
        };${side === 1 ? 'text-align:right' : ''}`,
      },
      String(v),
    );

  return el(
    'div',
    { style: 'margin-bottom:12px' },
    el(
      'div',
      { style: 'display:flex;align-items:center;gap:12px' },
      value(va, aWins, 0),
      el(
        'div',
        { style: 'flex:1' },
        el(
          'div',
          {
            class: 'stat-label',
            style: 'text-align:center;margin-bottom:4px;font-size:10px',
          },
          label,
        ),
        el(
          'div',
          {
            style:
              'display:flex;height:7px;border-radius:4px;overflow:hidden;background:var(--line)',
          },
          el('div', { style: `width:${pctA}%;background:${SIDE_COLOURS[0]}` }),
          el('div', { style: `width:${100 - pctA}%;background:${SIDE_COLOURS[1]}` }),
        ),
      ),
      value(vb, bWins, 1),
    ),
  );
}

// Unclassified seasons carry a null position and must be excluded from these
// aggregates, or a null silently coerces to 0 and beats every real result.
const classified = (seasons) => seasons.filter((s) => s.position != null);

const topThreeSeasons = (seasons) => classified(seasons).filter((s) => s.position <= 3).length;
const careerPoints = (seasons) => Math.round(seasons.reduce((t, s) => t + s.points, 0));

function bestFinish(seasons) {
  const positions = classified(seasons).map((s) => s.position);
  return positions.length ? Math.min(...positions) : 0;
}

/* --- season by season ----------------------------------------------------- */

/**
 * A season without a finishing position. Most are simply unranked drivers from
 * the early decades, but a letter code carries real meaning — Schumacher's 'D'
 * in 1997 records his disqualification from the championship.
 */
const UNCLASSIFIED_CODES = {
  D: { label: 'DSQ', title: 'Disqualified from the championship' },
  E: { label: 'EXC', title: 'Excluded from the final standings' },
};

function unclassified(positionText) {
  return (
    UNCLASSIFIED_CODES[positionText] ?? {
      label: 'N/C',
      title: 'Not classified in the final standings',
    }
  );
}

function renderSeasonTable(a, b, seasonsA, seasonsB) {
  const mapA = new Map(seasonsA.map((s) => [s.season, s]));
  const mapB = new Map(seasonsB.map((s) => [s.season, s]));
  const years = [...new Set([...mapA.keys(), ...mapB.keys()])].sort((x, y) => y - x);

  if (!years.length) return el('div', { class: 'empty' }, 'No season data for these drivers.');

  const cell = (s, side) => {
    if (!s) return el('td', { class: 'num', style: 'color:var(--dim)' }, '—');
    const isChampion = s.position === 1;
    return el(
      'td',
      { class: 'num' },
      el(
        'span',
        {
          style: `color:${isChampion ? 'var(--gold)' : 'inherit'};font-weight:${
            isChampion ? 700 : 400
          }`,
          title: s.position == null ? unclassified(s.positionText).title : null,
        },
        s.position == null ? unclassified(s.positionText).label : fmt.ordinal(s.position),
      ),
      el(
        'span',
        { class: 'driver-team' },
        `${fmt.points(s.points)} pts${s.wins ? ` · ${s.wins}W` : ''}`,
      ),
    );
  };

  const teamCell = (s) =>
    el(
      'td',
      {},
      s
        ? el(
            'span',
            {},
            el('span', { class: 'team-strip', style: `background:${teamColour(s.constructorId)}` }),
            s.constructor,
          )
        : el('span', { style: 'color:var(--dim)' }, '—'),
    );

  const rows = years.map((year) => {
    const sa = mapA.get(year);
    const sb = mapB.get(year);
    return el(
      'tr',
      {},
      el('td', { class: 'num', style: 'font-weight:700' }, String(year)),
      cell(sa, 0),
      teamCell(sa),
      cell(sb, 1),
      teamCell(sb),
    );
  });

  return el(
    'div',
    { class: 'table-wrap' },
    el(
      'table',
      {},
      el(
        'thead',
        {},
        el(
          'tr',
          {},
          el('th', {}, 'Season'),
          el('th', { style: `border-bottom:2px solid ${SIDE_COLOURS[0]}` }, a.name),
          el('th', { style: `border-bottom:2px solid ${SIDE_COLOURS[0]}` }, 'Team'),
          el('th', { style: `border-bottom:2px solid ${SIDE_COLOURS[1]}` }, b.name),
          el('th', { style: `border-bottom:2px solid ${SIDE_COLOURS[1]}` }, 'Team'),
        ),
      ),
      el('tbody', {}, rows),
    ),
  );
}
