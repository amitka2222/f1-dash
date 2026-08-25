/**
 * Archive — 76 seasons of records.
 *
 * Everything here reads the pre-baked JSON, so this view makes zero upstream
 * calls and stays fast no matter how many people are browsing it.
 */

import { archive } from '../api.js';
import { el, clear, teamColour, fmt, loading, debounce } from '../util.js';

const TABS = [
  { id: 'champions', label: 'Champions' },
  { id: 'drivers', label: 'Drivers' },
  { id: 'constructors', label: 'Constructors' },
  { id: 'circuits', label: 'Circuits' },
];

export async function render(root) {
  root.append(loading('Loading archive…'));

  const [meta, seasons, drivers, constructors, circuits] = await Promise.all(
    ['meta', 'seasons', 'drivers', 'constructors', 'circuits'].map(archive),
  );

  clear(root);

  const data = { meta, seasons, drivers, constructors, circuits };
  let active = 'champions';
  let query = '';

  root.append(
    el(
      'div',
      { class: 'page-head' },
      el('h1', {}, 'Archive'),
      el(
        'p',
        {},
        `${meta.counts.seasons} seasons · ${meta.counts.races} races · ${meta.counts.drivers} drivers · ` +
          `${meta.counts.circuits} circuits, from ${meta.firstSeason} to ${meta.latestSeason}.`,
      ),
    ),
  );

  root.append(renderHeadline(data));

  const toolbar = el('div', { class: 'toolbar' });
  const panel = el('div');

  const search = el('input', {
    type: 'search',
    placeholder: 'Filter…',
    style: 'margin-left:auto;min-width:200px',
    oninput: debounce((e) => {
      query = e.target.value.trim().toLowerCase();
      draw();
    }, 150),
  });

  const tabButtons = TABS.map((tab) =>
    el(
      'button',
      {
        class: tab.id === active ? 'primary' : '',
        onclick: () => {
          active = tab.id;
          query = '';
          search.value = '';
          for (const [i, btn] of tabButtons.entries()) {
            btn.className = TABS[i].id === active ? 'primary' : '';
          }
          draw();
        },
      },
      tab.label,
    ),
  );

  toolbar.append(...tabButtons, search);
  root.append(toolbar, panel);

  function draw() {
    const render = {
      champions: renderChampions,
      drivers: renderDrivers,
      constructors: renderConstructors,
      circuits: renderCircuits,
    }[active];

    clear(panel).append(render(data, query));
  }

  draw();
}

/* --- headline records ----------------------------------------------------- */

function renderHeadline({ drivers, constructors, circuits, seasons }) {
  const mostTitles = [...drivers].sort((a, b) => b.titles - a.titles)[0];
  const topWinner = drivers[0];
  const topTeam = constructors[0];
  const busiest = circuits[0];

  const tile = (label, value, sub) =>
    el(
      'div',
      { class: 'stat' },
      el('div', { class: 'stat-label' }, label),
      el('div', { class: 'stat-value', style: 'font-size:20px' }, value),
      el('div', { class: 'stat-sub' }, sub),
    );

  return el(
    'div',
    { class: 'grid grid-4', style: 'margin-bottom:22px' },
    tile('Most wins', topWinner.name, `${topWinner.wins} victories`),
    tile('Most titles', mostTitles.name, `${mostTitles.titles} championships`),
    tile('Most successful team', topTeam.name, `${topTeam.wins} wins · ${topTeam.titles} titles`),
    tile('Most used circuit', busiest.name, `${busiest.races} world championship races`),
  );
}

/* --- tables --------------------------------------------------------------- */

const matches = (query, ...fields) =>
  !query || fields.some((f) => String(f ?? '').toLowerCase().includes(query));

function table(headers, rows) {
  if (!rows.length) return el('div', { class: 'empty' }, 'Nothing matches that filter.');
  return el(
    'div',
    { class: 'table-wrap' },
    el(
      'table',
      {},
      el('thead', {}, el('tr', {}, headers.map((h) => el('th', {}, h)))),
      el('tbody', {}, rows),
    ),
  );
}

function renderChampions({ seasons }, query) {
  const rows = [...seasons]
    .reverse()
    .filter((s) =>
      matches(query, s.season, s.driver.name, s.driver.constructor, s.constructor?.name),
    )
    .map((s) =>
      el(
        'tr',
        {},
        el('td', { class: 'num', style: 'font-weight:700' }, String(s.season)),
        el(
          'td',
          {},
          el('span', { class: 'driver-name' }, s.driver.name),
          !s.complete ? el('span', { class: 'driver-team' }, 'IN PROGRESS') : null,
        ),
        el('td', { class: 'num' }, fmt.points(s.driver.points)),
        el('td', { class: 'num' }, String(s.driver.wins)),
        el(
          'td',
          {},
          s.constructor
            ? el(
                'span',
                {},
                el('span', {
                  class: 'team-strip',
                  style: `background:${teamColour(s.constructor.id)}`,
                }),
                s.constructor.name,
              )
            : el('span', { style: 'color:var(--dim)' }, 'no team title'),
        ),
        el('td', { class: 'num' }, String(s.rounds)),
      ),
    );

  return table(["Season", "Drivers' champion", 'Points', 'Wins', "Constructors' champion", 'Rounds'], rows);
}

function renderDrivers({ drivers }, query) {
  const rows = drivers
    .filter((d) => d.wins > 0 || query)
    .filter((d) => matches(query, d.name, d.nationality, d.code))
    .slice(0, 200)
    .map((d, i) =>
      el(
        'tr',
        {},
        el('td', { class: `pos ${i === 0 && !query ? 'pos-1' : ''}` }, String(i + 1)),
        el(
          'td',
          {},
          el('span', { class: 'driver-name' }, d.name),
          d.code ? el('span', { class: 'driver-team' }, d.code) : null,
        ),
        el('td', {}, d.nationality),
        el('td', { class: 'num', style: 'font-weight:700' }, String(d.wins)),
        el(
          'td',
          { class: 'num', style: d.titles ? 'color:var(--gold);font-weight:700' : '' },
          d.titles ? String(d.titles) : '—',
        ),
        el(
          'td',
          { class: 'num', style: 'color:var(--muted)' },
          d.firstWin ? `${d.firstWin}–${d.lastWin}` : '—',
        ),
      ),
    );

  return table(['', 'Driver', 'Nationality', 'Wins', 'Titles', 'Winning years'], rows);
}

function renderConstructors({ constructors }, query) {
  const rows = constructors
    .filter((c) => c.wins > 0 || query)
    .filter((c) => matches(query, c.name, c.nationality))
    .slice(0, 200)
    .map((c, i) =>
      el(
        'tr',
        {},
        el('td', { class: `pos ${i === 0 && !query ? 'pos-1' : ''}` }, String(i + 1)),
        el(
          'td',
          {},
          el('span', { class: 'team-strip', style: `background:${teamColour(c.id)}` }),
          el('span', { class: 'driver-name' }, c.name),
        ),
        el('td', {}, c.nationality),
        el('td', { class: 'num', style: 'font-weight:700' }, String(c.wins)),
        el(
          'td',
          { class: 'num', style: c.titles ? 'color:var(--gold);font-weight:700' : '' },
          c.titles ? String(c.titles) : '—',
        ),
      ),
    );

  return table(['', 'Constructor', 'Nationality', 'Wins', 'Titles'], rows);
}

function renderCircuits({ circuits }, query) {
  const rows = circuits
    .filter((c) => matches(query, c.name, c.country, c.locality))
    .map((c, i) =>
      el(
        'tr',
        {},
        el('td', { class: `pos ${i === 0 && !query ? 'pos-1' : ''}` }, String(i + 1)),
        el('td', {}, el('span', { class: 'driver-name' }, c.name)),
        el('td', {}, `${c.locality}, ${c.country}`),
        el('td', { class: 'num', style: 'font-weight:700' }, String(c.races)),
      ),
    );

  return table(['', 'Circuit', 'Location', 'Races held'], rows);
}
