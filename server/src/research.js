import fs from 'node:fs';
import path from 'node:path';
import { chatJSON } from './llm.js';
import { RESEARCH_SYSTEM } from './prompts.js';
import { DATA_DIR } from './store.js';

// Company research before applying: Google-Search-grounded facts with their sources, cached for a week per company + role.
const DIR = path.join(DATA_DIR, 'research');
fs.mkdirSync(DIR, { recursive: true });
const WEEK = 7 * 24 * 3600_000;
const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
const ATS = /greenhouse|lever\.co|ashbyhq|myworkdayjobs|workday|smartrecruiters|icims|jobvite|bamboohr|recruitee|workable|linkedin|indeed|naukri|wellfound|glassdoor|google\.com|pyjamahr|recruitcrm|darwinbox|keka|zoho|freshteam/i;

const UA = { 'User-Agent': 'Mozilla/5.0 (Auto Job company research; local tool)' };
const get = (url, ms = 8000) => fetch(url, { signal: AbortSignal.timeout(ms), headers: UA }).then((r) => (r.ok ? r.text() : '')).catch(() => '');
const textOf = (html) => html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<noscript[\s\S]*?<\/noscript>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&amp;|&#\d+;|&[a-z]+;/g, ' ').replace(/\s+/g, ' ').trim();

// Wikipedia summary and the official website from Wikidata (P856), for a company name.
async function wiki(company) {
  const found = JSON.parse((await get(`https://www.wikidata.org/w/api.php?action=wbsearchentities&format=json&language=en&type=item&limit=5&search=${encodeURIComponent(company)}`)) || '{}').search || [];
  const hit = found.find((e) => /compan|corporation|business|startup|enterprise|bank|firm|platform|software|technolog|service|manufactur|retail|conglomerate/i.test(e.description || '')) || null;
  if (!hit) return {};
  const ent = JSON.parse((await get(`https://www.wikidata.org/wiki/Special:EntityData/${hit.id}.json`)) || '{}').entities?.[hit.id];
  const website = ent?.claims?.P856?.[0]?.mainsnak?.datavalue?.value;
  const title = ent?.sitelinks?.enwiki?.title;
  const summary = title ? JSON.parse((await get(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`)) || '{}') : {};
  return { website, wikipedia: summary.extract ? { title: `Wikipedia: ${title}`, url: summary.content_urls?.desktop?.page || `https://en.wikipedia.org/wiki/${encodeURIComponent(title)}`, text: summary.extract } : null };
}

// The company's own website: home page plus its about / careers / engineering pages (never an ATS or job board).
async function companySite(urls) {
  for (const u of urls) {
    let url;
    try {
      url = new URL(u);
    } catch {
      continue;
    }
    if (!/^https?:$/.test(url.protocol) || ATS.test(url.hostname)) continue;
    const html = await get(url.origin);
    const home = textOf(html);
    if (home.length < 200) continue;
    const pages = [{ title: `${url.hostname} (home page)`, url: url.origin, text: home.slice(0, 4000) }];
    const links = [...html.matchAll(/href=["']([^"'#]+)["']/gi)].map((m) => { try { return new URL(m[1], url.origin); } catch { return null; } })
      .filter((l) => l && l.hostname.replace(/^www\./, '') === url.hostname.replace(/^www\./, '') && /about|company|careers|culture|engineering|tech|blog|life/i.test(l.pathname));
    for (const l of [...new Map(links.map((l) => [l.pathname, l])).values()].slice(0, 3)) {
      const t = textOf(await get(l.href));
      if (t.length > 200) pages.push({ title: `${url.hostname}${l.pathname}`, url: l.href, text: t.slice(0, 3000) });
    }
    return pages;
  }
  return [];
}

// Recent headlines from Google News RSS (public feed): title, date, link.
async function news(company) {
  const xml = await get(`https://news.google.com/rss/search?q=${encodeURIComponent(`"${company}"`)}&hl=en-IN&gl=IN&ceid=IN:en`);
  const year = Date.now() - 365 * 24 * 3600_000;
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(([, it]) => ({
    title: (it.match(/<title>([\s\S]*?)<\/title>/) || [])[1]?.replace(/<!\[CDATA\[|\]\]>/g, '').trim(),
    url: (it.match(/<link>([\s\S]*?)<\/link>/) || [])[1]?.trim(),
    date: (it.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1]?.trim(),
  })).filter((n) => n.title && n.url && Date.parse(n.date) > year).slice(0, 8);
}

// Everything we could read, numbered, so every claim can point at a real source.
async function gatherSources(company, urls) {
  const w = await wiki(company);
  const site = await companySite([...urls, w.website].filter(Boolean));
  const headlines = await news(company);
  const sources = [...site, ...(w.wikipedia ? [w.wikipedia] : []), ...headlines.map((n) => ({ title: n.title, url: n.url, text: `${n.title} (${n.date})` }))];
  return sources.map((x, i) => ({ n: i + 1, ...x }));
}

const candidateSummary = (p) => ({
  headline: p.headline,
  experience: (p.experience || []).slice(0, 5).map((e) => ({ title: e.title, company: e.company, highlights: (e.bullets || []).slice(0, 2) })),
  projects: (p.projects || []).slice(0, 3).map((x) => ({ name: x.name, tech: x.tech })),
  skills: (p.skills || []).flatMap((g) => g.items).slice(0, 40),
  education: (p.education || []).slice(0, 1).map((e) => `${e.degree} ${e.field}`),
});

export async function researchCompany(job, profile, { refresh = false } = {}) {
  const company = String(job.company || '').trim();
  if (!company) throw new Error('No company name for this job: read the job first');
  const file = path.join(DIR, `${slug(company)}--${slug(job.title)}.json`);
  if (!refresh && fs.existsSync(file)) {
    const cached = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Date.now() - cached.at < WEEK) return { ...cached, cached: true };
  }
  const urls = [...new Set([...(job.links || []), ...(String(job.description || '').match(/https?:\/\/[^\s)"'<>]+/g) || []), job.url].filter(Boolean))];
  const gathered = await gatherSources(company, urls);
  const input = {
    COMPANY: company,
    JOB: { title: job.title, location: job.location, description: String(job.description || '').slice(0, 6000) },
    SOURCES: gathered.map(({ n, title, url, text }) => ({ n, title, url, text })),
    CANDIDATE: candidateSummary(profile),
    TODAY: new Date().toISOString().slice(0, 10),
  };
  // Google Search grounding when the key allows it (paid keys); otherwise the sources we read ourselves.
  let out;
  let searched = false;
  try {
    out = await chatJSON(RESEARCH_SYSTEM, JSON.stringify(input), { search: true, temperature: 0.2, budgetMs: 60000 });
    searched = true;
  } catch {
    if (!gathered.length) throw new Error(`Couldn't find anything about ${company} to research from (no website, Wikipedia page or news)`);
    out = await chatJSON(RESEARCH_SYSTEM, JSON.stringify(input), { temperature: 0.2, heavy: true });
  }
  const arr = (x) => (Array.isArray(x) ? x.filter(Boolean) : []);
  const used = new Set(arr(out.usedSources).map(Number));
  const sources = [...gathered.filter((g) => !used.size || used.has(g.n)).map(({ title, url }) => ({ title, url })), ...arr(out._sources)];
  const result = {
    at: Date.now(),
    company,
    role: job.title || '',
    snapshot: out.snapshot || {},
    stack: arr(out.stack).slice(0, 20),
    culture: arr(out.culture).slice(0, 6),
    news: arr(out.news).slice(0, 6),
    team: out.team || '',
    interview: out.interview || {},
    redFlags: arr(out.redFlags).slice(0, 5),
    fit: { strengths: arr(out.fit?.strengths).slice(0, 5), gaps: arr(out.fit?.gaps).slice(0, 5) },
    strategy: out.strategy || {},
    confidence: out.confidence || (sources.length > 3 ? 'medium' : 'low'),
    method: searched ? 'Google Search + company sources' : 'company website, Wikipedia and news',
    sources: [...new Map(sources.map((s) => [s.url, s])).values()].slice(0, 12),
  };
  fs.writeFileSync(file, JSON.stringify(result, null, 2));
  return result;
}

// What the cover letter may use: only the facts we found with sources.
export function researchFor(job) {
  try {
    const file = path.join(DIR, `${slug(job.company)}--${slug(job.title)}.json`);
    if (!fs.existsSync(file)) return null;
    const r = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Date.now() - r.at > WEEK || !r.sources?.length) return null;
    return { what: r.snapshot?.what, products: r.snapshot?.products, recentNews: r.news?.slice(0, 2), stack: r.stack?.slice(0, 8), hook: r.strategy?.coverLetterHook, angle: r.strategy?.angle };
  } catch {
    return null;
  }
}
