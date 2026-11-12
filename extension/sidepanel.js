const $ = (s) => document.querySelector(s);
const state = { job: null, resume: null, cover: null, queue: [], queueIdx: -1, boardJobs: [], log: [], running: false };
let SERVER = 'http://localhost:8787';
const MAX_PAGES = 15;

const ANSWER_LABELS = {
  workAuthorization: 'Work authorization',
  needsSponsorship: 'Need visa sponsorship?',
  willingToRelocate: 'Willing to relocate? (Yes / No / Depends)',
  noticePeriod: 'Notice period / availability (e.g. "Immediate", "30 days")',
  earliestStartDate: 'Earliest start date',
  yearsOfExperience: 'Years of experience (e.g. "1.5 years incl. internships")',
  currentlyEmployed: 'Currently employed? (e.g. "No, last internship ended Jul 2026")',
  currentSalary: 'Current salary / CTC',
  expectedSalary: 'Expected salary / CTC (e.g. "₹18 LPA")',
  currentLocation: 'Current location (City, State, Country)',
  gender: 'Gender (EEO)',
  race: 'Race / ethnicity (EEO)',
  veteranStatus: 'Veteran status (EEO)',
  disabilityStatus: 'Disability status (EEO)',
  howDidYouHear: 'How did you hear about us?',
  jobTypes: 'Job types (full-time / internship)',
  workMode: 'Work mode (onsite / hybrid / remote)',
  targetRoles: 'Target roles (also the default Job board filter)',
  availability: 'Availability / commitment (e.g. Full time, 40 hrs/week)',
  timezone: 'Timezone (e.g. Asia/Kolkata / IST)',
  overlapPst: 'Can overlap required PST hours? (Yes / No)',
  hourlyRate: 'Hourly rate in USD',
  employmentType: 'Employment type (full-time / contractor / freelance)',
  firstLocationPreference: 'First location preference',
  secondLocationPreference: 'Second location preference',
  thirdLocationPreference: 'Third location preference',
  cgpaScale: 'CGPA scale (out of 4 / 5 / 8 / 10 / 100)',
  currentCGPA: 'Current CGPA',
  activeBacklogs: 'Active arrears / backlogs? (Yes / No)',
  computerScienceFundamentals: 'Know computer science fundamentals? (Yes / No)',
  governmentEmployee: 'Government employee (you or family)?',
  extra: 'Anything else the AI should know',
};
const PERSONAL_LABELS = {
  dateOfBirth: 'Date of birth (YYYY-MM-DD)',
  gender: 'Gender',
  nationality: 'Nationality',
  fatherName: "Father's / guardian's name",
  motherName: "Mother's name",
  addressLine1: 'Address line 1',
  addressLine2: 'Address line 2',
  city: 'City',
  state: 'State',
  postalCode: 'PIN / postal code',
  country: 'Country',
  currentAddressLine1: 'Current address (if different: hostel, PG, flat)',
  currentCity: 'Current city',
  currentState: 'Current state',
  currentPostalCode: 'Current PIN / postal code',
  graduationYear: 'Graduation year',
  graduationDate: 'Graduation month (e.g. May 2027)',
  placeOfBirth: 'Place of birth',
  languages: 'Languages you speak',
  pronouns: 'Pronouns',
  maritalStatus: 'Marital status',
};

// ---------- helpers ----------
function toast(msg, bad = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `show${bad ? ' bad' : ''}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.className = ''), bad ? 7000 : 2500);
}

// Every request has a time limit, so a slow AI or network shows an error instead of an endless spinner.
const API_TIMEOUTS = [[/^\/api\/profile\/import/, 300000], [/^\/api\/(tailor|cover-letter)/, 180000], [/^\/api\/otp/, 200000], [/^\/api\/(email|answer)/, 100000], [/^\/api\/(hackathons|export)/, 90000], [/^\/api\/jobs\/check/, 200000]];
async function api(path, opts = {}) {
  const ms = API_TIMEOUTS.find(([re]) => re.test(path))?.[1] || 30000;
  const res = await fetch(SERVER + path, {
    ...opts,
    signal: AbortSignal.timeout(ms),
    headers: opts.body instanceof FormData ? {} : { 'Content-Type': 'application/json' },
    body: opts.body instanceof FormData ? opts.body : opts.body && JSON.stringify(opts.body),
  }).catch((e) => {
    if (e.name === 'TimeoutError') throw new Error(`The server took over ${Math.round(ms / 1000)}s on this step. Try again, or check the server window.`);
    throw new Error('Server offline. Run "npm start" in the server folder.');
  });
  if (opts.raw && res.ok) return res.blob();
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Server error ${res.status}`);
  return data;
}

function busy(btn, fn) {
  return async (...a) => {
    btn.disabled = true;
    btn.classList.add('loading');
    try {
      return await fn(...a);
    } catch (e) {
      toast(e.message, true);
      progress(e.message, 'bad');
      stepError();
      throw e;
    } finally {
      btn.disabled = false;
      btn.classList.remove('loading');
    }
  };
}
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
// Links and images from job boards / APIs: only plain http(s) URLs get into the panel.
const safeUrl = (u) => (/^https?:\/\/[^\s"'<>]+$/i.test(String(u || '')) ? String(u) : '#');
const safeImg = (u) => (/^https:\/\/[^\s"'()<>]+$/i.test(String(u || '')) ? String(u) : '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Stepper: job → resume → fill → review. Earlier steps turn "done", the given one "active".
const STEPS = ['job', 'resume', 'fill', 'review'];
function setStep(name, done = false) {
  const at = STEPS.indexOf(name);
  document.querySelectorAll('#stepper li').forEach((li, i) => {
    li.classList.remove('active', 'error');
    li.classList.toggle('done', i < at || (i === at && done));
    if (i === at && !done) li.classList.add('active');
  });
}
const resetSteps = () => document.querySelectorAll('#stepper li').forEach((li) => li.classList.remove('active', 'done', 'error'));
const stepError = () => document.querySelector('#stepper li.active')?.classList.replace('active', 'error');

function scoreRing(score) {
  const pct = Math.max(0, Math.min(100, Number(score) || 0));
  return `<div class="ring"><svg viewBox="0 0 64 64"><defs><linearGradient id="ringGrad" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="var(--accent)"/><stop offset="1" stop-color="var(--accent2)"/></linearGradient></defs>
    <circle class="bg" cx="32" cy="32" r="26"/><circle class="fg" cx="32" cy="32" r="26" data-pct="${pct}"/></svg><div class="val">${score ?? '–'}</div></div>`;
}
// Animate rings after they are in the DOM.
const animateRings = () => requestAnimationFrame(() => document.querySelectorAll('.ring .fg').forEach((c) => (c.style.strokeDashoffset = 163.4 * (1 - c.dataset.pct / 100))));
// Keyword coverage: what the job asks for vs. what your resume now shows.
function keywordBlock(k) {
  if (!k?.total) return '';
  const gaps = k.gapFilled || [];
  const pct = Math.round(((k.covered.length + gaps.length) / k.total) * 100);
  return `<div class="kw">
    <div class="row between" style="margin:8px 0 4px"><b>Job keywords in your resume</b><span class="kw-num">${k.covered.length + gaps.length}/${k.total} · ${pct}%</span></div>
    <div class="meter"><i style="--w:${pct}%"></i></div>
    <div class="chips">${k.covered.map((x, i) => `<span class="chip ok" style="animation-delay:${i * 25}ms">✓ ${esc(x)}</span>`).join('')}</div>
    ${gaps.length ? `<div class="hint" style="margin-top:8px">On your “Familiar with / learning” line (be ready to talk about these):</div>
    <div class="chips">${gaps.map((x, i) => `<button class="chip learn" data-skill="${esc(x)}" title="Tap if you've really used it: moves it into your skills" style="animation-delay:${i * 25}ms">◐ ${esc(x)}</button>`).join('')}</div>` : ''}
    ${k.missing.length ? `<div class="hint" style="margin-top:8px">Not in your profile, so not added. Tap one you really have:</div>
    <div class="chips">${k.missing.map((x, i) => `<button class="chip miss" data-skill="${esc(x)}" style="animation-delay:${i * 25}ms">+ ${esc(x)}</button>`).join('')}</div>` : ''}
  </div>`;
}

const docLink = (b64, name, label) => `<a class="doc-link" href="${b64ToBlobUrl(b64, 'application/pdf')}" target="_blank">📄 ${esc(label || name)}</a>`;
const b64ToBlobUrl = (b64, type) => URL.createObjectURL(new Blob([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], { type }));

function progress(msg, cls = 'on') {
  const p = $('#progress');
  p.querySelectorAll('.step.on').forEach((s) => s.classList.remove('on'));
  p.insertAdjacentHTML('beforeend', `<div class="step ${cls}">${esc(msg)}</div>`);
  while (p.children.length > 8) p.firstChild.remove();
}

// The page you're working on: the active tab of your last-used browser window. (In window mode, e.g. in Arc,
// "current window" would be the Auto Job window itself.)
async function browserTab() {
  const win = await chrome.windows.getLastFocused({ windowTypes: ['normal'] }).catch(() => null);
  const [tab] = await chrome.tabs.query(win ? { active: true, windowId: win.id } : { active: true, lastFocusedWindow: true });
  if (tab && /^https?:/.test(tab.url || '')) return tab;
  // Opened as a tab (e.g. Arc Split View) or window: the "active tab" is Auto Job itself,
  // so use the last real web page you were on.
  const last = await chrome.runtime.sendMessage({ type: 'last-web-tab' }).catch(() => null);
  if (last?.id) {
    const t = await chrome.tabs.get(last.id).catch(() => null);
    if (t && /^https?:/.test(t.url || '')) return t;
  }
  // Fallback: the most recently used web tab in any window.
  const all = (await chrome.tabs.query({})).filter((t) => /^https?:/.test(t.url || ''));
  return all.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0] || tab;
}

async function activeTab() {
  const tab = await browserTab();
  if (!tab || !/^https?:/.test(tab.url || '')) throw new Error('Open a job page (http/https) in this tab first');
  return tab;
}

async function inject(tabId) {
  await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['content.js'] }).catch(() => {});
}

// Run a __jobfill method in every frame (job forms are often inside iframes, e.g. Greenhouse embeds).
async function callAll(tabId, method, ...args) {
  await inject(tabId);
  const res = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: (m, a) => window.__jobfill?.[m]?.(...a),
    args: [method, args],
  });
  return res.filter((r) => r.result != null);
}

async function callFrame(tabId, frameId, method, ...args) {
  const [r] = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [frameId] },
    func: (m, a) => window.__jobfill?.[m]?.(...a),
    args: [method, args],
  });
  return r?.result;
}

function waitForLoad(tabId, timeout = 15000) {
  return new Promise((resolve) => {
    const done = () => {
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      setTimeout(resolve, 1500); // let SPAs render after "complete"
    };
    const listener = (id, info) => id === tabId && info.status === 'complete' && done();
    const timer = setTimeout(done, timeout);
    chrome.tabs.onUpdated.addListener(listener);
  });
}

// After clicking Next: wait until the form step actually changes (SPA re-render or full navigation).
async function waitForNewStep(tabId, before, timeout = 12000) {
  const end = Date.now() + timeout;
  await sleep(800);
  while (Date.now() < end) {
    try {
      const keys = (await callAll(tabId, 'pageKey')).map((r) => r.result).join('||');
      if (keys && keys !== before) {
        await sleep(900); // let the new step finish rendering
        return true;
      }
    } catch {
      // mid-navigation: the frame is gone for a moment
    }
    await sleep(500);
  }
  return false;
}
const pageKeys = async (tabId) => (await callAll(tabId, 'pageKey')).map((r) => r.result).join('||');

// ---------- 1. job ----------
async function readJob() {
  const tab = await activeTab();
  const frames = await callAll(tab.id, 'extractJob');
  const best = frames.map((f) => f.result).sort((a, b) => (b.source === 'json-ld') - (a.source === 'json-ld') || b.description.length - a.description.length)[0];
  if (!best) throw new Error('Could not read this page');
  state.job = best;
  $('#jobTitle').value = best.title;
  $('#jobCompany').value = best.company;
  $('#jobLocation').value = best.location || '';
  $('#jobDesc').value = best.description;
  $('#jobMeta').textContent = [best.company, best.title].filter(Boolean).join(' · ');
  showEmails(frames.flatMap((f) => f.result.emails || []).filter((e, i, a) => a.indexOf(e) === i));
  setStep('job', true);
  warnIfTracked(best);
  return best;
}

// Applying twice to the same job looks careless to recruiters: say so when this one is already in the tracker.
async function warnIfTracked(job) {
  const apps = state.apps.length ? state.apps : (await api('/api/applications').catch(() => ({}))).items || [];
  const key = (a) => `${a.company || ''}|${a.title || ''}`.toLowerCase().trim();
  const page = (u) => String(u || '').split('#')[0];
  const dup = apps.find((a) => a.status !== 'saved' && ((a.url && page(a.url) === page(job.url)) || (a.company && a.title && key(a) === key(job))));
  if (dup) toast(`Already in your tracker: ${STATUS[dup.status]?.label || dup.status}${dup.appliedAt ? `, ${ago(dup.appliedAt)}` : ''}`, true);
}

const currentJob = () => ({
  title: $('#jobTitle').value.trim(),
  company: $('#jobCompany').value.trim(),
  location: $('#jobLocation').value.trim(),
  description: $('#jobDesc').value.trim(),
  url: state.job?.url,
});
const jobKey = () => `${currentJob().company}|${currentJob().title}|${currentJob().description.length}`;

// ---------- company research ----------
async function research({ refresh = false } = {}) {
  const job = currentJob();
  if (!job.company) throw new Error('Read the job first (no company name yet)');
  $('#researchOut').innerHTML = `<p class="hint">Researching ${esc(job.company)}: website, Wikipedia, recent news…</p>`;
  const tab = await activeTab().catch(() => null);
  const links = tab ? (await callAll(tab.id, 'pageLinks').catch(() => [])).flatMap((f) => f.result || []) : [];
  const r = await api('/api/research', { method: 'POST', body: { ...job, links, refresh } });
  state.research = r;
  renderResearch(r);
  return r;
}
function renderResearch(r) {
  const chips = (xs) => (xs || []).map((x) => `<span class="chip">${esc(x)}</span>`).join(' ');
  const list = (xs) => (xs?.length ? `<ul>${xs.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : '');
  const sec = (title, body) => (body ? `<div class="r-sec"><b>${title}</b>${body}</div>` : '');
  const s = r.snapshot || {};
  const age = Math.round((Date.now() - r.at) / 3600_000);
  $('#researchMeta').textContent = `${r.company} · ${r.confidence} confidence`;
  $('#researchOut').innerHTML = `<div class="research">
    <p>${esc(s.what || '')}${s.stage || s.hq ? `<span class="src">${esc([s.stage, s.hq].filter(Boolean).join(' · '))}</span>` : ''}</p>
    ${sec('Products', s.products?.length ? `<div>${chips(s.products)}</div>` : '')}
    ${sec('Customers', s.customers ? `<p>${esc(s.customers)}</p>` : '')}
    ${sec('Engineering stack', r.stack?.length ? `<div>${chips(r.stack)}</div>` : '')}
    ${sec('Recent news', r.news?.length ? `<ul>${r.news.map((n) => `<li>${esc(n.headline)}${n.date ? ` <span class="src">${esc(n.date)}</span>` : ''}</li>`).join('')}</ul>` : '')}
    ${sec('Culture', list(r.culture))}
    ${sec('The team', r.team ? `<p>${esc(r.team)}</p>` : '')}
    ${sec('Interview', r.interview?.process || r.interview?.focus?.length ? `<p>${esc(r.interview.process || '')}</p>${r.interview.focus?.length ? `<div>${chips(r.interview.focus)}</div>` : ''}` : '')}
    ${sec('⚠️ Red flags', r.redFlags?.length ? `<ul>${r.redFlags.map((f) => `<li class="bad-text">${esc(f.flag)}${f.evidence ? ` <span class="src">${esc(f.evidence)}</span>` : ''}</li>`).join('')}</ul>` : '<p class="hint">None found in these sources.</p>')}
    ${sec('Your fit', `${r.fit?.strengths?.length ? `<p class="good-text">✓ ${r.fit.strengths.map(esc).join('<br>✓ ')}</p>` : ''}${r.fit?.gaps?.length ? `<p class="warn-text">△ ${r.fit.gaps.map(esc).join('<br>△ ')}</p>` : ''}`)}
    ${sec('Your angle', r.strategy?.angle ? `<p><i>${esc(r.strategy.angle)}</i></p>${list(r.strategy.talkingPoints)}` : '')}
    ${sec('Questions to ask them', list(r.strategy?.questionsToAsk))}
    ${sec(`Sources (${r.sources?.length || 0})`, r.sources?.length ? `<ol class="sources">${r.sources.map((x) => `<li><a href="${esc(safeUrl(x.url))}" target="_blank">${esc(x.title || x.url)}</a></li>`).join('')}</ol>` : '<p class="hint">No sources found: treat this as unverified.</p>')}
    <p class="hint">${esc(r.method || '')}${r.cached ? ` · saved ${age < 1 ? 'just now' : `${age} h ago`}` : ''} · the cover letter uses these facts</p>
  </div>`;
}

// ---------- 2. resume & cover letter ----------
async function tailor() {
  if (currentJob().description.length < 80) await readJob();
  progress('Tailoring your resume to this job…');
  setStep('resume');
  const out = await api('/api/tailor', { method: 'POST', body: { ...currentJob(), fillGaps: $('#fillGaps').checked } });
  state.resume = { ...out, key: jobKey() };
  $('#tailorOut').innerHTML = `
    <div class="score-card">${scoreRing(out.matchScore)}<div><b>Match with this job</b><div class="hint">one-page resume, built from your real experience</div>${docLink(out.pdfBase64, out.filename, 'Open tailored resume')}</div></div>
    ${out.ats ? `<div class="hint">${out.ats.ok ? '✅ ATS check passed: a parser reads the PDF cleanly — contact details and ' + out.ats.chars + ' characters of text extract properly' : `⚠️ ATS check: ${out.ats.problems.map(esc).join(' · ')}`}</div>` : ''}
    ${keywordBlock(out.keywords)}
    <details><summary class="hint">What changed (${out.changes.length})</summary><ul>${out.changes.map((c) => `<li>${esc(c)}</li>`).join('')}</ul></details>`;
  animateRings();
  $('#resumeMeta').textContent = out.matchScore != null ? `${out.matchScore}% match` : 'ready';
  return out;
}
const ensureResume = async () => (state.resume?.key === jobKey() ? state.resume : tailor());

async function coverLetter() {
  if (currentJob().description.length < 80) await readJob();
  progress('Writing a cover letter for this job…');
  const keywords = state.resume?.key === jobKey() ? state.resume.keywords?.covered : undefined;
  const out = await api('/api/cover-letter', { method: 'POST', body: { ...currentJob(), keywords } });
  state.cover = { ...out, key: jobKey() };
  $('#coverOut').innerHTML = `<div class="row between"><b>Cover letter</b>${docLink(out.pdfBase64, out.filename, 'Open PDF')}</div>
    ${out.keywordsUsed?.length ? `<div class="hint">Uses ${out.keywordsUsed.length} job keywords: ${out.keywordsUsed.map(esc).join(', ')}</div>` : ''}
    <div class="letter">${esc(out.text)}</div>`;
  return out;
}
const ensureCover = async () => (state.cover?.key === jobKey() ? state.cover : coverLetter());

// ---------- 3. fill ----------
const COVER_RE = /cover\s*letter|letter\s*of\s*(motivation|interest)|motivation\s*letter/i;
const OTP_RE = /\botp\b|one[-\s]?time\s*(pass|code)|verification\s*code|security\s*code|passcode|confirmation\s*code|enter (the |your )?code|access\s*code|email\s*code/i;
const ATS_HOSTS = /greenhouse\.io|lever\.co|ashbyhq\.com|myworkdayjobs\.com|myworkday\.com|workable\.com|smartrecruiters\.com|icims\.com|jobvite\.com|successfactors\.|taleo\.net|bamboohr\.com|recruitee\.com|naukri\.com|instahyre\.com|wellfound\.com/i;
const siteHint = (url) => `${currentJob().company} ${new URL(url).hostname.replace(/^www\./, '')}`;

// Only follow emailed links that belong to the job site, the company, or a known applicant-tracking system.
function trustedLink(link, pageUrl) {
  try {
    const host = new URL(link).hostname;
    const page = new URL(pageUrl).hostname;
    const base = (h) => h.split('.').slice(-2).join('.');
    const company = currentJob().company.toLowerCase().replace(/[^a-z0-9]/g, '');
    return base(host) === base(page) || ATS_HOSTS.test(host) || (company.length > 2 && host.replace(/[^a-z0-9]/g, '').includes(company));
  } catch {
    return false;
  }
}

// Wait for a code from Gmail and type it in.
async function fillCodes(tab, otpFields) {
  progress('Waiting for the verification code in Gmail (up to 2 min)…');
  const hit = await api(`/api/otp?since=${state.startedAt}&hint=${encodeURIComponent(siteHint(tab.url))}&want=code&wait=120`).catch((e) => ({ error: e.message }));
  const rows = [];
  let typed = false;
  // The split-box widget first; a plain "or paste the code" box only if that didn't take.
  const ordered = [...otpFields].sort((a, b) => (b.type === 'otp-split') - (a.type === 'otp-split'));
  for (const f of ordered) {
    if (typed) break;
    let tag;
    if (hit?.code) {
      const [frameId, id] = f.id.split(/:(.*)/);
      const r = (await callFrame(tab.id, Number(frameId), 'fill', { [id]: hit.code }, [])) || {};
      typed = r[id] === 'filled';
      tag = typed
        ? `<span class="tag done">typed ${esc(hit.code)}</span> <span class="src">from “${esc(hit.subject.slice(0, 50))}”</span>`
        : `<span class="tag err">${esc(r[id] || 'could not type the code')}</span>`;
    } else tag = `<span class="tag review">${esc(hit?.error || 'no code email arrived yet')}</span>`;
    rows.push(`<div class="item ${typed ? '' : 'bad'}"><div class="q">🔑 ${esc(f.label.slice(0, 80))}</div><div class="v">${tag}</div></div>`);
  }
  // Whatever happened, show the code big with a Copy button so you can type it in one go.
  if (hit?.code) {
    rows.push(`<div class="code-box ${typed ? '' : 'need'}"><span class="code-digits">${esc(hit.code)}</span><button class="btn ghost sm" data-copy="${esc(hit.code)}">Copy</button><span class="hint">${typed ? 'Typed into the page.' : 'Type or paste this into the code boxes, then press Continue.'}</span></div>`);
    if (!typed) progress(`Couldn't type the code: it's ${hit.code}. Type it, then press Continue`, 'bad');
  }
  return { rows, ok: typed };
}
function fileKind(f, fileCount) {
  const l = `${f.label} ${f.name}`.toLowerCase();
  if (COVER_RE.test(l)) return 'cover';
  if (/signature/.test(l)) return 'signature';
  // Your saved documents (Profile → Documents).
  if (/marks?\s*sheet|mark\s*list|grade\s*sheet|report\s*card/.test(l) && /\b(10th|tenth|ssc|class\s*(x|10)\b|matric|secondary)/.test(l) && !/senior|higher/.test(l)) return 'marksheet10';
  if (/marks?\s*sheet|mark\s*list|grade\s*sheet/.test(l) && /\b(12th|twelfth|hsc|class\s*(xii|12)\b|intermediate|senior secondary|higher secondary|puc)/.test(l)) return 'marksheet12';
  if (/photo|picture|headshot|passport\s*-?\s*size|profile\s*image|your\s*image/.test(l) && !/photo\s*id|id\s*-?\s*proof|identity/.test(l)) return 'photo';
  if (/\bpan\b|pan\s*card|permanent account/.test(l) && !/aadhaa?r|address/.test(l)) return 'panCard';
  if (/id\s*-?\s*proof|identity|aadhaa?r|passport\b(?!\s*-?\s*size)|government id|photo id/.test(l)) return 'idProof';
  if (/address\s*proof|proof of address|residence proof|utility bill/.test(l)) return 'addressProof';
  if (/degree\s*certificate|provisional|graduation certificate|convocation/.test(l)) return 'degree';
  if (/transcript|consolidated mark|semester mark|grade card|cgpa (proof|certificate)/.test(l)) return 'transcript';
  if (/photo|picture|headshot|passport\s*size|profile\s*image|your\s*image/.test(l)) return 'photo';
  if (/resume|résumé|\bcv\b|curriculum/.test(l)) return 'resume';
  if (/transcript|marksheet|certificate|id\s*proof|aadha?ar|\bpan\b|passport|portfolio|work\s*sample|other/.test(l)) return 'other';
  return fileCount === 1 && !/image/.test(f.accept) ? 'resume' : 'other';
}

async function uploadFor(kind) {
  if (kind === 'resume') {
    const r = await ensureResume();
    return { base64: r.pdfBase64, filename: r.filename, mime: 'application/pdf' };
  }
  if (kind === 'cover') {
    if (!$('#autoCover').checked) return null;
    const c = await ensureCover();
    return { base64: c.pdfBase64, filename: c.filename, mime: 'application/pdf' };
  }
  if (['photo', 'signature', 'marksheet10', 'marksheet12', 'idProof', 'addressProof', 'panCard', 'degree', 'transcript'].includes(kind)) return api(`/api/documents/${kind}`).catch(() => null);
  return null;
}

// Sites that open an editor box per entry (fields + Cancel / "Add Language"): onEditor fills it and presses its button.
async function addSectionEntries(tab, onEditor) {
  const p = state.profile || {};
  const languages = String(p.personal?.languages || '').split(/\s*[,;/]\s*|\s+and\s+/i).filter(Boolean);
  const targets = { experience: Math.min(3, p.experience?.length || 0), education: Math.min(1, p.education?.length || 0), languages: Math.min(4, languages.length) };
  for (const [kind, want] of Object.entries(targets)) {
    for (let k = 0; k < want; k++) {
      const have = (await callAll(tab.id, 'sectionEntries', kind)).reduce((n, f) => n + (f.result || 0), 0);
      if (have >= want) break;
      const frames = await callAll(tab.id, 'addEntry', kind);
      const hit = frames.find((f) => f.result?.ok);
      if (!hit) break;
      progress(`Added a ${kind} entry (“${hit.result.label}”)`);
      if (hit.result.editor && onEditor) await onEditor(kind, have + 1, hit.frameId);
    }
  }
}

// "Phone *" / "Phone✱": the panel adds its own star for required fields.
const starless = (l) => String(l).replace(/\s*[*✱]+\s*$/, '');

// Upload the documents a page asks for (resume, cover letter, ID…), adding a result row for each.
async function uploadFiles(tab, files, rows, missingRequired) {
  const used = new Set();
  for (const f of files) {
    const kind = fileKind(f, files.length);
    // One copy of each document per page: two optional "Additional document" boxes don't both get the cover letter.
    if (used.has(kind) && kind !== 'other' && !f.required) {
      rows.push(`<div class="item"><div class="q">📎 ${esc(starless(f.label).slice(0, 100))} <span class="src">${kind}</span></div><div class="v"><span class="tag review">left empty</span> already attached above</div></div>`);
      continue;
    }
    used.add(kind);
    const doc = await uploadFor(kind).catch((e) => ({ error: e.message }));
    let tag;
    // Already there from an earlier pass (the site lists it beside the box): uploading again would add a duplicate.
    if (doc?.filename && (f.uploaded || []).some((n) => n.toLowerCase() === doc.filename.toLowerCase())) {
      rows.push(`<div class="item" style="--i:${rows.length}"><div class="q">📎 ${esc(starless(f.label).slice(0, 100))} <span class="src">${kind}</span></div><div class="v"><span class="tag done">already uploaded</span> ${esc(doc.filename)}</div></div>`);
      continue;
    }
    if (doc?.base64) {
      const r = await callFrame(tab.id, f.frameId, 'uploadFile', f.id, doc.base64, doc.filename, doc.mime);
      tag = r?.ok ? `<span class="tag done">uploaded</span> ${esc(doc.filename)}` : `<span class="tag err">${esc(r?.reason || 'upload failed')}</span>`;
    } else {
      tag = `<span class="tag review">${kind === 'other' ? 'upload it yourself' : doc?.error ? esc(doc.error) : `add your ${DOC_NAMES[kind] || kind} in Profile → Documents`}</span>`;
      if (f.required) missingRequired.push(f.label);
    }
    rows.push(`<div class="item ${doc?.base64 ? '' : f.required ? 'bad' : 'warn'}" style="--i:${rows.length}"><div class="q">📎 ${esc(starless(f.label).slice(0, 100))}${f.required ? ' *' : ''} <span class="src">${kind}</span></div><div class="v">${tag}</div></div>`);
  }
}

// Fill everything visible on the current step. Repeats when answers reveal follow-up questions.
async function fillPage(pageNo = 1) {
  const tab = await activeTab();
  const attempted = new Set();
  const rows = [];
  const failed = [];
  let missingRequired = [];
  let last = null;

  const filledValues = {}; // frameId -> { fieldId: value } we set, re-checked at the end
  const labelOf = {};
  let entryHint = null; // { section, entry } while filling one editor box ("Languages", entry 2)
  const fillRounds = async () => {
  for (let round = 0; round < 4; round++) {
    await callAll(tab.id, 'waitStable').catch(() => {}); // fields that load in stages
    const scans = await callAll(tab.id, 'scan');
    last = scans;
    let fields = [];
    const files = [];
    for (const { frameId, result } of scans) {
      for (const f of result.fields) {
        const key = `${frameId}:${f.id}`;
        if (attempted.has(key)) continue;
        if (f.type === 'file') {
          if (!f.filled) files.push({ ...f, key, frameId });
          continue;
        }
        if (f.type === 'captcha') continue; // you type CAPTCHAs; never guessed
        if ($('#onlyEmpty').checked && f.filled) continue;
        fields.push({ ...f, id: key, label: f.label.slice(0, 300), ...(entryHint && f.inEditor && !f.entry ? entryHint : {}) });
      }
    }
    const otpFields = fields.filter((f) => f.type === 'otp-split' || (OTP_RE.test(f.label) && ['text', 'tel', 'number', 'combobox'].includes(f.type)));
    fields = fields.filter((f) => !otpFields.includes(f));
    if (!fields.length && !files.length && !otpFields.length) break;

    // Uploads first: some sites (PyjamaHR…) read the resume and rewrite the form, wiping answers typed before it.
    if (files.length) {
      progress(`Page ${pageNo}: uploading ${files.length} file${files.length === 1 ? '' : 's'}…`);
      files.forEach((f) => attempted.add(f.key));
      await uploadFiles(tab, files, rows, missingRequired);
      await callAll(tab.id, 'waitStable').catch(() => {});
      await sleep(800);
      continue; // rescan: the upload may have changed the fields
    }
    progress(`Page ${pageNo}: filling ${fields.length} field${fields.length === 1 ? '' : 's'}${files.length ? ` + ${files.length} upload${files.length === 1 ? '' : 's'}` : ''}…`);
    fields.forEach((f) => { attempted.add(f.id); labelOf[f.id] = f.label; });
    otpFields.forEach((f) => attempted.add(f.id));

    const wantsCoverText = $('#autoCover').checked && fields.some((f) => COVER_RE.test(f.label) && ['textarea', 'text'].includes(f.type));
    const cover = wantsCoverText ? await ensureCover() : state.cover?.key === jobKey() ? state.cover : null;

    const { values, needsReview, source, aiError } = fields.length
      ? await api('/api/answer', { method: 'POST', body: { fields, job: currentJob(), coverLetter: cover?.text } })
      : { values: {}, needsReview: [], source: {} };
    if (aiError) progress(`AI unavailable (${aiError.slice(0, 60)}): filled what your profile knows, please fill the rest`, 'bad');

    const results = {};
    const byFrame = {};
    for (const [key, v] of Object.entries(values)) {
      const [frameId, id] = key.split(/:(.*)/);
      (byFrame[frameId] ||= {})[id] = v;
    }
    for (const [frameId, vals] of Object.entries(byFrame)) {
      const review = needsReview.filter((k) => k.startsWith(`${frameId}:`)).map((k) => k.split(/:(.*)/)[1]);
      const r = (await callFrame(tab.id, Number(frameId), 'fill', vals, review)) || {};
      for (const [id, status] of Object.entries(r)) {
        results[`${frameId}:${id}`] = status;
        if (status === 'filled') (filledValues[frameId] ||= {})[id] = vals[id];
      }
    }

    for (const f of fields) {
      const v = values[f.id];
      const status = results[f.id];
      const empty = v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length); // null: left empty on purpose
      if (empty && f.required) missingRequired.push(f.label);
      if (!empty && status && status !== 'filled') failed.push({ key: f.id, label: f.label, value: Array.isArray(v) ? v.join(', ') : String(v), error: status, required: f.required });
      const tag =
        status && status !== 'filled' ? `<span class="tag err">${esc(status)}</span>`
        : needsReview.includes(f.id) ? '<span class="tag review">check</span>'
        : !empty ? '<span class="tag done">filled</span>'
        : `<span class="tag review">${f.required ? 'required: fill it' : 'left empty'}</span>`;
      const src = source?.[f.id] ? `<span class="src">${{ profile: 'from profile', memory: 'remembered', ai: 'AI', 'cover-letter': 'cover letter' }[source[f.id]] || ''}</span>` : '';
      const cls = (status && status !== 'filled') || (empty && f.required) ? 'bad' : needsReview.includes(f.id) || empty ? 'warn' : '';
      rows.push(`<div class="item ${cls}" style="--i:${rows.length}"><div class="q">${esc(starless(f.label).slice(0, 120))}${f.required ? ' *' : ''} ${tag}${src}</div><div class="v">${esc(Array.isArray(v) ? v.join(', ') : typeof v === 'boolean' ? (v ? 'Yes' : 'No') : v ?? '')}</div></div>`);
    }

    if (otpFields.length) {
      const c = await fillCodes(tab, otpFields);
      rows.push(...c.rows);
      if (!c.ok) missingRequired.push('verification code');
    }
    await sleep(500); // give conditional questions time to appear before re-scanning
  }
  };

  // The whole form first: scroll through it and open collapsed sections, so nothing is missed.
  const revealed = (await callAll(tab.id, 'revealAll').catch(() => [])).reduce((n, f) => n + (f.result?.expanded || 0), 0);
  if (revealed) progress(`Page ${pageNo}: opened ${revealed} collapsed section${revealed > 1 ? 's' : ''}`);

  // Repeating sections ("Work Experience → Add"): add as many entries as your profile has (3 jobs, 1 degree, your languages).
  await addSectionEntries(tab, async (kind, n, frameId) => {
    entryHint = { section: kind[0].toUpperCase() + kind.slice(1), entry: n };
    await fillRounds();
    entryHint = null;
    const saved = await callFrame(tab.id, frameId, 'saveOpenCard').catch(() => null);
    rows.push(`<div class="item ${saved?.ok ? '' : 'warn'}"><div class="q">➕ ${esc(kind)} #${n} <span class="tag ${saved?.ok ? 'done' : 'review'}">${saved?.ok ? `added, pressed “${esc(saved.button)}”` : 'filled: press its Add / Save button'}</span></div></div>`);
  });
  // Link rows ("Work Link [+]", "Link 1/2/3 + Add link"): one box per link — both portfolios, LinkedIn, GitHub.
  const pl = state.profile?.links || {};
  const links = [...new Set([pl.portfolio, pl.linkedin, pl.github, ...(pl.other || []).filter((l) => !/leetcode/i.test(l))].filter(Boolean))];
  if (links.length > 1) await callAll(tab.id, 'addLinkRows', links.length).catch(() => {});
  await fillRounds();

  // Entry cards the site imported but flags ("Fields to fix: 1"): open each, fill it, press its Save / Add button.
  for (let c = 0; c < 6; c++) {
    const hit = (await callAll(tab.id, 'openFixCard').catch(() => [])).find((f) => f.result?.ok);
    if (!hit) break;
    progress(`Page ${pageNo}: fixing “${hit.result.label}”…`);
    await fillRounds();
    const saved = await callFrame(tab.id, hit.frameId, 'saveOpenCard').catch(() => null);
    rows.push(`<div class="item ${saved?.ok ? '' : 'warn'}"><div class="q">🧩 ${esc(hit.result.label)} <span class="tag ${saved?.ok ? 'done' : 'review'}">${saved?.ok ? `fixed, pressed “${esc(saved.button)}”` : 'filled: press its Save button'}</span></div></div>`);
  }

  // Trust but verify, once more at the end: refill anything the site cleared after we filled it.
  await callAll(tab.id, 'waitStable').catch(() => {});
  for (const [frameId, vals] of Object.entries(filledValues)) {
    const lost = (await callFrame(tab.id, Number(frameId), 'lostValues', vals).catch(() => null)) || [];
    if (!lost.length) continue;
    const r = (await callFrame(tab.id, Number(frameId), 'fill', Object.fromEntries(lost.map((id) => [id, vals[id]])), [])) || {};
    for (const id of lost) {
      const ok = r[id] === 'filled';
      if (!ok) failed.push({ key: `${frameId}:${id}`, label: labelOf[`${frameId}:${id}`] || id, value: String(vals[id]), error: r[id] || 'cleared by the site', required: false });
      rows.push(`<div class="item ${ok ? 'warn' : 'bad'}"><div class="q">🔁 ${esc((labelOf[`${frameId}:${id}`] || 'Field').slice(0, 90))}: the site cleared it <span class="tag ${ok ? 'review' : 'err'}">${ok ? 'refilled' : esc(r[id] || 'cleared')}</span></div><div class="v">${esc(String(vals[id]).slice(0, 120))}</div></div>`);
    }
  }

  // Check before you continue: dates in order, nothing left over from the site's resume import, no required box empty,
  // and no entries your profile doesn't have (Workday's import sometimes adds a second, empty Education).
  for (const fr of await callAll(tab.id, 'auditPage').catch(() => [])) {
    const a = fr.result;
    if (!a) continue;
    for (const i of a.issues) rows.push(`<div class="item warn"><div class="q">🔎 ${esc(starless(i.label).slice(0, 90))} <span class="tag review">check</span></div><div class="v">${esc(i.problem)}</div></div>`);
    const mine = { education: state.profile?.education?.length || 0, experience: state.profile?.experience?.length || 0 };
    for (const kind of ['education', 'experience']) {
      for (let n = a.entries[kind]; mine[kind] && n > mine[kind]; n--) {
        rows.push(`<div class="item warn"><div class="q">🧹 ${kind === 'education' ? 'Education' : 'Work Experience'} ${n} isn't in your profile <span class="tag review">extra entry</span></div><div class="v">The site added it from your resume. <button class="btn ghost sm" data-delentry="${fr.frameId}:${kind}:${n}">Delete it</button></div></div>`);
      }
    }
  }

  // Account creation: password boxes are always yours (Auto Job never types passwords).
  const pw = (await callAll(tab.id, 'focusPassword').catch(() => [])).find((f) => f.result?.waiting);
  // Account memory: the sites where you made an account, so sign-in pages say so instead of you guessing.
  const host = (() => { try { return new URL(tab.url).hostname.replace(/^www\./, ''); } catch { return ''; } })();
  const { accounts = {} } = await chrome.storage.local.get('accounts');
  if (pw && pw.result.count === 1 && accounts[host]) rows.push(`<div class="item"><div class="q">🔑 You made an account here on ${new Date(accounts[host]).toLocaleDateString()}</div><div class="v">Sign in with your usual email; Chrome's password manager has the password if you saved it.</div></div>`);
  if (pw && pw.result.count > 1) await chrome.storage.local.set({ accounts: { ...accounts, [host]: accounts[host] || Date.now() } });
  if (pw) {
    rows.push(`<div class="item warn"><div class="q">🔑 Password <span class="tag review">create it yourself</span></div><div class="v">Auto Job never types passwords. Your cursor is in the box: let Chrome suggest a strong password (right-click → Suggest password), then fill${pw.result.count > 1 ? ' the confirmation box too and' : ''} press Continue.</div></div>`);
    missingRequired.push('account password (create it yourself)');
  }
  // A CAPTCHA on the page: put your cursor in it and wait for you (the run stops here until you've typed it).
  const cap = (await callAll(tab.id, 'focusCaptcha').catch(() => [])).find((f) => f.result?.waiting);
  if (cap) {
    rows.push(`<div class="item warn"><div class="q">🔤 CAPTCHA <span class="tag review">type it yourself</span></div><div class="v">Your cursor is in the box. Type the characters, then press Fill again (or Submit).</div></div>`);
    missingRequired.push('CAPTCHA (type the characters yourself)');
  }

  const info = (last || []).map((s) => s.result);
  const next = info.map((i) => i.next).find(Boolean) || null;
  const submit = info.map((i) => i.submit).find(Boolean) || null;
  const errors = info.flatMap((i) => i.errors || []);
  const checkEmail = info.some((i) => i.checkEmail);
  $('#fillMeta').textContent = `page ${pageNo}`;
  state.log.push(`<div class="page">Page ${pageNo}</div>${rows.join('') || '<p class="hint">Nothing new to fill on this page.</p>'}`);
  $('#fillOut').innerHTML = `<p class="hint">Green outline = filled · orange = please check.</p>${state.log.join('')}`;
  return { count: rows.length, missingRequired: [...new Set(missingRequired)], failed, next, submit, errors, checkEmail };
}

// "Delete it" on an extra entry the site added: you pressed it, so remove that entry from the form.
$('#fillOut').addEventListener('click', async (e) => {
  const spec = e.target.dataset.delentry;
  if (!spec) return;
  const [frameId, kind, n] = spec.split(':');
  const tab = await activeTab();
  e.target.disabled = true;
  const r = await callFrame(tab.id, Number(frameId), 'deleteEntry', kind, Number(n)).catch(() => null);
  e.target.replaceWith(Object.assign(document.createElement('span'), { className: `tag ${r?.ok ? 'done' : 'err'}`, textContent: r?.ok ? 'deleted' : r?.reason || "couldn't delete it: use the page's Delete button" }));
});

// ---------- self-correction ----------
// Fields the page marks as invalid, across frames, keyed like the rest of the panel ("frameId:fieldId").
async function collectFieldErrors(tab) {
  const frames = await callAll(tab.id, 'fieldErrors').catch(() => []);
  return frames.flatMap(({ frameId, result }) => (result || []).map((e) => ({ ...e, key: `${frameId}:${e.id}`, frameId })));
}

// Ask for corrected values for the flagged fields (with the site's message and the rejected value) and re-fill them.
async function repairPage(tab, errs, pageErrors, pageNo, { trusted = false, title = 'fixes' } = {}) {
  const scans = await callAll(tab.id, 'scan');
  const meta = new Map();
  for (const { frameId, result } of scans) for (const f of result.fields) meta.set(`${frameId}:${f.id}`, { ...f, id: `${frameId}:${f.id}`, label: f.label.slice(0, 300) });
  let targets = errs.map((e) => meta.get(e.key)).filter((f) => f && f.type !== 'file' && f.type !== 'otp-split');
  // Only a banner ("Please complete all required fields"): retry the required fields that are still empty.
  if (!targets.length && pageErrors.length) targets = [...meta.values()].filter((f) => f.required && !f.filled && f.type !== 'file');
  if (!targets.length) return { fixed: 0, unresolved: errs.map((e) => e.label) };
  const errors = Object.fromEntries(errs.map((e) => [e.key, { message: e.error, previous: e.value }]));
  const { values, needsReview } = await api('/api/answer', { method: 'POST', body: { fields: targets, job: currentJob(), errors, pageErrors } });
  const byFrame = {};
  for (const [key, v] of Object.entries(values)) {
    const [frameId, id] = key.split(/:(.*)/);
    (byFrame[frameId] ||= {})[id] = v;
  }
  let fixed = 0;
  const rows = [];
  for (const [frameId, vals] of Object.entries(byFrame)) {
    const review = needsReview.filter((k) => k.startsWith(`${frameId}:`)).map((k) => k.split(/:(.*)/)[1]);
    // Real typing: text boxes get genuine keystrokes through the debugger; everything else is filled as usual.
    const typed = {};
    if (trusted) {
      for (const [id, v] of Object.entries(vals)) {
        const type = meta.get(`${frameId}:${id}`)?.type;
        if (TYPABLE.includes(type) && typeof v === 'string') typed[id] = await realType(tab.id, Number(frameId), id, v);
        else if (CLICKABLE.includes(type) && v !== '' && v != null) typed[id] = await realChoose(tab.id, Number(frameId), id, type, v);
        else continue;
        // The real way didn't work either: one last normal fill so nothing is left worse than before.
        if (typed[id] !== 'filled') continue;
        delete vals[id];
      }
    }
    const r = { ...typed, ...((Object.keys(vals).length && (await callFrame(tab.id, Number(frameId), 'fill', vals, review))) || {}) };
    for (const [id, status] of Object.entries(r)) {
      const key = `${frameId}:${id}`;
      const f = meta.get(key);
      if (status === 'filled') fixed++;
      rows.push(`<div class="item ${status === 'filled' ? 'warn' : 'bad'}"><div class="q">${id in typed ? '⌨️' : '🔧'} ${esc((f?.label || id).slice(0, 90))} <span class="tag ${status === 'filled' ? 'review' : 'err'}">${status === 'filled' ? (id in typed ? 'retyped' : 'corrected') : esc(status)}</span></div>
        <div class="v">${esc(String(values[key]).slice(0, 120))}${errors[key]?.message ? `<span class="src">site said: ${esc(errors[key].message.slice(0, 80))}</span>` : ''}</div></div>`);
    }
  }
  if (rows.length) {
    state.log.push(`<div class="page">Page ${pageNo} · ${esc(title)}</div>${rows.join('')}`);
    $('#fillOut').innerHTML = `<p class="hint">Green outline = filled · orange = please check.</p>${state.log.join('')}`;
  }
  const unresolved = targets.filter((f) => !values[f.id]).map((f) => f.label);
  if (trusted) await debuggerOff(tab.id);
  return { fixed, unresolved };
}

// ---------- real typing (Chrome debugger) ----------
// Some sites only accept what a real keyboard types. The debugger sends genuine keystrokes to the focused field.
// Chrome shows a "started debugging this browser" bar while attached, so we attach only while retyping.
const TYPABLE = ['text', 'email', 'tel', 'url', 'number', 'search', 'textarea', ''];
const CLICKABLE = ['dropdown', 'combobox', 'radio', 'checkbox', 'checkbox-group'];
const attached = new Set();
async function debuggerOn(tabId) {
  if (attached.has(tabId)) return true;
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
  } catch (e) {
    if (!/already attached/i.test(e.message)) return false;
  }
  attached.add(tabId);
  return true;
}
async function debuggerOff(tabId) {
  if (!attached.delete(tabId)) return;
  await chrome.debugger.detach({ tabId }).catch(() => {});
}
const key = (tabId, type, k, code, vk) => chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', { type, key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
async function realType(tabId, frameId, id, value) {
  if (!(await debuggerOn(tabId))) return 'real typing unavailable (another debugger is attached?)';
  // a split date box (MM or YYYY) gets only its own part, never the whole date
  const whole = value;
  value = (await callFrame(tabId, frameId, 'boxValue', id, value).catch(() => null)) ?? value;
  const ready = await callFrame(tabId, frameId, 'prepareType', id);
  if (!ready?.ok) return "couldn't focus the field";
  try {
    // Clear what's there, then type the value as real text input, then Tab out so the site validates it.
    await key(tabId, 'keyDown', 'Backspace', 'Backspace', 8);
    await key(tabId, 'keyUp', 'Backspace', 'Backspace', 8);
    await chrome.debugger.sendCommand({ tabId }, 'Input.insertText', { text: String(value) });
    await sleep(120);
    await key(tabId, 'keyDown', 'Tab', 'Tab', 9);
    await key(tabId, 'keyUp', 'Tab', 'Tab', 9);
    await sleep(250);
    if (await callFrame(tabId, frameId, 'checkValue', id, whole)) return 'filled';
    // Some widgets only react to individual key presses (masks, digit-only boxes): type it one key at a time.
    if (!(await callFrame(tabId, frameId, 'prepareType', id))?.ok) return "couldn't focus the field";
    await key(tabId, 'keyDown', 'Backspace', 'Backspace', 8);
    await key(tabId, 'keyUp', 'Backspace', 'Backspace', 8);
    for (const ch of String(value).slice(0, 400)) {
      await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', { type: 'keyDown', key: ch, text: ch, unmodifiedText: ch });
      await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', { type: 'keyUp', key: ch });
    }
    await key(tabId, 'keyDown', 'Tab', 'Tab', 9);
    await key(tabId, 'keyUp', 'Tab', 'Tab', 9);
    await sleep(250);
  } catch (e) {
    return `real typing failed: ${e.message}`;
  }
  if (await callFrame(tabId, frameId, 'checkValue', id, whole)) return 'filled';
  const shows = await callFrame(tabId, frameId, 'readFieldValue', id);
  return `didn't stick (shows "${String(shows ?? '').slice(0, 40)}")`;
}
// A real mouse click at a point in the page (top-window viewport coordinates).
async function realClick(tabId, p) {
  await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y });
  await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', buttons: 1, clickCount: 1 });
  await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', buttons: 0, clickCount: 1 });
}
// Dropdowns, type-to-search boxes, radios and checkboxes that ignore scripted clicks: click them for real,
// type into the list's search when there is one, then click the option.
async function realChoose(tabId, frameId, id, type, value) {
  if (!(await debuggerOn(tabId))) return 'real clicks unavailable (another debugger is attached?)';
  const v = Array.isArray(value) ? value[0] : value;
  try {
    if (type === 'checkbox' && typeof value === 'boolean') {
      if (await callFrame(tabId, frameId, 'checkValue', id, value)) return 'filled';
    }
    const p = await callFrame(tabId, frameId, 'clickPoint', id, typeof value === 'boolean' ? '' : v);
    if (!p) return "couldn't find where to click";
    await realClick(tabId, p);
    await sleep(500);
    if (type === 'dropdown' || type === 'combobox') {
      let o = type === 'dropdown' ? await callFrame(tabId, frameId, 'optionPoint', v) : null;
      if (!o) {
        await chrome.debugger.sendCommand({ tabId }, 'Input.insertText', { text: String(v) });
        await sleep(900);
        o = await callFrame(tabId, frameId, 'optionPoint', v);
      }
      if (!o) {
        await key(tabId, 'keyDown', 'Enter', 'Enter', 13);
        await key(tabId, 'keyUp', 'Enter', 'Enter', 13);
        await sleep(900);
        o = await callFrame(tabId, frameId, 'optionPoint', v);
      }
      if (!o) {
        await key(tabId, 'keyDown', 'Escape', 'Escape', 27);
        await key(tabId, 'keyUp', 'Escape', 'Escape', 27);
        return `no option matches "${v}"`;
      }
      await realClick(tabId, o);
      await sleep(400);
    }
  } catch (e) {
    return `real click failed: ${e.message}`;
  }
  return (await callFrame(tabId, frameId, 'checkValue', id, value)) ? 'filled' : "didn't stick after a real click";
}

// ---------- eyes: visual check ----------
// Screenshots of the page (top to bottom, up to 3 screens) for Gemini to look at like a person would.
// Every field wears a numbered badge while they're taken, so problems come back as "#7", not a guess at wording.
async function capturePage(tab, scans) {
  const m = await callFrame(tab.id, 0, 'pageMetrics');
  if (!m) return { images: [], numbered: [] };
  const numbered = [];
  let next = 1;
  for (const { frameId, result } of scans) {
    const ids = result.fields.filter((f) => f.type !== 'file').map((f) => f.id);
    const got = (await callFrame(tab.id, frameId, 'badgeFields', ids, next).catch(() => [])) || [];
    for (const g of got) numbered.push({ n: g.n, key: `${frameId}:${g.id}` });
    next += got.length;
  }
  const step = Math.max(300, Math.floor(m.view * 0.85));
  const images = [];
  try {
    for (let y = 0; images.length < 3 && y < m.height; y += step) {
      await callFrame(tab.id, 0, 'scrollToY', y);
      await sleep(500); // also stays under Chrome's 2-screenshots-per-second limit
      const url = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 70 }).catch(() => null);
      if (url) images.push(await shrink(url));
    }
  } finally {
    for (const { frameId } of scans) await callFrame(tab.id, frameId, 'clearBadges').catch(() => {});
    await callFrame(tab.id, 0, 'scrollToY', m.y);
  }
  return { images: images.filter(Boolean), numbered };
}
// Retina screenshots are huge; 1400 px wide is plenty to read a form, and much faster and cheaper to send.
async function shrink(dataUrl, max = 1400) {
  try {
    const bmp = await createImageBitmap(await (await fetch(dataUrl)).blob());
    const k = Math.min(1, max / bmp.width);
    const c = new OffscreenCanvas(Math.round(bmp.width * k), Math.round(bmp.height * k));
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    const blob = await c.convertToBlob({ type: 'image/jpeg', quality: 0.62 });
    return await new Promise((ok) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(',')[1]); r.readAsDataURL(blob); });
  } catch {
    return dataUrl.split(',')[1];
  }
}
const words = (x) => String(x).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w.length > 2);
function matchField(label, fields) {
  const want = words(label);
  if (!want.length) return null;
  let best = null;
  let score = 0;
  for (const f of fields) {
    const have = new Set(words(String(f.label).split('›').pop()));
    const s = want.filter((w) => have.has(w)).length / want.length;
    if (s > score) [best, score] = [f, s];
  }
  return score >= 0.6 ? best : null;
}
// Look at the page; anything visibly wrong on a field is fixed like a site error (with real typing / clicks if on).
async function visualCheck(tab, pageNo, { round = 1 } = {}) {
  if (!$('#visualCheck').checked) return { problems: 0, fixed: 0 };
  progress(`Page ${pageNo}: 👁 ${round > 1 ? 'looking again after the fixes' : 'looking at the page'}…`);
  const scans = await callAll(tab.id, 'scan');
  const fields = scans.flatMap(({ frameId, result }) => result.fields.map((f) => ({ ...f, key: `${frameId}:${f.id}` })));
  const { images, numbered } = await capturePage(tab, scans);
  if (!images.length) return { problems: 0, fixed: 0 };
  const byKey = new Map(fields.map((f) => [f.key, f]));
  const listed = numbered.map(({ n, key }) => ({ n, ...pick(byKey.get(key)) }));
  const seen = await api('/api/vision', { method: 'POST', body: { images, url: tab.url, fields: listed } }).catch((e) => ({ error: e.message }));
  if (seen.error) {
    progress(`Visual check skipped: ${seen.error.slice(0, 80)}`);
    return { problems: 0, fixed: 0 };
  }
  const errs = [];
  const loose = [];
  for (const p of seen.problems || []) {
    const hit = numbered.find((x) => x.n === Number(p.field));
    const f = (hit && byKey.get(hit.key)) || (p.label && matchField(p.label, fields));
    if (f && f.type !== 'file' && f.type !== 'captcha' && !errs.some((e) => e.key === f.key)) errs.push({ key: f.key, label: f.label, error: `${p.problem}${p.fix ? ` (should be: ${p.fix})` : ''}`, value: '' });
    else if (!f) loose.push(p);
  }
  const n = seen.problems?.length || 0;
  const rows = [`<div class="item ${n ? 'warn' : ''}"><div class="q">👁 ${round > 1 ? 'Looked again' : 'Visual check'} <span class="tag ${n ? 'review' : 'done'}">${n ? `${n} seen` : 'looks right'}</span></div><div class="v">${esc(seen.summary || '')}</div>
      <img class="seen" src="data:image/jpeg;base64,${images[0]}" alt="What the visual check saw" /></div>`,
    ...errs.map((e) => `<div class="item warn"><div class="q">👁 ${esc(e.label.slice(0, 90))} <span class="tag review">fixing</span></div><div class="v">${esc(e.error.slice(0, 160))}</div></div>`),
    ...loose.map((p) => `<div class="item bad"><div class="q">👁 ${esc(p.label || 'On the page')} <span class="tag err">check it</span></div><div class="v">${esc(p.problem)}</div></div>`)];
  // Keep one thumbnail: older ones are dropped so the log stays light.
  state.log = state.log.map((h) => h.replace(/<img class="seen"[^>]*>/g, ''));
  state.log.push(`<div class="page">Page ${pageNo} · ${round > 1 ? 'visual re-check' : 'visual check'}</div>${rows.join('')}`);
  $('#fillOut').innerHTML = `<p class="hint">Green outline = filled · orange = please check.</p>${state.log.join('')}`;
  let fixed = 0;
  if (errs.length) {
    progress(`Page ${pageNo}: 👁 fixing ${errs.length} field${errs.length > 1 ? 's' : ''} that look wrong`);
    fixed = (await healPage(tab, errs, pageNo, 'healed after the visual check')).fixed;
  }
  return { problems: n, fixed, loose: loose.length };
}
const pick = (f) => (f ? { label: String(f.label).slice(0, 140), type: f.type, required: f.required, filled: f.filled } : {});
// ---------- self-healing ----------
// One ladder for every field that fails: normal fill → real typing (paste, then key by key) → real click →
// a corrected value from the AI (with the site's message). After every step: read the field back and ask the
// site whether it still objects. The strategy that worked is remembered per site and tried first next time.
// What still fails goes to "Needs you" with what was tried and a "Show me" button.
const STRATEGY_NAMES = { fill: 'normal fill', type: 'real typing', click: 'real click', ai: 'corrected value' };
async function healMemory() {
  return (await chrome.storage.local.get('healMemory')).healMemory || {};
}
const healKey = (label) => String(label).split('›').pop().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 60);
async function rememberStrategy(host, label, strategy) {
  const mem = await healMemory();
  (mem[host] ||= {})[healKey(label)] = strategy;
  mem[host]._type = mem[host]._type === undefined ? strategy : mem[host]._type; // the first fix on a site hints at its widgets
  await chrome.storage.local.set({ healMemory: mem }).catch(() => {});
}
async function tryStrategy(tab, frameId, id, type, value, strategy) {
  if (strategy === 'fill') return ((await callFrame(tab.id, frameId, 'fill', { [id]: value }, [])) || {})[id] || 'no result';
  if (strategy === 'type') return realType(tab.id, frameId, id, String(value));
  if (strategy === 'click') return realChoose(tab.id, frameId, id, type, value);
  return 'unknown strategy';
}
// Fixed = shows the value AND the site has no error on it any more.
async function healed(tab, frameId, id, value) {
  await sleep(250);
  const holds = await callFrame(tab.id, frameId, 'checkValue', id, value).catch(() => false);
  const error = await callFrame(tab.id, frameId, 'fieldError', id).catch(() => '');
  return { ok: !!holds && !error, error };
}
async function healField(tab, field, value, siteError, mem) {
  const [frameId, id] = field.id.split(/:(.*)/).map((x, i) => (i ? x : Number(x)));
  const real = $('#realTyping').checked;
  let ladder = ['fill', ...(real && TYPABLE.includes(field.type) ? ['type'] : []), ...(real && CLICKABLE.includes(field.type) ? ['click'] : [])];
  const known = mem[healKey(field.label)] || mem._type;
  if (known && ladder.includes(known)) ladder = [known, ...ladder.filter((x) => x !== known)]; // what worked here before goes first
  const tried = [];
  let error = siteError;
  let aiAt = -1;
  for (const v of [value, null]) {
    let val = v;
    if (val === null) {
      // Every way of entering it failed: ask for a corrected value, using the site's own message.
      const fix = await api('/api/answer', { method: 'POST', body: { fields: [field], job: currentJob(), errors: { [field.id]: { message: error || 'the site did not accept this value', previous: value } } } }).catch(() => null);
      val = fix?.values?.[field.id];
      if (val === undefined || val === '' || String(val) === String(value)) break;
      aiAt = tried.push({ strategy: 'ai', ok: false, note: String(val).slice(0, 40) }) - 1;
    }
    for (const strategy of ladder) {
      const status = await tryStrategy(tab, frameId, id, field.type, val, strategy);
      const check = await healed(tab, frameId, id, val);
      tried.push({ strategy, ok: check.ok, note: check.ok ? '' : check.error || status });
      if (check.ok) {
        if (aiAt >= 0) tried[aiAt].ok = true;
        return { ok: true, tried, value: val, strategy };
      }
      error = check.error || error;
    }
  }
  return { ok: false, tried, value, error };
}
// Heal a list of failing fields ({ key, label, error, value }) on this page; returns what was fixed and what needs you.
async function healPage(tab, failures, pageNo, title = 'self-healing') {
  if (!failures.length) return { fixed: 0, unresolved: [] };
  const scans = await callAll(tab.id, 'scan');
  const meta = new Map();
  for (const { frameId, result } of scans) for (const f of result.fields) meta.set(`${frameId}:${f.id}`, { ...f, id: `${frameId}:${f.id}`, label: f.label.slice(0, 300) });
  const seen = new Set();
  const targets = failures.filter((e) => !seen.has(e.key) && seen.add(e.key)).map((e) => ({ e, f: meta.get(e.key) })).filter(({ f }) => f && !['file', 'otp-split', 'captcha'].includes(f.type));
  if (!targets.length) return { fixed: 0, unresolved: failures.map((e) => e.label) };
  progress(`Page ${pageNo}: 🩺 healing ${targets.length} field${targets.length > 1 ? 's' : ''}…`);
  // One answer request for all of them, with each field's own error.
  const errors = Object.fromEntries(targets.map(({ e }) => [e.key, { message: e.error, previous: e.value }]));
  const ans = await api('/api/answer', { method: 'POST', body: { fields: targets.map(({ f }) => f), job: currentJob(), errors } }).catch(() => ({ values: {} }));
  const host = (() => { try { return new URL(tab.url).hostname; } catch { return ''; } })();
  const mem = (await healMemory())[host] || {};
  const rows = [];
  const needs = [];
  let fixed = 0;
  for (const { e, f } of targets) {
    const value = ans.values?.[f.id] ?? (e.value || undefined);
    if (value === undefined || value === '') {
      needs.push({ f, why: e.error || 'no value in your profile for this' , tried: [] });
      continue;
    }
    const r = await healField(tab, f, value, e.error, mem);
    const path = r.tried.map((t) => `${STRATEGY_NAMES[t.strategy]} ${t.ok ? '✓' : '✗'}`).join(' → ');
    if (r.ok) {
      fixed++;
      await rememberStrategy(host, f.label, r.strategy);
      rows.push(`<div class="item warn"><div class="q">🩺 ${esc(starless(f.label).slice(0, 90))} <span class="tag review">healed</span></div><div class="v">${esc(String(r.value).slice(0, 100))}<span class="src">${esc(path)}</span></div></div>`);
    } else needs.push({ f, why: r.error || e.error || 'the site keeps rejecting it', tried: r.tried, path });
  }
  await debuggerOff(tab.id);
  for (const n of needs) {
    rows.push(`<div class="item bad"><div class="q">🙋 ${esc(starless(n.f.label).slice(0, 90))} <span class="tag err">needs you</span> <button class="btn ghost sm" data-jump="${esc(n.f.id)}">Show me</button></div>
      <div class="v">${esc(String(n.why).slice(0, 140))}${n.path ? `<span class="src">tried: ${esc(n.path)}</span>` : ''}</div></div>`);
  }
  if (rows.length) {
    state.log.push(`<div class="page">Page ${pageNo} · ${esc(title)}</div>${rows.join('')}`);
    $('#fillOut').innerHTML = `<p class="hint">Green outline = filled · orange = please check.</p>${state.log.join('')}`;
  }
  return { fixed, unresolved: needs.map((n) => n.f.label) };
}

// Last pass on a page: retype anything the site still flags with real keystrokes, look at it,
// and if the look led to fixes, look once more to confirm they took.
async function checkPage(tab, pageNo) {
  const stuck = await collectFieldErrors(tab);
  if (stuck.length) await healPage(tab, stuck, pageNo, 'self-healing').catch(() => {});
  const first = await visualCheck(tab, pageNo).catch(() => ({ problems: 0, fixed: 0 }));
  if (!first.fixed) return first;
  return visualCheck(tab, pageNo, { round: 2 }).catch(() => first);
}


// Fill → Next → fill … until the final page (Submit visible), a page needs you, or Next fails.
async function runPages() {
  const tab = await activeTab();
  for (let page = 1; page <= MAX_PAGES; page++) {
    const r = await fillPage(page);
    // Values a widget refused ("didn't stick", "no option matches"): ask again with that feedback.
    // Fields that didn't take, plus fields the site objects to right after filling (some only complain once you leave the box).
    const flagged = (await collectFieldErrors(tab).catch(() => [])).map((e) => ({ ...e, required: true }));
    const failures = [...r.failed, ...flagged.filter((e) => !r.failed.some((x) => x.key === e.key))];
    if (failures.length) {
      progress(`Page ${page}: ${failures.length} field${failures.length > 1 ? 's' : ''} didn't take or ${failures.length > 1 ? 'are' : 'is'} rejected, healing`);
      const fx = await healPage(tab, failures, page, 'self-healing');
      const left = new Set(fx.unresolved);
      r.missingRequired.push(...failures.filter((x) => x.required && left.has(x.label)).map((x) => x.label));
    }
    if (r.checkEmail && !r.next && !r.submit && !r.count) {
      if (!(await followEmailLink(tab))) return 'needs-input';
      continue;
    }
    if (r.missingRequired.length) {
      progress(`Page ${page}: needs you: ${r.missingRequired.slice(0, 3).join('; ')}`, 'bad');
      $('#submitOut').innerHTML = `<p><b>Fill the required fields marked “required” or “upload it yourself”</b>, then press <b>Continue</b>.</p>`;
      return 'needs-input';
    }
    // Final page: a Submit button and no Next. Fix anything flagged before you review.
    if (!r.next || !$('#autoNext').checked) {
      const errs = (await collectFieldErrors(tab)).filter((e) => e.value);
      if (errs.length) await repairPage(tab, errs, [], page).catch(() => {});
      await checkPage(tab, page);
      progress(r.submit ? `Final page: review everything, then press Submit` : `Done filling. Review the page.`);
      setStep('review');
      if (r.submit) $('#submit').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      $('#submitOut').innerHTML = r.submit
        ? `<p><b>Review the highlighted fields</b>, fix anything, then press Submit above (it clicks “${esc(r.submit)}”).</p>`
        : `<p class="hint">${r.next ? `Click “${esc(r.next)}” yourself or turn on auto-click Next.` : 'No Next or Submit button found on this page.'}</p>`;
      return r.submit ? 'final' : 'done';
    }
    // Fix anything the page already flags before moving on.
    for (let a = 0; a < 2; a++) {
      const errs = (await collectFieldErrors(tab)).filter((e) => e.value || /format|valid|select|choose|match|must|between|characters|digits/i.test(e.error));
      if (!errs.length) break;
      progress(`Page ${page}: fixing ${errs.length} flagged field${errs.length > 1 ? 's' : ''}`);
      if (!(await repairPage(tab, errs, [], page)).fixed) break;
    }
    await checkPage(tab, page);
    await remember(tab.id);
    const clickNextAndWait = async () => {
      const before = await pageKeys(tab.id);
      const t = (await callAll(tab.id, 'nextLabel')).find((f) => f.result);
      if (!t) return null;
      progress(`Page ${page}: clicking “${t.result}”`);
      await callFrame(tab.id, t.frameId, 'clickNext');
      return waitForNewStep(tab.id, before);
    };
    let moved = await clickNextAndWait();
    if (moved === null) {
      progress('The Next button disappeared: review the page, then press Continue', 'bad');
      return 'blocked';
    }
    // The site refused the page: read its errors, correct those fields, try again (up to 3 times).
    for (let attempt = 1; attempt <= 3 && !moved; attempt++) {
      const errs = await collectFieldErrors(tab);
      const pageErrs = (await callAll(tab.id, 'errorTexts')).flatMap((f) => f.result);
      if (!errs.length && !pageErrs.length) {
        // Nothing the page's code says is wrong, yet it didn't move: look at it.
        const v = await visualCheck(tab, page).catch(() => ({ fixed: 0 }));
        if (!v.fixed) break;
        moved = await clickNextAndWait();
        continue;
      }
      progress(`Page ${page}: the site found ${errs.length || pageErrs.length} problem${(errs.length || pageErrs.length) > 1 ? 's' : ''}, fixing (attempt ${attempt}/3)`);
      const fx = attempt > 1 && errs.length ? await healPage(tab, errs, page, `self-healing (attempt ${attempt})`) : await repairPage(tab, errs, pageErrs, page);
      if (!fx.fixed) break;
      moved = await clickNextAndWait();
    }
    if (!moved) {
      const errs = (await callAll(tab.id, 'errorTexts')).flatMap((f) => f.result);
      progress(`The site did not move on${errs.length ? `: ${errs.slice(0, 2).join(' · ')}` : ''}`, 'bad');
      $('#submitOut').innerHTML = `<p><b>The form stayed on this page.</b> ${errs.length ? `It says: ${errs.map(esc).join(' · ')}` : 'Look for a red error on the page.'} Fix it, then press <b>Continue</b>.</p>`;
      return 'blocked';
    }
  }
  progress(`Stopped after ${MAX_PAGES} pages`, 'bad');
  return 'too-many';
}

// "Check your email to continue": find the verification link in Gmail and open it in this tab.
async function followEmailLink(tab) {
  progress('Waiting for the verification email in Gmail (up to 2 min)…');
  const hit = await api(`/api/otp?since=${state.startedAt}&hint=${encodeURIComponent(siteHint(tab.url))}&want=link&wait=120`).catch((e) => ({ error: e.message }));
  if (!hit?.link) {
    progress(hit?.error || 'No verification email arrived. Open it yourself, then press Continue.', 'bad');
    return false;
  }
  if (!trustedLink(hit.link, tab.url)) {
    $('#submitOut').innerHTML = `<p>Found a verification link from “${esc(hit.from)}”, but it points to ${esc(new URL(hit.link).hostname)}, which isn't this job site. <a href="${esc(hit.link)}" target="_blank">Open it</a> only if you trust it, then press Continue.</p>`;
    progress('Verification link is on another site: check it yourself', 'bad');
    return false;
  }
  progress(`Opening the verification link from “${hit.subject.slice(0, 40)}”`);
  await chrome.tabs.update(tab.id, { url: hit.link });
  await waitForLoad(tab.id);
  return true;
}

// Answers are collected page by page, but only saved to memory when you actually submit
// (i.e. after you reviewed them), so an AI guess on an unreviewed page is never remembered.
state.pendingMemory = [];
async function remember(tabId) {
  const snaps = (await callAll(tabId, 'snapshot').catch(() => [])).flatMap((f) => f.result);
  state.pendingMemory.push(...snaps);
}
async function commitMemory() {
  const entries = state.pendingMemory;
  state.pendingMemory = [];
  if (entries.length) await api('/api/answer-bank', { method: 'POST', body: { entries } }).catch(() => {});
}

// On a job page, press Apply (several hops on boards: board → countdown page → company site → form) until the form shows.
async function openApplication(tab) {
  // Job boards often need several "Apply" hops (board → countdown page → company careers page → form).
  for (let hop = 0; hop < 4; hop++) {
    const scans = await callAll(tab.id, 'scan');
    // Already on the application form? Only when it asks for you (name, email, phone, resume…), not just any inputs.
    const fields = scans.flatMap((s) => s.result.fields);
    const asksForYou = fields.filter((f) => f.type === 'file' || /name|e-?mail|phone|mobile|resume|\bcv\b|linkedin|address|password|username/i.test(f.label)).length;
    if ((asksForYou >= 1 && fields.length >= 2) || fields.length >= 4) break;
    let clicked = await callFrame(tab.id, 0, 'clickApply');
    if (!clicked?.ok) {
      await sleep(3000); // countdown pages ("You can apply in 3…") enable the button after a moment
      clicked = await callFrame(tab.id, 0, 'clickApply');
    }
    if (!clicked?.ok) break;
    progress(`Clicked “${clicked.label}”${hop ? ` (step ${hop + 1})` : ''}`);
    // Some boards open the company site in a new tab: follow whichever tab is now in front.
    await sleep(1500);
    const now = await activeTab().catch(() => tab);
    await waitForLoad(now.id, 8000);
    tab = await activeTab();
  }
  return tab;
}

// ---------- all-in-one ----------
async function runAll() {
  let tab = await activeTab();
  state.log = [];
  state.startedAt = Date.now() - 2 * 60_000;
  state.pendingMemory = [];
  resetSteps();
  setStep('job');
  $('#progress').innerHTML = '';
  progress('Reading the job…');
  if (!state.job || state.job.url !== tab.url) await readJob();
  if ($('#researchFirst').checked && currentJob().company && state.research?.company !== currentJob().company) {
    progress(`Researching ${currentJob().company}…`);
    await research().catch((e) => progress(`Company research skipped: ${e.message.slice(0, 80)}`));
  }

  tab = await openApplication(tab);
  await ensureResume();
  // No form anywhere, but the post gives a recruiter email: apply by email instead.
  const formFields = (await callAll(tab.id, 'scan')).reduce((n, x) => n + x.result.fields.filter((f) => f.type !== 'file').length, 0);
  const emails = state.job?.emails || [];
  document.querySelector('.submit-card').hidden = formFields < 2 && emails.length > 0; // email jobs have no form to submit
  if (formFields < 2 && emails.length) {
    progress('This job applies by email: drafting it for you');
    showEmails(emails);
    await draftEmail();
    return 'email';
  }
  setStep('fill');
  return runPages();
}

// ---------- 4. submit ----------
async function submit() {
  const tab = await activeTab();
  const frames = await callAll(tab.id, 'submitLabel');
  const target = frames.find((f) => f.result);
  if (!target) throw new Error('No Submit button on this page. Use Continue to reach the last page.');
  // Two clicks within 10 s: the first one only arms it.
  if (!state.submitArmed || Date.now() - state.submitArmed > 10000) {
    state.submitArmed = Date.now();
    $('#submit').classList.add('armed');
    setTimeout(() => $('#submit').classList.remove('armed'), 10000);
    $('#submitOut').innerHTML = `<p><b>Press Submit again within 10 seconds</b> to click “${esc(target.result)}” and send this application.</p>`;
    return;
  }
  state.submitArmed = 0;
  $('#submit').classList.remove('armed');
  await remember(tab.id);
  await commitMemory();
  const r = await callFrame(tab.id, target.frameId, 'clickSubmit');
  if (!r?.ok) throw new Error(r?.reason || 'Could not click submit');
  const job = currentJob();
  await api('/api/applications', { method: 'POST', body: { title: job.title, company: job.company, location: job.location, url: state.job?.url || tab.url, description: String(state.job?.description || '').slice(0, 8000), status: 'applied', resume: state.resume?.filename, coverLetter: state.cover?.filename } }).catch(() => {});
  progress(`Submitted: clicked “${r.label}”`);
  loadTracker();
  setStep('review', true);
  toast('Application submitted 🎉');
  $('#submitOut').innerHTML = `<p><span class="tag done">submitted</span> Clicked “${esc(r.label)}”. Check the page for a confirmation.</p>`;
  if (state.queueIdx >= 0) setTimeout(() => nextInQueue(), 4000);
}

// ---------- job board queue ----------
// "Ends : 6 Nov", "Last date: 12 Dec 2026", "Apply by 5 November": an end date in the board's own text that has passed.
const MONTHS = 'jan feb mar apr may jun jul aug sep oct nov dec'.split(' ');
function endedByDate(j, now = Date.now()) {
  const m = String(j.meta || '').match(/\b(?:ends?|last date|deadline|apply by|closes?|closing date)\s*(?:on|:)?\s*(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]{3})[a-z]*\.?,?\s*(\d{4})?/i);
  const mon = m && MONTHS.indexOf(m[2].toLowerCase());
  if (!m || mon < 0) return false;
  const year = Number(m[3]) || new Date(now).getFullYear();
  let end = new Date(year, mon, Number(m[1]), 23, 59).getTime();
  if (!m[3] && end - now > 182 * 86400000) end = new Date(year - 1, mon, Number(m[1]), 23, 59).getTime(); // "Ends: 28 Dec" read in January
  return end < now;
}
const isClosed = (j) => j.open === 'closed' || endedByDate(j);

function visibleJobs() {
  const q = $('#jobFilter').value.toLowerCase().split(',').map((s) => s.trim()).filter(Boolean);
  const openOnly = $('#openOnly').checked;
  const list = state.boardJobs.map((j, i) => ({ j, i, m: matchScore(j) })).filter(({ j }) => (!q.length || q.some((w) => j.title.toLowerCase().includes(w))) && !(openOnly && isClosed(j)));
  if ($('#jobSort')?.value !== 'found') list.sort((a, b) => b.m.score - a.m.score);
  return list;
}

// ---------- job match score (no AI): your target roles and skills vs the posting, seniority vs your experience ----------
const tokens = (x) => String(x || '').toLowerCase().match(/[a-z][a-z0-9+#.]*/g) || [];
function matchScore(j) {
  const p = state.profile || {};
  const a = p.answers || {};
  const text = `${j.title} ${j.meta || ''}`.toLowerCase();
  const why = [];
  let score = 50;
  // Role: the title against your target roles and headline.
  const targets = String(a.targetRoles || p.headline || '').toLowerCase().split(/[,|/]+/).map((x) => x.trim()).filter(Boolean);
  const roleHit = targets.find((t) => tokens(t).filter((w) => w.length > 2 && !/engineer|developer|intern/.test(w)).some((w) => text.includes(w)));
  if (roleHit) { score += 20; why.push(`matches “${roleHit}”`); }
  else if (/engineer|developer|sde|scientist|analyst/.test(text)) score += 8;
  // Skills named in the title or meta.
  const skills = [...new Set((p.skills || []).flatMap((g) => g.items || []).map((x) => String(x).toLowerCase()))].filter((x) => x.length > 1);
  const hits = skills.filter((sk) => new RegExp(`(^|[^a-z0-9+#])${sk.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9+#])`).test(text));
  if (hits.length) { score += Math.min(15, 5 * hits.length); why.push(hits.slice(0, 3).join(', ')); }
  // Seniority against your experience.
  const years = /^\s*yes/i.test(a.isFresher || '') ? 0 : Number((String(a.yearsOfExperience || '').match(/\d+(\.\d+)?/) || [0])[0]);
  const need = Number((text.match(/(\d+)\s*\+?\s*(?:-\s*\d+\s*)?(?:years?|yrs)/) || [])[1] || 0);
  if (/\b(senior|sr\.?|lead|staff|principal|manager|head|director|architect|vp)\b|\b(ii|iii|iv)\b/.test(text) && years < 3) { score -= 30; why.push('senior role'); }
  if (need > years + 1) { score -= Math.min(30, 10 * (need - years)); why.push(`asks ${need}+ yrs`); }
  // Internship vs full-time, as your profile prefers.
  const wantsIntern = /intern/i.test(a.jobTypes || '');
  const wantsFull = /full[\s-]?time|job/i.test(a.jobTypes || '');
  if (/\bintern(ship)?\b/.test(text)) { if (wantsIntern) { score += 10; why.push('internship'); } else if (wantsFull && !wantsIntern) score -= 10; }
  // Already applied (same link, or same company and role in your tracker).
  const key = (x) => `${String(x.company || '').toLowerCase()}|${String(x.title || '').toLowerCase()}`;
  const applied = (state.apps || []).find((x) => x.status !== 'saved' && ((x.url && j.url && x.url.split('#')[0] === j.url.split('#')[0]) || (j.company && key(x) === key(j))));
  if (applied) { score -= 40; why.unshift('already applied'); }
  return { score: Math.max(0, Math.min(100, Math.round(score))), why, applied: !!applied };
}
function trackedBadge(j) {
  const a = j.url && state.apps?.find((x) => x.url && x.url.split('#')[0] === j.url.split('#')[0]);
  const m = a && STATUS[a.status];
  return m ? ` <span class="track-badge" style="--c:${m.c}">${m.label}</span>` : '';
}

function renderJobs() {
  saveJobs();
  const shown = visibleJobs();
  const closed = state.boardJobs.filter(isClosed).length;
  $('#jobCount').textContent = `${shown.length} shown · ${state.boardJobs.filter((j) => j.selected).length} selected${closed ? ` · ${closed} closed${$('#openOnly').checked ? ' hidden' : ''}` : ''}`;
  $('#jobList').innerHTML =
    shown.map(({ j, i, m }, n) => `<label class="job ${isClosed(j) ? 'is-closed' : ''}" style="--i:${Math.min(n, 30)}"><input type="checkbox" data-i="${i}" ${j.selected ? 'checked' : ''}/><span class="match" style="--m:${m.score}" title="${esc(m.why.join(' · ') || 'match score')}">${m.score}</span>
      <span class="job-main">${j.url ? `<a href="${esc(safeUrl(j.url))}" target="_blank">${esc(j.title)}</a>` : `<b>${esc(j.title)}</b>`}${trackedBadge(j)}${isClosed(j) ? ` <span class="badge bad" title="${j.open === 'closed' ? 'The link says this job is closed or expired' : 'Its end date has passed'}">closed</span>` : j.open === 'open' ? ` <span class="badge ok" title="The link still accepts applications">open</span>` : ''}${j.premium ? ` <span class="badge ${$('#includePremium').checked ? '' : 'warn'}">premium</span>` : ''}
      <span class="job-meta">${esc([j.meta, j.source].filter(Boolean).join(' · '))}${m.why.length ? ` · <i>${esc(m.why.slice(0, 2).join(' · '))}</i>` : ''}</span></span></label>`).join('') ||
    '<p class="hint">No jobs found yet.</p>';
}

// Your job boards. "Scan all" opens each one and merges every posting into one list.
const DEFAULT_BOARDS = [
  { name: 'The Job Company', url: 'https://thejobcompany.co.in/' },
  { name: 'TJC Internships', url: 'https://thejobcompany.co.in/job-category/internships' },
  { name: "Let's Code", url: 'https://www.lets-code.co.in/jobs/' },
  { name: 'EngineerHub Internships', url: 'https://www.engineerhub.in/career/internships' },
  { name: 'EngineerHub Jobs', url: 'https://www.engineerhub.in/career/jobs' },
  { name: 'Debug with Shubham', url: 'https://debugwithshubham.com/jobs' },
  { name: 'Crack Off-Campus', url: 'https://www.crackoffcampus.com/jobs' },
  // Fetched by the server (github.com/zapplyjobs/Internships-2027), not scraped from a tab.
  { name: 'Internships 2027 (zapply)', api: '/api/internships' },
];
let BOARDS = DEFAULT_BOARDS;

function renderBoards() {
  $('#boards').innerHTML = BOARDS.map((b, i) => `<span class="board-chip"><button class="board" data-b="${i}" title="${esc(b.url || b.api)}">${esc(b.name)}</button>${i >= DEFAULT_BOARDS.length ? `<button class="board-x" data-x="${i}" title="Remove">×</button>` : ''}</span>`).join('');
}
const saveBoards = () => chrome.storage.local.set({ boards: BOARDS.slice(DEFAULT_BOARDS.length) });

// A server-fed board (no tab scraping): the server parses the list, the panel merges it like any board.
async function scanApiBoard(b) {
  const r = await api(b.api).catch(() => null);
  if (r?.jobs?.length) mergeJobs(r.jobs, b.name);
  return r?.jobs?.length || 0;
}

// The job list survives closing the panel.
// Not before the saved list has loaded, or an early render would overwrite it with [].
const saveJobs = () => state.jobsLoaded && chrome.storage.local.set({ boardJobs: state.boardJobs.slice(0, 600) }).catch(() => {});

function mergeJobs(found, source) {
  const key = (j) => j.url || `${j.board}#${j.card}`;
  const have = new Set(state.boardJobs.map(key));
  for (const j of found) if (!have.has(key(j))) state.boardJobs.push({ ...j, source });
}

async function scanAllBoards() {
  const tab = await browserTab();
  for (const [i, b] of BOARDS.entries()) {
    $('#queueOut').textContent = `Scanning ${i + 1}/${BOARDS.length}: ${b.name}…`;
    if (b.api) {
      // Server-fed board: no tab needed.
      await scanApiBoard(b);
      renderJobs();
      continue;
    }
    await chrome.tabs.update(tab.id, { url: b.url });
    await waitForLoad(tab.id);
    await sleep(1500); // most boards render their list with JavaScript
    const frames = await callAll(tab.id, 'collectJobLinks').catch(() => []);
    mergeJobs(frames.flatMap((f) => f.result), b.name);
    renderJobs();
  }
  $('#queueOut').textContent = `Found ${state.boardJobs.length} jobs across ${BOARDS.length} boards. Filter, tick, then Start applying.`;
}

// Adds this tab's jobs to the list (never wipes what earlier scans found).
async function scanBoard() {
  const tab = await activeTab();
  const frames = await callAll(tab.id, 'collectJobLinks');
  const before = state.boardJobs.length;
  const board = BOARDS.find((b) => b.url && tab.url.startsWith(b.url.replace(/\/$/, '')));
  mergeJobs(frames.flatMap((f) => f.result), board?.name || new URL(tab.url).hostname.replace(/^www\./, ''));
  renderJobs();
  toast(`Added ${state.boardJobs.length - before} new jobs (${state.boardJobs.length} in your list)`);
}

async function openBoard() {
  const url = $('#boardUrl').value.trim();
  if (!/^https?:\/\//.test(url)) throw new Error('Paste a full link starting with https://');
  const tab = await browserTab();
  await chrome.tabs.update(tab.id, { url });
  await waitForLoad(tab.id);
  await scanBoard();
}

async function openJob(i) {
  const job = state.queue[i];
  state.queueIdx = i;
  state.job = state.resume = state.cover = null;
  ['#fillOut', '#tailorOut', '#coverOut', '#submitOut', '#emailOut'].forEach((s) => ($(s).innerHTML = ''));
  ['#emailTo', '#emailSubject', '#emailBody'].forEach((s) => ($(s).value = ''));
  document.querySelector('.submit-card').hidden = false;
  $('#queueOut').textContent = `Job ${i + 1} of ${state.queue.length}: ${job.title}: opening…`;
  const tab = await activeTab();
  if (job.url && safeUrl(job.url) === '#') throw new Error('That job link is not a normal web address');
  if (job.url) {
    await chrome.tabs.update(tab.id, { url: job.url });
    await waitForLoad(tab.id);
  } else {
    // A card without a link: reopen its board and click the card.
    await chrome.tabs.update(tab.id, { url: job.board });
    await waitForLoad(tab.id);
    await callFrame(tab.id, 0, 'openCard', job.card);
    await waitForLoad(tab.id, 6000);
  }
  switchTab('apply');
  await runAll().catch((e) => toast(e.message, true));
  $('#queueOut').textContent = `Job ${i + 1} of ${state.queue.length}: ${job.title}. Review it on the Apply tab, then Submit or Skip.`;
}

// Daily cap and a short, varied pause between jobs: steady, human pacing protects your accounts on job boards.
const DAILY_CAP = 25;
const appliedToday = () => (state.apps || []).filter((a) => a.appliedAt && new Date(a.appliedAt).toDateString() === new Date().toDateString()).length;
async function nextInQueue() {
  if (appliedToday() >= DAILY_CAP) {
    state.queueIdx = -1;
    $('#queueOut').textContent = `Paused: ${DAILY_CAP} applications today is the daily limit. The rest of the queue is still ticked for tomorrow.`;
    return;
  }
  if (state.queueIdx + 1 < state.queue.length) {
    const wait = 20 + Math.round(Math.random() * 20);
    $('#queueOut').textContent = `Next job in ${wait} s (pausing between applications)…`;
    await sleep(wait * 1000);
  }
  if (state.queueIdx + 1 >= state.queue.length) {
    state.queueIdx = -1;
    $('#queueOut').textContent = 'Queue finished.';
    switchTab('queue');
    return;
  }
  await openJob(state.queueIdx + 1);
}

// ---------- profile ----------
const inputsFor = (labels, values, group) =>
  Object.entries(labels)
    .map(([k, label]) => `<label class="field">${esc(label)}${k === 'extra' ? `<textarea data-g="${group}" data-k="${k}" rows="3">${esc(values?.[k])}</textarea>` : `<input data-g="${group}" data-k="${k}" value="${esc(values?.[k])}"/>`}</label>`)
    .join('');

function renderProfile(p) {
  state.profile = p;
  if (!p) {
    $('#profileOut').innerHTML = '<p class="hint">No resume imported yet.</p>';
    return;
  }
  const docs = Object.keys(p.documents || {});
  const initials = (p.name || '?').split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
  $('#profileOut').innerHTML = `
    <div class="profile-head"><div class="avatar">${esc(initials)}</div><div><b>${esc(p.name)}</b><div class="hint" style="margin:0">${esc(p.email)} · ${esc(p.phone)}</div></div></div>
    ${locationNote(p)}
    <div class="stats">
      <div class="stat"><b>${p.experience?.length || 0}</b><span>roles</span></div>
      <div class="stat"><b>${p.projects?.length || 0}</b><span>projects</span></div>
      <div class="stat"><b>${(p.skills || []).flatMap((s) => s.items).length}</b><span>skills</span></div>
    </div>
    <p class="hint">${p.sourceFiles?.length ? `Merged from ${p.sourceFiles.length} resume file(s)` : ''}${docs.length ? ` · documents: ${docs.map(esc).join(', ')}` : ''}</p>`;
  $('#personal').innerHTML = inputsFor(PERSONAL_LABELS, p.personal, 'personal');
  $('#answers').innerHTML = inputsFor(ANSWER_LABELS, p.answers, 'answers');
  if (!$('#jobFilter').value && p.answers?.targetRoles) {
    $('#jobFilter').placeholder = 'Filter titles (empty = show all), e.g. engineer, ml, data, sde';
  }
  const bank = Object.entries(p.answerBank || {});
  $('#bank').innerHTML = bank.length
    ? bank.map(([k, v]) => `<div class="bank"><span>${esc(k)} → <b>${esc(v.value)}</b></span><button data-forget="${esc(k)}">forget</button></div>`).join('')
    : '<p class="hint">Nothing yet.</p>';
}

async function importResume() {
  const files = [...$('#resumeFile').files];
  if (!files.length) throw new Error('Choose your resume file(s) first');
  const fd = new FormData();
  files.forEach((f) => fd.append('resume', f));
  renderProfile(await api('/api/profile/import', { method: 'POST', body: fd }));
  toast('Resume imported. Check your details below.');
}

async function saveProfile() {
  const p = await api('/api/profile');
  if (!p) throw new Error('Import your resume first');
  document.querySelectorAll('[data-g][data-k]').forEach((el) => (p[el.dataset.g][el.dataset.k] = el.value.trim()));
  renderProfile(await api('/api/profile', { method: 'PUT', body: p }));
  toast('Saved');
}

// ---------- tracker ----------
const STATUS = {
  saved: { label: 'To apply', c: '#8b8fa3', icon: '☆' },
  applied: { label: 'Applied', c: '#5b5bf6', icon: '📨' },
  assessment: { label: 'Assessment', c: '#0ea5e9', icon: '🧪' },
  interview1: { label: 'Interview 1', c: '#a855f7', icon: '🎙' },
  interview2: { label: 'Interview 2', c: '#9333ea', icon: '🎙' },
  interview3: { label: 'Interview 3', c: '#7e22ce', icon: '🎙' },
  hr: { label: 'HR round', c: '#d97706', icon: '🤝' },
  offer: { label: 'Offer', c: '#16a34a', icon: '🎉' },
  accepted: { label: 'Accepted', c: '#0f9d58', icon: '✅' },
  rejected: { label: 'Rejected', c: '#e0384a', icon: '✖' },
  withdrawn: { label: 'Withdrawn', c: '#6b7280', icon: '↩' },
};
const ACTIVE = ['applied', 'assessment', 'interview1', 'interview2', 'interview3', 'hr'];
state.apps = [];
state.trackFilter = 'all';

const ago = (iso) => {
  const d = (Date.now() - new Date(iso)) / 86400000;
  return d < 1 ? 'today' : d < 2 ? 'yesterday' : d < 30 ? `${Math.floor(d)} days ago` : new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
};

async function loadTracker() {
  const r = await api('/api/applications').catch(() => null);
  if (!r) return;
  if (!state.traceChecked) {
    state.traceChecked = true;
    chrome.storage.local.get(['lastTrace', 'lastTraceResult']).then(({ lastTrace, lastTraceResult }) => {
      if (lastTraceResult) renderTrace(lastTraceResult), ($('#traceCard').hidden = false);
      if (!lastTrace || Date.now() - lastTrace > 6 * 3600_000) traceGmail({ quiet: true }).catch(() => {});
    });
  }
  state.apps = (Array.isArray(r) ? r : r.items || []).filter((a) => a.id); // older servers return a plain list without ids
  renderTracker();
  renderJobs();
  renderGaps(await api('/api/upskill').catch(() => null));
}

// Skill-gap heatmap: missing keywords aggregated across every tailored job (server journal).
async function renderGaps(r) {
  if (!r || !r.jobs) return ($('#gapsOut').innerHTML = '<p class="hint">Tailor a resume for a job and the keywords it asked for (that you do not have yet) show up here.</p>');
  $('#gapsMeta').textContent = `${r.jobs} job${r.jobs > 1 ? 's' : ''} tracked`;
  $('#gapsOut').innerHTML =
    (r.gaps.length
      ? `<div class="chips">${r.gaps.slice(0, 12).map((g) => `<span class="chip miss" title="Asked by: ${esc(g.jobs.join(', '))}">${esc(g.term)} <b>×${g.jobs.length}</b></span>`).join('')}</div>`
      : '<p class="hint">No gaps recorded — every job you tailored for was fully covered.</p>') +
    `<button id="upskillPlan" class="btn ghost sm" style="margin-top:8px" ${r.gaps.length ? '' : 'disabled'}>🎓 Build a 6-week learning plan</button><div id="upskillOut"></div>`;
}

function renderTracker() {
  const apps = state.apps;
  renderInsights(apps);
  const count = (f) => apps.filter(f).length;
  const groups = [
    { k: 'saved', label: 'To apply', n: count((a) => a.status === 'saved'), c: STATUS.saved.c },
    { k: 'active', label: 'In process', n: count((a) => ACTIVE.includes(a.status)), c: STATUS.applied.c },
    { k: 'won', label: 'Offers', n: count((a) => ['offer', 'accepted'].includes(a.status)), c: STATUS.offer.c },
    { k: 'rejected', label: 'Rejected', n: count((a) => a.status === 'rejected'), c: STATUS.rejected.c },
  ];
  $('#trackCount').textContent = count((a) => a.status === 'saved' || ACTIVE.includes(a.status)) || '';
  $('#trackStats').innerHTML = groups.map((g) => `<div class="stat" data-g="${g.k}" style="--c:${g.c}"><b>${g.n}</b><span>${g.label}</span></div>`).join('');
  const total = apps.length || 1;
  $('#trackFunnel').innerHTML = Object.entries(STATUS)
    .map(([k, m]) => [k, m, count((a) => a.status === k)])
    .filter(([, , n]) => n)
    .map(([k, m, n]) => `<i title="${m.label}: ${n}" style="--c:${m.c};--w:${(n / total) * 100}%"></i>`)
    .join('');
  const filters = [['all', 'All', 'var(--accent)'], ['saved', 'To apply', STATUS.saved.c], ['applied', 'Applied', STATUS.applied.c], ['assessment', 'Assessment', STATUS.assessment.c], ['interviews', 'Interviews', STATUS.interview1.c], ['won', 'Offers', STATUS.offer.c], ['rejected', 'Rejected', STATUS.rejected.c]];
  $('#trackFilter').innerHTML = filters
    .map(([k, l, c]) => `<button class="sf ${state.trackFilter === k ? 'on' : ''}" data-f="${k}" style="--c:${c}">${l}</button>`)
    .join('');
  const q = $('#trackSearch').value.toLowerCase().trim();
  const match = (a) =>
    (state.trackFilter === 'all' || a.status === state.trackFilter || (state.trackFilter === 'active' && ACTIVE.includes(a.status)) || (state.trackFilter === 'won' && ['offer', 'accepted'].includes(a.status)) || (state.trackFilter === 'interviews' && ['interview1', 'interview2', 'interview3', 'hr'].includes(a.status))) &&
    (!q || `${a.title} ${a.company}`.toLowerCase().includes(q));
  const list = apps.filter(match);
  $('#trackList').innerHTML = list.length
    ? list
        .map((a, i) => {
          const m = STATUS[a.status] || STATUS.applied;
          const tl = (a.history || []).map((h, j) => `${j ? '<span class="ln"></span>' : ''}<span class="dot" style="--c:${(STATUS[h.status] || m).c}" title="${(STATUS[h.status] || m).label} · ${ago(h.at)}"></span>`).join('');
          return `<div class="app" data-id="${a.id}" style="--c:${m.c};--i:${Math.min(i, 20)}">
            <div class="app-top"><div><div class="app-title">${esc(a.title || 'Untitled role')}</div>
              <div class="app-sub">${esc([a.company, a.location].filter(Boolean).join(' · '))}${a.via === 'email' ? ' · via email' : ''} · ${a.status === 'saved' ? 'saved' : 'applied'} ${ago(a.appliedAt || a.createdAt)}</div></div>
              <select class="status-select" data-status="${a.id}" style="--c:${m.c}">${Object.entries(STATUS).map(([k, s]) => `<option value="${k}" ${k === a.status ? 'selected' : ''}>${s.icon} ${s.label}</option>`).join('')}</select></div>
            <div class="timeline">${tl}<span class="tl">${m.label}${a.history?.length ? ` · ${ago(a.history.at(-1).at)}` : ''}</span></div>
            ${mailLine(a)}${mailTimeline(a)}
            <textarea class="app-notes" data-notes="${a.id}" rows="1" placeholder="Add a note (recruiter name, test date, link…)">${esc(a.notes || '')}</textarea>
            <div class="app-actions">${a.resume ? `<a href="${esc(SERVER)}/api/resumes/${encodeURIComponent(a.resume)}" target="_blank" title="The resume you sent">📄 Resume sent</a>` : ''}${a.coverLetter ? `<a href="${esc(SERVER)}/api/resumes/${encodeURIComponent(a.coverLetter)}" target="_blank">✉️ Cover letter</a>` : ''}${a.status === 'saved' && a.url ? `<button class="go" data-apply="${a.id}">Apply now</button>` : ''}${a.url && safeUrl(a.url) !== '#' ? `<a href="${esc(a.url)}" target="_blank">Open job</a>` : ''}${coachButtons(a)}<button class="del" data-del="${a.id}">Delete</button></div><div class="app-coach" id="coach-${a.id}"></div>
          </div>`;
        })
        .join('')
    : `<div class="empty"><span class="big">🗂</span>${apps.length ? 'Nothing matches this filter.' : 'No applications yet. Submit one, or tick jobs on the Job board and press “Save to tracker”.'}</div>`;
}

// The last recruiting email about this application, or a nudge when nothing has come back for a while.
const DAY = 86400_000;
function mailLine(a) {
  const last = (a.mail || []).at(-1);
  if (last) return `<div class="app-mail k-${esc(last.kind)}" title="${esc(last.evidence || '')}">📬 ${esc(KIND_LABEL[last.kind] || last.kind)} · “${esc(String(last.subject || '').slice(0, 70))}” · ${ago(last.date)}</div>`;
  const days = Math.floor((Date.now() - new Date(a.appliedAt || a.createdAt)) / DAY);
  if (a.status === 'applied' && days >= 12) return `<div class="app-mail k-quiet">⏳ No reply in ${days} days: consider a follow-up</div>`;
  return '';
}
// Roles without a location: forms ask where each role was, and without it the AI has to guess.
function locationNote(p) {
  const missing = (p.experience || []).filter((e) => !String(e.location || '').trim()).map((e) => String(e.company || 'a role').split(',')[0]);
  return missing.length ? `<div class="item warn"><div class="q">📍 Add a location for ${esc(missing.join(', '))}</div><div class="v">Job forms ask where each role was. Without it, the answer is a guess.</div></div>` : '';
}
// Follow-up drafts and interview prep briefs on tracker cards (drafts to read and send yourself).
function coachHtml(kind, r) {
  if (kind === 'followup') return `<div class="coach"><b>${esc(r.subject || 'Follow-up')}</b><pre class="coach-text">${esc(r.body || '')}</pre><button class="btn ghost sm" data-copy="1">Copy</button></div>`;
  const list = (title, items, f) => (items || []).length ? `<p><b>${title}</b></p><ul>${items.map((x) => `<li>${f(x)}</li>`).join('')}</ul>` : '';
  return `<div class="coach coach-text"><p>${esc(r.summary || '')}</p>${list('Likely questions', r.likelyQuestions, (x) => `${esc(x.q)}<br><span class="hint">${esc(x.angle)}</span>`)}${list('Your stories', r.yourStories, (x) => `<b>${esc(x.story)}</b>: ${esc(x.use)}`)}${list('Ask them', r.askThem, esc)}${list('Day before', r.checklist, esc)}</div>`;
}
function coachButtons(a) {
  const days = Math.floor((Date.now() - new Date(a.appliedAt || a.createdAt)) / DAY);
  const last = (a.mail || []).at(-1)?.kind;
  const quiet = a.status === 'applied' && days >= 7 && !(a.mail || []).some((m) => m.kind !== 'applied');
  const interviewing = /^(interview|assessment|hr)/.test(a.status || '') || ['interview', 'assessment'].includes(last);
  return `${quiet ? `<button data-coach="followup" data-id="${a.id}">✉️ Follow-up draft</button>` : ''}${interviewing ? `<button data-coach="prep" data-id="${a.id}">🎯 Interview prep</button>` : ''}`;
}

// All the emails about one application, oldest first: its progress as the company wrote it.
function mailTimeline(a) {
  const mail = [...(a.mail || [])].sort((x, y) => new Date(x.date) - new Date(y.date));
  if (mail.length < 2) return '';
  return `<details class="app-timeline"><summary>📬 ${mail.length} emails</summary><ol>${mail.map((m) => `<li class="k-${esc(m.kind)}"><b>${esc(KIND_LABEL[m.kind] || m.kind)}</b> · ${new Date(m.date).toLocaleDateString()} · ${esc(String(m.subject || '').slice(0, 80))}</li>`).join('')}</ol></details>`;
}

const KIND_LABEL = { rejected: 'Rejected', interview: 'Interview invite', assessment: 'Assessment', offer: 'Offer', applied: 'Application received', update: 'Update', outreach: 'Recruiter' };

// Rejections and responses at a glance: what happens to your applications, and at which stage you're stopped.
function renderInsights(apps) {
  const sent = apps.filter((a) => a.status !== 'saved');
  if (!sent.length) return ($('#trackInsights').innerHTML = '');
  const responded = sent.filter((a) => (a.mail || []).some((m) => m.kind !== 'applied') || !['applied', 'saved'].includes(a.status));
  const interviews = sent.filter((a) => (a.history || []).some((h) => /interview|hr|offer|accepted/.test(h.status)));
  const rejected = sent.filter((a) => a.status === 'rejected');
  const days = rejected.map((a) => (new Date(a.rejectedAt || a.updatedAt) - new Date(a.appliedAt || a.createdAt)) / DAY).filter((d) => d >= 0).sort((x, y) => x - y);
  const median = days.length ? Math.round(days[Math.floor(days.length / 2)]) : null;
  const stage = {};
  for (const a of rejected) {
    const before = [...(a.history || [])].reverse().find((h) => h.status !== 'rejected')?.status || 'applied';
    const k = /interview|hr/.test(before) ? 'after an interview' : before === 'assessment' ? 'after the assessment' : 'at screening';
    stage[k] = (stage[k] || 0) + 1;
  }
  const pct = (n) => `${Math.round((100 * n) / sent.length)}%`;
  const quiet = sent.filter((a) => a.status === 'applied' && !(a.mail || []).length && Date.now() - new Date(a.appliedAt || a.createdAt) > 12 * DAY).length;
  $('#trackInsights').innerHTML = `<div class="ins"><b>${pct(responded.length)}</b><span>heard back</span></div><div class="ins"><b>${pct(interviews.length)}</b><span>reached interview</span></div><div class="ins"><b>${rejected.length}</b><span>rejected${median != null ? ` · median ${median} d` : ''}</span></div><div class="ins"><b>${quiet}</b><span>no reply 12+ d</span></div>
    ${rejected.length ? `<p class="hint">Rejected ${Object.entries(stage).map(([k, n]) => `${n} ${k}`).join(', ')}.${stage['at screening'] > rejected.length / 2 ? ' Most stop at screening: tailoring and keyword match matter most here.' : ''}</p>` : ''}`;
}

// ---------- Gmail outcomes ----------
async function traceGmail({ quiet = false } = {}) {
  if (!quiet) $('#traceOut').innerHTML = '<p class="hint">Reading your Gmail for application updates…</p>';
  $('#traceCard').hidden = false;
  const r = await api('/api/applications/trace', { method: 'POST', body: { apply: true } }).catch((e) => ({ error: e.message }));
  if (r.error) {
    $('#traceOut').innerHTML = `<p class="hint">${esc(r.error)}</p>`;
    return;
  }
  await chrome.storage.local.set({ lastTrace: Date.now(), lastTraceResult: r });
  await loadTracker();
  renderTrace(r);
}
function renderTrace(r) {
  state.trace = r;
  const row = (u, buttons = '') => `<div class="item ${u.kind === 'rejected' ? 'bad' : u.kind === 'offer' || u.kind === 'interview' ? '' : 'warn'}"><div class="q">${esc(u.company || u.from || '?')}${u.title ? ` · ${esc(u.title.slice(0, 50))}` : ''} <span class="tag ${u.kind === 'rejected' ? 'err' : u.kind === 'applied' ? 'review' : 'done'}">${esc(KIND_LABEL[u.kind] || u.kind)}</span> ${buttons}</div><div class="v">“${esc(u.evidence || u.subject)}”<span class="src">${esc(u.subject.slice(0, 70))} · ${ago(u.date)}</span></div></div>`;
  const applied = r.applied || [];
  const pending = (r.updates || []).filter((u) => u.change && !u.confident);
  const added = new Set((state.apps || []).flatMap((a) => (a.mail || []).map((m) => m.id)));
  const untracked = (r.unmatched || []).filter((u) => !added.has(u.mailId));
  $('#traceMeta').textContent = r.scanned ? `${r.scanned} emails read · ${r.jobEmails} about your job search · ${ago(r.at || Date.now())}` : `${r.checked} emails checked · ${ago(Date.now())}`;
  // Cumulative picture of your whole search: total tracked, each stage, and who's still silent.
  const appsNow = state.apps || [];
  const tally = (f) => appsNow.filter(f).length;
  const summary = appsNow.length
    ? `<p class="hint"><b>${appsNow.length} applications tracked</b> · 📨 ${tally((a) => a.status === 'applied')} applied · 🧪 ${tally((a) => a.status === 'assessment')} assessment · 🎙 ${tally((a) => /^(interview|hr)/.test(a.status))} interview · 🎉 ${tally((a) => ['offer', 'accepted'].includes(a.status))} offer · ✖ ${tally((a) => a.status === 'rejected')} rejected · ☆ ${tally((a) => a.status === 'saved')} to apply · 👀 ${tally((a) => a.status === 'applied' && !(a.mail || []).length)} awaiting reply</p>`
    : '';
  const addedApps = (r.added || []).filter((u) => (state.apps || []).some((a) => a.id === u.appId));
  const outreach = r.outreach || [];
  $('#traceOut').innerHTML = [
    summary,
    addedApps.length ? `<div class="page">Added from your mail (${addedApps.length})</div>${addedApps.map((u) => row({ ...u, kind: u.mail.at(-1)?.kind || 'applied', evidence: u.mail.at(-1)?.evidence, subject: u.mail.at(-1)?.subject || '', date: u.mail.at(-1)?.date, title: `${u.title ? `${u.title} · ` : ''}${u.mail.length} email${u.mail.length > 1 ? 's' : ''}` }, `<button class="btn ghost sm" data-unadd="${esc(u.appId)}">Remove</button>`)).join('')}` : '',
    applied.length ? `<div class="page">Updated (${applied.length})</div>${applied.map((u) => row({ ...u, title: `${STATUS[u.from_status]?.label || u.from_status} → ${STATUS[u.to_status]?.label || u.to_status}` }, `<button class="btn ghost sm" data-undo="${esc(u.appId)}" data-to="${esc(u.from_status)}">Undo</button>`)).join('')}` : '',
    pending.length ? `<div class="page">Check these (${pending.length})</div>${pending.map((u) => row(u, `<button class="btn ghost sm" data-confirm="${esc(u.appId)}" data-to="${esc(u.to_status)}" data-mail="${esc(u.mailId)}">Apply</button>`)).join('')}` : '',
    untracked.length ? `<div class="page">Not in your tracker (${untracked.length}) <button class="btn ghost sm" data-addall="1">Add all</button></div>${untracked.map((u, i) => row(u, `<button class="btn ghost sm" data-add="${i}">Add</button>`)).join('')}` : '',
    outreach.length ? `<details class="trace-outreach"><summary class="page">Recruiters writing to you (${outreach.length})</summary>${outreach.map((u) => row(u)).join('')}</details>` : '',
    !addedApps.length && !applied.length && !pending.length && !untracked.length && !outreach.length ? '<p class="hint">Nothing new: your tracker matches your inbox.</p>' : '',
  ].join('');
  state.untracked = untracked;
}
const TO_STATUS_UI = { rejected: 'rejected', interview: 'interview1', assessment: 'assessment', offer: 'offer', applied: 'applied' };
async function addFromMail(u) {
  const a = await api('/api/applications', { method: 'POST', body: { title: u.title || '(role from email)', company: u.company || u.from, status: TO_STATUS_UI[u.kind] || 'applied', notes: `From Gmail: ${u.subject}` } });
  await api(`/api/applications/${a.id}`, { method: 'PATCH', body: { mail: { id: u.mailId, kind: u.kind, subject: u.subject, from: u.from, date: u.date, evidence: u.evidence } } });
}
$('#traceOut').addEventListener('click', async (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  b.disabled = true;
  try {
    if (b.dataset.undo) await patchApp(b.dataset.undo, { status: b.dataset.to });
    if (b.dataset.unadd) {
      await api(`/api/applications/${b.dataset.unadd}`, { method: 'DELETE' });
      await loadTracker();
    }
    if (b.dataset.confirm) {
      const u = state.trace.updates.find((x) => x.mailId === b.dataset.mail);
      await patchApp(b.dataset.confirm, { status: b.dataset.to, mail: { id: u.mailId, kind: u.kind, subject: u.subject, from: u.from, date: u.date, evidence: u.evidence } });
    }
    if (b.dataset.add) await addFromMail(state.untracked[Number(b.dataset.add)]);
    if (b.dataset.addall) for (const u of state.untracked) await addFromMail(u);
    b.textContent = '✓';
    if (b.dataset.add || b.dataset.addall) {
      await loadTracker();
      renderTrace(state.trace);
    }
  } catch (err) {
    toast(err.message, true);
    b.disabled = false;
  }
});


async function patchApp(id, body) {
  const a = await api(`/api/applications/${id}`, { method: 'PATCH', body });
  state.apps = state.apps.map((x) => (x.id === id ? a : x));
  renderTracker();
  return a;
}

// ---------- apply by email ----------
function showEmails(emails = []) {
  $('#emailFound').innerHTML = emails.map((e) => `<button class="chip" data-email="${esc(e)}">${esc(e)}</button>`).join('');
  if (emails.length && !$('#emailTo').value) $('#emailTo').value = emails[0];
  $('#emailMeta').textContent = emails.length ? `${emails.length} recruiter email${emails.length > 1 ? 's' : ''} found` : '';
  if (emails.length) $('#emailCard').open = true;
}

function renderAttachments() {
  const files = [state.resume?.key === jobKey() && { ...state.resume, kind: 'Resume' }, state.cover?.key === jobKey() && $('#autoCover').checked && { ...state.cover, kind: 'Cover letter' }].filter(Boolean);
  $('#emailAttach').innerHTML = files.length
    ? files.map((f) => `<span class="file">📎 <a href="${b64ToBlobUrl(f.pdfBase64, 'application/pdf')}" target="_blank">${esc(f.filename)}</a></span>`).join('')
    : '<span class="hint">Resume and cover letter are attached once written.</span>';
  return files;
}

async function draftEmail() {
  if (currentJob().description.length < 80) await readJob();
  await ensureResume();
  if ($('#autoCover').checked) await ensureCover();
  renderAttachments();
  progress('Writing the application email…');
  const out = await api('/api/email/draft', { method: 'POST', body: { job: currentJob(), keywords: state.resume?.keywords?.covered } });
  $('#emailSubject').value = out.subject;
  $('#emailBody').value = out.body;
  $('#emailCard').open = true;
  $('#emailOut').innerHTML = '<p class="hint">Read and edit the email. Nothing is sent until you press <b>Send email</b> twice.</p>';
  progress('Email ready: review it, then press Send email');
  setStep('review');
}

async function sendEmail() {
  const to = $('#emailTo').value.trim();
  const subject = $('#emailSubject').value.trim();
  const body = $('#emailBody').value.trim();
  if (!to || !subject || !body) throw new Error('Fill in To, Subject and Message first (or press Write email)');
  const files = renderAttachments();
  if (!files.length) throw new Error('Write the tailored resume first (press Write email)');
  if (!state.emailArmed || Date.now() - state.emailArmed > 10000) {
    state.emailArmed = Date.now();
    $('#sendEmail').classList.add('armed');
    setTimeout(() => $('#sendEmail').classList.remove('armed'), 10000);
    $('#emailOut').innerHTML = `<p><b>Press Send email again within 10 seconds</b> to send to ${esc(to)} with ${files.length} attachment${files.length > 1 ? 's' : ''}.</p>`;
    return;
  }
  state.emailArmed = 0;
  $('#sendEmail').classList.remove('armed');
  const r = await api('/api/email/send', {
    method: 'POST',
    body: { to, subject, body, job: { ...currentJob(), url: state.job?.url }, attachments: files.map((f) => ({ filename: f.filename, base64: f.pdfBase64, mime: 'application/pdf' })) },
  });
  $('#emailOut').innerHTML = `<p><span class="tag done">sent</span> Sent to ${esc(r.accepted?.join(', ') || to)} from your Gmail. Added to your Tracker as Applied.</p>`;
  toast('Email sent 🎉');
  setStep('review', true);
  loadTracker();
  if (state.queueIdx >= 0) setTimeout(() => nextInQueue(), 3000);
}

// ---------- hackathons ----------
const PLAT = {
  devpost: { name: 'Devpost', c: '#0ea5b7' },
  unstop: { name: 'Unstop', c: '#3b82f6' },
  devfolio: { name: 'Devfolio', c: '#3770ff' },
  hackerearth: { name: 'HackerEarth', c: '#7c8cff' },
  hack2skill: { name: 'Hack2skill', c: '#e2512c' },
  lablab: { name: 'lablab.build', c: '#7c3aed' },
  taikai: { name: 'Taikai', c: '#ff2d55' },
  hackindia: { name: 'HackIndia', c: '#ff7a00' },
  mlh: { name: 'MLH', c: '#1d539f' },
  ethglobal: { name: 'ETHGlobal', c: '#6b5bff' },
};

// How well a hackathon fits you: your skills named in it, its themes against your profile, career perks,
// whether you can take part (online / India), and time left to register.
const MY_THEMES = {
  'AI / ML': /\b(ai|ml|machine learning|deep learning|llm|nlp|pytorch|tensorflow|computer vision|genai|data science|rag|agents?)\b/i,
  'Web3': /blockchain|web3|solidity|ethereum|smart contract/i,
  'FinTech': /fintech|finance|payments?|banking|trading/i,
  'Mobile / Web': /react|node|javascript|typescript|frontend|full[\s-]?stack|next\.?js|flutter|android|ios|mern/i,
  'Cloud / DevOps': /aws|azure|gcp|docker|kubernetes|devops|cloud|terraform/i,
  'Security': /security|cyber|ctf/i,
  'Hardware / IoT': /iot|embedded|arduino|raspberry|robotics|drone/i,
  'Health': /health|medical|bio/i,
  'Climate': /climate|energy|sustainab/i,
  'Gaming': /unity|unreal|game/i,
};
function hackMatch(h) {
  const p = state.profile || {};
  if (!state.myHackProfile || state.myHackProfile.p !== p) {
    // Skills are kept in groups ({ category, items }); one- and two-letter ones ("C", "Go") would match ordinary words.
    const flat = (p.skills || []).flatMap((s) => (typeof s === 'string' ? [s] : s?.items || []));
    const skills = [...new Set(flat.map((s) => String(s).toLowerCase().trim()).filter((s) => s.length >= 3 && s.length <= 30))];
    const text = `${p.headline || ''} ${flat.join(' ')} ${(p.experience || []).map((e) => e.title).join(' ')} ${(p.projects || []).map((x) => x.name).join(' ')}`;
    state.myHackProfile = { p, skills: skills.map((s) => [s, new RegExp(`[^a-z0-9]${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^a-z0-9]`)]), themes: Object.keys(MY_THEMES).filter((t) => MY_THEMES[t].test(text)) };
  }
  const me = state.myHackProfile;
  const text = ` ${h.title} ${(h.tags || []).join(' ')} ${h.rewards || ''} `.toLowerCase();
  const hits = me.skills.filter(([, re]) => re.test(text)).map(([s]) => s).slice(0, 3);
  const themes = (h.themes || []).filter((t) => me.themes.includes(t));
  const perks = h.perks || [];
  const days = h.deadline ? (new Date(h.deadline) - Date.now()) / 86400000 : 30;
  const reachable = h.mode === 'online' || /india/i.test(`${h.location} ${h.title}`) || ['unstop', 'devfolio', 'hack2skill', 'hackindia'].includes(h.platform);
  // Fit comes first: perks and prizes count fully only for hackathons in your field (a PPO on a slide-deck contest isn't for you).
  const fit = hits.length * 3 + themes.length * 4;
  const perkScore = (perks.includes('PPO') ? 6 : 0) + (perks.includes('PPI') ? 4 : 0) + (perks.length ? 2 : 0);
  const score = fit + perkScore * (fit ? 1 : 0.3) + (reachable ? 3 : 0) + (days >= 2 && days <= 21 ? 1 : 0) + Math.min(3, Math.log10((h.prizeUSD || 0) + 1) / 1.5) * (fit ? 1 : 0.3);
  return { score, hits, themes };
}
state.hacks = [];
state.hackOff = new Set();
state.hackMode = 'all';
state.savedHacks = new Set();

function closesIn(iso) {
  if (!iso) return null;
  const days = (new Date(iso) - Date.now()) / 86400000;
  if (days < 0) return null;
  if (days < 1) return { text: `closes in ${Math.max(1, Math.round(days * 24))}h`, cls: 'urgent' };
  if (days < 4) return { text: `closes in ${Math.ceil(days)} days`, cls: 'soon' };
  return { text: `closes ${new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`, cls: '' };
}

async function loadHacks(refresh = false) {
  $('#hackSummary').textContent = `Fetching hackathons from ${Object.keys(PLAT).length} platforms…`;
  $('#hackList').innerHTML = Array.from({ length: 4 }, (_, i) => `<div class="hack skel" style="--i:${i}" aria-hidden="true"><div class="thumb"></div><div class="body"><i></i><i></i><i></i></div></div>`).join('');
  const r = await api(`/api/hackathons${refresh ? '?refresh=1' : ''}`).catch((e) => {
    $('#hackList').innerHTML = `<div class="empty"><span class="big">⚠️</span>${esc(e.message)}<br>Press Refresh to try again.</div>`;
    throw e;
  });
  state.hacks = r.items || [];
  state.hackSources = r.sources || {};
  renderHacks();
}

function renderHacks() {
  const src = state.hackSources || {};
  $('#hackPlatforms').innerHTML = Object.entries(PLAT)
    .map(([k, p]) => {
      const st = src[k];
      const n = state.hacks.filter((h) => h.platform === k).length;
      return `<button class="plat ${state.hackOff.has(k) ? 'off' : ''} ${st && !st.ok ? 'err' : ''}" data-p="${k}" style="--c:${p.c}" title="${st && !st.ok ? esc(st.error) : 'Tap to show / hide'}"><i></i>${p.name} <b>${st && !st.ok ? '!' : n}</b></button>`;
    })
    .join('');
  const q = $('#hackSearch').value.toLowerCase().trim();
  const words = q.split(/[\s,]+/).filter(Boolean);
  const india = $('#hackIndia').checked;
  // Themes on offer, with counts (kept as chosen across refreshes).
  const counts = {};
  for (const h of state.hacks) for (const t of h.themes || []) counts[t] = (counts[t] || 0) + 1;
  const theme = $('#hackTheme').value;
  $('#hackTheme').innerHTML = `<option value="">All themes</option>${Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([t, n]) => `<option value="${esc(t)}" ${t === theme ? 'selected' : ''}>${esc(t)} (${n})</option>`).join('')}`;
  const week = $('#hackWeek').checked;
  let list = state.hacks.filter(
    (h) =>
      !state.hackOff.has(h.platform) &&
      (state.hackMode === 'all' || h.mode === state.hackMode) &&
      (!$('#hackSaved').checked || state.savedHacks.has(h.id)) &&
      (!$('#hackPPO').checked || (h.perks || []).length > 0) &&
      (!theme || (h.themes || []).includes(theme)) &&
      (!week || (h.deadline && new Date(h.deadline) - Date.now() < 7 * 86400000)) &&
      (!india || h.mode === 'online' || /india|delhi|mumbai|bengaluru|bangalore|chennai|hyderabad|pune|kolkata|noida|gurgaon|gurugram|lucknow|jaipur|ahmedabad/i.test(`${h.location} ${h.title}`) || ['unstop', 'devfolio', 'hack2skill', 'hackindia'].includes(h.platform)) &&
      (!words.length || words.every((w) => `${h.title} ${h.organizer} ${h.location} ${(h.tags || []).join(' ')} ${h.mode}`.toLowerCase().includes(w))),
  );
  const sort = $('#hackSort').value;
  const far = 8.64e15;
  if (sort === 'deadline') list.sort((a, b) => (a.deadline ? new Date(a.deadline) : far) - (b.deadline ? new Date(b.deadline) : far));
  if (sort === 'prize') list.sort((a, b) => (b.prizeUSD || 0) - (a.prizeUSD || 0));
  // With the PPI / PPO filter on, offers first, then interviews, then internships and hiring tracks.
  const rank = (h) => ((h.perks || []).includes('PPO') ? 3 : 0) + ((h.perks || []).includes('PPI') ? 2 : 0) + ((h.perks || []).length ? 1 : 0);
  if ($('#hackPPO').checked) list.sort((a, b) => rank(b) - rank(a));
  if (sort === 'popular') list.sort((a, b) => (b.participants || 0) - (a.participants || 0));
  const fit = new Map(list.map((h) => [h.id, hackMatch(h)]));
  if (sort === 'match') list.sort((a, b) => fit.get(b.id).score - fit.get(a.id).score || (a.deadline ? new Date(a.deadline) : far) - (b.deadline ? new Date(b.deadline) : far));
  $('#hackSummary').textContent = `${list.length} open hackathons${state.hacks.length !== list.length ? ` (of ${state.hacks.length})` : ''} · only events still open (finished ones are excluded) · updated ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  $('#hackList').innerHTML = list.length
    ? list
        .slice(0, 150)
        .map((h, i) => {
          const p = PLAT[h.platform] || { name: h.platform, c: 'var(--accent)' };
          const cl = closesIn(h.deadline);
          const initials = h.title.replace(/[^A-Za-z0-9 ]/g, '').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
          const img = safeImg(h.image);
          const thumb = img ? `style="background-image:url('${esc(img)}')"` : `style="background:${p.c}"`;
          return `<div class="hack" style="--c:${p.c};--i:${Math.min(i, 30)}">
            <div class="thumb" ${thumb}>${img ? '' : esc(initials)}</div>
            <div class="body">
              <div class="t"><a href="${esc(safeUrl(h.url))}" target="_blank">${esc(h.title)}</a></div>
              <div class="m">${[h.organizer && h.organizer !== p.name ? esc(h.organizer) : '', h.mode ? esc(h.mode) : '', h.location ? `📍 ${esc(h.location)}` : '', h.participants ? `👥 ${Number(h.participants).toLocaleString()}` : '', h.stage ? esc(h.stage) : ''].filter(Boolean).join(' · ')}</div>
              <div class="badges">${(() => { const m = fit.get(h.id); const why = [...m.hits, ...m.themes.filter((t) => !m.hits.length)].slice(0, 3); return why.length ? `<span class="hb match" title="Matches your profile">✨ ${esc(why.join(', '))}</span>` : ''; })()}<span class="hb plat-b">${p.name}</span>${h.prize ? `<span class="hb prize">🏆 ${esc(h.prize)}</span>` : ''}${(h.perks || []).map((k) => `<span class="hb perk" title="${esc(h.rewards || k)}">🎯 ${esc(k)}</span>`).join('')}${cl ? `<span class="hb ${cl.cls}">⏰ ${cl.text}</span>` : ''}${(h.tags || []).slice(0, 3).map((t) => `<span class="hb">${esc(t)}</span>`).join('')}</div>
            </div>
            ${h.deadline || h.start ? `<button class="save cal" data-cal="${esc(h.id)}" title="Add to your calendar (reminder a day before)">📅</button>` : ''}
            <button class="save ${state.savedHacks.has(h.id) ? 'on' : ''}" data-save="${esc(h.id)}" title="Save">${state.savedHacks.has(h.id) ? '★' : '☆'}</button>
          </div>`;
        })
        .join('')
    : `<div class="empty"><span class="big">🔎</span>No hackathons match. Try clearing the search or filters.</div>`;
}

// ---------- documents ----------
const DOC_NAMES = { photo: 'Photo', signature: 'Signature', marksheet10: '10th marksheet', marksheet12: '12th marksheet', idProof: 'ID proof (Aadhaar)', addressProof: 'Address proof', panCard: 'PAN card', degree: 'Degree certificate', transcript: 'Transcript / grade card' };
async function loadDocs() {
  const r = await api('/api/documents').catch(() => null);
  if (!r) return;
  const saved = r.saved || {};
  $('#docsMeta').textContent = `${Object.keys(saved).length}/${r.kinds.length} added`;
  $('#docs').innerHTML = r.kinds
    .map((k) => `<div class="doc ${saved[k] ? 'has' : ''}"><div class="dn"><b>${esc(DOC_NAMES[k] || k)}</b><span>${saved[k] ? '✓ ' + esc(saved[k]) : 'not added'}</span></div>
      <button class="btn ghost sm" data-doc-add="${k}">${saved[k] ? 'Replace' : 'Add'}</button>${saved[k] ? `<button class="btn ghost sm" data-doc-del="${k}">Remove</button>` : ''}</div>`)
    .join('');
}
let docKind = null;
$('#docs').addEventListener('click', async (e) => {
  const add = e.target.dataset.docAdd;
  const del = e.target.dataset.docDel;
  if (add) {
    docKind = add;
    $('#docFile').value = '';
    $('#docFile').click();
  }
  if (del) {
    await api(`/api/documents/${del}`, { method: 'DELETE' }).catch((err) => toast(err.message, true));
    loadDocs();
  }
});
$('#docFile').addEventListener('change', async () => {
  const file = $('#docFile').files[0];
  if (!file || !docKind) return;
  const fd = new FormData();
  fd.append('file', file);
  try {
    await api(`/api/documents/${docKind}`, { method: 'POST', body: fd });
    toast(`${DOC_NAMES[docKind]} saved`);
  } catch (err) {
    toast(err.message, true);
  }
  loadDocs();
});

// ---------- wiring ----------
function switchTab(name) {
  if (name === 'hacks' && !state.hacks.length) loadHacks().catch((e) => toast(e.message, true));
  const btns = [...document.querySelectorAll('nav button')];
  btns.forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  $('#tabPill').style.transform = `translateX(${btns.findIndex((b) => b.dataset.tab === name) * 100}%)`;
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.id === `tab-${name}`));
}

async function checkServer() {
  const s = $('#status');
  try {
    const h = await api('/api/health');
    // Most Gemini models out of quota: say so, since AI-only questions will be slow or left for you.
    const limited = (h.resting || []).length >= 4;
    s.querySelector('.pill-text').textContent = h.usingLocalAI ? 'local AI (Gemini quota out)' : limited ? 'AI quota low' : `${h.llm.model.replace(/^gemini-/, 'gemini ')}${h.gmail ? ' · gmail ✓' : ''}`;
    s.title = `${h.llm.provider} · ${h.llm.model} · Gmail ${h.gmail ? 'connected' : 'not connected'} · AI requests today: ${h.ai?.calls ?? '?'}${h.ai?.failed ? ` (${h.ai.failed} failed)` : ''}${(h.resting || []).length ? ` · resting: ${h.resting.map((r) => r.model).join(', ')}` : ''}`;
    if (h.ai) s.querySelector('.pill-text').textContent += ` · ${h.ai.calls} AI`;
    s.className = `pill ${limited && !h.usingLocalAI ? 'warn' : 'ok'}`;
    renderProfile(await api('/api/profile'));
    loadTracker();
    loadDocs();
  } catch {
    s.querySelector('.pill-text').textContent = 'server offline';
    s.title = 'Run "npm start" in the server folder';
    s.className = 'pill bad';
  }
}

document.querySelectorAll('nav button').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));
const on = (id, fn) => $(id).addEventListener('click', (e) => busy(e.currentTarget, fn)().catch(() => {}));
on('#runAll', runAll);
on('#traceGmail', () => traceGmail());
on('#reportForm', async () => {
  const tab = await activeTab();
  const shot = (await callFrame(tab.id, 0, 'snapshotForm')) || {};
  if (!shot.html) throw new Error('Could not read this page');
  const failures = (await collectFieldErrors(tab).catch(() => [])).map((e) => ({ label: e.label, error: e.error }));
  const r = await api('/api/report-form', { method: 'POST', body: { ...shot, failures } });
  toast(`Saved ${r.file}: share it (or ask Claude to fix it) and it becomes a regression test`);
  state.log.push(`<div class="page">🐞 Reported</div><div class="item"><div class="q">Saved a scrubbed copy of this form</div><div class="v">${esc(r.file)}<span class="src">no values, emails or phone numbers are in it</span></div></div>`);
  $('#fillOut').innerHTML = `<p class="hint">Green outline = filled · orange = please check.</p>${state.log.join('')}`;
});
on('#readJob', readJob);
on('#research', () => research());
on('#refreshResearch', () => research({ refresh: true }));
on('#tailor', tailor);
on('#cover', coverLetter);
on('#fill', async () => {
  state.log = [];
  document.querySelector('.submit-card').hidden = false;
  state.startedAt ||= Date.now() - 10 * 60_000;
  await openApplication(await activeTab()); // on a job page, press "Apply now" first
  await fillPage(1);
});
on('#continue', async () => {
  state.log = [];
  state.startedAt ||= Date.now() - 10 * 60_000;
  await runPages();
});
on('#submit', submit);
on('#importResume', importResume);
on('#saveProfile', saveProfile);
on('#openBoard', openBoard);
on('#scanBoard', scanBoard);
on('#skipJob', nextInQueue);

// ---------- scripts ----------
const loadScript = async (name) => (await fetch(chrome.runtime.getURL(`scripts/${name}`))).text();
// Your own copy (scripts/wellfound-autoapply.local.js, never committed) wins. Otherwise the public template,
// with its YOUR DETAILS block filled in from your Auto Job profile.
async function wellfoundScript() {
  const own = await fetch(chrome.runtime.getURL('scripts/wellfound-autoapply.local.js')).then((r) => (r.ok ? r.text() : '')).catch(() => '');
  if (own.trim()) return { code: own, source: 'your own copy' };
  const code = await loadScript('wellfound-autoapply.js');
  const p = state.profile;
  if (!p?.name) return { code, source: 'template: fill in YOUR DETAILS before running it' };
  const exp = p.experience || [];
  const me = {
    name: p.name,
    pitch: (p.headline ? `a ${p.headline.split('|')[0].trim()}` : 'an engineer') + (p.education?.[0]?.degree ? ` (${[p.education[0].degree, p.education[0].field].filter(Boolean).join(' ').replace(/\s*\(.*?\)/g, '')} at ${String(p.education[0].school || '').split(',')[0]})` : '') + ' who loves building and shipping products from 0 to 1',
    highlights: [
      ...exp.slice(0, 2).map((e) => `${e.title} @ ${String(e.company).split(',')[0]}: ${String(e.bullets?.[0] || '').replace(/\.$/, '')}`),
      p.achievements?.[0],
      (p.skills || []).flatMap((g) => g.items).slice(0, 10).join(', '),
    ].filter(Boolean).map((x) => String(x).slice(0, 220)),
    closing: "I thrive in fast-paced startup teams where you own the problem from architecture to deployment, and I'd love to contribute to what you're building.",
    links: Object.fromEntries([['Portfolio', p.links?.portfolio], ['GitHub', p.links?.github], ['LinkedIn', p.links?.linkedin]].filter(([, u]) => u)),
  };
  const filled = code.replace(/const ME = \{[\s\S]*?\n  \};/, `const ME = ${JSON.stringify(me, null, 2).replace(/\n/g, '\n  ')};`);
  return { code: filled, source: 'template, filled from your profile' };
}
on('#copyWellfound', async () => {
  const { code, source } = await wellfoundScript();
  await navigator.clipboard.writeText(code);
  const btn = $('#copyWellfound');
  btn.classList.add('copied');
  btn.querySelector('span').textContent = 'Copied ✓';
  toast(`Script copied (${source}). Paste it into the Wellfound console.`);
  setTimeout(() => {
    btn.classList.remove('copied');
    btn.querySelector('span').textContent = 'Copy script';
  }, 2500);
});
$('#viewWellfound').addEventListener('click', async () => {
  const pre = $('#wellfoundCode');
  if (pre.hidden && !pre.textContent) pre.textContent = (await wellfoundScript()).code;
  pre.hidden = !pre.hidden;
  $('#viewWellfound').textContent = pre.hidden ? 'View' : 'Hide';
});

// LinkedIn Easy Apply script: same convention (your own *.local.js copy wins), with the placeholder fields
// filled from your profile. The answers map (regexes) is kept intact — only the personal fields are replaced.
function fillContactPlaceholders(code, p) {
  return code
    .replace(/name: 'YOUR FULL NAME'/, `name: ${JSON.stringify(p.name)}`)
    .replace(/email: 'YOUR EMAIL'/, `email: ${JSON.stringify(p.email)}`)
    .replace(/phone: 'YOUR PHONE WITH COUNTRY CODE'/, `phone: ${JSON.stringify(p.phone)}`)
    .replace(/city: 'YOUR CITY'/, `city: ${JSON.stringify(p.answers?.currentLocation || p.location || p.personal?.city || '')}`)
    .replace(/Portfolio: 'https:\/\/YOUR-PORTFOLIO\.example'/, `Portfolio: ${JSON.stringify(p.links?.portfolio || '')}`)
    .replace(/GitHub: 'https:\/\/github\.com\/YOUR-USERNAME'/, `GitHub: ${JSON.stringify(p.links?.github || '')}`)
    .replace(/LinkedIn: 'https:\/\/www\.linkedin\.com\/in\/YOUR-PROFILE'/, `LinkedIn: ${JSON.stringify(p.links?.linkedin || '')}`);
}
async function linkedinScript() {
  const own = await fetch(chrome.runtime.getURL('scripts/linkedin-autoapply.local.js')).then((r) => (r.ok ? r.text() : '')).catch(() => '');
  if (own.trim()) return { code: own, source: 'your own copy' };
  const code = await loadScript('linkedin-autoapply.js');
  const p = state.profile;
  if (!p?.name) return { code, source: 'template: fill in YOUR DETAILS before running it' };
  return { code: fillContactPlaceholders(code, p), source: 'template, filled from your profile' };
}
on('#copyLinkedin', async () => {
  const { code, source } = await linkedinScript();
  await navigator.clipboard.writeText(code);
  const btn = $('#copyLinkedin');
  btn.classList.add('copied');
  btn.querySelector('span').textContent = 'Copied ✓';
  toast(`Script copied (${source}). Paste it into the LinkedIn console.`);
  setTimeout(() => {
    btn.classList.remove('copied');
    btn.querySelector('span').textContent = 'Copy script';
  }, 2500);
});
$('#viewLinkedin').addEventListener('click', async () => {
  const pre = $('#linkedinCode');
  if (pre.hidden && !pre.textContent) pre.textContent = (await linkedinScript()).code;
  pre.hidden = !pre.hidden;
  $('#viewLinkedin').textContent = pre.hidden ? 'View' : 'Hide';
});

// Naukri auto-apply script: same convention (own *.local.js copy wins; placeholders filled from the profile).
async function naukriScript() {
  const own = await fetch(chrome.runtime.getURL('scripts/naukri-autoapply.local.js')).then((r) => (r.ok ? r.text() : '')).catch(() => '');
  if (own.trim()) return { code: own, source: 'your own copy' };
  const code = await loadScript('naukri-autoapply.js');
  const p = state.profile;
  if (!p?.name) return { code, source: 'template: fill in YOUR DETAILS before running it' };
  return { code: fillContactPlaceholders(code, p), source: 'template, filled from your profile' };
}
on('#copyNaukri', async () => {
  const { code, source } = await naukriScript();
  await navigator.clipboard.writeText(code);
  const btn = $('#copyNaukri');
  btn.classList.add('copied');
  btn.querySelector('span').textContent = 'Copied ✓';
  toast(`Script copied (${source}). Paste it into the Naukri console.`);
  setTimeout(() => {
    btn.classList.remove('copied');
    btn.querySelector('span').textContent = 'Copy script';
  }, 2500);
});
$('#viewNaukri').addEventListener('click', async () => {
  const pre = $('#naukriCode');
  if (pre.hidden && !pre.textContent) pre.textContent = (await naukriScript()).code;
  pre.hidden = !pre.hidden;
  $('#viewNaukri').textContent = pre.hidden ? 'View' : 'Hide';
});
on('#selectAll', async () => {
  visibleJobs().forEach(({ j }) => (j.selected = !j.premium || $('#includePremium').checked)); // premium jobs need a premium login
  renderJobs();
});
on('#scanAll', scanAllBoards);
on('#saveSelected', async () => {
  const items = state.boardJobs.filter((j) => j.selected && j.url).map((j) => ({ title: j.title.split(' — ')[0], company: j.title.split(' — ')[1] || j.source, url: j.url, location: j.meta?.split(' · ')[0], source: j.source, status: 'saved' }));
  if (!items.length) throw new Error('Tick the jobs you want to save');
  await api('/api/applications/bulk', { method: 'POST', body: { items } });
  await loadTracker();
  toast(`Saved ${items.length} job${items.length > 1 ? 's' : ''} to your Tracker`);
});
on('#draftEmail', draftEmail);
on('#sendEmail', sendEmail);
$('#emailFound').addEventListener('click', (e) => {
  if (e.target.dataset.email) $('#emailTo').value = e.target.dataset.email;
});
on('#refreshTracker', loadTracker);
// Tracker as CSV for Excel / Sheets. Cells starting with = + - @ are prefixed with ' so a spreadsheet never runs them as formulas.
const csvCell = (v) => `"${String(v ?? '').replace(/^[=+\-@\t\r]/, "'$&").replace(/"/g, '""')}"`;
// Excel: each tab's button exports that tab's sheet (data-sheet), colour-coded with Apply links.
document.querySelectorAll('.xlsx-export').forEach((b) => b.addEventListener('click', busy(b, async () => {
  if (!state.apps.length) state.apps = ((await api('/api/applications').catch(() => ({}))).items || []).filter((a) => a.id);
  const jobs = visibleJobs().map(({ j, m }) => ({ ...j, score: m.score, status: state.apps.find((x) => x.url && j.url && x.url.split('#')[0] === j.url.split('#')[0])?.status }));
  const sheet = b.dataset.sheet;
  const blob = await api('/api/export', { method: 'POST', body: { jobs: sheet === 'jobs' ? jobs : [], only: sheet }, raw: true });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `auto-job-${sheet}-${new Date().toISOString().slice(0, 10)}.xlsx` });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  toast(`Excel file saved: ${sheet}`);
})));
$('#exportCsv').addEventListener('click', () => {
  const cols = ['company', 'title', 'status', 'appliedAt', 'updatedAt', 'location', 'url', 'via', 'contact', 'notes'];
  saveFile(`applications-${new Date().toISOString().slice(0, 10)}.csv`, [cols, ...state.apps.map((a) => cols.map((c) => a[c]))].map((r) => r.map(csvCell).join(',')).join('\r\n'), 'text/csv');
});
on('#refreshHacks', () => loadHacks(true));
$('#hackSearch').addEventListener('input', renderHacks);
$('#hackSort').addEventListener('change', renderHacks);
$('#hackTheme').addEventListener('change', renderHacks);
$('#hackWeek').addEventListener('change', renderHacks);
$('#hackSaved').addEventListener('change', renderHacks);
$('#hackPPO').addEventListener('change', renderHacks);
$('#hackIndia').addEventListener('change', renderHacks);
$('#hackMode').addEventListener('click', (e) => {
  const m = e.target.dataset.m;
  if (!m) return;
  state.hackMode = m;
  document.querySelectorAll('#hackMode button').forEach((b) => b.classList.toggle('on', b.dataset.m === m));
  renderHacks();
});
$('#hackPlatforms').addEventListener('click', (e) => {
  const k = e.target.closest('[data-p]')?.dataset.p;
  if (!k) return;
  state.hackOff.has(k) ? state.hackOff.delete(k) : state.hackOff.add(k);
  renderHacks();
});
// A calendar file (.ics) for the deadline, or the start when there's no deadline; opens in Calendar / Outlook / Google.
const saveFile = (name, text, type) => {
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([text], { type })), download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
};
const icsTime = (d) => new Date(d).toISOString().replace(/[-:]|\.\d{3}/g, '');
const icsText = (s) => String(s).replace(/[\\;,]/g, (c) => `\\${c}`).replace(/\r?\n/g, '\\n');
function hackIcs(h) {
  const at = h.deadline || h.start;
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Auto Job//Hackathons//EN', 'BEGIN:VEVENT', `UID:${icsText(h.id)}@autojob`, `DTSTAMP:${icsTime(Date.now())}`, `DTSTART:${icsTime(at)}`, `DTEND:${icsTime(new Date(at).getTime() + 1800_000)}`,
    `SUMMARY:${icsText(`${h.deadline ? 'Closes' : 'Starts'}: ${h.title}`)}`, `DESCRIPTION:${icsText(h.url)}`, `URL:${icsText(h.url)}`,
    'BEGIN:VALARM', 'TRIGGER:-P1D', 'ACTION:DISPLAY', `DESCRIPTION:${icsText(`Tomorrow: ${h.title}`)}`, 'END:VALARM', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
}
$('#hackList').addEventListener('click', (e) => {
  const cal = state.hacks.find((h) => h.id === e.target.dataset.cal);
  if (cal) return saveFile(`${cal.title.replace(/[^\w -]+/g, '').slice(0, 60) || 'hackathon'}.ics`, hackIcs(cal), 'text/calendar');
  const id = e.target.dataset.save;
  if (!id) return;
  state.savedHacks.has(id) ? state.savedHacks.delete(id) : state.savedHacks.add(id);
  chrome.storage.local.set({ savedHacks: [...state.savedHacks] }).catch(() => {});
  e.target.classList.toggle('on');
  e.target.textContent = state.savedHacks.has(id) ? '★' : '☆';
  toast(state.savedHacks.has(id) ? 'Saved hackathon' : 'Removed from saved');
});
$('#trackSearch').addEventListener('input', renderTracker);
$('#trackFilter').addEventListener('click', (e) => {
  if (!e.target.dataset.f) return;
  state.trackFilter = e.target.dataset.f;
  renderTracker();
});
$('#trackStats').addEventListener('click', (e) => {
  const g = e.target.closest('[data-g]')?.dataset.g;
  if (!g) return;
  state.trackFilter = g;
  renderTracker();
});
$('#trackList').addEventListener('change', async (e) => {
  const id = e.target.dataset.status;
  if (!id) return;
  await patchApp(id, { status: e.target.value }).catch((err) => toast(err.message, true));
  toast(`Moved to ${STATUS[e.target.value].label}`);
});
$('#trackList').addEventListener('focusout', async (e) => {
  const id = e.target.dataset.notes;
  if (!id) return;
  const a = state.apps.find((x) => x.id === id);
  if (a && (a.notes || '') !== e.target.value) await patchApp(id, { notes: e.target.value }).catch(() => {});
});
$('#trackList').addEventListener('click', async (e) => {
  const coach = e.target.dataset.coach;
  if (coach) {
    const id = e.target.dataset.id;
    const box = $(`#coach-${id}`);
    box.innerHTML = `<p class="hint">${coach === 'prep' ? 'Preparing your brief…' : 'Writing a draft…'}</p>`;
    try {
      box.innerHTML = coachHtml(coach, await api(`/api/applications/${id}/${coach}`, { method: 'POST' }));
    } catch (err) {
      box.innerHTML = `<p class="hint">${esc(err.message)}</p>`;
    }
    return;
  }
  if (e.target.dataset.copy) {
    await navigator.clipboard.writeText(e.target.closest('.app-coach').querySelector('.coach-text').innerText).catch(() => {});
    e.target.textContent = 'Copied';
    return;
  }
  const del = e.target.dataset.del;
  const go = e.target.dataset.apply;
  if (del) {
    if (e.target.dataset.armed !== '1') {
      e.target.dataset.armed = '1';
      e.target.textContent = 'Tap again to delete';
      return setTimeout(() => { e.target.dataset.armed = ''; e.target.textContent = 'Delete'; }, 3000);
    }
    await api(`/api/applications/${del}`, { method: 'DELETE' });
    state.apps = state.apps.filter((a) => a.id !== del);
    renderTracker();
  }
  if (go) {
    const a = state.apps.find((x) => x.id === go);
    state.queue = [{ title: a.title, url: a.url }];
    await openJob(0).catch((err) => toast(err.message, true));
  }
});
on('#addCurrent', async () => {
  const tab = await activeTab();
  const job = await readJob().catch(() => null);
  $('#addTitle').value = job?.title || tab.title;
  $('#addCompany').value = job?.company || '';
  $('#addUrl').value = tab.url;
});
on('#addApp', async () => {
  const title = $('#addTitle').value.trim();
  if (!title) throw new Error('Enter the role');
  await api('/api/applications', { method: 'POST', body: { title, company: $('#addCompany').value.trim(), url: $('#addUrl').value.trim(), status: 'applied' } });
  ['#addTitle', '#addCompany', '#addUrl'].forEach((x) => ($(x).value = ''));
  await loadTracker();
  toast('Added to your Tracker');
});
on('#clearJobs', async () => {
  state.boardJobs = [];
  renderJobs();
  toast('Job list cleared');
});
$('#boards').addEventListener('click', async (e) => {
  const x = e.target.dataset.x;
  if (x != null) {
    BOARDS.splice(Number(x), 1);
    saveBoards();
    return renderBoards();
  }
  const b = BOARDS[e.target.dataset.b];
  if (!b) return;
  if (b.api) {
    // Server-fed board: merge its jobs straight into the list.
    $('#queueOut').textContent = `Fetching ${b.name}…`;
    await busy($('#scanBoard'), async () => {
      const before = state.boardJobs.length;
      await scanApiBoard(b);
      renderJobs();
      toast(`Added ${state.boardJobs.length - before} new jobs (${state.boardJobs.length} in your list)`);
      $('#queueOut').textContent = `Found ${state.boardJobs.length} jobs. Filter, tick, then Start applying.`;
    })().catch((err) => toast(err.message, true));
    return;
  }
  $('#boardUrl').value = b.url;
  await busy($('#openBoard'), openBoard)().catch(() => {});
});
on('#saveBoard', async () => {
  const url = $('#boardUrl').value.trim() || (await activeTab()).url;
  if (!/^https?:\/\//.test(url)) throw new Error('Paste a board link first');
  if (BOARDS.some((b) => b.url === url)) throw new Error('That board is already saved');
  BOARDS.push({ name: new URL(url).hostname.replace(/^www\./, '').split('.')[0], url });
  saveBoards();
  renderBoards();
  toast('Board saved');
});

on('#startQueue', async () => {
  const picked = state.boardJobs.filter((j) => j.selected);
  state.queue = picked.filter((j) => !matchScore(j).applied);
  if (!picked.length) throw new Error('Tick the jobs you want to apply to');
  if (!state.queue.length) throw new Error('You have already applied to all the ticked jobs');
  if (picked.length > state.queue.length) toast(`Skipping ${picked.length - state.queue.length} you already applied to`);
  await openJob(0);
});
$('#jobList').addEventListener('change', (e) => {
  if (e.target.dataset.i) state.boardJobs[e.target.dataset.i].selected = e.target.checked;
  renderJobs();
});
// "+ skill": you confirm you have it; it joins your profile and the resume is re-tailored with it.
$('#tailorOut').addEventListener('click', async (e) => {
  const skill = e.target.closest('[data-skill]')?.dataset.skill;
  if (!skill) return;
  const chip = e.target.closest('[data-skill]');
  chip.disabled = true;
  try {
    await api('/api/profile/skills', { method: 'POST', body: { skill } });
    chip.classList.replace('miss', 'ok');
    chip.textContent = `✓ ${skill}`;
    toast(`Added “${skill}” to your skills. Re-tailoring…`);
    state.resume = null;
    await busy($('#tailor'), tailor)();
  } catch (err) {
    chip.disabled = false;
    toast(err.message, true);
  }
});

$('#fillOut').addEventListener('click', async (e) => {
  const jump = e.target.closest?.('[data-jump]')?.dataset.jump;
  if (jump) {
    const [frameId, id] = jump.split(/:(.*)/);
    const tab = await activeTab().catch(() => null);
    if (tab) await callFrame(tab.id, Number(frameId), 'jumpTo', id).catch(() => {});
    return;
  }
  const code = e.target.dataset.copy;
  if (!code) return;
  await navigator.clipboard.writeText(code).catch(() => {});
  e.target.textContent = 'Copied ✓';
  toast(`Code ${code} copied`);
});

$('#bank').addEventListener('click', async (e) => {
  const key = e.target.dataset.forget;
  if (!key) return;
  const p = await api('/api/profile');
  delete p.answerBank[key];
  renderProfile(await api('/api/profile', { method: 'PUT', body: p }));
});

// 🎓 Learning plan for the top skill gaps (button is re-rendered, so the listener is delegated on document).
document.addEventListener('click', async (e) => {
  if (e.target.id !== 'upskillPlan') return;
  $('#upskillOut').innerHTML = '<p class="hint">Building your learning plan…</p>';
  try {
    const p = await api('/api/upskill', { method: 'POST', body: {} });
    $('#upskillOut').innerHTML =
      `<div class="page">Priorities</div>` +
      (p.priorities || []).map((x) => `<div class="item"><div class="q">${esc(x.term)} <span class="src">${esc(x.demand || '')}</span></div><div class="v">${esc(x.why || '')}<span class="src">Learn: ${esc(x.learn || '')} · Proof: ${esc(x.proof || '')}</span></div></div>`).join('') +
      `<div class="page">6-week plan</div>` +
      (p.plan || []).map((w) => `<div class="item"><div class="q">Week ${w.week} · ${esc(w.focus || '')}</div><div class="v"><span class="src">${esc(w.hours || '')}</span></div></div>`).join('') +
      `<p class="hint">${esc(p.note || '')}</p>`;
  } catch (err) {
    $('#upskillOut').innerHTML = `<p class="hint">${esc(err.message)}</p>`;
  }
});

// 🔎 GitHub scan: suggest skills from the repos in your GitHub link; each is added only on confirm.
$('#expandScan').addEventListener('click', async () => {
  $('#expandOut').innerHTML = '<p class="hint">Scanning your GitHub repos…</p>';
  try {
    const r = await api('/api/expand');
    $('#expandOut').innerHTML = r.suggestions.length
      ? `<p class="hint">${r.repos} repos scanned. Tap to add — only if it's true, it feeds your tailored resumes:</p>` +
        r.suggestions.map((s) => `<button class="chip miss" data-addskill="${esc(s.skill)}" title="seen in ${esc(s.source)}">+ ${esc(s.skill)}</button>`).join('')
      : '<p class="hint">Nothing new — the tools in your repos are already in your profile.</p>';
  } catch (err) {
    $('#expandOut').innerHTML = `<p class="hint">${esc(err.message)}</p>`;
  }
});
$('#expandOut').addEventListener('click', async (e) => {
  const chip = e.target.closest('[data-addskill]');
  if (!chip) return;
  try {
    await api('/api/profile/skills', { method: 'POST', body: { skill: chip.dataset.addskill } });
    chip.classList.replace('miss', 'ok');
    chip.textContent = `✓ ${chip.dataset.addskill}`;
    toast(`Added “${chip.dataset.addskill}”`);
  } catch (err) {
    toast(err.message, true);
  }
});
$('#jobFilter').addEventListener('input', renderJobs);
$('#jobSort').addEventListener('change', renderJobs);
$('#includePremium').addEventListener('change', renderJobs);
$('#openOnly').addEventListener('change', renderJobs);
// Opens every job link on the server (8 at a time, 40 per request so the count moves), then hides the closed ones.
on('#checkOpen', async () => {
  const todo = state.boardJobs.filter((j) => j.url && !endedByDate(j));
  if (!todo.length) throw new Error('No jobs to check: scan your boards first');
  const bar = $('#checkMeter');
  bar.hidden = false;
  try {
    for (let i = 0; i < todo.length; i += 40) {
      $('#jobCount').textContent = `Checking ${Math.min(i + 40, todo.length)} of ${todo.length} links…`;
      bar.firstElementChild.style.setProperty('--w', `${Math.max(4, (i / todo.length) * 100)}%`);
      const { results } = await api('/api/jobs/check', { method: 'POST', body: { urls: todo.slice(i, i + 40).map((j) => j.url) } });
      for (const j of todo.slice(i, i + 40)) j.open = results[j.url] || j.open;
    }
  } finally {
    bar.hidden = true;
  }
  $('#openOnly').checked = true;
  chrome.storage.local.set({ openOnly: true }).catch(() => {});
  renderJobs();
  const n = state.boardJobs.filter(isClosed).length;
  toast(`${n} closed job${n === 1 ? '' : 's'} hidden · ${todo.filter((j) => j.open === 'unknown').length} couldn't be checked (kept)`);
});
$('#serverUrl').addEventListener('change', async (e) => {
  SERVER = e.target.value.trim().replace(/\/$/, '') || 'http://localhost:8787';
  await chrome.storage.local.set({ server: SERVER });
  checkServer();
});
for (const id of ['autoNext', 'autoCover', 'onlyEmpty', 'includePremium', 'openOnly', 'fillGaps', 'visualCheck', 'realTyping', 'researchFirst']) {
  $(`#${id}`).addEventListener('change', (e) => chrome.storage.local.set({ [id]: e.target.checked }));
}

setInterval(() => $('#status').classList.contains('bad') && checkServer(), 5000); // reconnect when the server starts
// Tell the background page the panel really opened (Arc pretends to support side panels but never shows them).
// How this panel is shown: the toolbar popup (Arc shows it as a floating window), a side panel, a tab or a window.
const PANEL_MODE = new URLSearchParams(location.search).get('mode') || (chrome.extension?.getViews?.({ type: 'popup' })?.includes(window) ? 'popup' : 'sidepanel');
chrome.runtime.sendMessage({ type: 'panel-alive', mode: PANEL_MODE }).catch(() => {});
document.documentElement.dataset.mode = PANEL_MODE;

// ---------- pop out (tab / window / side panel) ----------
// Chrome only opens the side panel inside the click itself: no awaiting before chrome.sidePanel.open,
// so the window id is looked up when the panel loads, and the click handler calls open() first thing.
let thisWindowId = null;
chrome.windows?.getCurrent?.().then((w) => (thisWindowId = w.id)).catch(() => {});
const openSidePanelNow = () => {
  if (typeof chrome.sidePanel?.open !== 'function') return null;
  if (thisWindowId == null) return Promise.reject(new Error('the window was not ready yet, try again'));
  return chrome.sidePanel.open({ windowId: thisWindowId });
};
async function popOut(how, opening = null) {
  const page = await browserTab().catch(() => null);
  if (how === 'tab') {
    const base = chrome.runtime.getURL('sidepanel.html');
    const existing = (await chrome.tabs.query({})).find((t) => t.url?.startsWith(base) && /mode=tab/.test(t.url));
    if (existing) await chrome.tabs.update(existing.id, { active: true });
    else await chrome.tabs.create({ url: `${base}?mode=tab`, index: page ? page.index + 1 : undefined, windowId: page?.windowId });
  } else if (how === 'window') {
    const r = await chrome.runtime.sendMessage({ type: 'open-window' }).catch(() => null);
    if (!r?.ok) return popOut('tab');
  } else if (how === 'sidepanel') {
    try {
      try {
        await (opening || chrome.sidePanel.open({ windowId: page?.windowId }));
      } catch (e) {
        // Refused (not a browser limit): keep offering the dock, and say why where you can see it.
        toast(`Couldn't open the side panel: ${e.message}`, true);
        const note = $('#dockError');
        if (note) note.textContent = `Chrome said: ${e.message}. Right-click the Auto Job icon → "Open Auto Job as sidebar", or press Alt+Shift+S.`;
        return;
      }
      const since = Date.now();
      let ok = false;
      for (let i = 0; i < 8 && !ok; i++) {
        await sleep(125);
        ok = await chrome.runtime.sendMessage({ type: 'side-panel-open?', since }).catch(() => false);
      }
      if (!ok) throw new Error('no side panel');
    } catch {
      // Arc and other browsers without a visible side panel: stop offering to dock.
      chrome.storage.local.set({ sidePanelUnsupported: true });
      $('#dockNote').hidden = true;
      toast("This browser doesn't show side panels: opening a tab instead");
      return popOut('tab');
    }
  }
  if (PANEL_MODE === 'popup') window.close(); // the popped-out copy takes over
}
$('#popoutBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  $('#popoutMenu').hidden = !$('#popoutMenu').hidden;
});
document.addEventListener('click', () => ($('#popoutMenu').hidden = true));
$('#popoutMenu').addEventListener('click', (e) => {
  const how = e.target.closest('[data-open]')?.dataset.open;
  if (how) popOut(how, how === 'sidepanel' ? openSidePanelNow() : null).catch((err) => toast(err.message, true));
});
if (typeof chrome.sidePanel?.open !== 'function' || PANEL_MODE === 'sidepanel') $('#openSide').hidden = true;
$('#popoutNow').addEventListener('click', () => popOut('window'));
// Chrome / Edge / Brave: offer to dock as a real sidebar. Once it loads there, the icon opens the sidebar every time.
if (PANEL_MODE === 'popup' && typeof chrome.sidePanel?.open === 'function') {
  chrome.storage.local.get('sidePanelUnsupported').then(({ sidePanelUnsupported }) => ($('#dockNote').hidden = !!sidePanelUnsupported));
}
$('#dockNow').addEventListener('click', () => popOut('sidepanel', openSidePanelNow()).catch((err) => toast(err.message, true)));
// Long runs need the panel to stay open; a toolbar popup can close when you click the page.
const notePopup = () => PANEL_MODE === 'popup' && ($('#popupNote').hidden = false);
for (const id of ['#runAll', '#startQueue', '#continue', '#scanAll']) $(id).addEventListener('click', notePopup, true);

chrome.storage.local.get(['boards', 'boardJobs', 'savedHacks']).then(({ boards, boardJobs, savedHacks }) => {
  state.savedHacks = new Set(savedHacks || []);
  state.jobsLoaded = true;
  BOARDS = [...DEFAULT_BOARDS, ...(boards || [])];
  renderBoards();
  if (boardJobs?.length) {
    state.boardJobs = boardJobs;
    renderJobs();
  }
});
chrome.storage.local.get(['server', 'autoNext', 'autoCover', 'onlyEmpty', 'includePremium', 'openOnly', 'fillGaps', 'visualCheck', 'realTyping', 'researchFirst']).then((s) => {
  if (s.server) SERVER = s.server;
  $('#serverUrl').value = SERVER;
  for (const id of ['autoNext', 'autoCover', 'onlyEmpty', 'includePremium', 'openOnly', 'fillGaps', 'visualCheck', 'realTyping', 'researchFirst']) if (typeof s[id] === 'boolean') $(`#${id}`).checked = s[id];
  checkServer();
});
