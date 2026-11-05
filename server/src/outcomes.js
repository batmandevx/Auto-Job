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
const coWords = (c) => norm(c).replace(STOP_CO, ' ').split(' ').filter((w) => w.length >= 3);

// Which tracked application an email is about: the company in the sender / subject / body, plus the role title.
function matchApp(apps, mail) {
  const from = norm(`${mail.fromName} ${mail.fromAddr}`);
  const subject = norm(mail.subject);
  const body = norm(mail.text).slice(0, 6000);
  let best = null;
  for (const a of apps) {
    const words = coWords(a.company);
    if (!words.length) continue;
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

// Read recruiting mail since `since` (ms) and propose a status for each tracked application.
export async function traceOutcomes(apps, { since, limit = 400 } = {}) {
  if (!mailConfigured()) throw new Error('Connect Gmail first: set GMAIL_USER and GMAIL_APP_PASSWORD in server/.env');
  const c = new ImapFlow({ host: 'imap.gmail.com', port: 993, secure: true, auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD.replace(/\s+/g, '') }, logger: false });
  const days = Math.max(1, Math.ceil((Date.now() - since) / 86400_000) + 1);
  const mails = [];
  await c.connect();
  try {
    await c.mailboxOpen('[Gmail]/All Mail', { readOnly: true }).catch(() => c.mailboxOpen('INBOX', { readOnly: true }));
    const uids = (await c.search({ gmraw: `newer_than:${days}d ${QUERY}` }, { uid: true })) || [];
    for await (const msg of c.fetch(uids.slice(-limit), { uid: true, internalDate: true, source: true }, { uid: true })) {
      const m = await simpleParser(msg.source);
      mails.push({
        id: m.messageId || `${msg.uid}`,
        date: (m.date || msg.internalDate)?.toISOString?.() || null,
        subject: m.subject || '',
        fromName: m.from?.value?.[0]?.name || '',
        fromAddr: m.from?.value?.[0]?.address || '',
        text: (m.text || String(m.html || '').replace(/<[^>]+>/g, ' ')).slice(0, 12000),
      });
    }
  } finally {
    await c.logout().catch(() => {});
  }
  const seen = new Set(apps.flatMap((a) => (a.mail || []).map((x) => x.id)));
  const updates = [];
  const unmatched = [];
  for (const mail of mails.sort((a, b) => new Date(a.date) - new Date(b.date))) {
    if (seen.has(mail.id)) continue;
    const kind = classify(mail.subject, mail.text);
    if (!kind) continue;
    const hit = matchApp(apps, mail);
    const item = { mailId: mail.id, kind: kind.kind, evidence: kind.evidence, subject: mail.subject.slice(0, 160), from: mail.fromName || mail.fromAddr, date: mail.date };
    if (!hit) {
      if (kind.kind !== 'applied') unmatched.push({ ...item, company: guessCompany(mail), title: guessRole(mail) });
      continue;
    }
    const to = TO_STATUS[kind.kind];
    const cur = hit.app.status || 'applied';
    // Statuses only move forward (a late "thanks for applying" never undoes an interview), except that a rejection
    // or offer always lands, since it ends the process.
    const forward = ['rejected', 'offer'].includes(to) ? !['rejected', 'offer', 'accepted', 'withdrawn'].includes(cur) : RANK[to] > RANK[cur];
    updates.push({ ...item, appId: hit.app.id, company: hit.app.company, title: hit.app.title, from_status: cur, to_status: to, change: forward, confident: hit.score >= 7 });
  }
  return { checked: mails.length, since: new Date(since).toISOString(), updates, unmatched: unmatched.slice(-40) };
}
