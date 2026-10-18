import { getStore } from '@netlify/blobs';

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

// "Feels like" temperature: the US National Weather Service heat index formula
function heatIndexC(tc, rh) {
  const T = tc * 9 / 5 + 32;
  let HI = 0.5 * (T + 61 + (T - 68) * 1.2 + rh * 0.094);
  if ((HI + T) / 2 >= 80) {
    HI = -42.379 + 2.04901523 * T + 10.14333127 * rh - 0.22475541 * T * rh
      - 0.00683783 * T * T - 0.05481717 * rh * rh + 0.00122874 * T * T * rh
      + 0.00085282 * T * rh * rh - 0.00000199 * T * T * rh * rh;
    if (rh < 13 && T >= 80 && T <= 112) HI -= ((13 - rh) / 4) * Math.sqrt((17 - Math.abs(T - 95)) / 17);
    else if (rh > 85 && T >= 80 && T <= 87) HI += ((rh - 85) / 10) * ((87 - T) / 5);
  }
  return Math.max(tc, (HI - 32) * 5 / 9);
}

// ---------- weather ----------

const RAINY = /rain|shower|thunder/i;

async function weather() {
  const [now2h, day24, temp, hum] = await Promise.all([
    getJSON('https://api.data.gov.sg/v1/environment/2-hour-weather-forecast'),
    getJSON('https://api.data.gov.sg/v1/environment/24-hour-weather-forecast'),
    getJSON('https://api-open.data.gov.sg/v2/real-time/api/air-temperature').catch(() => null),
    getJSON('https://api-open.data.gov.sg/v2/real-time/api/relative-humidity').catch(() => null),
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

  // Island-wide averages from all NEA stations reporting right now
  const avg = (j) => {
    const vals = (j?.data?.readings?.[0]?.data || []).map((r) => Number(r.value)).filter((v) => Number.isFinite(v));
    return vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : null;
  };
  const tAvg = avg(temp);
  const hAvg = avg(hum);
  const tempNow = tAvg != null ? Math.round(tAvg) : null;
  const humidity = hAvg != null ? Math.round(hAvg) : null;
  const feelsLike = tAvg != null && hAvg != null ? Math.round(heatIndexC(tAvg, hAvg)) : null;

  return {
    tempNow,
    feelsLike,
    humidity,
    nowCondition,
    rainAreas,
    areaCount: forecasts.length,
    validUntil: f2.valid_period?.end || null,
    today: {
      forecast: general.forecast || null,
      high: general.temperature?.high ?? null,
      low: general.temperature?.low ?? null,
      humidityHigh: general.relative_humidity?.high ?? null,
      wind: general.wind ? { dir: general.wind.direction || null, low: general.wind.speed?.low ?? null, high: general.wind.speed?.high ?? null } : null,
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

const FX = ['MYR', 'USD', 'CNY', 'THB', 'JPY', 'IDR', 'KRW', 'PHP'];

async function fx() {
  const start = new Date(Date.now() - 10 * 86400000).toISOString().slice(0, 10);
  const j = await getJSON(`https://api.frankfurter.dev/v1/${start}..?base=SGD&symbols=${FX.join(',')}`);
  const dates = Object.keys(j?.rates || {}).sort();
  if (!dates.length) throw new Error('no fx');
  const last = j.rates[dates[dates.length - 1]];
  const prev = dates.length > 1 ? j.rates[dates[dates.length - 2]] : null;
  const rates = FX.filter((c) => last[c] != null).map((c) => ({
    code: c,
    rate: last[c],
    changePct: prev && prev[c] ? ((last[c] - prev[c]) / prev[c]) * 100 : null,
  }));
  const v = await vnd();
  if (v) rates.push(v);
  return { date: dates[dates.length - 1], rates };
}

// The ECB doesn't publish the Vietnamese dong, so VND comes from Yahoo Finance,
// with open.er-api.com as a backup (that one has no daily change).
async function vnd() {
  try {
    const q = await oneIndex({ sym: 'SGDVND=X', name: 'VND' });
    if (q.price > 1000) return { code: 'VND', rate: q.price, changePct: q.changePct };
  } catch {}
  try {
    const j = await getJSON('https://open.er-api.com/v6/latest/SGD');
    const r = Number(j?.rates?.VND);
    if (r > 1000) return { code: 'VND', rate: r, changePct: null };
  } catch {}
  return null;
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

const WORLD_FEEDS = [
  { src: 'BBC', url: 'https://feeds.bbci.co.uk/news/world/rss.xml' },
  { src: 'CNA', url: 'https://www.channelnewsasia.com/api/v1/rss-outbound-feed?_format=xml&category=6311' },
  { src: 'The Straits Times', url: 'https://www.straitstimes.com/news/world/rss.xml' },
];

// Chinese world headlines for the 中文 view, from news outlets that publish in Chinese
const WORLD_FEEDS_ZH = [
  { src: 'BBC中文', url: 'https://feeds.bbci.co.uk/zhongwen/simp/rss.xml' },
  { src: '德国之声', url: 'https://rss.dw.com/rdf/rss-chi-all' },
];

async function worldNewsZh() {
  const results = await Promise.allSettled(WORLD_FEEDS_ZH.map((f) => getText(f.url).then((x) => parseRSS(x, f.src))));
  const all = results.flatMap((r) => (r.status === 'fulfilled' ? r.value.slice(0, 5) : []));
  all.sort((a, b) => (b.time || 0) - (a.time || 0));
  if (!all.length) throw new Error('no chinese world news');
  return all.slice(0, 8);
}

async function worldNews() {
  const results = await Promise.allSettled(WORLD_FEEDS.map((f) => getText(f.url).then((x) => parseRSS(x, f.src))));
  const perFeed = results.map((r) => (r.status === 'fulfilled' ? r.value : []));
  const all = perFeed.flatMap((list) => list.slice(0, 4));
  all.sort((a, b) => (b.time || 0) - (a.time || 0));
  if (!all.length) throw new Error('no world news');
  return all.slice(0, 8);
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
  // Jams, accidents and other incidents, most important first, newest first within each type
  const PRIORITY = { 'heavy traffic': 0, 'accident': 1, 'vehicle breakdown': 2, 'obstacle': 3, 'road block': 3, 'unattended vehicle': 3, 'diversion': 4, 'roadwork': 5 };
  const now = new Date();
  const incidents = (inc?.value || [])
    .map((x) => {
      const type = String(x.Type || '').trim();
      const key = type.toLowerCase();
      if (!(key in PRIORITY)) return null;
      // Messages start with "(18/10)18:30 ": pull out the time, keep the rest
      const msg = String(x.Message || '');
      const m = /^\((\d{1,2})\/(\d{1,2})\)(\d{1,2}):(\d{2})\s*/.exec(msg);
      let time = null;
      if (m) {
        const d = new Date(Date.UTC(now.getUTCFullYear(), Number(m[2]) - 1, Number(m[1]), Number(m[3]) - 8, Number(m[4])));
        time = d.toISOString();
      }
      return { type, rank: PRIORITY[key], message: m ? msg.slice(m[0].length) : msg, time };
    })
    .filter(Boolean)
    .sort((a, b) => a.rank - b.rank || String(b.time).localeCompare(String(a.time)))
    .slice(0, 40);
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

// ---------- Causeway / Second Link crossing estimate (Google Maps traffic, optional) ----------
// Driving time across each bridge, checkpoint to checkpoint, in both directions.
// Road traffic only. Immigration clearance can add time on top.
const CROSSINGS = [
  { id: 'woodlands-jb', cam: '2701', dir: 'jb', origin: 'Woodlands Checkpoint, Singapore', destination: 'Bangunan Sultan Iskandar, Johor Bahru, Malaysia' },
  { id: 'tuas-jb', cam: '4703', dir: 'jb', origin: 'Tuas Checkpoint, Singapore', destination: 'Kompleks Sultan Abu Bakar, Gelang Patah, Johor, Malaysia' },
  { id: 'woodlands-sg', cam: '2701', dir: 'sg', origin: 'Johor Bahru City Square, Johor Bahru, Malaysia', destination: 'Woodlands Checkpoint, Singapore' },
  { id: 'tuas-sg', cam: '4703', dir: 'sg', origin: 'Kompleks Sultan Abu Bakar, Gelang Patah, Johor, Malaysia', destination: 'Tuas Checkpoint, Singapore' },
];

const secs = (s) => (s ? Number(String(s).replace('s', '')) : null);

async function routeTime(c, key) {
  const res = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': key,
      'X-Goog-FieldMask': 'routes.duration,routes.staticDuration',
    },
    body: JSON.stringify({
      origin: { address: c.origin },
      destination: { address: c.destination },
      travelMode: 'DRIVE',
      routingPreference: 'TRAFFIC_AWARE',
    }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`routes ${res.status}`);
  const j = await res.json();
  const r = j.routes?.[0];
  const now = secs(r?.duration);
  const free = secs(r?.staticDuration);
  if (!now) return null;
  const mins = now / 60;
  const ratio = free ? now / free : 1;
  return {
    id: c.id, cam: c.cam, dir: c.dir,
    minutes: Math.round(mins),
    low: Math.max(3, Math.round(mins * 0.9)),
    high: Math.max(5, Math.round(mins * 1.4)),
    level: ratio < 1.5 ? 'smooth' : ratio < 2.5 ? 'moderate' : 'heavy',
  };
}

// Google allows 5,000 free traffic requests a month. Four routes every 30 minutes,
// paused 1am to 5am, comes to about 4,800. The last result is saved in Netlify's
// storage so restarts never trigger extra requests.
const XING_TTL = 30 * 60 * 1000;

function sgHour() {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: 'numeric', hour12: false }).format(new Date()));
}

async function crossings() {
  const key = process.env.GOOGLE_MAPS_KEY;
  if (!key) return null;
  let store = null;
  let saved = null;
  try {
    store = getStore('yaysg-cache');
    saved = await store.get('crossings', { type: 'json' });
  } catch (e) {
    console.error('[blobs]', e.message);
  }
  const age = saved ? Date.now() - Date.parse(saved.updated) : Infinity;
  const h = sgHour();
  const quietHours = h >= 1 && h < 5;
  if (saved && (age < XING_TTL || quietHours)) return saved;

  const results = await Promise.allSettled(CROSSINGS.map((c) => routeTime(c, key)));
  const list = results.map((r) => (r.status === 'fulfilled' ? r.value : null)).filter(Boolean);
  if (!list.length) return saved; // keep the last good numbers if Google fails
  const fresh = { updated: new Date().toISOString(), list };
  try { if (store) await store.setJSON('crossings', fresh); } catch (e) { console.error('[blobs]', e.message); }
  return fresh;
}

// ---------- stock market indexes (Yahoo Finance public chart feed, unofficial) ----------
const INDEXES = [
  { sym: '^STI', name: 'STI' },
  { sym: '^KLSE', name: 'KLCI' },
  { sym: '^N225', name: 'Nikkei 225' },
  { sym: '^HSI', name: 'Hang Seng' },
  { sym: '000001.SS', name: 'Shanghai' },
  { sym: '^DJI', name: 'Dow Jones' },
  { sym: '^IXIC', name: 'Nasdaq' },
  { sym: '^GSPC', name: 'S&P 500' },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const YAHOO_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';

async function oneIndex(ix) {
  let lastErr;
  for (const host of ['query1', 'query2']) {
    try {
      const url = `https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ix.sym)}?range=5d&interval=1d`;
      const res = await fetch(url, { headers: { 'User-Agent': YAHOO_UA, Accept: 'application/json' }, signal: AbortSignal.timeout(3500) });
      if (!res.ok) throw new Error(`yahoo ${res.status} ${ix.sym}`);
      const j = await res.json();
      const r = j?.chart?.result?.[0];
      const m = r?.meta;
      const price = Number(m?.regularMarketPrice);
      if (!Number.isFinite(price)) throw new Error(`no price ${ix.sym}`);
      // Daily closes for the last few sessions. The change is measured against the
      // close of the previous trading day, not the start of the 5-day window.
      const ts = r?.timestamp || [];
      const closes = r?.indicators?.quote?.[0]?.close || [];
      const days = ts.map((s, i) => ({ day: new Date((s + (m.gmtoffset || 0)) * 1000).toISOString().slice(0, 10), close: closes[i] }))
        .filter((d) => Number.isFinite(d.close));
      const marketDay = m.regularMarketTime ? new Date((m.regularMarketTime + (m.gmtoffset || 0)) * 1000).toISOString().slice(0, 10) : null;
      const earlier = days.filter((d) => d.day !== marketDay);
      const prev = earlier.length ? earlier[earlier.length - 1].close : Number(m.previousClose);
      return {
        name: ix.name,
        price,
        changePct: Number.isFinite(prev) && prev ? ((price - prev) / prev) * 100 : null,
        time: m.regularMarketTime ? m.regularMarketTime * 1000 : null,
      };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

// Remember the last good value for each index, so one failed request doesn't drop it from the strip
const lastGood = new Map();

async function markets() {
  // One at a time with a short pause, so Yahoo doesn't block a burst of requests.
  // Stop after about 7 seconds so the page never waits too long; missing ones keep their last value.
  const deadline = Date.now() + 7000;
  for (const ix of INDEXES) {
    if (Date.now() > deadline) break;
    try {
      const v = await oneIndex(ix);
      if (v) lastGood.set(ix.name, v);
    } catch (e) {
      console.error('[markets]', e.message);
    }
    await sleep(250);
  }
  const list = INDEXES.map((ix) => lastGood.get(ix.name)).filter(Boolean);
  if (!list.length) throw new Error('no market data');
  return list;
}

// ---------- Singapore Pools 4D and TOTO (latest draw) ----------
const POOLS = 'https://www.singaporepools.com.sg/DataFileArchive/Lottery/Output/';
const DATE_RE = /(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{1,2} [A-Za-z]{3} \d{4}/;

// The pages list several draws, newest first. Keep only the first one.
function firstDraw(html) {
  const re = new RegExp(DATE_RE.source, 'g');
  const a = re.exec(html);
  if (!a) return null;
  const b = re.exec(html);
  return html.slice(a.index, b ? b.index : undefined);
}
const cells = (block) => [...block.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => decodeEntities(m[1]));

async function fourD() {
  const html = await getText(POOLS + 'fourd_result_top_draws_en.html');
  const block = firstDraw(html);
  if (!block) throw new Error('4d: no draw');
  const nums = cells(block).filter((c) => /^\d{4}$/.test(c));
  if (nums.length < 23) throw new Error('4d: unexpected layout');
  return {
    date: (block.match(DATE_RE) || [])[0] || null,
    draw: (block.match(/Draw No\.?\s*(\d+)/i) || [])[1] || null,
    first: nums[0], second: nums[1], third: nums[2],
    starter: nums.slice(3, 13),
    consolation: nums.slice(13, 23),
  };
}

async function toto() {
  const html = await getText(POOLS + 'toto_result_top_draws_en.html');
  const block = firstDraw(html);
  if (!block) throw new Error('toto: no draw');
  const c = cells(block);
  const balls = c.filter((x) => /^\d{1,2}$/.test(x)).map(Number).filter((n) => n >= 1 && n <= 49);
  if (balls.length < 7) throw new Error('toto: unexpected layout');
  // Only read the cell straight after the "Group 1 Prize" heading, never a later table
  const g1cell = block.match(/Group 1 Prize[\s\S]*?<td[^>]*>([\s\S]*?)<\/td>/i);
  const g1text = g1cell ? decodeEntities(g1cell[1]) : '';
  const g1 = /^\$[\d,]+$/.test(g1text) ? [null, g1text] : null;
  // Winning shares table: Group, share amount, number of winning shares
  const groups = [];
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let m;
  while ((m = rowRe.exec(block))) {
    const tds = [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((x) => decodeEntities(x[1]));
    const g = tds.length >= 3 && /^Group\s*(\d)$/i.exec(tds[0]);
    if (g && Number(g[1]) <= 3) groups.push({ group: Number(g[1]), amount: tds[1], winners: tds[2] });
  }
  return {
    date: (block.match(DATE_RE) || [])[0] || null,
    draw: (block.match(/Draw No\.?\s*(\d+)/i) || [])[1] || null,
    winning: balls.slice(0, 6),
    additional: balls[6],
    group1: g1 ? g1[1] : null,
    groups,
  };
}

// Next TOTO draw date and estimated jackpot
async function totoNext() {
  const html = await getText(POOLS + 'toto_next_draw_estimate_en.html');
  const text = decodeEntities(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ');
  const amount = (text.match(/\$[\d,]+/) || [])[0] || null;
  if (!amount) throw new Error('toto next: no amount');
  return {
    date: (text.match(DATE_RE) || [])[0] || null,
    time: (text.match(/\b\d{1,2}[.:]\d{2}\s*[ap]m\b/i) || [])[0] || null,
    jackpot: amount,
    estimate: /est/i.test(text),
  };
}

async function lottery() {
  const [d4, tt, nx] = await Promise.allSettled([fourD(), toto(), totoNext()]);
  const out = { fourD: d4.status === 'fulfilled' ? d4.value : null, toto: tt.status === 'fulfilled' ? tt.value : null, totoNext: nx.status === 'fulfilled' ? nx.value : null };
  if (!out.fourD && !out.toto) throw new Error('no lottery results');
  return out;
}

// ---------- Johor Bahru air quality (Open-Meteo, modelled US AQI, free) ----------
function usAqiBand(v) {
  if (v == null) return null;
  if (v <= 50) return { label: 'Good', level: 0 };
  if (v <= 100) return { label: 'Moderate', level: 1 };
  if (v <= 150) return { label: 'Unhealthy for sensitive groups', level: 2 };
  if (v <= 200) return { label: 'Unhealthy', level: 2 };
  if (v <= 300) return { label: 'Very unhealthy', level: 3 };
  return { label: 'Hazardous', level: 4 };
}

async function jbAir() {
  const j = await getJSON('https://air-quality-api.open-meteo.com/v1/air-quality?latitude=1.4927&longitude=103.7414&current=us_aqi,pm2_5&timezone=Asia%2FSingapore');
  const aqi = Number(j?.current?.us_aqi);
  if (!Number.isFinite(aqi)) throw new Error('no jb aqi');
  return { aqi: Math.round(aqi), pm25: j.current.pm2_5 ?? null, band: usAqiBand(aqi), time: j.current.time || null };
}

// ---------- handler ----------

export default async () => {
  const [w, p, c, f, co, hk, n, l, x, mk, wn, lt, ja, wz] = await Promise.all([
    cached('weather', 4 * MIN, weather),
    cached('psi', 10 * MIN, psi),
    cached('cams', 2 * MIN, cams),
    cached('fx', 60 * MIN, fx),
    cached('coe', 6 * 60 * MIN, coe),
    cached('hawkers', 6 * 60 * MIN, hawkers),
    cached('news', 10 * MIN, news),
    cached('lta', 3 * MIN, lta),
    cached('crossings', 5 * MIN, crossings),
    cached('markets', 10 * MIN, markets),
    cached('world', 10 * MIN, worldNews),
    cached('lottery', 15 * MIN, lottery),
    cached('jbair', 30 * MIN, jbAir),
    cached('worldzh', 10 * MIN, worldNewsZh),
  ]);

  const body = {
    updated: new Date().toISOString(),
    weather: w, psi: p, cams: c, fx: f, coe: co, hawkers: hk,
    holiday: nextHoliday(), news: n, lta: l, crossings: x, markets: mk, world: wn, worldZh: wz, lottery: lt, jbAir: ja,
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
