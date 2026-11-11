import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { mailConfigured } from './mail.js';

// Traces what happened to your applications from your Gmail (read-only): rejections, interview invites,
// assessments, offers and "we received your application" confirmations, each matched to a tracked job.
// It uses Gmail's own search (X-GM-RAW) so only likely recruiting mail is ever downloaded.

const KINDS = [
  // Order matters: an offer beats everything, and a rejection beats the "thank you for applying" it opens with.
  ['offer', /pleased to (extend|offer)|offer (letter|of employment)|we('d| would) like to (extend|make) (you )?an offer|congratulations[^.]{0,60}\b(offer|selected)\b|delighted to offer|happy to offer you/i],
  ['rejected', /unfortunately,? (we|your|the|at this (time|stage)|after)[^.]{0,100}\b(not|other candidates|unable to (offer|move|proceed|progress)|declin|decided)|regret to inform|not (be )?moving forward|decided (to|not to) (move forward|proceed|pursue)( with)? (other|another|different)?|will not be (moving|progressing|proceeding)|not been (selected|shortlisted|successful)|was not successful|were not successful|pursue other candidates|other candidates (whose|who)|position (has been|was) (filled|closed)|no longer (being )?consider|not (a|the right) (fit|match)( at this time)?|decided not to (proceed|progress|continue)|unable to (offer|progress|move forward)|won'?t be (moving|progressing)|we have chosen (another|other)|not to (advance|progress) your (application|candidacy)|after careful (consideration|review)[^.]{0,120}(not|other|unable)/i],
  ['interview', /invit(e|ation|ing) you (to|for) (an? )?(interview|conversation|call|chat|discussion)|interview (invitation|invite|schedul|slot|round)|schedule (an? |your )?(interview|call|chat|time)|(phone|video|technical|virtual|hr|first|second|final)[\s-]*(screen|interview|round)|next (round|stage|step)s? (of|in) (the |our )?(interview|hiring|selection|recruitment)|shortlisted for|like to (speak|talk|chat) (with|to) you|book a (time|slot)|calendly\.com|availability for (an? )?(interview|call)/i],
  ['assessment', /(online|technical|coding) (assessment|test)( (link|invite|invitation|round|is ready|for))|invit(e|ation|ed) (you )?(to|for) (an? |the )?(online |coding |technical )?(assessment|test|challenge|assignment)|assessment (link|invitation|invite|round)|assignment round|(hackerrank|codility|hackerearth|codesignal|mettl|testgorilla|imocha|coderbyte|karat)\.(com|io)\/(test|tests|invite|a\/|candidate|assessment)|take[\s-]?home (assignment|test|task|challenge)|aptitude test|complete (the|this|your|an?) (online )?(assessment|test|assignment|coding challenge) (by|within|before)/i],
  ['applied', /thank(s| you) for (applying|your application|your interest)|(we('ve| have)|has been) received your application|application (has been )?(received|submitted|confirmed)|successfully (applied|submitted)|your application for|application confirmation|confirm(ing|ation of) your application/i],
];
const RANK = { saved: 0, applied: 1, assessment: 2, interview1: 3, interview2: 4, interview3: 5, hr: 6, offer: 8, accepted: 9, rejected: 7, withdrawn: 7 };
const TO_STATUS = { offer: 'offer', rejected: 'rejected', interview: 'interview1', assessment: 'assessment', applied: 'applied' };

// What kind of outcome an email is, with the sentence that shows it.
const NEWSLETTER = /newsletter|weekly digest|horror stories|\btips\b|how to (ace|crack|prepare)|webinar|insider\b|daily digest|daily (coding )?challenge|unsubscribe from (this|these) (newsletter|digest)|top \d+ (jobs|tips)|job alert|jobs? (matching|recommended) for you|recommended jobs/i;
// A match that is negated ("This email is not an offer of employment") or conditional ("if the role requires an
// assessment, you may…") doesn't count.
const NEGATED = /\b(not|no|never|isn'?t|without)\s+(an?\s+|the\s+)?$|\b(if|should you|in case|once you|whether|may be|might be)\b[^.]{0,80}$/i;
// Interview / assessment / offer wording counts only when it speaks to you ("we'd like to invite you…"),
// not a newsletter line about "securing an interview invitation".
const PERSONAL = /\byou(r)?\b|\bcandidate\b/i;
function firstReal(body, re) {
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  for (const m of body.matchAll(g)) if (!NEGATED.test(body.slice(Math.max(0, m.index - 90), m.index))) return m;
  return null;
}
export function classify(subject, text) {
  if (/create your (candidate|account|profile)|complete your (candidate )?profile|verify your email/i.test(subject)) return { kind: 'applied', evidence: subject.slice(0, 220) };
  if (NEWSLETTER.test(subject) || (NEWSLETTER.test(String(text || '').slice(0, 600)) && !/your application|your candidacy/i.test(`${subject} ${text}`))) return null;
  const body = `${subject}\n${String(text || '').slice(0, 8000)}`;
  // The subject says it most plainly ("Assignment Round", "Interview invitation"), so it's read first.
  for (const [kind, re] of KINDS) {
    if (kind === 'applied' || !firstReal(subject, re)) continue;
    if (kind === 'interview' && firstReal(body, KINDS[1][1])) break;
    return { kind, evidence: subject.slice(0, 220) };
  }
  for (const [kind, re] of KINDS) {
    const m = firstReal(body, re);
    if (!m) continue;
    if (kind === 'interview' && firstReal(body, KINDS[1][1])) continue; // "unfortunately… thank you for your interview" is a rejection
    const at = m.index;
    const s = Math.max(body.lastIndexOf('.', at) + 1, body.lastIndexOf('\n', at) + 1, 0);
    const e = [body.indexOf('.', at + m[0].length), body.indexOf('\n', at + m[0].length)].filter((x) => x > 0);
    const evidence = body.slice(s, e.length ? Math.min(...e) + 1 : at + 200).replace(/\s+/g, ' ').trim().slice(0, 220);
    if (['interview', 'assessment', 'offer'].includes(kind) && !PERSONAL.test(evidence)) continue;
    return { kind, evidence };
  }
  return null;
}

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
const STOP_CO = /\b(pvt|private|ltd|limited|inc|llc|llp|corp|corporation|company|co|technologies|technology|tech|solutions|services|india|global|group|international|careers?|jobs?|the)\b/g;
const coWords = (c) => {
  const words = norm(c).replace(STOP_CO, ' ').split(' ').filter((w) => w.length >= 3);
  return words.length ? words : norm(c).length >= 2 ? [norm(c)] : []; // "P&G" -> "p g", "SG Group" -> "sg group"
};

// Which tracked application an email is about: the company in the sender / subject / body, plus the role title.
function matchApp(apps, mail) {
  const from = norm(`${mail.fromName} ${mail.fromAddr}`);
  const subject = norm(mail.subject);
  const body = norm(mail.text).slice(0, 6000);
  let best = null;
  for (const a of apps) {
    const words = coWords(a.company);
    if (!words.length) continue;
    // An entry named after a job board or a subject line ("Hackerrank", "Update on your application…") is never a sure
    // match on its own: the AI reads those emails and they stay only when the employer agrees.
    const platformName = NOT_COMPANY.test(String(a.company || '').trim()) || /^(unstop|hacker ?rank|hacker ?earth|wellfound|internshala|naukri)\b/i.test(String(a.company || '').trim());
    const key = words.join(' ');
    let score = 0;
    if (from.includes(key) || words.every((w) => from.includes(w))) score += 5;
    if (subject.includes(key) || words.every((w) => subject.includes(w))) score += 4;
    else if (body.includes(key)) score += 2;
    if (!score) continue;
    const role = norm(a.title).split(' ').filter((w) => w.length > 3);
    const hits = role.filter((w) => subject.includes(w) || body.includes(w)).length;
    if (role.length) score += Math.round((3 * hits) / role.length);
    if (mail.date && a.appliedAt && new Date(mail.date) < new Date(a.appliedAt) - 86400_000) score -= 4; // before you applied
    if (platformName) score = Math.min(score, 6);
    if (!best || score > best.score) best = { app: a, score };
  }
  return best && best.score >= 4 ? best : null;
}

// For an outcome about a job you didn't track: the company and role, from the sender and subject.
function guessCompany(m) {
  const lead = m.subject.match(/^([A-Z][\w&.' -]{1,40}?)(?:\s+careers?)?\s*[:–—-]\s+/)?.[1];
  if (lead && !/^(re|fwd?|update|reminder|important|action required|thank you|thanks|your|an?|the)$/i.test(lead.trim())) return lead.trim().replace(/\s+(careers?|application|jobs?|hr)$/i, '');
  const subj = m.subject.match(/application (?:to|at|with|for a job at)\s+([A-Z][\w&.' -]{1,40}?)(?:\s+(?:was|has|is|for)\b|[!:|,.-]|$)/i)?.[1];
  if (subj) return subj.trim();
  const name = String(m.fromName || '').replace(/\s+via\s+.*$/i, '').replace(/\b(talent acquisition|recruiting|recruitment|careers?|jobs|hiring|hr|team|people|no[-\s]?reply|noreply|notifications?|workday|sap\s*successfactors|sapsuccessfactors|successfactors|taleo|icims|greenhouse|lever|workable|system|portal)\b/gi, ' ').replace(/[^\w&.' ]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (name.length >= 2 && !/@/.test(name)) return name.replace(/^at\s+/i, '');
  const dom = String(m.fromAddr || '').split('@')[1] || '';
  const parts = dom.split('.').filter((x) => !/^(com|co|in|io|org|net|mail|email|careers|jobs|hire|myworkday|greenhouse|lever|smartrecruiters|icims|workablemail|ashbyhq|recruitee)$/i.test(x));
  return parts.at(-1) ? parts.at(-1)[0].toUpperCase() + parts.at(-1).slice(1) : '';
}
function guessRole(m) {
  return (m.subject.match(/(?:for|position of|role of|the)\s+(?:the\s+)?([A-Z][\w/&,()+. -]{3,70}?)\s+(?:role|position|opening|job)\b/i)?.[1] || m.subject.match(/\|\|\s*([^|]{4,60})\s*\|\|/)?.[1] || '').trim();
}

const QUERY = '(unfortunately OR regret OR "moving forward" OR "not been selected" OR "other candidates" OR interview OR assessment OR "coding challenge" OR hackerrank OR codility OR "offer letter" OR "pleased to offer" OR "thank you for applying" OR "received your application" OR "your application") -in:chats -in:sent';

// ---------- which emails are about your job search ----------
// Applicant-tracking systems, job boards and assessment / scheduling tools that only write about applications.
const ATS = /myworkday|workday|greenhouse|lever\.co|hire\.lever|smartrecruiters|ashbyhq|icims|successfactors|taleo|oraclecloud|jobvite|workable|recruitee|breezy|bamboohr|jazzhr|zohorecruit|freshteam|keka|darwinbox|pyjamahr|recruitcrm|hirist|naukri|instahyre|wellfound|angel\.co|unstop|internshala|foundit|monster|indeed|cutshort|hackerrank|hackerearth|codility|codesignal|mettl|testgorilla|imocha|karat|hirevue|eightfold|phenom|avature|beamery|calendly|goodtime|modernhire|turing\.com|crossover|toptal|uplers|apna|shine\.com|glassdoor|jobs-noreply@linkedin|jobs-listings@linkedin|hit-reply@linkedin|talent|recruit|careers?@|hiring@|hr@|jobs@|people@/i;
const JOB_WORDS = /\b(application|applied|applying|candidate|candidacy|interview|assessment|assignment|coding (test|challenge|round)|offer letter|job offer|internship|hiring|recruit(er|ment|ing)?|talent acquisition|shortlist(ed)?|next steps|onboarding|joining (date|formalities|letter)|background (check|verification)|reference check|selection process|online test|aptitude)\b/i;
const NOT_JOB = /^\W*(job|walk-?in interview)\s*\||register now|hackathon|ideathon|job alert|jobs? (for you|matching|recommended|you may be interested)|recommended (jobs|for you)|new jobs|jobs? in [A-Z]|people (also )?viewed|who'?s viewed your profile|newsletter|digest|webinar|course|certificate of completion|discount|sale\b|% off|order|invoice|receipt|payment|otp|one[- ]time (password|code)|verification code|security alert|sign[- ]?in|password reset|statement|subscription|delivery|shipment|your (daily|weekly)/i;
const RECRUITER_OUTREACH = /(came across|found) your (profile|resume)|(exciting|great) (opportunity|role)|would you be (open|interested)|are you (open|interested|exploring)|reaching out (about|regarding|with)|i('m| am) (a )?(recruiter|hiring)/i;

// Job-portal alert formats ("✉️ Job | Golang Developer in…", "Walk-in interview | …"): listings, not your applications.
const ALERT = /^\W*(job|walk-?in interview|walk-?in drive)\s*\|/i;
function jobSignal(m) {
  if (ALERT.test(m.subject)) return 0;
  const from = `${m.fromName} <${m.fromAddr}>`;
  if (NOT_JOB.test(m.subject) && !/your application|interview|assessment|offer letter/i.test(m.subject)) return 0;
  return (ATS.test(from) ? 2 : 0) + (JOB_WORDS.test(m.subject) ? 2 : 0);
}

// Uncertain emails (no outcome wording, but a job-ish sender or subject): the AI reads the subject, sender and the
// first lines (never the whole mailbox) and says which are about your applications. MAIL_AI=off keeps it rules-only.
const MAIL_AI_SYSTEM = `You read a job seeker's emails. For each EMAIL decide whether it is about the user's OWN job search:
an application they made, an online test, an interview, a decision, an offer, or a recruiter personally contacting them.
NOT job related: job alerts and "jobs for you" lists, newsletters, marketing, courses, hackathons and competitions, OTPs, receipts.
Return JSON {"emails":[{"i": number, "job": boolean, "kind": "applied"|"assessment"|"interview"|"rejected"|"offer"|"update"|"outreach"|"none",
"company": string, "role": string}]} with one entry for EVERY email.
- company = the employer hiring for the role, never the platform that sent the mail (not Wellfound, Greenhouse, Workday, Lever,
  LinkedIn, Naukri, Internshala, Unstop, HackerRank, HackerEarth, Indeed, iCIMS, SuccessFactors). "" if the email doesn't say.
- role = the job title exactly as written ("Software Engineer Intern"), "" if not stated.
- kind: "update" = about an application but no decision (reviewing, scheduling details, documents needed);
  "outreach" = a recruiter offering the user a new role; "applied" = a confirmation that an application was received.`;
// Returns Map(mailId -> {job, kind, company, role}) for every email it could read, or null when no AI is available.
async function aiRead(list) {
  if (!list.length || /^(off|0|false|no)$/i.test(process.env.MAIL_AI || '')) return null;
  const { chatJSON } = await import('./llm.js');
  const out = new Map();
  for (let k = 0; k < list.length && k < 640; k += 40) {
    const batch = list.slice(k, k + 40);
    const user = JSON.stringify({ EMAILS: batch.map((m, j) => ({ i: j, from: `${m.fromName} <${m.fromAddr}>`.slice(0, 120), subject: m.subject.slice(0, 160), start: m.text.replace(/\s+/g, ' ').slice(0, 700) })) });
    try {
      const r = await chatJSON(MAIL_AI_SYSTEM, user, { temperature: 0, budgetMs: 60000 });
      for (const e of r.emails || []) if (e && batch[e.i]) out.set(batch[e.i].id, e);
    } catch {
      if (!out.size && k >= 80) return null; // no AI right now: the rules-only result stands
    }
  }
  return out.size ? out : null; // nothing read at all: the rules decide, as without AI
}

// Platforms and subject fragments that are never the employer.
const NOT_COMPANY = /^(wellfound|angel ?list|greenhouse(-?mail)?|workday\w*|myworkday|internshala|linked ?in|naukri\w*|unstop|indeed|glassdoor|hacker ?earth|hacker ?rank|lever|smart ?recruiters|ashby\w*|icims|success ?factors|taleo|jobvite|workable|codility|mettl|foundit|instahyre|cutshort|application\b.*|update\b.*|next steps\b.*|cv reviewed|your (application|candidacy).*|thank(s| you)\b.*|re|fwd?|no-?reply|donotreply|.*do ?not ?reply.*|talent acquisition|recruiting|careers?|hr|team)$/i;
const tidyCompany = (c) => String(c || '')
  .replace(/\s+(human resources|job application|application recei\w*|recruiting|recruitment|talent (acquisition|attraction)\b.*|careers?|hiring team|hr)$/i, '')
  .replace(/^([a-z0-9-]+?)(apps|careers|jobs)?\.(com|in|io|co)$/i, (_, n) => n[0].toUpperCase() + n.slice(1)) // "transunionapps.com" -> "Transunion"
  .trim();
const roleWords = (r) => new Set(norm(r).split(' ').filter((w) => w.length > 2 && !/^(the|and|for|with|intern|internship|role|position|job)$/.test(w)));
const sameRole = (a, b) => {
  const x = roleWords(a), y = roleWords(b);
  if (!x.size || !y.size) return true; // unknown role: treat as the same application
  const shared = [...x].filter((w) => y.has(w)).length;
  return shared / Math.min(x.size, y.size) >= 0.5;
};

const imapClient = () => new ImapFlow({ host: 'imap.gmail.com', port: 993, secure: true, auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD.replace(/\s+/g, '') }, logger: false });
const parseMail = async (msg) => {
  const m = await simpleParser(msg.source);
  return {
    id: m.messageId || `${msg.uid}`,
    date: (m.date || msg.internalDate)?.toISOString?.() || null,
    subject: m.subject || '',
    fromName: m.from?.value?.[0]?.name || '',
    fromAddr: m.from?.value?.[0]?.address || '',
    text: (m.text || String(m.html || '').replace(/<[^>]+>/g, ' ')).slice(0, 12000),
  };
};

// Read your mail since `since` (ms): every email's sender and subject, then the full text of the job-related ones.
// Returns status changes for tracked applications, new applications found in your mail, and recruiter messages.
// `ignore`: ids of emails you dismissed (an application you removed), never read again.
export async function traceOutcomes(apps, { since, ignore = [] } = {}) {
  if (!mailConfigured()) throw new Error('Connect Gmail first: set GMAIL_USER and GMAIL_APP_PASSWORD in server/.env');
  const c = imapClient();
  const days = Math.max(1, Math.ceil((Date.now() - since) / 86400_000) + 1);
  const mails = [];
  let scanned = 0;
  // Gmail can drop a connection mid-scan: retry the connect, and skip a failed chunk instead of losing the whole trace.
  for (let attempt = 0; ; attempt++) {
    try {
      await c.connect();
      break;
    } catch (e) {
      if (attempt >= 2) throw new Error(`Gmail IMAP could not connect (check the App Password and your network): ${e.responseText || e.message}`);
      console.warn(`Gmail connect failed (${e.message}); retrying…`);
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
    }
  }
  try {
    await c.mailboxOpen('[Gmail]/All Mail', { readOnly: true }).catch(() => c.mailboxOpen('INBOX', { readOnly: true }));
    // 1) Every email in the window, headers only, in chunks — a large mailbox is never truncated.
    const all = (await c.search({ gmraw: `newer_than:${days}d -in:chats -in:sent` }, { uid: true })) || [];
    scanned = all.length;
    const pick = new Set();
    for (let i = 0; i < all.length; i += 1000) {
      try {
        for await (const msg of c.fetch(all.slice(i, i + 1000), { uid: true, envelope: true }, { uid: true })) {
          const f = msg.envelope?.from?.[0] || {};
          if (jobSignal({ subject: msg.envelope?.subject || '', fromName: f.name || '', fromAddr: f.address || '' }) >= 2) pick.add(msg.uid);
        }
      } catch (e) {
        console.warn(`Gmail: header chunk ${i / 1000 + 1} failed (${String(e.message).slice(0, 80)}); continuing with the rest`);
      }
    }
    // 2) Plus mail whose text says an outcome even when the subject is vague ("An update from Acme").
    for (const uid of (await c.search({ gmraw: `newer_than:${days}d ${QUERY}` }, { uid: true })) || []) pick.add(uid);
    // 3) Read every job-related email, in batches: one failed batch never loses the others.
    const uids = [...pick].sort((a, b) => a - b);
    for (let i = 0; i < uids.length; i += 150) {
      try {
        for await (const msg of c.fetch(uids.slice(i, i + 150), { uid: true, internalDate: true, source: true }, { uid: true })) {
          try {
            mails.push(await parseMail(msg));
          } catch {
            // a malformed message (weird encoding) is skipped, not fatal
          }
        }
      } catch (e) {
        console.warn(`Gmail: message batch ${i / 150 + 1} failed (${String(e.message).slice(0, 80)}); continuing`);
      }
    }
  } finally {
    await c.logout().catch(() => {});
  }

  // 4) What each email is: rules first, the AI for the uncertain ones.
  const seen = new Set([...apps.flatMap((a) => (a.mail || []).map((x) => x.id)), ...ignore]);
  const fresh = mails.filter((m) => !seen.has(m.id)).sort((a, b) => new Date(a.date) - new Date(b.date));
  const kinds = new Map();
  const unsure = [];
  for (const m of fresh) {
    if (ALERT.test(m.subject)) continue;
    const k = classify(m.subject, m.text);
    if (k) kinds.set(m.id, { kind: k.kind, evidence: k.evidence });
    else if (RECRUITER_OUTREACH.test(`${m.subject} ${m.text.slice(0, 1500)}`) && !NOT_JOB.test(m.subject)) kinds.set(m.id, { kind: 'outreach', evidence: m.subject.slice(0, 220) });
    else if (jobSignal(m) >= 2) unsure.push(m);
  }
  // The AI reads every job email that isn't already tied to a tracked application: is it really about your job
  // search, which employer (never the job board), which role. Without AI the rules decide.
  const toAI = [...unsure, ...fresh.filter((m) => kinds.has(m.id) && !(matchApp(apps, m)?.score >= 7))];
  const ai = await aiRead(toAI);
  if (ai) {
    for (const m of toAI) {
      const a = ai.get(m.id);
      if (!a) continue;
      if (!a.job || a.kind === 'none') {
        kinds.delete(m.id);
        continue;
      }
      const rule = kinds.get(m.id);
      // The AI read the whole context, so its kind wins, except rejections and offers, whose wording rules are strict.
      kinds.set(m.id, { kind: rule && ['rejected', 'offer'].includes(rule.kind) ? rule.kind : a.kind, evidence: rule?.evidence || m.subject.slice(0, 220), company: tidyCompany(a.company), role: String(a.role || '').trim(), byAI: true });
    }
  }

  // 5) Each job email goes to its application; outcomes for jobs you didn't track become new applications,
  //    and later emails from the same company follow them.
  const updates = [];
  const created = [];
  const outreach = [];
  const pool = [...apps];
  for (const mail of fresh) {
    const k = kinds.get(mail.id);
    if (!k) continue;
    const item = { mailId: mail.id, kind: k.kind, evidence: k.evidence, subject: mail.subject.slice(0, 160), from: mail.fromName || mail.fromAddr, date: mail.date, ...(k.byAI ? { byAI: true } : {}) };
    if (k.kind === 'outreach') {
      if (!ai && !k.byAI) continue; // outreach is only listed when the AI confirmed it (the wording alone is too loose)
      outreach.push({ ...item, company: k.company || guessCompany(mail), title: k.role || guessRole(mail) });
      continue;
    }
    let hit = matchApp(pool, mail);
    if (hit && k.byAI && k.company && !hit.app.isNew && !(hit.score >= 7) && !coWords(k.company).some((w) => coWords(hit.app.company).includes(w))) hit = null;
    // Two roles at one company are two applications.
    if (hit?.app.isNew && k.role && hit.app.title && !sameRole(k.role, hit.app.title)) hit = null;
    if (!hit) {
      const company = tidyCompany(k.company || (k.byAI ? '' : guessCompany(mail)));
      if (!company || NOT_COMPANY.test(company) || k.kind === 'update') continue;
      const app = { id: `new-${created.length}`, company, title: (k.role || guessRole(mail)).trim(), status: TO_STATUS[k.kind] || 'applied', appliedAt: mail.date, mail: [item], isNew: true };
      created.push(app);
      pool.push(app);
      continue;
    }
    if (hit.app.isNew) {
      // A later email about an application found earlier in this read: move it along.
      const to = TO_STATUS[k.kind];
      if (to && (['rejected', 'offer'].includes(to) || RANK[to] > RANK[hit.app.status])) hit.app.status = to;
      hit.app.mail.push(item);
      if (!hit.app.title && (k.role || guessRole(mail))) hit.app.title = k.role || guessRole(mail);
      continue;
    }
    const to = TO_STATUS[k.kind];
    const cur = hit.app.status || 'applied';
    // Statuses only move forward (a late "thanks for applying" never undoes an interview), except that a rejection
    // or offer always lands, since it ends the process. "update" emails are kept as evidence without a change.
    const forward = !to ? false : ['rejected', 'offer'].includes(to) ? !['rejected', 'offer', 'accepted', 'withdrawn'].includes(cur) : RANK[to] > RANK[cur];
    updates.push({ ...item, appId: hit.app.id, company: hit.app.company, title: hit.app.title, from_status: cur, to_status: to || cur, change: forward, confident: hit.score >= 7 || (k.byAI && hit.score >= 5) });
  }
  return {
    scanned,
    checked: mails.length,
    jobEmails: kinds.size,
    readByAI: ai ? ai.size : 0,
    since: new Date(since).toISOString(),
    updates,
    created: created.map(({ id, isNew, ...a }) => a),
    outreach: outreach.slice(-30),
    unmatched: [],
  };
}
