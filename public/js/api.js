/**
 * Data access. Every network call goes to our own origin — either the Worker
 * proxy under /api, or the pre-baked archive under /data. The client has no
 * idea which upstreams sit behind them.
 */

// Requests are deduplicated per page-load. The Worker caches at the edge too,
// but this stops a single view firing the same call from three components.
const inflight = new Map();

async function getJSON(url) {
  if (inflight.has(url)) return inflight.get(url);

  const promise = fetch(url)
    .then(async (res) => {
      if (!res.ok) {
        const detail = await res.json().catch(() => ({}));
        throw new ApiError(detail.error ?? `request_failed`, res.status);
      }
      return res.json();
    })
    .catch((err) => {
      // Don't poison the cache with a failure — let the next attempt retry.
      inflight.delete(url);
      throw err;
    });

  inflight.set(url, promise);
  return promise;
}

export class ApiError extends Error {
  constructor(code, status) {
    super(code);
    this.code = code;
    this.status = status;
  }

  get friendly() {
    if (this.status === 429) return 'Hit the data provider’s rate limit. Try again shortly.';
    if (this.status === 404) return 'No data has been recorded for that session yet.';
    if (this.status === 502 || this.status === 503) {
      return 'The data provider is unreachable right now.';
    }
    return 'Could not load that data.';
  }
}

/** Historical / standings data (Ergast-shaped). */
export function history(path, params = {}) {
  const qs = new URLSearchParams(params).toString();
  return getJSON(`/api/h/${path}${qs ? `?${qs}` : ''}`).then((d) => d.MRData);
}

/** Session and telemetry data. */
export function live(endpoint, params = {}) {
  const qs = new URLSearchParams(params).toString();
  return getJSON(`/api/l/${endpoint}${qs ? `?${qs}` : ''}`);
}

/** Pre-baked archive file, e.g. archive('drivers'). */
export function archive(name) {
  return getJSON(`/data/${name}.json`);
}

/* --- shaped helpers ------------------------------------------------------ */

export async function driverStandings(season = 'current') {
  const data = await history(`${season}/driverstandings`);
  const list = data.StandingsTable?.StandingsLists?.[0];
  if (!list) return { round: 0, season, rows: [] };

  return {
    season: Number(list.season),
    round: Number(list.round),
    rows: list.DriverStandings.map((s) => ({
      position: Number(s.position),
      points: Number(s.points),
      wins: Number(s.wins),
      driverId: s.Driver.driverId,
      code: s.Driver.code ?? s.Driver.familyName.slice(0, 3).toUpperCase(),
      name: `${s.Driver.givenName} ${s.Driver.familyName}`,
      surname: s.Driver.familyName,
      nationality: s.Driver.nationality,
      constructorId: s.Constructors.at(-1)?.constructorId ?? null,
      constructor: s.Constructors.at(-1)?.name ?? '—',
    })),
  };
}

export async function constructorStandings(season = 'current') {
  const data = await history(`${season}/constructorstandings`);
  const list = data.StandingsTable?.StandingsLists?.[0];
  if (!list) return { round: 0, season, rows: [] };

  return {
    season: Number(list.season),
    round: Number(list.round),
    rows: list.ConstructorStandings.map((s) => ({
      position: Number(s.position),
      points: Number(s.points),
      wins: Number(s.wins),
      constructorId: s.Constructor.constructorId,
      name: s.Constructor.name,
      nationality: s.Constructor.nationality,
    })),
  };
}

export async function schedule(season = 'current') {
  const data = await history(`${season}`);
  return (data.RaceTable?.Races ?? []).map((r) => ({
    season: Number(r.season),
    round: Number(r.round),
    name: r.raceName,
    date: r.date,
    time: r.time ?? null,
    circuitId: r.Circuit.circuitId,
    circuit: r.Circuit.circuitName,
    locality: r.Circuit.Location.locality,
    country: r.Circuit.Location.country,
    // Sprint weekends carry an extra points-paying race, which the title
    // calculator has to account for.
    sprint: Boolean(r.Sprint),
  }));
}

/**
 * Season-by-season standings history for one driver.
 *
 * Read from the pre-baked archive rather than the API: the upstream rejects
 * cross-season standings queries, so doing this live would cost one request per
 * season per driver — roughly 40 calls for a single comparison.
 */
export async function driverSeasons(driverId) {
  const bySeason = await archive('standings');

  return Object.entries(bySeason)
    .map(([season, rows]) => {
      const row = rows.find((r) => r.d === driverId);
      if (!row) return null;
      return {
        season: Number(season),
        // null when the driver was not classified that year (e.g. excluded).
        position: row.p,
        positionText: row.pt ?? null,
        points: row.pts,
        wins: row.w,
        constructor: row.c ?? '—',
        constructorId: row.ci,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.season - b.season);
}

/**
 * Race sessions for a year, newest first.
 *
 * Sessions that have not started yet are dropped: they exist in the calendar
 * but have no timing data behind them, so offering one only produces an error.
 * Note that `session_type: 'Race'` covers sprints too, hence the explicit flag.
 */
export async function raceSessions(year) {
  const sessions = await live('sessions', { year, session_type: 'Race' });
  const now = Date.now();

  return sessions
    .filter((s) => !s.is_cancelled && new Date(s.date_start).getTime() < now)
    .map((s) => ({ ...s, isSprint: s.session_name === 'Sprint' }))
    .sort((a, b) => new Date(b.date_start) - new Date(a.date_start));
}
