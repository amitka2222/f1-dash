# f1-dash

A Formula 1 dashboard built on free, public F1 data: championship permutations,
driver head-to-heads, 76 years of records, and a race replay rebuilt from
telemetry-grade timing data.

Four views:

| View | What it does | Data source |
| --- | --- | --- |
| **Title Race** | Assign finishing positions to the contenders across every remaining round and watch the championship recompute. Handles sprint scoring. | Live standings + calendar |
| **Head to Head** | Compare any two drivers since 1950 — wins, titles, season form, teams. | Pre-baked archive |
| **Archive** | Every champion, race winner, constructor and circuit since 1950. | Pre-baked archive |
| **Race Replay** | Final classification, position-change chart and tyre strategy for any race since 2023. | Session timing data |

## Architecture

```
browser  ──►  Cloudflare Worker  ──►  upstream APIs
              (proxy + cache)         (hostnames in secrets)
         └─►  /data/*.json
              (pre-baked archive, served from the edge)
```

The browser only ever talks to this origin. It never learns which upstream APIs
sit behind it — the hostnames live in Cloudflare secrets, and the Worker strips
the self-referential URL the history API echoes back inside its own payloads.

Two constraints drove the whole design:

- **The upstream quotas are shared across all visitors.** 500 requests/hour for
  history, 30/minute for timing. Those are consumed by everyone at once, so an
  uncached site would fall over under a few dozen concurrent users. The Worker
  caches by data class — completed seasons for 30 days, in-session timing for 4
  seconds — and serves a stale copy rather than an error if an upstream fails.
- **Cross-season queries aren't supported.** Every standings request must name a
  single season, so a career comparison would cost ~40 live calls. Instead the
  archive is pre-baked at build time into static JSON and served straight from
  the edge, costing zero upstream requests at runtime.

## Setup

```bash
npm install
cp .dev.vars.example .dev.vars   # fill in the two upstream base URLs
npm run dev
```

Build the archive (~400 throttled requests, about 7 minutes):

```bash
HISTORY_API="<history-api-base-url>" npm run build:archive
```

## Deploying

Set the upstream hostnames as Worker secrets so they never enter the repo:

```bash
npx wrangler secret put HISTORY_API
```

```bash
npx wrangler secret put LIVE_API
```

Then deploy:

```bash
npm run deploy
```

For CI, add repository secrets `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`
and `HISTORY_API`. Pushing to `main` deploys; the archive refreshes every Monday
morning and deploys itself when the data changes.

## Going live during a session

Race Replay is deliberately built as if it were live — the rendering path is the
same one live timing needs. The timing provider classifies data as "live" from
30 minutes before a session to 30 minutes after, and that window requires a paid
sponsor tier (about €9.90/month). Everything outside it is free.

To switch on true live timing, no rewrite is needed:

1. Subscribe, and set the sponsor API key as a Worker secret.
2. Attach it as a request header in `serve()` in `src/worker.js`.
3. Poll `loadSession()` in `public/js/views/live.js` on an interval; the Worker
   already caps in-session caching at 4 seconds so polling won't multiply
   upstream load.

## Notes

- Season standings can legitimately have no position — Michael Schumacher was
  excluded from the 1997 championship — so unclassified seasons are stored as
  null and rendered as such rather than being coerced to zero.
- `session_type: 'Race'` includes sprint races; they're flagged separately.
- Sessions that haven't started yet are hidden from the replay picker, since
  they have no timing data behind them.

Unofficial. Not associated with Formula 1, the FIA, or any team.
