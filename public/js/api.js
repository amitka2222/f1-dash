/**
 * Data access for a fully static site.
 *
 * Three of the four views read pre-baked JSON from this origin and make no
 * network calls to anyone. Only Race Replay talks to a live API, and it does so
 * straight from the browser — both providers send `access-control-allow-origin:
 * *`, so no proxy is needed.
 *
 * Calling direct also means each visitor spends their OWN rate-limit budget
 * rather than drawing on one shared server-side pool, which is the failure mode
 * that actually breaks a site like this under load.
 */

// Timing data for the replay view. Public, unauthenticated, CORS-enabled.
const LIVE_API = 'https://api.openf1.org/v1';

// Requests are deduplicated per page-load so one view firing the same call from
// several components only hits the network once.
const inflight = new Map();

async function getJSON(url) {
  if (inflight.has(url)) return inflight.get(url);

  const promise = fetch(url)
    .then(async (res) => {
      if (!res.ok) throw new ApiError('request_failed', res.status);
      return res.json();
    })
    .catch((err) => {
      // Don't cache a failure — let the next attempt retry.
      inflight.delete(url);
      if (err instanceof ApiError) throw err;
      throw new ApiError('network_error', 0);
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
    if (this.status === 429) {
      return 'The timing provider is rate-limiting this browser. Wait a minute and try again.';
    }
    if (this.status === 404) return 'No data has been recorded for that session yet.';
    if (this.status === 0) return 'Could not reach the timing provider. Check your connection.';
    return 'Could not load that data.';
  }
}

/** A pre-baked archive file, e.g. archive('drivers'). */
export function archive(name) {
  return getJSON(`data/${name}.json`);
}

/** Live session and telemetry data. */
export function live(endpoint, params = {}) {
  const qs = new URLSearchParams(params).toString();
  return getJSON(`${LIVE_API}/${endpoint}${qs ? `?${qs}` : ''}`);
}

/* --- shaped helpers ------------------------------------------------------- */

/**
 * Current-season driver standings, from the pre-baked archive.
 *
 * Standings only change after a race, and the archive rebuilds every Monday, so
 * a static read is as fresh as a live call would be for all but the few hours
 * right after a chequered flag.
 */
export async function driverStandings() {
  // Prime the name index first: the rows below carry only driver ids.
  const [bySeason, meta] = await Promise.all([
    archive('standings'),
    archive('meta'),
    primeDrivers(),
  ]);

  const season = meta.latestSeason;
  const rows = bySeason[season] ?? [];

  return {
    season,
    round: meta.latestRound ?? 0,
    builtAt: meta.builtAt,
    rows: rows
      .filter((r) => r.p != null)
      .sort((a, b) => a.p - b.p)
      .map((r) => ({
        position: r.p,
        points: r.pts,
        wins: r.w,
        driverId: r.d,
        code: codeFor(r.d),
        name: nameFor(r.d),
        constructorId: r.ci,
        constructor: r.c ?? '—',
      })),
  };
}

/** Current-season calendar, from the pre-baked archive. */
export async function schedule() {
  return archive('calendar');
}

/**
 * Season-by-season standings history for one driver.
 *
 * The history provider rejects cross-season standings queries outright — every
 * request must name a single season — so doing this live would cost one call
 * per season per driver. The archive makes it a file lookup.
 */
export async function driverSeasons(driverId) {
  const bySeason = await archive('standings');

  return Object.entries(bySeason)
    .map(([season, rows]) => {
      const row = rows.find((r) => r.d === driverId);
      if (!row) return null;
      return {
        season: Number(season),
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
 * Sessions that have not started are dropped — they exist in the calendar but
 * have no timing behind them, so offering one only produces an error. Note that
 * `session_type: 'Race'` covers sprints too, hence the explicit flag.
 */
export async function raceSessions(year) {
  const sessions = await live('sessions', { year, session_type: 'Race' });
  const now = Date.now();

  return sessions
    .filter((s) => !s.is_cancelled && new Date(s.date_start).getTime() < now)
    .map((s) => ({ ...s, isSprint: s.session_name === 'Sprint' }))
    .sort((a, b) => new Date(b.date_start) - new Date(a.date_start));
}

/* --- driver name lookup --------------------------------------------------- */

// Resolved lazily from the archive so standings rows can show real names and
// codes without every caller having to join the two files itself.
let driverIndex = null;

export async function primeDrivers() {
  if (!driverIndex) {
    const drivers = await archive('drivers');
    driverIndex = new Map(drivers.map((d) => [d.id, d]));
  }
  return driverIndex;
}

function nameFor(id) {
  return driverIndex?.get(id)?.name ?? id.replace(/_/g, ' ');
}

function codeFor(id) {
  const driver = driverIndex?.get(id);
  if (driver?.code) return driver.code;
  // Fall back to the last name's first three letters, as the sport does.
  return (driver?.name ?? id).split(/[\s_]/).at(-1).slice(0, 3).toUpperCase();
}
