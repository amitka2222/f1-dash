/**
 * Generates one static HTML page per Grand Prix, plus an index.
 *
 * These are real files with real URLs — unlike the rest of the site, which is a
 * single hash-routed page — so a race can be linked, shared and indexed by
 * search engines, and reads fine with JavaScript disabled.
 *
 * Cost is kept low by fetching a whole season's results and qualifying in bulk
 * (3 requests each at 100 rows) rather than per race. Only pit stops require a
 * round, so those are the one per-race call.
 *
 *   HISTORY_API=... node scripts/build-races.mjs          # current season
 *   SEASON=2025 HISTORY_API=... node scripts/build-races.mjs
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.env.HISTORY_API;
if (!BASE) {
  console.error('HISTORY_API is not set. See the README.');
  process.exit(1);
}

// Incident messages are a bonus, not a requirement: this provider blocks all
// access — including historical — while any live session is running.
const LIVE_API = process.env.LIVE_API ?? 'https://api.openf1.org/v1';

const SEASON = Number(process.env.SEASON ?? new Date().getUTCFullYear());
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const OUT_DIR = join(ROOT, 'races');

const PAGE = 100;
const MIN_GAP_MS = 340;

let lastCall = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path, { limit = PAGE, offset = 0 } = {}) {
  const wait = MIN_GAP_MS - (Date.now() - lastCall);
  if (wait > 0) await sleep(wait);

  const url = `${BASE}/${path}.json?limit=${limit}&offset=${offset}`;
  for (let attempt = 0; attempt < 5; attempt++) {
    lastCall = Date.now();
    const res = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'f1-dash-race-pages' },
    });
    if (res.ok) return (await res.json()).MRData;
    if (res.status === 429) {
      const retry = Number(res.headers.get('retry-after')) || 2 ** attempt;
      await sleep(retry * 1000);
      continue;
    }
    if (res.status >= 500) {
      await sleep(2 ** attempt * 1000);
      continue;
    }
    throw new Error(`${res.status} on ${path}`);
  }
  throw new Error(`gave up on ${path}`);
}

/** Every page of a paginated race collection, flattened into round -> rows. */
async function bulkByRound(path, extract) {
  const byRound = new Map();
  let offset = 0;
  let total = Infinity;

  while (offset < total) {
    const data = await api(path, { offset });
    total = Number(data.total);
    const races = data.RaceTable?.Races ?? [];
    if (!races.length) break;
    for (const race of races) {
      const round = Number(race.round);
      const rows = extract(race);
      byRound.set(round, [...(byRound.get(round) ?? []), ...rows]);
    }
    offset += PAGE;
  }

  return byRound;
}

/* --- html ------------------------------------------------------------------ */

const esc = (v) =>
  String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const slug = (s) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

const fileFor = (round, name) => `${SEASON}-r${String(round).padStart(2, '0')}-${slug(name)}.html`;

/** Shared shell so the generated pages match the app they sit beside. */
function layout({ title, description, body, canonicalPath }) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${esc(title)}</title>
    <meta name="description" content="${esc(description)}" />
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link
      href="https://fonts.googleapis.com/css2?family=Archivo:wght@500;700;800&family=JetBrains+Mono:wght@400;700&display=swap"
      rel="stylesheet"
    />
    <link rel="stylesheet" href="../css/app.css" />
    <link
      rel="icon"
      href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><text y='26' font-size='26'>🏎️</text></svg>"
    />
  </head>
  <body>
    <header class="masthead">
      <a class="brand" href="../index.html">
        <span class="brand-mark" aria-hidden="true"></span>
        <span class="brand-text">f1<span>dash</span></span>
      </a>
      <nav class="tabs">
        <a href="../index.html#/whatif">Title Race</a>
        <a href="../index.html#/h2h">Head to Head</a>
        <a href="../index.html#/archive">Archive</a>
        <a href="../index.html#/map">Track Map</a>
        <a href="./index.html"${canonicalPath === 'index' ? ' class="active"' : ''}>Races</a>
      </nav>
    </header>

    <main class="view">
${body}
    </main>

    <footer class="footer">
      <span>${SEASON} season</span>
      <span class="footer-note">Unofficial. Not associated with Formula 1 or the FIA.</span>
    </footer>
  </body>
</html>
`;
}

const table = (headers, rows) => `        <div class="table-wrap">
          <table>
            <thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead>
            <tbody>
${rows.map((cells) => `              <tr>${cells.join('')}</tr>`).join('\n')}
            </tbody>
          </table>
        </div>`;

const td = (v, cls = '') => `<td${cls ? ` class="${cls}"` : ''}>${v}</td>`;

const tile = (label, value, sub) => `          <div class="stat">
            <div class="stat-label">${esc(label)}</div>
            <div class="stat-value" style="font-size:19px">${esc(value)}</div>
            <div class="stat-sub">${esc(sub)}</div>
          </div>`;

/* --- race page ------------------------------------------------------------- */

function racePage({ race, results, quali, sprint, pits, incidents }) {
  const podium = results.filter((r) => Number(r.position) <= 3);
  const winner = podium[0];
  const pole = quali.find((q) => Number(q.position) === 1);
  const fastest = results.find((r) => r.fastestLapRank === 1);

  const sections = [];

  sections.push(`      <div class="page-head">
        <p class="stat-label" style="margin-bottom:6px">Round ${race.round} · ${esc(race.date)}</p>
        <h1>${esc(race.name)}</h1>
        <p>${esc(race.circuit)} — ${esc(race.locality)}, ${esc(race.country)}${
          race.sprint ? ' · sprint weekend' : ''
        }</p>
      </div>`);

  // Headline facts, each only rendered when the data supports it.
  const tiles = [];
  if (winner) {
    tiles.push(tile('Winner', winner.code, `${winner.name} · ${winner.constructor}`));
  }
  if (pole) tiles.push(tile('Pole position', pole.code, `${pole.name} · ${pole.best ?? '—'}`));
  if (fastest) {
    tiles.push(tile('Fastest lap', fastest.code, `${fastest.fastestLapTime} on lap ${fastest.fastestLapLap}`));
  }
  if (winner?.time) tiles.push(tile('Race time', winner.time, `${winner.laps} laps`));
  if (tiles.length) {
    sections.push(`      <div class="grid grid-4" style="margin-bottom:24px">
${tiles.join('\n')}
      </div>`);
  }

  // Classification
  sections.push(`      <h2 class="card-title">Race classification</h2>
${table(
  ['', 'Driver', 'Team', 'Grid', 'Laps', 'Time / status', 'Pts'],
  results.map((r) => [
    td(esc(r.positionText), Number(r.position) === 1 ? 'pos pos-1' : 'pos'),
    td(
      `<span class="driver-cell"><span class="team-strip" style="background:${esc(
        r.colour,
      )}"></span><span class="driver-name">${esc(r.name)}</span></span>`,
    ),
    td(esc(r.constructor)),
    td(esc(r.grid), 'num'),
    td(esc(r.laps), 'num'),
    td(esc(r.time ?? r.status), 'num'),
    td(esc(r.points), 'num'),
  ]),
)}`);

  if (sprint.length) {
    sections.push(`      <h2 class="card-title" style="margin-top:26px">Sprint result</h2>
${table(
  ['', 'Driver', 'Team', 'Laps', 'Time / status', 'Pts'],
  sprint.map((r) => [
    td(esc(r.positionText), Number(r.position) === 1 ? 'pos pos-1' : 'pos'),
    td(`<span class="driver-name">${esc(r.name)}</span>`),
    td(esc(r.constructor)),
    td(esc(r.laps), 'num'),
    td(esc(r.time ?? r.status), 'num'),
    td(esc(r.points), 'num'),
  ]),
)}`);
  }

  if (quali.length) {
    sections.push(`      <h2 class="card-title" style="margin-top:26px">Qualifying</h2>
${table(
  ['', 'Driver', 'Team', 'Q1', 'Q2', 'Q3'],
  quali.map((q) => [
    td(esc(q.position), Number(q.position) === 1 ? 'pos pos-1' : 'pos'),
    td(`<span class="driver-name">${esc(q.name)}</span>`),
    td(esc(q.constructor)),
    td(esc(q.q1 ?? '—'), 'num'),
    td(esc(q.q2 ?? '—'), 'num'),
    td(esc(q.q3 ?? '—'), 'num'),
  ]),
)}`);
  }

  if (pits.length) {
    sections.push(`      <h2 class="card-title" style="margin-top:26px">Pit stops</h2>
${table(
  ['Driver', 'Stop', 'Lap', 'Duration'],
  pits.map((p) => [
    td(`<span class="driver-name">${esc(p.name ?? p.driverId)}</span>`),
    td(esc(p.stop), 'num'),
    td(esc(p.lap), 'num'),
    td(esc(p.duration), 'num'),
  ]),
)}`);
  }

  if (incidents.length) {
    sections.push(`      <h2 class="card-title" style="margin-top:26px">Incidents and race control</h2>
${table(
  ['Lap', 'Category', 'Message'],
  incidents.map((m) => [
    td(esc(m.lap ?? '—'), 'num'),
    td(esc(m.category ?? '—')),
    td(`<span style="white-space:normal">${esc(m.message)}</span>`),
  ]),
)}`);
  }

  sections.push(`      <p style="margin-top:26px"><a href="./index.html" style="color:var(--accent)">← All ${SEASON} races</a></p>`);

  const podiumText = podium.map((p) => p.name).join(', ');
  return layout({
    title: `${race.name} ${SEASON} — results`,
    description: `Full ${SEASON} ${race.name} result${
      podiumText ? `: ${podiumText}` : ''
    }. Classification, qualifying, pit stops and race control messages.`,
    body: sections.join('\n\n'),
  });
}

/* --- index page ------------------------------------------------------------ */

function indexPage(races) {
  const rows = races.map((r) => [
    td(String(r.round), 'num pos'),
    td(
      `<a href="./${esc(fileFor(r.round, r.name))}" style="color:var(--text);font-weight:600">${esc(
        r.name,
      )}</a>`,
    ),
    td(esc(r.date), 'num'),
    td(esc(`${r.locality}, ${r.country}`)),
    td(
      r.winner
        ? `<span class="driver-cell"><span class="team-strip" style="background:${esc(
            r.winnerColour,
          )}"></span><span class="driver-name">${esc(r.winner)}</span></span>`
        : '<span style="color:var(--dim)">—</span>',
    ),
  ]);

  const body = `      <div class="page-head">
        <h1>${SEASON} Races</h1>
        <p>Every round of the ${SEASON} season with a page of its own — full classification,
        qualifying, pit stops and race control messages.</p>
      </div>

${table(['', 'Grand Prix', 'Date', 'Location', 'Winner'], rows)}`;

  return layout({
    title: `${SEASON} Formula 1 races — results by round`,
    description: `Every ${SEASON} Formula 1 Grand Prix with full results, qualifying and pit stops.`,
    body,
    canonicalPath: 'index',
  });
}

/* --- team colours ---------------------------------------------------------- */

// Mirrors public/js/util.js. Duplicated rather than imported because that file
// is a browser module and this script has no bundler.
const TEAM_COLOURS = {
  mercedes: '#00d7b6', ferrari: '#e8002d', red_bull: '#3671c6', mclaren: '#ff8000',
  aston_martin: '#229971', alpine: '#00a1e8', williams: '#1868db', rb: '#6692ff',
  audi: '#00e701', sauber: '#00e701', haas: '#b6babd', cadillac: '#c8a24a',
};
const colourOf = (id) => TEAM_COLOURS[id] ?? '#5b6373';

/* --- build ----------------------------------------------------------------- */

async function fetchIncidents(sessionKeyByRound, round) {
  const key = sessionKeyByRound.get(round);
  if (!key) return [];
  try {
    const res = await fetch(`${LIVE_API}/race_control?session_key=${key}`);
    if (!res.ok) return [];
    const rows = await res.json();
    if (!Array.isArray(rows)) return [];
    return rows
      .filter((r) => r.message)
      .map((r) => ({ lap: r.lap_number, category: r.category, message: r.message }));
  } catch {
    return [];
  }
}

/** Map round -> timing session_key, or an empty map if the provider is closed. */
async function loadSessionKeys() {
  try {
    const res = await fetch(`${LIVE_API}/sessions?year=${SEASON}&session_name=Race`);
    if (!res.ok) {
      console.warn(`  timing provider unavailable (${res.status}) — pages build without incidents`);
      return new Map();
    }
    const sessions = await res.json();
    if (!Array.isArray(sessions)) return new Map();
    // Sessions carry no round number, so order by date and pair with the calendar.
    return new Map(
      sessions
        .sort((a, b) => new Date(a.date_start) - new Date(b.date_start))
        .map((s, i) => [i + 1, s.session_key]),
    );
  } catch {
    return new Map();
  }
}

async function main() {
  const started = Date.now();
  await mkdir(OUT_DIR, { recursive: true });

  console.log(`Building ${SEASON} race pages...`);

  const schedule = (await api(`${SEASON}`, { limit: 30 })).RaceTable.Races.map((r) => ({
    round: Number(r.round),
    name: r.raceName,
    date: r.date,
    circuit: r.Circuit.circuitName,
    locality: r.Circuit.Location.locality,
    country: r.Circuit.Location.country,
    sprint: Boolean(r.Sprint),
  }));

  console.log('  results...');
  const resultsByRound = await bulkByRound(`${SEASON}/results`, (race) =>
    race.Results.map((r) => ({
      position: r.position,
      positionText: r.positionText,
      points: r.points,
      code: r.Driver.code ?? r.Driver.familyName.slice(0, 3).toUpperCase(),
      name: `${r.Driver.givenName} ${r.Driver.familyName}`,
      driverId: r.Driver.driverId,
      constructor: r.Constructor.name,
      colour: colourOf(r.Constructor.constructorId),
      grid: r.grid,
      laps: r.laps,
      status: r.status,
      time: r.Time?.time ?? null,
      fastestLapRank: r.FastestLap ? Number(r.FastestLap.rank) : null,
      fastestLapTime: r.FastestLap?.Time?.time ?? null,
      fastestLapLap: r.FastestLap?.lap ?? null,
    })),
  );

  console.log('  qualifying...');
  const qualiByRound = await bulkByRound(`${SEASON}/qualifying`, (race) =>
    (race.QualifyingResults ?? []).map((q) => ({
      position: q.position,
      code: q.Driver.code ?? q.Driver.familyName.slice(0, 3).toUpperCase(),
      name: `${q.Driver.givenName} ${q.Driver.familyName}`,
      constructor: q.Constructor.name,
      q1: q.Q1 || null,
      q2: q.Q2 || null,
      q3: q.Q3 || null,
      best: q.Q3 || q.Q2 || q.Q1 || null,
    })),
  );

  console.log('  sprints...');
  const sprintByRound = await bulkByRound(`${SEASON}/sprint`, (race) =>
    (race.SprintResults ?? []).map((r) => ({
      position: r.position,
      positionText: r.positionText,
      points: r.points,
      name: `${r.Driver.givenName} ${r.Driver.familyName}`,
      constructor: r.Constructor.name,
      laps: r.laps,
      status: r.status,
      time: r.Time?.time ?? null,
    })),
  );

  const sessionKeys = await loadSessionKeys();

  // Only rounds that have actually been scored get a page.
  const completed = schedule.filter((r) => resultsByRound.has(r.round));
  console.log(`  ${completed.length} of ${schedule.length} rounds have results`);

  const nameById = new Map();
  for (const rows of resultsByRound.values()) {
    for (const r of rows) nameById.set(r.driverId, r.name);
  }

  const written = [];

  for (const race of completed) {
    const results = (resultsByRound.get(race.round) ?? []).sort(
      (a, b) => Number(a.position) - Number(b.position),
    );
    const quali = (qualiByRound.get(race.round) ?? []).sort(
      (a, b) => Number(a.position) - Number(b.position),
    );
    const sprint = (sprintByRound.get(race.round) ?? []).sort(
      (a, b) => Number(a.position) - Number(b.position),
    );

    let pits = [];
    try {
      const data = await api(`${SEASON}/${race.round}/pitstops`, { limit: 100 });
      pits = (data.RaceTable?.Races?.[0]?.PitStops ?? []).map((p) => ({
        driverId: p.driverId,
        name: nameById.get(p.driverId),
        stop: p.stop,
        lap: p.lap,
        duration: p.duration,
      }));
    } catch {
      // Pit data is missing for some rounds; the section just doesn't render.
    }

    const incidents = await fetchIncidents(sessionKeys, race.round);

    const html = racePage({ race, results, quali, sprint, pits, incidents });
    const file = fileFor(race.round, race.name);
    await writeFile(join(OUT_DIR, file), html, 'utf8');

    const winner = results[0];
    written.push({ ...race, winner: winner?.name ?? null, winnerColour: winner?.colour });
    console.log(
      `    R${String(race.round).padStart(2, '0')} ${race.name} — ${results.length} finishers` +
        `${quali.length ? `, quali` : ''}${pits.length ? `, ${pits.length} stops` : ''}` +
        `${incidents.length ? `, ${incidents.length} messages` : ''}`,
    );
  }

  await writeFile(join(OUT_DIR, 'index.html'), indexPage(written), 'utf8');

  console.log(
    `\nWrote ${written.length + 1} pages to public/races in ${((Date.now() - started) / 1000).toFixed(0)}s.`,
  );
}

main().catch((err) => {
  console.error('Race page build failed:', err.message);
  process.exit(1);
});
