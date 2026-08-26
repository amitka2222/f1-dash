/**
 * Shell: hash router plus the masthead championship badge.
 *
 * Views are loaded lazily so a visitor who only opens the title calculator
 * never downloads the archive explorer's code.
 */

import { driverStandings } from './api.js';
import { el, clear, loading, errorBox } from './util.js';

const ROUTES = {
  whatif: () => import('./views/whatif.js'),
  h2h: () => import('./views/h2h.js'),
  archive: () => import('./views/archive.js'),
  map: () => import('./views/map.js'),
  live: () => import('./views/live.js'),
};

const DEFAULT_ROUTE = 'whatif';

const viewEl = document.getElementById('view');
const tabsEl = document.getElementById('tabs');
const badgeEl = document.getElementById('season-badge');
const footerEl = document.getElementById('footer-meta');

/** Parse "#/route/arg" into its parts. */
function parseHash() {
  const [route, ...args] = (location.hash.replace(/^#\/?/, '') || DEFAULT_ROUTE).split('/');
  return { route: route in ROUTES ? route : DEFAULT_ROUTE, args };
}

function markActiveTab(route) {
  for (const link of tabsEl.querySelectorAll('a')) {
    link.classList.toggle('active', link.dataset.route === route);
  }
}

let renderToken = 0;

async function render() {
  const { route, args } = parseHash();
  const token = ++renderToken;

  markActiveTab(route);
  clear(viewEl).append(loading());

  try {
    const module = await ROUTES[route]();
    // A fast second navigation can resolve out of order; drop the stale one.
    if (token !== renderToken) return;

    clear(viewEl);
    await module.render(viewEl, args);
  } catch (err) {
    if (token !== renderToken) return;
    console.error(`[${route}]`, err);
    clear(viewEl).append(errorBox(err));
  }
}

/** Masthead badge: who leads, by how much, and how much is still on the table. */
async function renderBadge() {
  try {
    const { rows, round, season, builtAt } = await driverStandings();
    if (!rows.length) return;

    const [leader, second] = rows;
    const gap = leader.points - (second?.points ?? 0);

    badgeEl.append(
      el('div', {}, `${season} · after round `, el('b', {}, String(round))),
      el(
        'div',
        {},
        el('b', {}, leader.code),
        ` leads by `,
        el('b', {}, String(gap)),
        gap === 1 ? ' pt' : ' pts',
      ),
    );

    // Standings are baked at build time, so say how fresh they actually are
    // rather than implying they update continuously.
    const built = builtAt
      ? new Date(builtAt).toLocaleDateString(undefined, {
          day: 'numeric',
          month: 'short',
          year: 'numeric',
        })
      : null;

    footerEl.textContent =
      `${season} season · after round ${round}` + (built ? ` · data updated ${built}` : '');
  } catch {
    // The badge is decoration; a failure here must not break the page.
    badgeEl.textContent = '';
  }
}

window.addEventListener('hashchange', render);
render();
renderBadge();
