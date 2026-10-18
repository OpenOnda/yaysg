// Yay.sg live data function.
// Fetches every feed on the server, so the page loads with one request
// and nothing breaks because of browser security rules (CORS).

const TZ = 'Asia/Singapore';
const UA = 'YaySG/1.0 (+https://yay.sg)';

// ---------- small helpers ----------

async function getJSON(url, opts = {}) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'application/json', ...(opts.headers || {}) },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

async function getText(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'application/rss+xml, application/xml, text/xml' },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.text();
}

// Today's date in Singapore as YYYY-MM-DD
function sgToday(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(now);
}

function daysBetween(fromYMD, toYMD) {
  return Math.round((Date.parse(toYMD + 'T00:00:00Z') - Date.parse(fromYMD + 'T00:00:00Z')) / 86400000);
}

// "7/12/2026" -> "2026-12-07"; anything else -> null
function parseDMY(s) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(s || '').trim());
  if (!m) return null;
  return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
}

function decodeEntities(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .trim();
}

// Simple in-memory cache. Survives between requests while the function stays warm.
const cache = new Map();
async function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value;
  try {
    const value = await fn();
    cache.set(key, { at: Date.now(), value });
    return value;
  } catch (err) {
    console.error(`[${key}]`, err.message);
    return hit ? hit.value : null; // fall back to last good copy
  }
}

const MIN = 60 * 1000;

// ---------- weather ----------

const RAINY = /rain|shower|thunder/i;

async function weather() {
  const [now2h, day24, temp] = await Promise.all([
    getJSON('https://api.data.gov.sg/v1/environment/2-hour-weather-forecast'),
    getJSON('https://api.data.gov.sg/v1/environment/24-hour-weather-forecast'),
    getJSON('https://api.data.gov.sg/v1/environment/air-temperature').catch(() => null),
  ]);

  const f2 = now2h?.items?.[0] || {};
  const forecasts = f2.forecasts || [];
  const rainAreas = forecasts.filter((f) => RAINY.test(f.forecast)).map((f) => f.area);
  // Most common 2-hour forecast word = the headline condition
  const counts = {};
  forecasts.forEach((f) => (counts[f.forecast] = (counts[f.forecast] || 0) + 1));
  const nowCondition = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || null;

  const d = day24?.items?.[0] || {};
  const general = d.general || {};
  const periods = (d.periods || []).map((p) => ({
    start: p.time?.start,
    end: p.time?.end,
    regions: p.regions || {},
  }));

  let tempNow = null;
  const readings = temp?.items?.[0]?.readings || [];
  if (readings.length) {
    tempNow = Math.round(readings.reduce((s, r) => s + r.value, 0) / readings.length);
  }

  return {
    tempNow,
    nowCondition,
    rainAreas,
    areaCount: forecasts.length,
    validUntil: f2.valid_period?.end || null,
    today: {
      forecast: general.forecast || null,
      high: general.temperature?.high ?? null,
      low: general.temperature?.low ?? null,
      humidityHigh: general.relative_humidity?.high ?? null,
    },
    periods,
  };
}

// ---------- haze ----------

function psiBand(v) {
  if (v == null) return null;
  if (v <= 50) return { label: 'Good', level: 0 };
  if (v <= 100) return { label: 'Moderate', level: 1 };
  if (v <= 200) return { label: 'Unhealthy', level: 2 };
  if (v <= 300) return { label: 'Very unhealthy', level: 3 };
  return { label: 'Hazardous', level: 4 };
}

async function psi() {
  const j = await getJSON('https://api.data.gov.sg/v1/environment/psi');
  const r = j?.items?.[0]?.readings || {};
  const psi24 = r.psi_twenty_four_hourly || {};
  const pm25 = r.pm25_twenty_four_hourly || {};
  const regions = ['north', 'south', 'east', 'west', 'central'].filter((k) => psi24[k] != null);
  const vals = regions.map((k) => psi24[k]);
  const max = vals.length ? Math.max(...vals) : null;
  const min = vals.length ? Math.min(...vals) : null;
  return {
    min, max,
    band: psiBand(max),
    regions: Object.fromEntries(regions.map((k) => [k, psi24[k]])),
    pm25Max: Object.values(pm25).length ? Math.max(...Object.values(pm25)) : null,
    timestamp: j?.items?.[0]?.timestamp || null,
  };
}

// ---------- checkpoint cameras ----------

const CAMS = [
  { id: '2701', label: 'Woodlands Causeway', sub: 'Towards Johor' },
  { id: '4703', label: 'Tuas Second Link', sub: 'Towards Johor' },
  { id: '2702', label: 'Woodlands Checkpoint', sub: 'Checkpoint area' },
  { id: '4713', label: 'Tuas Checkpoint', sub: 'Checkpoint area' },
];

async function cams() {
  const j = await getJSON('https://api.data.gov.sg/v1/transport/traffic-images');
  const list = j?.items?.[0]?.cameras || [];
  return CAMS.map((c) => {
    const hit = list.find((x) => String(x.camera_id) === c.id);
    return hit ? { ...c, url: hit.image, timestamp: hit.timestamp } : null;
  }).filter(Boolean);
}

// ---------- exchange rates (ECB reference rates via Frankfurter) ----------

const FX = ['MYR', 'USD', 'CNY', 'THB', 'JPY', 'IDR', 'INR', 'AUD', 'GBP', 'EUR', 'KRW', 'HKD'];

async function fx() {
  const start = new Date(Date.now() - 10 * 86400000).toISOString().slice(0, 10);
  const j = await getJSON(`https://api.frankfurter.dev/v1/${start}..?base=SGD&symbols=${FX.join(',')}`);
  const dates = Object.keys(j?.rates || {}).sort();
  if (!dates.length) throw new Error('no fx');
  const last = j.rates[dates[dates.length - 1]];
  const prev = dates.length > 1 ? j.rates[dates[dates.length - 2]] : null;
  return {
    date: dates[dates.length - 1],
    rates: FX.filter((c) => last[c] != null).map((c) => ({
      code: c,
      rate: last[c],
      changePct: prev && prev[c] ? ((last[c] - prev[c]) / prev[c]) * 100 : null,
    })),
  };
}

// ---------- COE ----------

const COE_LABELS = {
  'Category A': { cat: 'A', label: 'Cars up to 1600cc' },
  'Category B': { cat: 'B', label: 'Cars above 1600cc' },
  'Category C': { cat: 'C', label: 'Goods vehicles & buses' },
  'Category D': { cat: 'D', label: 'Motorcycles' },
  'Category E': { cat: 'E', label: 'Open' },
};

async function coe() {
  const url = 'https://data.gov.sg/api/action/datastore_search?resource_id=d_69b3380ad7e51aff3a7dcc84eba52b8a&limit=20&sort=' +
    encodeURIComponent('month desc,bidding_no desc');
  const j = await getJSON(url);
  const recs = j?.result?.records || [];
  if (!recs.length) throw new Error('no coe');
  // Group by round
  const rounds = [];
  for (const r of recs) {
    const key = `${r.month}#${r.bidding_no}`;
    let g = rounds.find((x) => x.key === key);
    if (!g) rounds.push((g = { key, month: r.month, round: r.bidding_no, items: {} }));
    g.items[r.vehicle_class] = Number(r.premium);
  }
  const [cur, prev] = rounds;
  return {
    month: cur.month,
    round: cur.round,
    cats: Object.keys(COE_LABELS).filter((k) => cur.items[k] != null).map((k) => ({
      ...COE_LABELS[k],
      premium: cur.items[k],
      change: prev && prev.items[k] != null ? cur.items[k] - prev.items[k] : null,
    })),
  };
}

// ---------- hawker centre closures ----------

async function hawkers() {
  const j = await getJSON('https://data.gov.sg/api/action/datastore_search?resource_id=d_bda4baa634dd1cc7a6c7cad5f19e2d68&limit=300');
  const recs = j?.result?.records || [];
  const today = sgToday();
  const spans = [
    ['q1_cleaningstartdate', 'q1_cleaningenddate', 'Cleaning'],
    ['q2_cleaningstartdate', 'q2_cleaningenddate', 'Cleaning'],
    ['q3_cleaningstartdate', 'q3_cleaningenddate', 'Cleaning'],
    ['q4_cleaningstartdate', 'q4_cleaningenddate', 'Cleaning'],
    ['other_works_startdate', 'other_works_enddate', 'Other works'],
  ];
  const closedToday = [];
  const upcoming = [];
  for (const r of recs) {
    for (const [s, e, why] of spans) {
      const start = parseDMY(r[s]);
      const end = parseDMY(r[e]) || start;
      if (!start) continue;
      const name = String(r.name || '').replace(/\s*\(.*\)\s*$/, '').trim() || r.name;
      if (start <= today && today <= end) {
        closedToday.push({ name, until: end, reason: why });
      } else if (start > today && daysBetween(today, start) <= 7) {
        upcoming.push({ name, from: start, until: end, reason: why });
      }
    }
  }
  closedToday.sort((a, b) => a.name.localeCompare(b.name));
  upcoming.sort((a, b) => a.from.localeCompare(b.from));
  return { today, closedToday, upcoming: upcoming.slice(0, 8) };
}

// ---------- public holidays (MOM list; update yearly) ----------

const HOLIDAYS = [
  ['2026-01-01', "New Year's Day"], ['2026-02-17', 'Chinese New Year'], ['2026-02-18', 'Chinese New Year'],
  ['2026-03-21', 'Hari Raya Puasa'], ['2026-04-03', 'Good Friday'], ['2026-05-01', 'Labour Day'],
  ['2026-05-27', 'Hari Raya Haji'], ['2026-05-31', 'Vesak Day', '2026-06-01'],
  ['2026-08-09', 'National Day', '2026-08-10'], ['2026-11-08', 'Deepavali', '2026-11-09'],
  ['2026-12-25', 'Christmas Day'],
  ['2027-01-01', "New Year's Day"], ['2027-02-06', 'Chinese New Year'], ['2027-02-07', 'Chinese New Year', '2027-02-08'],
  ['2027-03-10', 'Hari Raya Puasa'], ['2027-03-26', 'Good Friday'], ['2027-05-01', 'Labour Day'],
  ['2027-05-17', 'Hari Raya Haji'], ['2027-05-20', 'Vesak Day'], ['2027-08-09', 'National Day'],
  ['2027-10-28', 'Deepavali'], ['2027-12-25', 'Christmas Day'],
];

function nextHoliday() {
  const today = sgToday();
  const h = HOLIDAYS.find(([d]) => d >= today);
  if (!h) return null;
  return { date: h[0], name: h[1], observed: h[2] || null, days: daysBetween(today, h[0]) };
}

// ---------- news headlines (RSS) ----------

const FEEDS = [
  { src: 'CNA', url: 'https://www.channelnewsasia.com/api/v1/rss-outbound-feed?_format=xml&category=10416' },
  { src: 'The Straits Times', url: 'https://www.straitstimes.com/news/singapore/rss.xml' },
  { src: 'Mothership', url: 'https://mothership.sg/feed/' },
];

function parseFeedDate(s) {
  if (!s) return null;
  let t = Date.parse(s);
  // ISO without a timezone (Mothership) is Singapore time
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(s.trim())) t = Date.parse(s.trim() + '+08:00');
  return Number.isNaN(t) ? null : t;
}

function parseRSS(xml, src) {
  const items = [];
  const re = /<item[\s>][\s\S]*?<\/item>/gi;
  let m;
  while ((m = re.exec(xml)) && items.length < 6) {
    const block = m[0];
    const pick = (tag) => {
      const x = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i').exec(block);
      return x ? decodeEntities(x[1]) : '';
    };
    const title = pick('title');
    const link = pick('link') || pick('guid');
    if (!title || !/^https?:\/\//.test(link)) continue;
    items.push({ title, link, src, time: parseFeedDate(pick('pubDate') || pick('dc:date')) });
  }
  return items;
}

async function news() {
  const results = await Promise.allSettled(FEEDS.map((f) => getText(f.url).then((x) => parseRSS(x, f.src))));
  const perFeed = results.map((r) => (r.status === 'fulfilled' ? r.value : []));
  // Take up to 4 from each source so no single outlet dominates, newest first
  const all = perFeed.flatMap((list) => list.slice(0, 4));
  all.sort((a, b) => (b.time || 0) - (a.time || 0));
  if (!all.length) throw new Error('no news');
  return all.slice(0, 10);
}

// ---------- LTA DataMall (optional, needs a free key) ----------

async function lta() {
  const key = process.env.LTA_KEY;
  if (!key) return { enabled: false };
  const base = 'https://datamall2.mytransport.sg/ltaodataservice';
  const headers = { AccountKey: key };
  const [inc, trains] = await Promise.all([
    getJSON(`${base}/TrafficIncidents`, { headers }).catch(() => null),
    getJSON(`${base}/TrainServiceAlerts`, { headers }).catch(() => null),
  ]);
  const incidents = (inc?.value || [])
    .filter((x) => /accident|vehicle breakdown|roadwork|obstacle|heavy traffic/i.test(x.Type || ''))
    .map((x) => ({ type: x.Type, message: x.Message }))
    .slice(0, 6);
  const v = trains?.value || {};
  const disrupted = Number(v.Status) === 2;
  const segs = (v.AffectedSegments || []).map((s) => ({ line: s.Line, direction: s.Direction, stations: s.Stations }));
  const msgs = (v.Message || []).map((x) => x.Content).filter(Boolean);
  return {
    enabled: true,
    trains: trains ? { disrupted, segments: segs, messages: msgs.slice(0, 2) } : null,
    incidents: inc ? incidents : null,
  };
}

// ---------- handler ----------

export default async () => {
  const [w, p, c, f, co, hk, n, l] = await Promise.all([
    cached('weather', 4 * MIN, weather),
    cached('psi', 10 * MIN, psi),
    cached('cams', 2 * MIN, cams),
    cached('fx', 60 * MIN, fx),
    cached('coe', 6 * 60 * MIN, coe),
    cached('hawkers', 6 * 60 * MIN, hawkers),
    cached('news', 10 * MIN, news),
    cached('lta', 3 * MIN, lta),
  ]);

  const body = {
    updated: new Date().toISOString(),
    weather: w, psi: p, cams: c, fx: f, coe: co, hawkers: hk,
    holiday: nextHoliday(), news: n, lta: l,
  };

  return new Response(JSON.stringify(body), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      // Browsers re-check every minute; Netlify's edge shares one copy for 2 minutes
      'Cache-Control': 'public, max-age=60',
      'Netlify-CDN-Cache-Control': 'public, s-maxage=120, stale-while-revalidate=300',
    },
  });
};

export const config = { path: '/api/data' };
