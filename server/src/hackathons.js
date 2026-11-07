// Hackathons from Devpost, Unstop, Devfolio, HackerEarth, Hack2skill, lablab.ai, Taikai, HackIndia, MLH and ETHGlobal,
// normalised to one shape. Public listing endpoints / pages only; results are cached for 30 minutes.

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './store.js';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36';
const TTL = 30 * 60_000;
const CACHE_FILE = path.join(DATA_DIR, 'hackathons.json');
let cache = (() => {
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  } catch {
    return { at: 0, items: [], sources: {}, byPlatform: {} };
  }
})();
cache.byPlatform ||= {};

const get = async (url, opts = {}) => {
  const res = await fetch(url, { ...opts, headers: { 'User-Agent': UA, Accept: 'application/json,text/html', ...(opts.headers || {}) }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return opts.text ? res.text() : res.json();
};
const iso = (d) => {
  const t = d ? new Date(d) : null;
  return t && !isNaN(t) ? t.toISOString() : null;
};
const stripTags = (s) => String(s || '').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
const modeOf = (s) => {
  const t = String(s || '').toLowerCase();
  if (/hybrid/.test(t)) return 'hybrid';
  if (/online|virtual|remote/.test(t)) return 'online';
  return t ? 'in-person' : '';
};

// "Nov 02 - 03, 2026" | "Oct 15 - Nov 05, 2026" | "Dec 30, 2026 - Jan 05, 2027"
function devpostDates(s) {
  const m = String(s || '').match(/^([A-Za-z]{3})\s+(\d{1,2})(?:,\s*(\d{4}))?\s*-\s*(?:([A-Za-z]{3})\s+)?(\d{1,2}),\s*(\d{4})$/);
  if (!m) return {};
  const [, m1, d1, y1, m2, d2, y2] = m;
  return { start: iso(`${m1} ${d1} ${y1 || y2}`), end: iso(`${m2 || m1} ${d2} ${y2} 23:59`) };
}

// Amounts like "$10,000", "₹ 20,000" -> a rough USD value, only for sorting by prize.
function prizeUSD(text) {
  const t = String(text || '');
  const n = Number((t.match(/[\d,]+(\.\d+)?/) || ['0'])[0].replace(/,/g, ''));
  if (!n) return 0;
  if (/₹|inr|rs\.?/i.test(t)) return n / 84;
  if (/€|eur/i.test(t)) return n * 1.08;
  return n;
}

const SOURCES = {
  async devpost() {
    // Every open / upcoming page (9 per page), a few at a time.
    const url = (p) => `https://devpost.com/api/hackathons?status[]=upcoming&status[]=open&order_by=deadline&page=${p}`;
    const first = await get(url(1));
    const last = Math.min(30, Math.ceil((first.meta?.total_count || 0) / (first.meta?.per_page || 9)) || 1);
    const pages = [first];
    for (let p = 2; p <= last; p += 6) pages.push(...(await Promise.all(Array.from({ length: Math.min(6, last - p + 1) }, (_, k) => get(url(p + k)).catch(() => ({ hackathons: [] }))))));
    return pages.flatMap((p) => p.hackathons || []).map((h) => {
      const prize = stripTags(h.prize_amount);
      const { start, end } = devpostDates(h.submission_period_dates);
      const loc = h.displayed_location?.location || '';
      return {
        title: h.title,
        url: h.url,
        organizer: h.organization_name,
        mode: modeOf(loc) || (loc ? 'in-person' : ''),
        location: /online/i.test(loc) ? '' : loc,
        start,
        end,
        deadline: end,
        status: h.open_state === 'upcoming' ? 'upcoming' : 'open',
        prize: prizeUSD(prize) ? prize : '',
        prizeUSD: prizeUSD(prize),
        tags: (h.themes || []).map((t) => t.name).slice(0, 5),
        participants: h.registrations_count,
        image: h.thumbnail_url?.startsWith('//') ? `https:${h.thumbnail_url}` : h.thumbnail_url,
      };
    });
  },

  async unstop() {
    // Pages until one comes back empty (30 per page, at most 10 pages).
    const pages = [];
    for (let p = 1; p <= 10; p += 5) {
      const batch = await Promise.all([p, p + 1, p + 2, p + 3, p + 4].map((n) => get(`https://unstop.com/api/public/opportunity/search-result?opportunity=hackathons&page=${n}&per_page=30&oppstatus=open`).catch(() => null)));
      pages.push(...batch);
      if (batch.some((b) => !(b?.data?.data || []).length)) break;
    }
    return pages.flatMap((p) => p?.data?.data || []).map((h) => {
      const cash = (h.prizes || []).reduce((s, p) => s + (Number(p.cash) || 0), 0);
      const prizeText = (h.prizes || []).map((p) => p.others || '').join(' | ');
      return {
        // Unstop flags these per prize; the reward text and description say the rest ("pre placement interview").
        perks: careerPerks(`${prizeText} ${String(h.details || '').replace(/<[^>]+>/g, ' ')}`, {
          ppi: (h.prizes || []).some((p) => Number(p.pre_placement_internship) > 0),
          ppo: (h.prizes || []).some((p) => Number(p.pre_placement_opportunity) > 0),
        }),
        rewards: prizeText.replace(/\s+/g, ' ').trim().slice(0, 240),
        title: h.title,
        url: h.seo_url || `https://unstop.com/${h.public_url}`,
        organizer: h.organisation?.name,
        mode: modeOf(h.region),
        location: h.address_with_country_logo?.city || '',
        start: iso(h.regnRequirements?.start_regn_dt),
        end: iso(h.end_date),
        deadline: iso(h.regnRequirements?.end_regn_dt || h.end_date),
        status: h.regn_open ? 'open' : 'upcoming',
        prize: cash ? `₹${cash.toLocaleString('en-IN')}` : '',
        prizeUSD: cash / 84,
        tags: (h.required_skills || []).map((s) => s.name || s.skill || s).filter((x) => typeof x === 'string').slice(0, 5),
        participants: h.registerCount,
        image: h.logoUrl2,
      };
    });
  },

  async devfolio() {
    const out = [];
    for (const type of ['application_open', 'upcoming']) {
      const d = await get('https://api.devfolio.co/api/search/hackathons', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type, from: 0, size: 40 }) }).catch(() => null);
      for (const { _source: h } of d?.hits?.hits || []) {
        out.push({
          title: h.name,
          url: `https://${h.slug}.devfolio.co/`,
          organizer: h.hosted_by?.name || '',
          mode: h.is_online ? 'online' : 'in-person',
          location: [h.city, h.country].filter(Boolean).join(', '),
          start: iso(h.starts_at),
          end: iso(h.ends_at),
          deadline: iso(h.hackathon_setting?.reg_ends_at || h.starts_at),
          status: type === 'application_open' ? 'open' : 'upcoming',
          prize: '',
          prizeUSD: 0,
          tags: (h.themes || []).map((t) => t.name).filter(Boolean).slice(0, 5),
          participants: h.participants_count,
          image: h.hackathon_setting?.logo || '',
        });
      }
    }
    return out;
  },

  async hackerearth() {
    const d = await get('https://www.hackerearth.com/chrome-extension/events/');
    return (d.response || [])
      .filter((h) => h.status !== 'ENDED')
      .map((h) => ({
        title: h.title,
        url: h.url,
        organizer: h.college ? 'College' : 'HackerEarth',
        mode: 'online',
        location: '',
        start: iso(h.start_utc_tz),
        end: iso(h.end_utc_tz),
        deadline: iso(h.end_utc_tz),
        status: h.status === 'ONGOING' ? 'open' : 'upcoming',
        prize: '',
        prizeUSD: 0,
        tags: [h.challenge_type].filter(Boolean),
        image: h.thumbnail,
      }));
  },

  async hack2skill() {
    const d = await get('https://hack2skill.com/api/v1/innovator/public/event/list?page=1&limit=60');
    const list = [...(d.data?.flagshipEvents || []), ...(d.data?.communityEvents || [])];
    const now = Date.now();
    return list
      .filter((h) => !h.registrationEnd || new Date(h.registrationEnd) > now)
      .map((h) => ({
        title: h.title,
        url: h.customEventUrl || `https://vision.hack2skill.com/event/${h.eventUrl}`,
        organizer: 'Hack2skill',
        mode: modeOf(h.tags?.mode?.value?.replace('_', '-')) || (h.tags?.mode?.value === 'IN_PERSON' ? 'in-person' : ''),
        location: '',
        start: iso(h.registrationStart),
        end: null,
        deadline: iso(h.registrationEnd),
        status: h.registrationStart && new Date(h.registrationStart) > now ? 'upcoming' : 'open',
        prize: '',
        prizeUSD: 0,
        tags: [h.tags?.ticket?.value === 'FREE' ? 'Free' : '', ...(h.tags?.technology?.value || [])].filter(Boolean).slice(0, 5),
        participants: h.tags?.registrations?.value,
        image: h.thumbnail,
      }));
  },

  async lablab() {
    const html = await get('https://lablab.ai/ai-hackathons', { text: true });
    const items = [];
    for (const m of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
      try {
        const j = JSON.parse(m[1]);
        for (const g of j['@graph'] || [j]) {
          for (const it of g.itemListElement || g.mainEntity?.itemListElement || []) {
            if (it.url && /ai-hackathons\//.test(it.url)) items.push({ title: it.name, url: it.url });
          }
        }
      } catch {}
    }
    return items.map((h) => ({ ...h, organizer: 'lablab.ai', mode: 'online', location: '', start: null, end: null, deadline: null, status: 'open', prize: '', prizeUSD: 0, tags: ['AI'] }));
  },

  async taikai() {
    const html = await get('https://taikai.network/hackathons', { text: true });
    const out = [];
    for (const m of html.matchAll(/<a href="(\/en\/[^"]+\/hackathons\/[^"]+)"[\s\S]*?alt="([^"]+)"[\s\S]*?__state" data-ended="(true|false)">([^<]*)</g)) {
      const [, path, name, ended, state] = m;
      if (ended === 'true' || /finished|ended/i.test(state)) continue;
      out.push({
        title: stripTags(name),
        url: `https://taikai.network${path}`,
        organizer: path.split('/')[2],
        mode: '',
        location: '',
        start: null,
        end: null,
        deadline: null,
        status: /registrations? open/i.test(state) ? 'open' : 'upcoming',
        stage: state.trim(),
        prize: '',
        prizeUSD: 0,
        tags: [],
      });
    }
    return out;
  },

  async hackindia() {
    const html = await get('https://hackindia.org/hackathons', { text: true });
    const out = [];
    const seen = new Set();
    for (const m of html.matchAll(/href="(\/20\d\d\/[a-z0-9-]+)"([\s\S]{0,2500}?)<\/a>/g)) {
      const [, path, inner] = m;
      if (seen.has(path)) continue;
      seen.add(path);
      const parts = inner.split(/<[^>]+>/).map(stripTags).filter(Boolean);
      const statusText = parts.find((p) => /^(ended|starts|live|ongoing|registrations?|closes|open)/i.test(p)) || '';
      if (/^ended/i.test(statusText)) continue;
      const slugTitle = path.split('/').pop().replace(/-/g, ' ').replace(/\b[a-z]/g, (c) => c.toUpperCase());
      const title = (parts.find((p) => p.length > 4 && p !== statusText && !/university|college|institute|,/i.test(p)) || slugTitle).replace(/^[>\s]+/, '');
      out.push({
        title,
        url: `https://hackindia.org${path}`,
        organizer: 'HackIndia',
        mode: '',
        location: parts.find((p) => /,|university|college|institute/i.test(p)) || '',
        start: null,
        end: null,
        deadline: null,
        status: /live|ongoing|open/i.test(statusText) ? 'open' : 'upcoming',
        stage: statusText,
        prize: '',
        prizeUSD: 0,
        tags: [],
      });
    }
    return out;
  },

  // Major League Hacking: the season's events, marked up with schema.org Event data (url, dates, place, attendance).
  async mlh() {
    const year = new Date().getMonth() >= 6 ? new Date().getFullYear() + 1 : new Date().getFullYear();
    const html = await get(`https://mlh.io/seasons/${year}/events`, { text: true });
    const meta = (b, k) => b.match(new RegExp(`itemProp="${k}" content="([^"]*)"`, 'i'))?.[1] || '';
    return html.split('itemType="https://schema.org/Event"').slice(1).map((b) => {
      const name = stripTags(b.match(/<h4[^>]*>([\s\S]*?)<\/h4>/i)?.[1] || b.match(/alt="([^"]+?) (?:logo|background)"/i)?.[1] || '');
      const attendance = meta(b, 'eventAttendanceMode');
      const place = stripTags(b.match(/itemProp="location"[\s\S]*?itemProp="name">([\s\S]*?)<\/span>/i)?.[1] || '');
      const start = iso(meta(b, 'startDate')), end = iso(meta(b, 'endDate'));
      const url = meta(b, 'url');
      return {
        title: name,
        url,
        organizer: 'MLH',
        mode: /Online/i.test(attendance) ? 'online' : /Mixed/i.test(attendance) ? 'hybrid' : 'in-person',
        location: /everywhere|worldwide/i.test(place) ? '' : place,
        start,
        end,
        deadline: start, // MLH events take sign-ups until they start
        status: 'upcoming',
        prize: '',
        prizeUSD: 0,
        tags: [...b.matchAll(/title="([A-Za-z][\w &/-]{1,24})"/g)].map((m) => m[1]).filter((t) => !/^(digital|in-person|hybrid)$/i.test(t)).slice(0, 4),
        image: b.match(/<img src="([^"]+)"/)?.[1] || '',
      };
    }).filter((h) => h.title && h.url && (!h.end || new Date(h.end) > Date.now()));
  },

  // ETHGlobal: its hackathons (online and in cities), not the meetups, cafés and happy hours on the same page.
  async ethglobal() {
    const html = await get('https://ethglobal.com/events', { text: true });
    const out = [];
    for (const m of html.matchAll(/href="\/events\/([a-z0-9-]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
      const [, slug, body] = m;
      if (/happy-hour|cafe|cowork|activation|anniversary|conf|meetup|-wtf|aggregation|summit|pragma|day$/i.test(slug)) continue;
      const title = stripTags(body.match(/<h3[^>]*>([\s\S]*?)<\/h3>/i)?.[1] || '');
      const times = [...body.matchAll(/<time[^>]*>([\s\S]*?)<\/time>/gi)].map((t) => stripTags(t[1]).replace(/(\d)(st|nd|rd|th)/, '$1'));
      if (!title || times.length < 2) continue;
      const year = times[1].match(/\d{4}/)?.[0];
      const start = iso(/\d{4}/.test(times[0]) ? times[0] : `${times[0]}, ${year}`), end = iso(`${times[1]} 23:59`);
      if (!end || new Date(end) < Date.now()) continue;
      const where = stripTags(body.match(/<div[^>]*>(Online|[A-Z][\w .'-]{2,30})<\/div>\s*<svg/)?.[1] || '');
      out.push({ title, url: `https://ethglobal.com/events/${slug}`, organizer: 'ETHGlobal', mode: /online/i.test(where) ? 'online' : 'in-person', location: /online/i.test(where) ? '' : where, start, end, deadline: start, status: 'upcoming', prize: '', prizeUSD: 0, tags: ['Web3', 'Ethereum'], image: body.match(/<img src="([^"]+)"/)?.[1] || '' });
    }
    return out.filter((h, i, a) => a.findIndex((x) => x.url === h.url) === i);
  },
};

export const PLATFORMS = Object.keys(SOURCES);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchPlatform(p) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const items = await SOURCES[p]();
      // A platform that suddenly returns nothing is more likely a hiccup than an empty market.
      if (!items.length && cache.byPlatform[p]?.length && attempt < 2) throw new Error('empty response');
      return items;
    } catch (e) {
      lastErr = e;
      await sleep(800 * (attempt + 1));
    }
  }
  throw lastErr;
}

// At most 3 platforms at a time; a failing platform falls back to its last good results.
// Career rewards a hackathon offers: PPI (pre-placement interview), PPO (pre-placement offer), internships, hiring.
export function careerPerks(text, flags = {}) {
  const t = String(text || '');
  const perks = [];
  if (flags.ppo || /\bppos?\b|pre[\s-]?placement\s*(offer|opportunit)|full[\s-]?time (job )?offers?|job offers?/i.test(t)) perks.push('PPO');
  if (flags.ppi || /\bppis?\b|pre[\s-]?placement\s*interviews?|(fast[\s-]?track(ed)?|direct) interviews?|interview opportunit/i.test(t)) perks.push('PPI');
  if (/internships?\s*(opportunit|offer|role|position)|paid internships?|intern(ship)? (offers?|roles?) (for|to) (the )?(winners?|top)|win (an )?internship|pre[\s-]?placement\s*internship/i.test(t)) perks.push('Internship');
  if (/hiring (challenge|hackathon|drive)|get hired|recruit(ment|ing) (drive|opportunit)|jobs? (opportunit|for (the )?winners)/i.test(t)) perks.push('Hiring');
  return perks;
}

// What a hackathon is about, from its title, tags and rewards: for filtering and for matching your skills.
const THEMES = [
  ['AI / ML', /\b(ai|a\.i\.|ml|machine learning|deep learning|llm|genai|generative|gpt|agents?|agentic|nlp|computer vision|data science|rag)\b/i],
  ['Web3', /web3|blockchain|crypto|ethereum|solana|defi|nft|dao|smart contract|polygon|bitcoin|\beth\b/i],
  ['FinTech', /fintech|finance|banking|payments?|trading|insurance|upi/i],
  ['Health', /health|medical|medtech|biotech|wellness|mental|healthcare/i],
  ['Climate', /climate|sustainab|green|energy|environment|carbon|agri|agriculture/i],
  ['Education', /education|edtech|e-?learning|\bschools?\b|teach(ers?|ing)|classroom/i],
  ['Security', /security|cyber|ctf|privacy|hacking/i],
  ['Cloud / DevOps', /cloud|devops|kubernetes|aws|azure|gcp|serverless|infra/i],
  ['Mobile / Web', /\b(web|mobile|android|ios|flutter|react|frontend|full[\s-]?stack|app)\b/i],
  ['Hardware / IoT', /hardware|iot|robotics|embedded|arduino|drone|space/i],
  ['Social good', /social|impact|community|ngo|accessibility|inclusion|civic|government|smart city/i],
  ['Gaming', /gaming|game|esports|metaverse|ar\b|vr\b|xr\b/i],
];
const themesOf = (h) => THEMES.filter(([, re]) => re.test(`${h.title} ${(h.tags || []).join(' ')} ${h.rewards || ''}`)).map(([name]) => name);

export async function listHackathons({ refresh = false } = {}) {
  if (!refresh && Date.now() - cache.at < TTL && cache.items.length) return cache;
  const results = [];
  const queue = [...PLATFORMS];
  await Promise.all(
    [0, 1, 2].map(async () => {
      while (queue.length) {
        const p = queue.shift();
        try {
          const items = (await fetchPlatform(p)).map((h) => ({ ...h, platform: p }));
          cache.byPlatform[p] = items;
          results.push([p, { ok: true, count: items.length }]);
        } catch (e) {
          const stale = cache.byPlatform[p] || [];
          results.push([p, { ok: false, error: String(e.message || e).slice(0, 120), stale: stale.length }]);
        }
      }
    }),
  );
  const now = Date.now();
  const seen = new Set();
  const items = PLATFORMS.flatMap((p) => cache.byPlatform[p] || [])
    .filter((h) => h.title && h.url)
    .filter((h) => !h.deadline || new Date(h.deadline) > now - 3600_000) // registration still open
    .filter((h) => {
      const k = h.title.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 40);
      return !seen.has(k) && seen.add(k);
    })
    .map((h) => ({ ...h, themes: themesOf(h), perks: [...new Set([...(h.perks || []), ...careerPerks(`${h.title} ${(h.tags || []).join(' ')} ${h.rewards || ''} ${h.prize || ''}`)])], id: `${h.platform}:${h.url}` }));
  cache = { at: now, items, sources: Object.fromEntries(results), byPlatform: cache.byPlatform };
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache));
  } catch {}
  return cache;
}
