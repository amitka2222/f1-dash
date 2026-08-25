/**
 * f1-dash edge proxy.
 *
 * The browser only ever calls this Worker. Upstream hostnames live in secrets
 * and any paid API key stays server-side, so the client never learns where the
 * data actually comes from.
 *
 * Beyond hiding the source, this layer exists because the upstreams are on
 * tight shared quotas — 500 req/hour for history, 30 req/min for live. Those
 * budgets are consumed by ALL visitors at once, so an uncached site would die
 * under a few dozen concurrent users. Everything here is about spending as few
 * upstream calls as possible.
 */

const HISTORY = 'h';
const LIVE = 'l';

// Only these upstream paths may be proxied. Without an allowlist the Worker is
// an open proxy and our quota becomes someone else's free bandwidth.
const HISTORY_SEGMENTS = new Set([
  'seasons', 'races', 'results', 'sprint', 'qualifying', 'laps', 'pitstops',
  'drivers', 'constructors', 'circuits', 'status', 'driverstandings',
  'constructorstandings', 'current', 'last', 'next',
]);

// Collections whose next path segment is an entity id rather than a resource.
const ID_BEARING = new Set(['drivers', 'constructors', 'circuits', 'status']);

const LIVE_ENDPOINTS = new Set([
  'sessions', 'meetings', 'drivers', 'laps', 'position', 'intervals',
  'car_data', 'location', 'pit', 'stints', 'team_radio', 'weather',
  'race_control', 'session_result', 'starting_grid', 'overtakes',
]);

// How long each class of data stays fresh at the edge.
const TTL = {
  IMMUTABLE: 60 * 60 * 24 * 30, // completed seasons never change
  REFERENCE: 60 * 60 * 24,      // circuit/driver reference lists
  SEASON: 60 * 10,              // current-season standings between races
  SESSION: 60 * 5,              // session/meeting metadata
  VOLATILE: 4,                  // in-session timing, telemetry
};

const CURRENT_YEAR = 2026;

export default {
  async fetch(request, env, ctx) {
    if (request.method !== 'GET') {
      return json({ error: 'method_not_allowed' }, 405);
    }

    const url = new URL(request.url);
    const match = url.pathname.match(/^\/api\/([hl])\/(.*)$/);
    if (!match) return json({ error: 'not_found' }, 404);

    try {
      const [, kind, rest] = match;
      const upstream = buildUpstream(kind, rest, url.searchParams, env);
      if (!upstream) return json({ error: 'forbidden_path' }, 403);

      return await serve(url, upstream, ctx);
    } catch (err) {
      if (err instanceof ConfigError) {
        // A misconfigured secret is our fault, and silently returning a raw
        // platform error makes it near-impossible to diagnose from outside.
        console.error(`Bad upstream configuration: ${err.message}`);
        return json({ error: 'misconfigured_upstream', detail: err.message }, 500);
      }
      console.error(`Unhandled: ${err?.stack ?? err}`);
      return json({ error: 'internal_error' }, 500);
    }
  },
};

class ConfigError extends Error {}

/**
 * Normalise an upstream base URL from a secret.
 *
 * Secrets are typed or pasted by hand, so they arrive with surrounding quotes,
 * stray whitespace or a trailing slash more often than not. Rather than letting
 * `new URL` throw an opaque TypeError, clean the value and fail loudly.
 */
function upstreamBase(value, name) {
  const cleaned = String(value ?? '')
    .trim()
    .replace(/^['"]+|['"]+$/g, '')
    .replace(/\/+$/, '');

  if (!cleaned) throw new ConfigError(`${name} is not set`);
  if (!/^https:\/\/[^\s/]+/i.test(cleaned)) {
    throw new ConfigError(`${name} is not a valid https URL`);
  }
  return cleaned;
}

/**
 * Translate a public /api path into an upstream URL, rejecting anything not on
 * the allowlist. Returns null if the path is not permitted.
 */
function buildUpstream(kind, rest, params, env) {
  const segments = rest.split('/').filter(Boolean);
  if (!segments.length || segments.length > 8) return null;

  if (kind === HISTORY) {
    if (!isAllowedHistoryPath(segments)) return null;

    const target = new URL(`${upstreamBase(env.HISTORY_API, 'HISTORY_API')}/${segments.join('/')}.json`);
    copyParams(params, target, ['limit', 'offset']);
    // Ergast defaults to 30 rows; ask for a useful page when nothing is set.
    if (!target.searchParams.has('limit')) target.searchParams.set('limit', '100');
    return { url: target, ttl: historyTtl(segments), kind };
  }

  if (kind === LIVE) {
    if (segments.length !== 1) return null;
    const endpoint = segments[0].toLowerCase();
    if (!LIVE_ENDPOINTS.has(endpoint)) return null;

    const target = new URL(`${upstreamBase(env.LIVE_API, 'LIVE_API')}/${endpoint}`);
    // Live filters are field-name based, so pass them through but cap the count
    // to keep cache keys bounded.
    let count = 0;
    for (const [key, value] of params) {
      if (++count > 12) break;
      if (/^[a-z_]{1,32}[<>=]?$/i.test(key)) target.searchParams.append(key, value);
    }
    return { url: target, ttl: liveTtl(endpoint), kind };
  }

  return null;
}

/**
 * Ergast paths interleave resources with identifiers — /drivers/hamilton/results,
 * /2026/5/qualifying. Rather than allowing any word through, an identifier is
 * only accepted directly after a collection that actually takes one. Everything
 * else must be a known resource or a bare number (season, round, position).
 */
function isAllowedHistoryPath(segments) {
  return segments.every((segment, index) => {
    const value = segment.toLowerCase();
    if (HISTORY_SEGMENTS.has(value)) return true;
    if (/^\d{1,4}$/.test(value)) return true;

    const previous = segments[index - 1]?.toLowerCase();
    return ID_BEARING.has(previous) && /^[a-z0-9_]{1,40}$/.test(value);
  });
}

function copyParams(from, to, allowed) {
  for (const key of allowed) {
    const value = from.get(key);
    if (value && /^\d{1,5}$/.test(value)) to.searchParams.set(key, value);
  }
}

/** Past seasons are frozen; the running season changes after every race. */
function historyTtl(segments) {
  const year = segments.find((s) => /^(19|20)\d{2}$/.test(s));
  if (year && Number(year) < CURRENT_YEAR) return TTL.IMMUTABLE;
  if (!year && segments.some((s) => ['circuits', 'seasons'].includes(s))) return TTL.REFERENCE;
  return TTL.SEASON;
}

/** Timing data moves every few seconds; metadata about a session does not. */
function liveTtl(endpoint) {
  if (['sessions', 'meetings', 'drivers'].includes(endpoint)) return TTL.SESSION;
  return TTL.VOLATILE;
}

/**
 * Fetch through the edge cache, falling back to a stale copy when the upstream
 * rate-limits or fails. A stale lap chart beats an error page.
 */
async function serve(requestUrl, upstream, ctx) {
  const cache = caches.default;

  // Cache under our OWN request path, never the upstream URL.
  //
  // `caches.default` and the subrequest cache share one namespace keyed by URL.
  // Keying on the upstream URL therefore lets anything the fetch layer stored —
  // including error responses — surface as one of our cache hits. That is not
  // hypothetical: it cached a 429 and served it for the full TTL, which looked
  // exactly like a permanent rate-limit ban.
  const namespace = `https://cache.invalid${requestUrl.pathname}${requestUrl.search}`;
  const cacheKey = new Request(namespace, { method: 'GET' });
  const staleKey = new Request(`${namespace}#stale`, { method: 'GET' });

  const hit = await cache.match(cacheKey);
  if (hit) return decorate(hit, 'HIT');

  let upstreamResponse;
  try {
    upstreamResponse = await fetch(upstream.url.toString(), {
      headers: {
        // Identify ourselves so the upstream maintainers can reach us if this
        // ever misbehaves, rather than silently blocking the Worker.
        'User-Agent': 'f1-dash (+https://github.com/f1-dash)',
        Accept: 'application/json',
      },
      // Deliberately no `cacheEverything`: it caches non-200s too. Caching is
      // done explicitly below, only for responses that actually succeeded.
      cf: { cacheTtl: 0 },
    });
  } catch {
    return (await serveStale(cache, staleKey)) ?? json({ error: 'upstream_unreachable' }, 502);
  }

  if (!upstreamResponse.ok) {
    const stale = await serveStale(cache, staleKey);
    if (stale) return stale;
    // Pass through the statuses a client can act on. Anything else is reported
    // as a bad gateway, since it is our upstream that failed, not the request.
    const passthrough = new Set([404, 429]);
    const status = passthrough.has(upstreamResponse.status) ? upstreamResponse.status : 502;
    return json({ error: 'upstream_error', status: upstreamResponse.status }, status);
  }

  const body = sanitise(await upstreamResponse.text(), upstream.kind);

  const fresh = new Response(body, {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': `public, max-age=${upstream.ttl}`,
    },
  });
  ctx.waitUntil(cache.put(cacheKey, fresh.clone()));

  // Keep a long-lived copy purely as a fallback for upstream outages.
  const stale = new Response(body, {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': `public, max-age=${TTL.IMMUTABLE}`,
    },
  });
  ctx.waitUntil(cache.put(staleKey, stale));

  return decorate(fresh, 'MISS');
}

/**
 * Strip the upstream's self-referential URL out of the payload. Ergast echoes
 * the exact endpoint it was called on, which would hand the client the very
 * hostname the secret is meant to conceal. Nested `url` fields are Wikipedia
 * links and are left alone.
 */
function sanitise(body, kind) {
  if (kind !== HISTORY) return body;
  try {
    const parsed = JSON.parse(body);
    if (parsed?.MRData) {
      delete parsed.MRData.url;
      delete parsed.MRData.xmlns;
    }
    return JSON.stringify(parsed);
  } catch {
    // If it isn't the shape we expect, don't risk mangling it.
    return body;
  }
}

async function serveStale(cache, staleKey) {
  const stale = await cache.match(staleKey);
  return stale ? decorate(stale, 'STALE') : null;
}

function decorate(response, state) {
  const out = new Response(response.body, response);
  out.headers.set('X-Cache', state);
  out.headers.set('Access-Control-Allow-Origin', '*');
  return out;
}

function json(payload, status) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
