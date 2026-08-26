/**
 * Title Race — what has to happen for each contender to win the championship.
 *
 * The default view answers the questions people actually ask — how big is the
 * lead, when could it be sealed, what does each chaser need — without the
 * visitor touching anything. The manual scenario builder is secondary and stays
 * collapsed until asked for, because a wall of dropdowns is not a starting
 * point, it's a follow-up.
 */

import { driverStandings, schedule } from '../api.js';
import { el, clear, teamColour, fmt, select, loading } from '../util.js';

// 2026 scoring. The fastest-lap bonus point no longer exists.
const RACE_POINTS = [25, 18, 15, 12, 10, 8, 6, 4, 2, 1];
const SPRINT_POINTS = [8, 7, 6, 5, 4, 3, 2, 1];

const WIN = RACE_POINTS[0];
const SPRINT_WIN = SPRINT_POINTS[0];

const DNF = 'DNF';
const CONTENDERS = 5;

const racePoints = (pos) => (pos === DNF ? 0 : (RACE_POINTS[pos - 1] ?? 0));
const sprintPoints = (pos) => (pos === DNF ? 0 : (SPRINT_POINTS[pos - 1] ?? 0));

const POSITION_OPTIONS = [
  ...RACE_POINTS.map((_, i) => ({ value: String(i + 1), label: fmt.ordinal(i + 1) })),
  { value: '11', label: '11th+' },
  { value: DNF, label: 'DNF' },
];

/** Maximum points still available across a set of rounds. */
const maxPoints = (races) =>
  races.length * WIN + races.filter((r) => r.sprint).length * SPRINT_WIN;

export async function render(root) {
  root.append(loading('Loading championship state…'));

  const [standings, calendar] = await Promise.all([driverStandings(), schedule()]);
  clear(root);

  const remaining = calendar.filter((r) => r.round > standings.round);
  const tracked = standings.rows.slice(0, CONTENDERS);
  const scenario = baselineScenario(remaining, tracked);
  const state = { standings, remaining, tracked, scenario };

  root.append(
    el(
      'div',
      { class: 'page-head' },
      el('h1', {}, `${standings.season} Title Race`),
      el(
        'p',
        {},
        remaining.length
          ? `${standings.rows[0].name} leads with ${remaining.length} rounds still to run. ` +
              `Here's what each contender needs — and what would have to go wrong.`
          : 'The season is complete — every round has been scored.',
      ),
    ),
  );

  if (!remaining.length) {
    root.append(renderFinalStandings(state));
    return;
  }

  root.append(renderHeadline(state), renderNeeds(state), renderBuilder(state));
}

/* --- headline ------------------------------------------------------------- */

/**
 * Earliest round at which the leader could mathematically seal the title,
 * assuming the best case for them: they win every race, the nearest rival
 * finishes second in every race.
 */
function earliestClinch({ standings, remaining }) {
  const [leader, rival] = standings.rows;
  if (!rival) return null;

  let gap = leader.points - rival.points;

  for (const [index, race] of remaining.entries()) {
    // Leader wins, rival is runner-up: the gap grows by the difference.
    gap += WIN - RACE_POINTS[1];
    if (race.sprint) gap += SPRINT_WIN - SPRINT_POINTS[1];

    const left = remaining.slice(index + 1);
    if (gap > maxPoints(left)) return { race, round: race.round, gap };
  }

  return null;
}

function renderHeadline(state) {
  const { standings, remaining } = state;
  const [leader, second] = standings.rows;
  const available = maxPoints(remaining);
  const clinch = earliestClinch(state);
  const sprints = remaining.filter((r) => r.sprint).length;

  const tile = (label, value, sub) =>
    el(
      'div',
      { class: 'stat' },
      el('div', { class: 'stat-label' }, label),
      el('div', { class: 'stat-value' }, value),
      el('div', { class: 'stat-sub' }, sub),
    );

  return el(
    'div',
    { class: 'grid grid-4', style: 'margin-bottom:24px' },
    tile('Leads the championship', leader.code, `${leader.name} · ${fmt.points(leader.points)} pts`),
    tile(
      'Lead over 2nd',
      second ? fmt.points(leader.points - second.points) : '—',
      second ? `${second.name} on ${fmt.points(second.points)}` : 'no rival',
    ),
    tile(
      'Still to play for',
      String(available),
      `${remaining.length} rounds${sprints ? ` · ${sprints} sprint` : ''}`,
    ),
    clinch
      ? tile('Could clinch as early as', `R${clinch.round}`, clinch.race.name)
      : tile('Could clinch as early as', '—', 'not before the finale'),
  );
}

/* --- what each contender needs -------------------------------------------- */

/**
 * For each chaser, the average per-race margin they need over the leader to
 * overturn the deficit. That's a far more intuitive answer than a raw points
 * total: "beat him by 6 points a race" means something, "make up 59" doesn't.
 */
function renderNeeds(state) {
  const { standings, remaining } = state;
  const leader = standings.rows[0];
  const available = maxPoints(remaining);

  const rows = standings.rows.slice(0, 8).map((driver, index) => {
    const deficit = leader.points - driver.points;
    const alive = deficit <= available;
    const perRace = deficit / remaining.length;

    // The most you can gain on a rival in one race is a win against their zero
    // (25). Beating them into second only swings 7 — so anyone needing more
    // than that per race cannot do it on their own results alone; the leader
    // has to actually drop points somewhere.
    const swingIfLeaderSecond = WIN - RACE_POINTS[1];

    let verdict;
    if (index === 0) {
      verdict = el('span', { style: 'color:var(--gold)' }, 'Leads the championship');
    } else if (!alive) {
      verdict = el('span', { style: 'color:var(--dim)' }, 'Cannot win the title');
    } else if (perRace > swingIfLeaderSecond) {
      verdict = el(
        'span',
        { style: 'color:var(--muted)' },
        `Needs ${perRace.toFixed(1)} pts/race — winning every race isn't enough on its own, ` +
          `so ${leader.code} has to drop points too`,
      );
    } else {
      verdict = el(
        'span',
        {},
        `Enough to win every race with `,
        el('b', {}, leader.code),
        ` second: needs `,
        el('b', {}, perRace.toFixed(1)),
        ' pts per race',
      );
    }

    return el(
      'tr',
      {},
      el('td', { class: `pos ${index === 0 ? 'pos-1' : ''}` }, String(index + 1)),
      el(
        'td',
        {},
        el(
          'span',
          { class: 'driver-cell' },
          el('span', { class: 'team-strip', style: `background:${teamColour(driver.constructorId)}` }),
          el('span', { class: 'driver-name' }, driver.name),
          el('span', { class: 'driver-team' }, driver.constructor),
        ),
      ),
      el('td', { class: 'num' }, fmt.points(driver.points)),
      el('td', { class: 'num', style: index === 0 ? 'color:var(--dim)' : '' },
        index === 0 ? '—' : `−${fmt.points(deficit)}`),
      el('td', { style: 'white-space:normal;min-width:280px' }, verdict),
    );
  });

  return el(
    'div',
    { style: 'margin-bottom:24px' },
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
            el('th', {}, 'Points'),
            el('th', {}, 'Behind'),
            el('th', {}, 'What they need'),
          ),
        ),
        el('tbody', {}, rows),
      ),
    ),
    el(
      'p',
      { class: 'stat-sub', style: 'margin-top:10px;max-width:78ch' },
      `A win is worth ${WIN} points and second ${RACE_POINTS[1]}, so beating the leader into ` +
        `second gains you just ${WIN - RACE_POINTS[1]} a race. The full ${WIN} only swings your ` +
        `way if they finish out of the points altogether.`,
    ),
  );
}

/* --- scenario builder (collapsed by default) ------------------------------- */

/** Baseline: everyone holds the position they currently hold in the standings. */
function baselineScenario(remaining, tracked) {
  const scenario = {};
  for (const race of remaining) {
    scenario[race.round] = {};
    tracked.forEach((driver, index) => {
      scenario[race.round][driver.driverId] = String(index + 1);
    });
  }
  return scenario;
}

function renderBuilder(state) {
  const { tracked } = state;

  const body = el('div', { style: 'display:none' });
  let open = false;

  const toggle = el(
    'button',
    {
      onclick: () => {
        open = !open;
        body.style.display = open ? 'block' : 'none';
        toggle.textContent = open ? 'Hide scenario builder' : 'Build your own scenario';
        if (open && !body.childElementCount) fill();
      },
    },
    'Build your own scenario',
  );

  const gridHost = el('div');
  const results = el('div');

  function refresh(rebuildGrid = false) {
    if (rebuildGrid) clear(gridHost).append(renderScenarioGrid(state, () => refresh()));
    clear(results).append(renderProjection(state));
  }

  function fill() {
    body.append(
      el(
        'p',
        { style: 'color:var(--muted);font-size:14px;max-width:70ch;margin:0 0 14px' },
        'Each row is a remaining Grand Prix and each column is a title contender. ' +
          'Set where you think they finish and the final championship below updates. ' +
          'It starts from a baseline where everyone simply holds their current championship position.',
      ),
      renderPresets(state, () => refresh(true)),
      gridHost,
      results,
    );
    refresh(true);
  }

  return el(
    'div',
    { class: 'card' },
    el('h2', { class: 'card-title' }, 'Play it out yourself'),
    el(
      'p',
      { style: 'margin:-6px 0 12px;color:var(--muted);font-size:14px;max-width:70ch' },
      `Want to test a specific run of results — a retirement, a bad weekend, a comeback? ` +
        `Set finishing positions for the top ${tracked.length} and see where the championship lands.`,
    ),
    toggle,
    body,
  );
}

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

  const preset = (label, title, fn) =>
    el('button', { title, onclick: () => apply(fn) }, label);

  return el(
    'div',
    { class: 'toolbar' },
    el('label', {}, 'Quick scenarios'),
    preset('Form holds', 'Everyone finishes in their current championship order', (_, i) =>
      String(i + 1),
    ),
    preset(`${tracked[0].code} wins out`, `${tracked[0].name} wins every remaining race`, (_, i) =>
      i === 0 ? '1' : String(i + 1),
    ),
    preset(
      `${tracked[1].code} wins out`,
      `${tracked[1].name} wins every remaining race`,
      (_, i) => (i === 1 ? '1' : i === 0 ? '2' : String(i + 1)),
    ),
    preset(
      `${tracked[0].code} retires`,
      `${tracked[0].name} fails to finish every remaining race`,
      (_, i) => (i === 0 ? DNF : String(i)),
    ),
  );
}

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
        { style: `border-bottom:2px solid ${teamColour(d.constructorId)}`, title: d.name },
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
        race.sprint
          ? el(
              'span',
              { class: 'driver-team', title: 'Sprint weekend — extra points available' },
              'SPRINT',
            )
          : null,
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
            { 'aria-label': `${driver.name} at the ${race.name}` },
          ),
        ),
      ),
    ),
  );

  return el(
    'div',
    { class: 'table-wrap', style: 'margin-bottom:20px' },
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
        return { ...driver, gained: 0, projected: driver.points };
      }

      let gained = 0;
      let wins = driver.wins;

      for (const race of remaining) {
        const raw = scenario[race.round][driver.driverId];
        const pos = raw === DNF ? DNF : Number(raw);
        gained += racePoints(pos);
        if (race.sprint) gained += sprintPoints(pos);
        if (raw === '1') wins += 1;
      }

      return { ...driver, gained, projected: driver.points + gained, wins };
    })
    .sort((a, b) => b.projected - a.projected || b.wins - a.wins);
}

function renderProjection(state) {
  const projected = project(state);
  const [champion, runnerUp] = projected;
  const margin = champion.projected - (runnerUp?.projected ?? 0);

  const rows = projected.slice(0, 8).map((d, i) =>
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
        ),
      ),
      el('td', { class: 'num' }, fmt.points(d.points)),
      el('td', { class: 'num', style: d.gained ? 'color:var(--green)' : 'color:var(--dim)' },
        d.gained ? `+${fmt.points(d.gained)}` : '—'),
      el('td', { class: 'num', style: 'font-weight:700' }, fmt.points(d.projected)),
    ),
  );

  return el(
    'div',
    {},
    el(
      'p',
      { style: 'font-size:15px;margin:0 0 12px' },
      margin === 0 && runnerUp
        ? `${champion.name} takes it on countback — level with ${runnerUp.name}, ahead on wins.`
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
            el('th', {}, 'Gains'),
            el('th', {}, 'Final'),
          ),
        ),
        el('tbody', {}, rows),
      ),
    ),
    el(
      'p',
      { class: 'stat-sub', style: 'margin-top:10px' },
      'Only the contenders above score in this projection — everyone else stays on their current total.',
    ),
  );
}

/* --- completed season ------------------------------------------------------ */

function renderFinalStandings({ standings }) {
  const rows = standings.rows.slice(0, 10).map((d, i) =>
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
      el('thead', {}, el('tr', {}, el('th', {}, ''), el('th', {}, 'Driver'), el('th', {}, 'Points'), el('th', {}, 'Wins'))),
      el('tbody', {}, rows),
    ),
  );
}
