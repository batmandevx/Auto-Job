// Is a job posting still open? Each link is opened (following redirects) and read for the signs boards use:
// 404 / 410, a redirect to the general listing (Greenhouse, zapply), "no longer accepting applications" text,
// and for Workday (whose pages are built by script) its JSON job API, which answers 404 once a job closes.
// Answers: 'open', 'closed', or 'unknown' (blocked, login wall, timeout): unknown jobs are never hidden.
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36';
const CLOSED_TEXT = /no longer (accepting|available|open|active)|(position|role|vacancy|job) has (already )?been filled|(this |the )?(job|posting|position|role|vacancy|opening|requisition) (has |is )?(now )?(expired|closed|been closed|been removed)|applications? (are|is|have) (now )?closed|not accepting (any )?(new )?applications|job not found|posting is closed/i;
// Only public web hosts: the panel decides which links get opened, never a page.
const PRIVATE = /^(localhost|0\.|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[)/i;
const TTL = 12 * 3600_000;
const cache = new Map(); // url -> { status, at }

const pathOf = (u) => u.pathname.replace(/\/+$/, '');

// https://T.wdN.myworkdayjobs.com/[en-US/]Site/job/Loc/Title_R123 -> https://T.wdN.myworkdayjobs.com/wday/cxs/T/Site/job/Loc/Title_R123
export function workdayApi(href) {
  const u = new URL(href);
  const m = u.hostname.match(/^([^.]+)\.wd\d+\.myworkdayjobs\.com$/);
  const parts = u.pathname.split('/').filter(Boolean);
  if (/^[a-z]{2}-[A-Z]{2}$/.test(parts[0] || '')) parts.shift();
  const at = parts.indexOf('job');
  if (!m || at !== 1) return null;
  return `${u.origin}/wday/cxs/${m[1]}/${parts.join('/')}`;
}

// The verdict from what the fetch saw (pure, so it is tested without the network).
export function verdict({ from, to, status, text = '' }) {
  if (status === 404 || status === 410) return 'closed';
  if (status >= 400) return 'unknown'; // 403 / 429 / 5xx: blocked or down, not proof of anything
  const a = new URL(from), b = new URL(to);
  if (/[?&]error=true\b/.test(b.search)) return 'closed'; // Greenhouse: closed job -> board?error=true
  const pa = pathOf(a), pb = pathOf(b);
  if (pa !== pb) {
    // Sent back to the listing: the target is the old path minus the job id, or a one-level page like /jobs.
    if ((a.hostname === b.hostname && pb.length < pa.length && pa.startsWith(pb)) || pb.split('/').filter(Boolean).length <= 1) return 'closed';
  }
  return CLOSED_TEXT.test(text.slice(0, 400_000)) ? 'closed' : 'open';
}

async function checkOne(url) {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < TTL) return hit.status;
  let status = 'unknown';
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol) || PRIVATE.test(u.hostname)) return 'unknown';
    // shortcut: only the first URL is checked against private hosts, not redirect targets; fine while only the extension can call this.
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html,application/json' }, redirect: 'follow', signal: AbortSignal.timeout(15000) });
    const api = res.ok && workdayApi(res.url);
    if (api) {
      const w = await fetch(api, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
      const info = w.ok ? (await w.json().catch(() => ({}))).jobPostingInfo : null;
      status = w.status === 404 ? 'closed' : !w.ok ? 'unknown' : info?.canApply === false ? 'closed' : 'open';
    } else {
      const html = /html|text/.test(res.headers.get('content-type') || '') ? await res.text() : '';
      // Visible words only: scripts and tags often carry template strings like "Job expired" for every job.
      const text = html.replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ');
      status = verdict({ from: url, to: res.url, status: res.status, text });
    }
  } catch {
    status = 'unknown';
  }
  if (status !== 'unknown') cache.set(url, { status, at: Date.now() }); // a slow or blocked site gets another try next time
  return status;
}

export async function checkJobs(urls) {
  const list = [...new Set(urls.filter((u) => typeof u === 'string'))].slice(0, 100);
  const out = {};
  const queue = [...list];
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (queue.length) {
      const u = queue.shift();
      out[u] = await checkOne(u);
    }
  }));
  return out;
}
