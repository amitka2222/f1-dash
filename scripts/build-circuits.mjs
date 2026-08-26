/**
 * Pre-bakes circuit layouts for the track map.
 *
 * The layout provider sends no CORS headers, so a static page cannot fetch it
 * directly — the outlines have to be baked in at build time. That is fine:
 * track geometry changes at most once a season.
 *
 * Crucially, the outline coordinates are in the SAME space as the live car
 * position feed, so cars can be drawn straight onto the traced circuit with no
 * calibration.
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const LIVE_API = process.env.LIVE_API ?? 'https://api.openf1.org/v1';
const LAYOUT_API = process.env.LAYOUT_API ?? 'https://api.multiviewer.app/api/v1/circuits';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'data');
const FIRST_YEAR = 2023; // telemetry coverage begins here

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJSON(url, { tolerate404 = false } = {}) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (res.ok) return res.json();
    if (res.status === 404 && tolerate404) return null;
    if (res.status === 429 || res.status >= 500) {
      await sleep(2 ** attempt * 1000);
      continue;
    }
    throw new Error(`${res.status} on ${url}`);
  }
  throw new Error(`gave up on ${url}`);
}

/**
 * Round coordinates to whole units. They are already in metres-ish units where
 * sub-unit precision is meaningless for a map, and it roughly halves file size.
 */
const round = (n) => Math.round(n);

async function main() {
  await mkdir(OUT_DIR, { recursive: true });

  const currentYear = new Date().getUTCFullYear();
  const years = [];
  for (let y = FIRST_YEAR; y <= currentYear; y++) years.push(y);

  // Find every circuit that has actually hosted a session we can replay.
  console.log('Collecting circuits from session history...');
  const wanted = new Map(); // circuitKey -> most recent year seen

  for (const year of years) {
    const meetings = await getJSON(`${LIVE_API}/meetings?year=${year}`);
    for (const m of meetings ?? []) {
      if (!m.circuit_key) continue;
      const seen = wanted.get(m.circuit_key);
      if (!seen || year > seen.year) {
        wanted.set(m.circuit_key, { year, name: m.circuit_short_name, country: m.country_name });
      }
    }
    await sleep(400); // stay well inside the timing provider's limits
  }

  console.log(`  ${wanted.size} distinct circuits`);

  const circuits = {};
  let missing = 0;

  for (const [key, info] of wanted) {
    // Layouts are published per season; fall back through earlier years since a
    // circuit that ran in 2023 but not since has no current-year entry.
    let layout = null;
    for (let y = info.year; y >= FIRST_YEAR && !layout; y--) {
      layout = await getJSON(`${LAYOUT_API}/${key}/${y}`, { tolerate404: true });
      await sleep(250);
    }

    if (!layout?.x?.length) {
      console.warn(`  no layout for ${info.name} (key ${key})`);
      missing++;
      continue;
    }

    circuits[key] = {
      key,
      name: layout.circuitName ?? info.name,
      country: info.country ?? null,
      // Flat [x,y,x,y,...] keeps the payload compact and is trivial to walk.
      path: layout.x.flatMap((x, i) => [round(x), round(layout.y[i])]),
      rotation: layout.rotation ?? 0,
      corners: (layout.corners ?? []).map((c) => ({
        n: c.number,
        x: round(c.trackPosition?.x ?? 0),
        y: round(c.trackPosition?.y ?? 0),
      })),
    };

    console.log(`  ${circuits[key].name} — ${layout.x.length} points, ${circuits[key].corners.length} corners`);
  }

  await writeFile(join(OUT_DIR, 'circuits-map.json'), JSON.stringify(circuits), 'utf8');

  const bytes = JSON.stringify(circuits).length;
  console.log(
    `\nWrote data/circuits-map.json — ${Object.keys(circuits).length} circuits, ` +
      `${(bytes / 1024).toFixed(0)} KB${missing ? `, ${missing} missing` : ''}.`,
  );
}

main().catch((err) => {
  console.error('Circuit build failed:', err.message);
  process.exit(1);
});
