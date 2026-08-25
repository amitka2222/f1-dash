/**
 * Title Race — championship permutation calculator.
 *
 * Takes the live standings and the remaining calendar, lets you assign a
 * finishing position to each contender in every remaining round, and recomputes
 * the final championship as you go.
 */

import { driverStandings, schedule } from '../api.js';
import { el, clear, teamColour, fmt, select, loading } from '../util.js';

// 2026 scoring. The fastest-lap bonus point no longer exists.
const RACE_POINTS = [25, 18, 15, 12, 10, 8, 6, 4, 2, 1];
const SPRINT_POINTS = [8, 7, 6, 5, 4, 3, 2, 1];

const DNF = 'DNF';
const DEFAULT_TRACKED = 5;

const racePoints = (pos) => (pos === DNF ? 0 : (RACE_POINTS[pos - 1] ?? 0));
const sprintPoints = (pos) => (pos === DNF ? 0 : (SPRINT_POINTS[pos - 1] ?? 0));

/** Positions offered per race: the points-paying places plus a DNF. */
const POSITION_OPTIONS = [
  ...RACE_POINTS.map((_, i) => ({ value: String(i + 1), label: fmt.ordinal(i + 1) })),
  { value: '11', label: '11th+ (no points)' },
  { value: DNF, label: 'DNF' },
];

export async function render(root) {
  root.append(loading('Loading championship state…'));

  const [standings, calendar] = await Promise.all([
    driverStandings(),
    schedule(),
  ]);

  clear(root);

  const remaining = calendar.filter((r) => r.round > standings.round);
  const tracked = standings.rows.slice(0, DEFAULT_TRACKED);

  // scenario[round][driverId] = position string
  const scenario = defaultScenario(remaining, tracked);

  const state = { standings, calendar, remaining, tracked, scenario };

  root.append(
    el(
      'div',
      { class: 'page-head' },
      el('h1', {}, `${standings.season} Title Race`),
      el(
        'p',
        {},
        remaining.length
          ? `${remaining.length} rounds left. Set a finishing position for each contender and the championship recalculates instantly.`
          : 'The season is complete — every round has been scored.',
      ),
    ),
  );

  root.append(renderSummary(state));

  if (!remaining.length) {
    root.append(renderFinal(state));
    return;
  }

  // Both panels re-render into stable containers, so a preset can rebuild the
  // selects without any node-swapping bookkeeping.
  const gridHost = el('div');
  const results = el('div');

  root.append(renderPresets(state, () => refresh(true)), gridHost, results);

  function refresh(rebuildGrid = false) {
    if (rebuildGrid) {
      clear(gridHost).append(renderScenarioGrid(state, () => refresh()));
    }
    clear(results).append(renderProjection(state));
  }

  refresh(true);
}

/** Neutral starting point: everyone finishes where they currently sit. */
function defaultScenario(remaining, tracked) {
  const scenario = {};
  for (const race of remaining) {
    scenario[race.round] = {};
    tracked.forEach((driver, index) => {
      scenario[race.round][driver.driverId] = String(index + 1);
    });
  }
  return scenario;
}

/* --- summary tiles -------------------------------------------------------- */

function renderSummary(state) {
  const { standings, remaining } = state;
  const [leader, second] = standings.rows;

  const sprintsLeft = remaining.filter((r) => r.sprint).length;
  const maxRemaining = remaining.length * RACE_POINTS[0] + sprintsLeft * SPRINT_POINTS[0];

  const alive = standings.rows.filter((d) => d.points + maxRemaining >= leader.points);
  const decided = remaining.length > 0 && alive.length <= 1;

  return el(
    'div',
    { class: 'grid grid-4', style: 'margin-bottom:22px' },

    tile('Championship leader', leader.code, `${leader.name} · ${fmt.points(leader.points)} pts`),
    tile(
      'Lead',
      second ? `${fmt.points(leader.points - second.points)}` : '—',
      second ? `over ${second.name}` : 'no rival',
    ),
    tile(
      'Still on the table',
      String(maxRemaining),
      `${remaining.length} rounds${sprintsLeft ? ` · ${sprintsLeft} sprint` : ''}`,
    ),
    tile(
      'Mathematically alive',
      String(Math.max(alive.length, 1)),
      decided ? 'title already decided' : `of ${standings.rows.length} drivers`,
    ),
  );
}

function tile(label, value, sub) {
  return el(
    'div',
    { class: 'stat' },
    el('div', { class: 'stat-label' }, label),
    el('div', { class: 'stat-value' }, value),
    el('div', { class: 'stat-sub' }, sub),
  );
}

/* --- presets -------------------------------------------------------------- */

function renderPresets(state, onChange) {
  const { remaining, tracked, scenario } = state;

  const apply = (fn) => {
    for (const race of remaining) {
      tracked.forEach((driver, index) => {
        scenario[race.round][driver.driverId] = fn(driver, index, race);
      });
    }
    onChange();
  };

  return el(
    'div',
    { class: 'toolbar' },
    el('label', {}, 'Presets'),
    el(
      'button',
      { onclick: () => apply((_, index) => String(index + 1)) },
      'Current form',
    ),
    el(
      'button',
      {
        onclick: () =>
          apply((driver, index) => (index === 0 ? '1' : String(index + 1))),
      },
      'Leader wins out',
    ),
    el(
      'button',
      {
        // Flip the order so the chaser wins every remaining round.
        onclick: () =>
          apply((driver, index) => {
            if (index === 1) return '1';
            if (index === 0) return '2';
            return String(index + 1);
          }),
      },
      'Challenger wins out',
    ),
    el(
      'button',
      { onclick: () => apply((driver, index) => (index === 0 ? DNF : String(index))) },
      'Leader DNFs out',
    ),
  );
}

/* --- scenario grid -------------------------------------------------------- */

function renderScenarioGrid(state, onChange) {
  const { remaining, tracked, scenario } = state;

  const head = el(
    'tr',
    {},
    el('th', {}, 'Round'),
    el('th', {}, 'Grand Prix'),
    tracked.map((d) =>
      el(
        'th',
        { style: `border-bottom:2px solid ${teamColour(d.constructorId)}` },
        d.code,
      ),
    ),
  );

  const rows = remaining.map((race) =>
    el(
      'tr',
      {},
      el('td', { class: 'num pos' }, String(race.round)),
      el(
        'td',
        {},
        race.name,
        race.sprint ? el('span', { class: 'driver-team' }, 'SPRINT') : null,
      ),
      tracked.map((driver) =>
        el(
          'td',
          {},
          select(
            POSITION_OPTIONS,
            scenario[race.round][driver.driverId],
            (value) => {
              scenario[race.round][driver.driverId] = value;
              onChange();
            },
            { 'aria-label': `${driver.name} at ${race.name}` },
          ),
        ),
      ),
    ),
  );

  return el(
    'div',
    { class: 'table-wrap', style: 'margin-bottom:22px' },
    el('table', {}, el('thead', {}, head), el('tbody', {}, rows)),
  );
}

/* --- projection ----------------------------------------------------------- */

function project(state) {
  const { standings, remaining, tracked, scenario } = state;
  const trackedIds = new Set(tracked.map((d) => d.driverId));

  return standings.rows
    .map((driver) => {
      if (!trackedIds.has(driver.driverId)) {
        // Untracked drivers are assumed to score nothing further, so the
        // projection stays a comparison between the contenders you chose.
        return { ...driver, gained: 0, projected: driver.points, wins: driver.wins };
      }

      let gained = 0;
      let wins = driver.wins;

      for (const race of remaining) {
        const pos = scenario[race.round][driver.driverId];
        gained += racePoints(pos === DNF ? DNF : Number(pos));
        if (race.sprint) gained += sprintPoints(pos === DNF ? DNF : Number(pos));
        if (pos === '1') wins += 1;
      }

      return { ...driver, gained, projected: driver.points + gained, wins };
    })
    .sort((a, b) => b.projected - a.projected || b.wins - a.wins);
}

function renderProjection(state) {
  const projected = project(state);
  const [champion, runnerUp] = projected;
  const margin = champion.projected - (runnerUp?.projected ?? 0);
  const tieBroken = margin === 0 && runnerUp;

  const rows = projected.slice(0, 10).map((d, i) =>
    el(
      'tr',
      {},
      el('td', { class: `pos ${i === 0 ? 'pos-1' : ''}` }, String(i + 1)),
      el(
        'td',
        {},
        el(
          'span',
          { class: 'driver-cell' },
          el('span', {
            class: 'team-strip',
            style: `background:${teamColour(d.constructorId)}`,
          }),
          el('span', { class: 'driver-name' }, d.name),
          el('span', { class: 'driver-team' }, d.constructor),
        ),
      ),
      el('td', { class: 'num' }, fmt.points(d.points)),
      el('td', { class: 'num', style: d.gained ? 'color:var(--green)' : '' },
        d.gained ? `+${fmt.points(d.gained)}` : '—'),
      el('td', { class: 'num', style: 'font-weight:700' }, fmt.points(d.projected)),
      el('td', { class: 'num' }, String(d.wins)),
    ),
  );

  return el(
    'div',
    { class: 'card' },
    el('h2', { class: 'card-title' }, 'Projected final championship'),

    el(
      'p',
      { style: 'margin:-6px 0 14px;color:var(--muted);font-size:14px' },
      tieBroken
        ? `${champion.name} takes the title on countback — level on points with ${runnerUp.name}, ahead on wins.`
        : `${champion.name} wins the championship by ${fmt.points(margin)} ${margin === 1 ? 'point' : 'points'}.`,
    ),

    el(
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
            el('th', {}, ''),
            el('th', {}, 'Driver'),
            el('th', {}, 'Now'),
            el('th', {}, 'Gained'),
            el('th', {}, 'Final'),
            el('th', {}, 'Wins'),
          ),
        ),
        el('tbody', {}, rows),
      ),
    ),

    el(
      'p',
      { class: 'stat-sub', style: 'margin-top:12px' },
      'Only the tracked contenders score in this projection; everyone else is held at their current total.',
    ),
  );
}

/** Season already finished — just show how it ended. */
function renderFinal(state) {
  const rows = state.standings.rows.slice(0, 10).map((d, i) =>
    el(
      'tr',
      {},
      el('td', { class: `pos ${i === 0 ? 'pos-1' : ''}` }, String(i + 1)),
      el(
        'td',
        {},
        el(
          'span',
          { class: 'driver-cell' },
          el('span', { class: 'team-strip', style: `background:${teamColour(d.constructorId)}` }),
          el('span', { class: 'driver-name' }, d.name),
          el('span', { class: 'driver-team' }, d.constructor),
        ),
      ),
      el('td', { class: 'num' }, fmt.points(d.points)),
      el('td', { class: 'num' }, String(d.wins)),
    ),
  );

  return el(
    'div',
    { class: 'table-wrap' },
    el(
      'table',
      {},
      el(
        'thead',
        {},
        el('tr', {}, el('th', {}, ''), el('th', {}, 'Driver'), el('th', {}, 'Points'), el('th', {}, 'Wins')),
      ),
      el('tbody', {}, rows),
    ),
  );
}
