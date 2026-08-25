/**
 * Pre-bakes the historical archive into static JSON.
 *
 * The records explorer needs aggregates across all 76 seasons. Computing those
 * from the API per visitor is impossible on a 500 req/hour shared quota, so we
 * pay the cost once at build time and ship the result as static files.
 *
 * Set HISTORY_API to the provider's base URL before running.
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.env.HISTORY_API;
if (!BASE) {
  console.error('HISTORY_API is not set. See the README.');
  process.exit(1);
}

// Written into the published directory so the files ship as part of the site.
const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'data');

const FIRST_SEASON = 1950;
const CURRENT_SEASON = new Date().getUTCFullYear();
const PAGE = 100; // Jolpica caps pages at 100 rows
const MIN_GAP_MS = 340; // ~3 req/s, comfortably under the 4/s burst cap

let lastCall = 0;
let requestCount = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Serialised, throttled GET with backoff on rate-limit responses. */
async function api(path, { limit = PAGE, offset = 0 } = {}) {
  const wait = MIN_GAP_MS - (Date.now() - lastCall);
  if (wait > 0) await sleep(wait);

  const url = `${BASE}/${path}.json?limit=${limit}&offset=${offset}`;

  for (let attempt = 0; attempt < 5; attempt++) {
    lastCall = Date.now();
    requestCount++;
    const res = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'f1-dash-archive-builder' },
    });

    if (res.ok) return (await res.json()).MRData;

    if (res.status === 429) {
      // Respect the server's own backoff hint when it gives one.
      const retryAfter = Number(res.headers.get('retry-after')) || 2 ** attempt;
      console.warn(`  rate limited on ${path}, waiting ${retryAfter}s`);
      await sleep(retryAfter * 1000);
      continue;
    }

    if (res.status >= 500) {
      await sleep(2 ** attempt * 1000);
      continue;
    }

    throw new Error(`${res.status} on ${path}`);
  }

  throw new Error(`gave up on ${path} after 5 attempts`);
}

/** Walk every page of a paginated collection and concatenate the rows. */
async function apiAll(path, extract) {
  const rows = [];
  let offset = 0;
  let total = Infinity;

  while (offset < total) {
    const data = await api(path, { offset });
    total = Number(data.total);
    const page = extract(data);
    if (!page.length) break;
    rows.push(...page);
    offset += PAGE;
  }

  return rows;
}

const seasonRange = () =>
  Array.from({ length: CURRENT_SEASON - FIRST_SEASON + 1 }, (_, i) => FIRST_SEASON + i);

async function buildChampions() {
  console.log('Champions per season...');
  const seasons = [];

  for (const year of seasonRange()) {
    const drv = await api(`${year}/driverstandings/1`, { limit: 1 });
    // The constructors' championship only exists from 1958.
    const con = year >= 1958 ? await api(`${year}/constructorstandings/1`, { limit: 1 }) : null;

    const dList = drv.StandingsTable?.StandingsLists?.[0];
    if (!dList) continue; // season scheduled but not yet scored

    const cList = con?.StandingsTable?.StandingsLists?.[0];
    const d = dList.DriverStandings[0];
    const c = cList?.ConstructorStandings?.[0];

    seasons.push({
      season: Number(year),
      rounds: Number(dList.round),
      complete: year < CURRENT_SEASON,
      driver: {
        id: d.Driver.driverId,
        name: `${d.Driver.givenName} ${d.Driver.familyName}`,
        nationality: d.Driver.nationality,
        points: Number(d.points),
        wins: Number(d.wins),
        constructor: d.Constructors.at(-1)?.name ?? null,
      },
      constructor: c
        ? {
            id: c.Constructor.constructorId,
            name: c.Constructor.name,
            points: Number(c.points),
            wins: Number(c.wins),
          }
        : null,
    });

    if (year % 10 === 0) console.log(`  ...${year}`);
  }

  return seasons;
}

/**
 * Full driver standings for every season, keyed by year.
 *
 * The upstream refuses cross-season standings queries — every request must name
 * a season — so a career comparison would otherwise cost one call per season
 * per driver at runtime. Fetching all 77 seasons once here turns the whole
 * comparator into a static file lookup.
 *
 * Keys are abbreviated because this is the largest file we ship.
 */
async function buildSeasonStandings() {
  console.log('Season-by-season standings...');
  const standings = {};

  for (const year of seasonRange()) {
    const data = await api(`${year}/driverstandings`);
    const list = data.StandingsTable?.StandingsLists?.[0];
    if (!list) continue;

    standings[year] = list.DriverStandings.map((s) => {
      // A driver can finish a season without a classified position — Schumacher
      // was excluded from the 1997 championship, for instance. Ergast marks
      // those with a non-numeric positionText, so keep the position null and
      // carry the code through for display.
      const position = Number(s.position);
      const classified = Number.isFinite(position) && position > 0;

      return {
        d: s.Driver.driverId,
        p: classified ? position : null,
        pt: classified ? null : (s.positionText ?? null),
        pts: Number(s.points),
        w: Number(s.wins),
        c: s.Constructors.at(-1)?.name ?? null,
        ci: s.Constructors.at(-1)?.constructorId ?? null,
      };
    });

    if (year % 10 === 0) console.log(`  ...${year}`);
  }

  return standings;
}

/**
 * The current season's calendar, including which rounds carry a sprint.
 *
 * Baked in so the title calculator needs no network call at all: standings come
 * from standings.json and the remaining rounds come from here.
 */
async function buildCalendar() {
  console.log('Current season calendar...');
  const data = await api(`${CURRENT_SEASON}`, { limit: 30 });

  return (data.RaceTable?.Races ?? []).map((r) => ({
    round: Number(r.round),
    name: r.raceName,
    date: r.date,
    circuit: r.Circuit.circuitName,
    locality: r.Circuit.Location.locality,
    country: r.Circuit.Location.country,
    sprint: Boolean(r.Sprint),
  }));
}

async function buildWins() {
  console.log('Every race winner since 1950...');
  return apiAll('results/1', (d) =>
    d.RaceTable.Races.map((r) => {
      const res = r.Results[0];
      return {
        season: Number(r.season),
        round: Number(r.round),
        race: r.raceName,
        date: r.date,
        circuitId: r.Circuit.circuitId,
        country: r.Circuit.Location.country,
        driverId: res.Driver.driverId,
        driver: `${res.Driver.givenName} ${res.Driver.familyName}`,
        constructorId: res.Constructor.constructorId,
        constructor: res.Constructor.name,
        grid: Number(res.grid),
      };
    }),
  );
}

async function buildReference() {
  console.log('Drivers, constructors, circuits...');

  const drivers = await apiAll('drivers', (d) =>
    d.DriverTable.Drivers.map((x) => ({
      id: x.driverId,
      code: x.code ?? null,
      number: x.permanentNumber ? Number(x.permanentNumber) : null,
      name: `${x.givenName} ${x.familyName}`,
      nationality: x.nationality,
      dob: x.dateOfBirth,
      wiki: x.url,
    })),
  );

  const constructors = await apiAll('constructors', (d) =>
    d.ConstructorTable.Constructors.map((x) => ({
      id: x.constructorId,
      name: x.name,
      nationality: x.nationality,
      wiki: x.url,
    })),
  );

  const circuits = await apiAll('circuits', (d) =>
    d.CircuitTable.Circuits.map((x) => ({
      id: x.circuitId,
      name: x.circuitName,
      locality: x.Location.locality,
      country: x.Location.country,
      lat: Number(x.Location.lat),
      lng: Number(x.Location.long),
      wiki: x.url,
    })),
  );

  return { drivers, constructors, circuits };
}

/** Fold the win list into per-entity tallies so the client does no counting. */
function summarise({ seasons, wins, drivers, constructors, circuits }) {
  const tally = (list, key) => {
    const counts = new Map();
    for (const w of list) counts.set(w[key], (counts.get(w[key]) ?? 0) + 1);
    return counts;
  };

  const driverWins = tally(wins, 'driverId');
  const constructorWins = tally(wins, 'constructorId');
  const circuitRaces = tally(wins, 'circuitId');

  const driverTitles = new Map();
  const constructorTitles = new Map();
  for (const s of seasons) {
    if (!s.complete) continue;
    driverTitles.set(s.driver.id, (driverTitles.get(s.driver.id) ?? 0) + 1);
    if (s.constructor) {
      constructorTitles.set(s.constructor.id, (constructorTitles.get(s.constructor.id) ?? 0) + 1);
    }
  }

  const span = new Map();
  for (const w of wins) {
    const cur = span.get(w.driverId);
    span.set(
      w.driverId,
      cur ? [Math.min(cur[0], w.season), Math.max(cur[1], w.season)] : [w.season, w.season],
    );
  }

  return {
    drivers: drivers
      .map((d) => ({
        ...d,
        wins: driverWins.get(d.id) ?? 0,
        titles: driverTitles.get(d.id) ?? 0,
        firstWin: span.get(d.id)?.[0] ?? null,
        lastWin: span.get(d.id)?.[1] ?? null,
      }))
      // Winners rank first; winless drivers stay in the list for the comparator
      // but sort to the bottom.
      .sort((a, b) => b.wins - a.wins || a.name.localeCompare(b.name)),

    constructors: constructors
      .map((c) => ({
        ...c,
        wins: constructorWins.get(c.id) ?? 0,
        titles: constructorTitles.get(c.id) ?? 0,
      }))
      .sort((a, b) => b.wins - a.wins || a.name.localeCompare(b.name)),

    circuits: circuits
      .map((c) => ({ ...c, races: circuitRaces.get(c.id) ?? 0 }))
      .sort((a, b) => b.races - a.races || a.name.localeCompare(b.name)),
  };
}

async function main() {
  const started = Date.now();
  await mkdir(OUT_DIR, { recursive: true });

  const seasons = await buildChampions();
  const seasonStandings = await buildSeasonStandings();
  const calendar = await buildCalendar();
  const wins = await buildWins();
  const reference = await buildReference();
  const summary = summarise({ seasons, wins, ...reference });

  const files = {
    'seasons.json': seasons,
    'standings.json': seasonStandings,
    'calendar.json': calendar,
    'wins.json': wins,
    'drivers.json': summary.drivers,
    'constructors.json': summary.constructors,
    'circuits.json': summary.circuits,
    'meta.json': {
      builtAt: new Date().toISOString(),
      firstSeason: FIRST_SEASON,
      latestSeason: seasons.at(-1)?.season ?? null,
      latestRound: seasons.at(-1)?.rounds ?? null,
      counts: {
        seasons: seasons.length,
        races: wins.length,
        drivers: summary.drivers.length,
        constructors: summary.constructors.length,
        circuits: summary.circuits.length,
      },
      upstreamRequests: requestCount,
    },
  };

  for (const [name, payload] of Object.entries(files)) {
    await writeFile(join(OUT_DIR, name), JSON.stringify(payload), 'utf8');
    console.log(`  wrote data/${name}`);
  }

  console.log(
    `\nDone in ${((Date.now() - started) / 1000).toFixed(0)}s using ${requestCount} upstream requests.`,
  );
}

main().catch((err) => {
  console.error('Archive build failed:', err.message);
  process.exit(1);
});
