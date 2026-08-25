# f1-dash

A Formula 1 dashboard built on free, public F1 data: championship permutations,
driver head-to-heads, 76 years of records, and a race replay rebuilt from
telemetry-grade timing data.

Live at **https://amitka2222.github.io/f1-dash/**

| View | What it does | Data |
| --- | --- | --- |
| **Title Race** | Assign finishing positions to the contenders across every remaining round and watch the championship recompute. Handles sprint scoring. | Static |
| **Head to Head** | Compare any two drivers since 1950 — wins, titles, season form, teams. | Static |
| **Archive** | Every champion, race winner, constructor and circuit since 1950. | Static |
| **Race Replay** | Final classification, position-change chart and tyre strategy for any race since 2023. | Live API |

## How it works

There is no server and no build step. GitHub Pages serves `public/` as-is:
plain HTML, CSS and ES modules.

Almost all of the data is **pre-baked into static JSON** by
`scripts/build-archive.mjs`, which runs weekly in CI and commits the result.
That is not premature optimisation — it is forced by the history provider:

- It **rejects cross-season standings queries outright.** Every request must
  name a single season, so a career comparison would cost roughly 40 calls.
- It allows **500 requests/hour and 100 rows per page.**

So the archive is assembled once at build time (~400 throttled requests, about
7 minutes) and read as files thereafter. Three of the four views therefore make
no third-party network calls at all.

Only Race Replay queries a live API, and it does so **directly from the
browser** — both providers send `access-control-allow-origin: *`. Calling direct
also means each visitor spends their own rate-limit budget rather than drawing
on a single shared server-side pool, which is the failure mode that actually
takes a site like this down under load.

### On hiding the data source

An earlier version proxied everything through a Cloudflare Worker to keep the
upstream hostnames out of the client. That is gone. A static site has no server,
so the browser must call the API itself and the URL is visible in devtools.

This was a deliberate trade: the proxy bought obscurity (not secrecy — the APIs
are public and unauthenticated either way) at the cost of an entire moving part,
a shared rate-limit pool, and a class of caching bugs that only appeared in
production.

## Development

```bash
npm run dev
```

Serves `public/` at http://localhost:8787. No install step, no dependencies.

Rebuild the archive:

```bash
HISTORY_API="https://api.jolpi.ca/ergast/f1" npm run build:archive
```

## Deploying

Pushing to `main` publishes to Pages. Enable it once under
**Settings → Pages → Source → GitHub Actions**.

The archive refreshes every Monday morning and publishes itself when the data
changes — a data-only commit made with `GITHUB_TOKEN` does not re-trigger the
push workflow, so `archive.yml` calls `deploy.yml` directly.

## Notes

- Season standings can legitimately have no position — Michael Schumacher was
  disqualified from the 1997 championship — so unclassified seasons are stored
  as null and rendered as `DSQ`/`N/C` rather than coerced to zero.
- `session_type: 'Race'` includes sprint races; they're flagged separately.
- Sessions that haven't started are hidden from the replay picker, since they
  have no timing data behind them.
- Asset paths are relative, because project Pages sites are served from
  `/<repo>/` rather than the domain root.

## Adding live timing later

Race Replay is built as if it were live — the rendering path is the one live
timing needs. The timing provider classifies data as "live" from 30 minutes
before a session to 30 minutes after, and that window needs a paid tier (about
€9.90/month). Everything outside it is free, which is why this ships as a replay.

Turning it on means subscribing, then polling `loadSession()` in
`public/js/views/live.js` on an interval. Note that an API key would need
somewhere server-side to live — which would mean reintroducing a proxy.

Unofficial. Not associated with Formula 1, the FIA, or any team.
