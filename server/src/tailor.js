import { chatJSON } from './llm.js';
import { TAILOR_SYSTEM } from './prompts.js';
import { profileSkillsInJD, techTermsInJD, coverage, norm, canonical, makeMatcher } from './keywords.js';

const STOP = new Set('a an the and or of to in for on with by from at as into using via that this which was were is are be built'.split(' '));
const words = (s) => (String(s).toLowerCase().match(/[a-z0-9+#.]+/g) || []).map((w) => w.replace(/\.$/, '')).filter((w) => w && !STOP.has(w));
const numbers = (s) => String(s).match(/\d+(?:[.,]\d+)?/g) || [];

// A reworded bullet is accepted only if it keeps the original's numbers, adds none, and stays close to it.
export function faithful(original, rewrite) {
  if (!rewrite || typeof rewrite !== 'string') return false;
  const o = numbers(original);
  const r = numbers(rewrite);
  if (r.some((n) => !o.includes(n)) || o.some((n) => !r.includes(n))) return false;
  const ow = new Set(words(original));
  const rw = words(rewrite);
  if (!ow.size || !rw.length) return false;
  const kept = [...ow].filter((w) => rw.includes(w)).length / ow.size;
  const fresh = rw.filter((w) => !ow.has(w)).length / rw.length;
  return kept >= 0.4 && fresh <= 0.5;
}

function pickBullets(source, choice, max) {
  if (!Array.isArray(choice?.bullets)) return source.bullets;
  const used = new Set();
  const out = [];
  for (const c of choice.bullets) {
    const i = Number(c?.from);
    if (!Number.isInteger(i) || i < 0 || i >= source.bullets.length || used.has(i)) continue;
    used.add(i);
    out.push(crisp(faithful(source.bullets[i], c.text) ? c.text.trim() : source.bullets[i]));
    if (out.length >= max) break;
  }
  return out.length ? out : source.bullets;
}

export async function tailorResume(resume, sourceText, job, { fillGaps = false } = {}) {
  const indexed = {
    ...resume,
    experience: (resume.experience || []).map((e, index) => ({ index, ...e, bullets: e.bullets.map((text, b) => ({ b, text })) })),
    projects: (resume.projects || []).map((p, index) => ({ index, ...p, bullets: (p.bullets || []).map((text, b) => ({ b, text })) })),
  };
  const profileText = `${sourceText}\n${JSON.stringify(resume)}`;
  const preMatched = profileSkillsInJD(resume, job.description);
  const out = await chatJSON(
    TAILOR_SYSTEM,
    JSON.stringify({ RESUME: indexed, KEYWORDS_YOU_HAVE: preMatched, JOB: { title: job.title, company: job.company, description: job.description.slice(0, 15000) } }),
    { temperature: 0.3, heavy: true },
  );

  const haystack = profileText.toLowerCase();
  const notes = [];

  // Every role stays, in its original order; only its bullets are chosen / reworded.
  const expChoice = new Map((out.experience || []).map((e) => [Number(e.index), e]));
  const experience = (resume.experience || []).map((e, i) => ({ ...e, bullets: pickBullets(e, expChoice.get(i), 5) }));

  const projects = (out.projects || [])
    .map((c) => ({ c, p: resume.projects?.[Number(c.index)] }))
    .filter(({ p }) => p)
    .filter(({ p }, i, arr) => arr.findIndex((x) => x.p === p) === i)
    .slice(0, 3)
    .map(({ c, p }) => ({ ...p, bullets: pickBullets({ ...p, bullets: p.bullets || [] }, c, 3) }));

  // Skills: only ones the candidate actually listed.
  let skills = (out.skills || [])
    .map((s) => ({ category: String(s.category || ''), items: (s.items || []).filter((x) => typeof x === 'string' && haystack.includes(x.toLowerCase())) }))
    .filter((s) => s.items.length);
  if (!skills.length) skills = resume.skills;

  // Every job-description keyword you have goes in, spelled as the job spells it (what ATS filters match on).
  // Keywords you don't have are reported, never added.
  const jdKeywords = Array.isArray(out.jdKeywords) ? out.jdKeywords.filter((k) => typeof k === 'string' && k.trim().length > 1 && k.length < 40) : [];
  const { matched, missing } = coverage([...jdKeywords, ...techTermsInJD(job.description), ...preMatched], profileText);
  const inSkills = makeMatcher(skills.flatMap((x) => x.items).join(', '));
  const key = matched.filter((k) => !inSkills(k) || jdKeywords.some((j) => norm(j) === norm(k)));
  if (key.length) {
    // One entry per meaning ("LLM" = "LLMs"), tidy capitalisation, and no repeats in the rows below.
    const pretty = (k) => (k === k.toLowerCase() ? k.replace(/(^|[\s/-])([a-z])/g, (m, a, b) => a + b.toUpperCase()) : k);
    const keyMap = new Map();
    for (const k of key) if (!keyMap.has(canonical(k))) keyMap.set(canonical(k), pretty(k));
    const keyItems = [...keyMap.values()].slice(0, 28);
    const used = new Set(keyItems.map(canonical));
    const seenBelow = new Set(used);
    // Your other relevant skills join the same groups (job keywords first in each), so there is one tidy block.
    const extra = skills.flatMap((x) => x.items).filter((i) => { const c = canonical(i); if (seenBelow.has(c)) return false; seenBelow.add(c); return true; });
    skills = groupSkills(keyItems, extra.slice(0, 18));
  }

  // Headline / summary may not introduce numbers that aren't in the resume.
  const noNewNumbers = (t) => typeof t === 'string' && t.trim() && numbers(t).every((n) => haystack.includes(n));
  const summary = noNewNumbers(out.summary) ? out.summary.trim() : resume.summary;
  const headline = noNewNumbers(out.headline) ? out.headline.trim() : resume.headline;
  if (summary === resume.summary && out.summary) notes.push('Kept your original summary (the AI version added facts).');

  // Alignment with the posting: the headline names the exact role (what recruiters and ATS search for),
  // and the summary carries the top keywords you have.
  const role = cleanRole(job.title);
  let finalHeadline = headline;
  if (role && !norm(headline).includes(norm(role))) {
    // Keep the AI's focus skills (it picks the job's core ones); otherwise the job's own top keywords.
    const aiFocus = String(headline || '').split('|').slice(1).map((x) => x.trim()).filter((x) => x && x.length <= 40);
    const focus = aiFocus.length ? aiFocus.slice(0, 3) : matched.filter((k) => k.length <= 20 && !/^(python|sql|git|java)$/i.test(k)).slice(0, 3);
    finalHeadline = [role, ...focus].join(' | ');
  }
  let finalSummary = summary;
  const inSummary = makeMatcher(summary || '');
  const notInSummary = matched.filter((k) => !inSummary(k)).slice(0, Math.max(0, 6 - matched.filter(inSummary).length));
  if (notInSummary.length) finalSummary = `${(summary || '').trim().replace(/\.?$/, '.')} Hands-on with ${listJoin(notInSummary)}.`;

  finalSummary = crisp(finalSummary);
  // You asked for no graduation-year talk: drop any summary sentence about it (the Education section keeps the dates).
  const noGrad = withoutGradSentences(finalSummary);
  if (noGrad.length > 60) finalSummary = noGrad;

  // Optional: list the job keywords you don't have yet on an honest "Familiar with / learning" line, so keyword
  // filters see 100% coverage without any bullet, number or employer claiming experience you don't have.
  let gapFilled = [];
  if (fillGaps && missing.length) {
    const pretty = (k) => (k === k.toLowerCase() ? k.replace(/(^|[\s/-])([a-z])/g, (m, a, b) => a + b.toUpperCase()) : k);
    gapFilled = [...new Map(missing.map((k) => [canonical(k), pretty(k)])).values()].slice(0, 14);
    const at = skills.filter((x) => x.key).length;
    skills = [...skills.slice(0, at), { category: 'Familiar with / learning', items: gapFilled }, ...skills.slice(at)];
  }

  const finalResume = { ...resume, targetRole: role, headline: finalHeadline, summary: finalSummary, skills, experience, projects: projects.length ? projects : resume.projects };
  const inResume = makeMatcher(JSON.stringify({ headline: finalHeadline, summary: finalSummary, skills, experience, projects: finalResume.projects }));
  const covered = matched.filter(inResume);
  return {
    resume: finalResume,
    keywords: { covered, missing: fillGaps ? [] : missing, gapFilled, total: covered.length + missing.length },
    changes: [...(out.changes || []), ...notes],
    matchScore: Number.isFinite(Number(out.matchScore)) ? Number(out.matchScore) : null,
    missingKeywords: missing,
  };
}

// "Software Development Engineer I – Payments (Remote)" -> "Software Development Engineer I"
// "Intern - Bachelors - AI Engineering" -> "AI Engineering Intern"
const NOT_ROLE = /^(bachelors?|masters?|b\.?\s*tech|m\.?\s*tech|graduate|undergrad\w*|post\s*grad\w*|campus|fresher|freshers|20\d\d|full[- ]?time|part[- ]?time|remote|hybrid|on[- ]?site|india|[a-z]+,\s*india|job\s*id.*|req.*|\d+)$/i;
export function cleanRole(title) {
  const parts = String(title || '').replace(/\s*[([].*?[)\]]\s*/g, ' ').split(/\s[–—|-]\s|,|\s\/\s/).map((x) => x.replace(/\s+/g, ' ').trim()).filter((x) => x && !NOT_ROLE.test(x));
  let t = parts[0] || '';
  if (/^(intern|internship|trainee|apprentice)$/i.test(t) && parts[1]) t = `${parts[1]} ${/trainee|apprentice/i.test(t) ? t : 'Intern'}`;
  return t.length >= 3 && t.length <= 60 ? t : '';
}

// Key skills grouped the way recruiters scan them (every item stays: ATS reads them all).
const SKILL_GROUPS = [
  ['Languages', /^(python|java|javascript|typescript|c\+\+|c#|c|go|golang|rust|kotlin|swift|scala|r|sql|bash|shell|html|css|solidity|matlab)$/i],
  ['Generative AI', /llm|rag|retrieval|langchain|langgraph|llamaindex|prompt|vector|agent|genai|generative|gpt|gemini|transformer|hugging\s*face|fine-?tun|embedding|openai/i],
  ['AI / ML', /machine learning|deep learning|\bml\b|nlp|natural language|computer vision|pytorch|tensorflow|keras|scikit|sklearn|xgboost|opencv|cnn|lstm|neural|reinforcement|recommend|forecast|algorithm|statistic|model/i],
  ['Data & Backend', /pandas|numpy|spark|kafka|hadoop|airflow|etl|data pipeline|sql|postgres|mysql|mongo|redis|elastic|fastapi|flask|django|node|express|spring|rest|graphql|api|microservice|react|next|angular|vue|backend|frontend|full[- ]?stack|power bi|tableau|visuali/i],
  ['Cloud & MLOps', /aws|azure|gcp|google cloud|docker|kubernetes|k8s|ci\/cd|devops|mlops|terraform|jenkins|github actions|lambda|serverless|linux|git\b|github|monitoring|cloud/i],
];
function groupSkills(items, extra = []) {
  const groups = new Map();
  for (const it of [...items, ...extra]) {
    const g = SKILL_GROUPS.find(([, re]) => re.test(it))?.[0] || 'Practices & Tools';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(it);
  }
  const order = [...SKILL_GROUPS.map(([g]) => g), 'Practices & Tools'];
  return order.filter((g) => groups.has(g)).map((g) => ({ category: g, items: groups.get(g), key: true }));
}

// Filler that weakens a summary ("Successfully deployed", "Proficient in", "extensive experience").
const FILLER = [
  [/\b(successfully|effectively|efficiently)\s+/gi, ''],
  [/\bproficient in\b/gi, 'skilled in'],
  [/\bhands-on expertise in\b/gi, 'experience'],
  [/\b(extensive|diverse|various|wide range of|a variety of)\s+/gi, ''],
  [/\b(results-driven|highly motivated|passionate|dynamic|detail-oriented|self-motivated|hardworking)\s+/gi, ''],
  [/\butiliz(e|ed|ing)\b/gi, (m) => m.toLowerCase().replace('utiliz', 'us')],
  [/\bEngineering student\b/g, 'engineer'],
  [/\bexpert in\b/gi, 'skilled in'],
  // Keyword tacked on as a concept ("…, using Python and Deep Learning"): tools belong there, concepts don't.
  [/,?\s+(using|with|via)\s+(Python\s+and\s+)?(Deep Learning|Machine Learning|Computer Vision|NLP|Artificial Intelligence|AI)(\s+and\s+(Deep Learning|Machine Learning|Computer Vision|NLP))?(?=\s*$|\.\s*$)/g, ''],
  [/\b(student|undergraduate) with\b/gi, 'engineer with'],
];
export const crisp = (t) => {
  let out = String(t || '');
  for (const [re, to] of FILLER) out = out.replace(re, to);
  return out.replace(/[ \t]{2,}/g, ' ').replace(/(^|[.!?]\s+)([a-z])/g, (m, a, b) => a + b.toUpperCase()).trim();
};
const listJoin = (xs) => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}` : xs[0]);

// Sentences end at ". " + capital letter, so "B.Tech" or "Node.js" never split a sentence.
export const withoutGradSentences = (text) =>
  String(text || '')
    .split(/(?<=[.!?])\s+(?=[A-Z"(])/)
    .filter((x) => !/\b(graduat\w*|class of \d{4}|batch of \d{4}|final[- ]year)\b/i.test(x))
    .join(' ')
    .trim();
