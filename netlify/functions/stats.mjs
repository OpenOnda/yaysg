// yay.sg private visitor stats: pulls Web Analytics numbers from Cloudflare's GraphQL API.
// Netlify environment variables:
//   CF_API_TOKEN    Cloudflare API token with "Account Analytics: Read"
//   STATS_PASSWORD  password for the /stats page
//   CF_ACCOUNT_ID   optional, defaults to the yay.sg Cloudflare account
//   CF_SITE_TAG     optional, the Web Analytics site tag. Without it, filters by host yay.sg

const DEFAULT_ACCOUNT = 'eaf2d6e527b7cdef5b8eca93dfc46068';
const TZ_OFFSET = 8 * 3600e3; // Singapore
let cache = null;

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
});

// Midnight in Singapore, n days ago, as an ISO string
function sgMidnight(daysAgo = 0) {
  const now = new Date(Date.now() + TZ_OFFSET);
  const d = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - daysAgo * 864e5 - TZ_OFFSET;
  return new Date(d).toISOString();
}

async function fetchStats() {
  const token = process.env.CF_API_TOKEN;
  const account = process.env.CF_ACCOUNT_ID || DEFAULT_ACCOUNT;
  const site = process.env.CF_SITE_TAG;
  const scope = site ? `siteTag: "${site}"` : `requestHost: "yay.sg"`;
  const end = new Date().toISOString();
  const f = (start) => `{ AND: [{ datetime_geq: "${start}", datetime_leq: "${end}" }, { ${scope} }] }`;
  const s30 = sgMidnight(29), s7 = sgMidnight(6), s1 = sgMidnight(0);

  const query = `{
    viewer { accounts(filter: { accountTag: "${account}" }) {
      today: rumPageloadEventsAdaptiveGroups(limit: 1, filter: ${f(s1)}) { count sum { visits } }
      week: rumPageloadEventsAdaptiveGroups(limit: 1, filter: ${f(s7)}) { count sum { visits } }
      month: rumPageloadEventsAdaptiveGroups(limit: 1, filter: ${f(s30)}) { count sum { visits } }
      hourly: rumPageloadEventsAdaptiveGroups(limit: 1000, filter: ${f(s30)}, orderBy: [datetimeHour_ASC]) { count sum { visits } dimensions { datetimeHour } }
      countries: rumPageloadEventsAdaptiveGroups(limit: 8, filter: ${f(s30)}, orderBy: [count_DESC]) { count sum { visits } dimensions { metric: countryName } }
      devices: rumPageloadEventsAdaptiveGroups(limit: 5, filter: ${f(s30)}, orderBy: [count_DESC]) { count sum { visits } dimensions { metric: deviceType } }
      sources: rumPageloadEventsAdaptiveGroups(limit: 8, filter: ${f(s30)}, orderBy: [count_DESC]) { count sum { visits } dimensions { metric: refererHost } }
    } }
  }`;

  const res = await fetch('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(10000),
  });
  const j = await res.json().catch(() => null);
  if (!res.ok || !j || (j.errors && j.errors.length)) {
    const msg = j?.errors?.map((e) => e.message).join('; ') || `Cloudflare responded ${res.status}`;
    throw new Error(msg);
  }
  const a = j?.data?.viewer?.accounts?.[0];
  if (!a) throw new Error('No data for this Cloudflare account. Check CF_ACCOUNT_ID and the token permission.');

  const tot = (g) => ({ views: g?.[0]?.count || 0, visits: g?.[0]?.sum?.visits || 0 });
  const list = (g) => (g || []).map((r) => ({ name: r.dimensions?.metric || '', views: r.count, visits: r.sum?.visits || 0 }));

  // Hourly rows -> Singapore calendar days, last 30 days, empty days filled with 0
  const days = new Map();
  for (let i = 29; i >= 0; i--) days.set(new Date(Date.parse(sgMidnight(i)) + TZ_OFFSET).toISOString().slice(0, 10), { views: 0, visits: 0 });
  for (const r of a.hourly || []) {
    const key = new Date(Date.parse(r.dimensions.datetimeHour) + TZ_OFFSET).toISOString().slice(0, 10);
    const d = days.get(key);
    if (d) { d.views += r.count; d.visits += r.sum?.visits || 0; }
  }

  return {
    updated: new Date().toISOString(),
    today: tot(a.today), week: tot(a.week), month: tot(a.month),
    daily: [...days].map(([date, v]) => ({ date, ...v })),
    countries: list(a.countries), devices: list(a.devices), sources: list(a.sources),
  };
}

export default async (req) => {
  const pass = process.env.STATS_PASSWORD; // optional: without it, the stats page is open to anyone with the link
  if (!process.env.CF_API_TOKEN) {
    return json({ error: 'Stats are not set up yet. Add CF_API_TOKEN in Netlify.' }, 500);
  }
  if (pass && req.headers.get('x-stats-key') !== pass) return json({ error: 'Wrong password.' }, 401);
  try {
    if (!cache || Date.now() - cache.at > 5 * 60e3) cache = { at: Date.now(), value: await fetchStats() };
    return json(cache.value);
  } catch (e) {
    return json({ error: 'Cloudflare: ' + e.message }, 502);
  }
};

export const config = { path: '/api/stats' };
