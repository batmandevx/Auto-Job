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

export async function tailorResume(resume, sourceText, job, { fillGaps = false, fixThese = null, previous = null } = {}) {
  const indexed = {
    ...resume,
    experience: (resume.experience || []).map((e, index) => ({ index, ...e, bullets: e.bullets.map((text, b) => ({ b, text })) })),
    projects: (resume.projects || []).map((p, index) => ({ index, ...p, bullets: (p.bullets || []).map((text, b) => ({ b, text })) })),
  };
  const profileText = `${sourceText}\n${JSON.stringify(resume)}`;
  const preMatched = profileSkillsInJD(resume, job.description);
  // A fix-up pass revises the previous outline instead of starting over (facts stay fixed; presentation improves).
  const previousOutline = previous
    ? {
      headline: previous.headline,
      summary: previous.summary,
      skills: (previous.skills || []).map((s) => `${s.category}: ${(s.items || []).join(', ')}`),
      experience: (previous.experience || []).map((e, i) => `role ${i} (${e.title} @ ${e.company}):\n${(e.bullets || []).map((b) => `- ${b}`).join('\n')}`),
      projects: (previous.projects || []).map((p, i) => `project ${i} (${p.name}):\n${(p.bullets || []).map((b) => `- ${b}`).join('\n')}`),
    }
    : undefined;
  const out = await chatJSON(
    TAILOR_SYSTEM,
    JSON.stringify({
      RESUME: indexed,
      KEYWORDS_YOU_HAVE: preMatched,
      JOB: { title: job.title, company: job.company, description: job.description.slice(0, 15000) },
      ...(fixThese?.length ? { PREVIOUS_OUTLINE: previousOutline, FIX_THESE: fixThese } : {}),
    }),
    { temperature: 0.3, heavy: true },
  );

  const haystack = profileText.toLowerCase();
  // Whole-word matching against the profile, so "Perl" can't sneak in via "hyperlinks" or "EDA" via a project name.
  const inProfile = makeMatcher(profileText);
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

  // Skills: only ones the candidate actually listed (whole-word).
  let skills = (out.skills || [])
    .map((s) => ({ category: String(s.category || ''), items: (s.items || []).filter((x) => typeof x === 'string' && inProfile(x)) }))
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

  // Headline / summary may not introduce numbers the resume doesn't have, nor claim the job's skills
  // the profile doesn't back: a far-from-profile job tempts models to bluff ("deep foundations in
  // digital logic design" on a resume that never mentions it). Bluffing is rejected here — the honest
  // original summary is used instead, then augmented with the keywords you genuinely have below.
  const noNewNumbers = (t) => typeof t === 'string' && t.trim() && numbers(t).every((n) => haystack.includes(n));
  const aiText = `${out.summary || ''} ${out.headline || ''}`;
  const bluffTerms = [...new Set([...(out.jdKeywords || []), ...techTermsInJD(job.description)])]
    .filter((t) => !inProfile(t) && makeMatcher(aiText)(t));
  const summaryOk = noNewNumbers(out.summary) && !bluffTerms.length;
  const summary = summaryOk ? out.summary.trim() : resume.summary;
  const headline = noNewNumbers(out.headline) && !bluffTerms.length ? out.headline.trim() : resume.headline;
  if (!summaryOk && out.summary) notes.push(`Kept your original summary (the AI version claimed skills your resume doesn't back: ${bluffTerms.slice(0, 4).join(', ')}).`);
  if (summary === resume.summary && out.summary && bluffTerms.length === 0) notes.push('Kept your original summary (the AI version added facts).');

  // Alignment with the posting: the headline names the exact role (what recruiters and ATS search for),
  // and the summary carries the top keywords you have.
  const role = cleanRole(job.title);
  let finalHeadline = headline;
  if (role && !norm(headline).includes(norm(role))) {
    // Keep the AI's focus skills (it picks the job's core ones) — only ones your resume backs;
    // otherwise the job's own top keywords you genuinely have.
    const aiFocus = String(headline || '').split('|').slice(1).map((x) => x.trim()).filter((x) => x && x.length <= 40 && inProfile(x));
    const focus = aiFocus.length ? aiFocus.slice(0, 3) : matched.filter((k) => k.length <= 20 && !/^(python|sql|git|java)$/i.test(k)).slice(0, 3);
    finalHeadline = [role, ...focus].join(' | ');
  }
  let finalSummary = summary;
  const inSummary = makeMatcher(summary || '');
  const notInSummary = matched.filter((k) => !inSummary(k)).slice(0, Math.max(0, 6 - matched.filter(inSummary).length));
  const wordCount = (t) => String(t).split(/\s+/).filter(Boolean).length;
  // The Skills section already carries every keyword verbatim, so the summary addition is belt-and-braces:
  // add it only while the summary stays a 6-second read.
  if (notInSummary.length && wordCount(finalSummary) < 80) finalSummary = `${(summary || '').trim().replace(/\.?$/, '.')} Hands-on with ${listJoin(notInSummary)}.`;

  finalSummary = crisp(finalSummary);
  // Graduation talk: hidden for full-time roles (the standing rule). For internships, enrollment IS the
  // qualification ("intent to return to degree program"), so keep it — and make sure it is stated.
  if (!isInternship(job)) {
    const noGrad = withoutGradSentences(finalSummary);
    if (noGrad.length > 60) finalSummary = noGrad;
  } else {
    // Spell out degree abbreviations ("B.Tech in CSE" -> "Bachelor of Technology in Computer Science and
    // Engineering"): screener bots must be able to verify "Bachelor's degree in an engineering field".
    finalSummary = finalSummary.replace(/\bB\.?\s*Tech\b\.?/gi, 'Bachelor of Technology').replace(/\bCSE\b/g, 'Computer Science and Engineering');
    const edu = resume.education?.[0] || {};
    const fieldCore = String(edu.field || '').split('(')[0].trim();
    const degreeFull = degreeName([edu.degree, fieldCore].filter(Boolean).join(' in ')) || 'a degree';
    // The full field name ("...Engineering") must be verifiable in the summary itself, not just the
    // Education section: screeners read the summary first, and models paraphrase the field away.
    const fieldShown = fieldCore && norm(finalSummary).includes(norm(fieldCore));
    if (!/pursuing|enrolled|expected to (graduate|complete)|return to|undergraduate|class of 20\d\d/i.test(finalSummary)) {
      // Enrollment + degree name + return intent, all in one canonical sentence.
      if (edu.end) {
        const sentences = finalSummary.split(/(?<=[.!?])\s+/);
        while (sentences.length > 3 && wordCount(sentences.join(' ')) > 70) sentences.splice(sentences.length - 2, 1);
        finalSummary = `${sentences.join(' ')} Currently pursuing ${degreeFull}, and will return to the degree program after the internship to complete it in ${edu.end}.`;
      }
    } else if (!fieldShown) {
      // Enrolled, but the model paraphrased the field ("Computer Science (AI & ML)") and lost "Engineering".
      const sentences = finalSummary.split(/(?<=[.!?])\s+/);
      while (sentences.length > 3 && wordCount(sentences.join(' ')) > 78) sentences.splice(sentences.length - 2, 1);
      finalSummary = `${sentences.join(' ')} Pursuing ${degreeFull}${edu.end ? `, and will return to the degree program after the internship to complete it in ${edu.end}` : ''}.`;
    } else if (!/\breturn\b/i.test(finalSummary)) {
      // Enrolled and the degree is spelled out, but the return itself is not stated yet.
      const sentences = finalSummary.split(/(?<=[.!?])\s+/);
      while (sentences.length > 3 && wordCount(sentences.join(' ')) > 84) sentences.splice(sentences.length - 2, 1);
      finalSummary = `${sentences.join(' ')} Will return to the degree program after the internship to complete it${edu.end ? ` in ${edu.end}` : ''}.`;
    }
    // Recruiters skim: hard-cap the summary even if that drops a keyword sentence (the Skills block has them all).
    const sentences = finalSummary.split(/(?<=[.!?])\s+/);
    while (wordCount(finalSummary) > 95 && sentences.length > 3) {
      sentences.splice(sentences.length - 2, 1); // drop the least central sentence, keep the closing one
      finalSummary = sentences.join(' ');
    }
  }

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

// Deterministic quality gate for a tailored resume: what would make an ATS filter or a recruiter pass on it.
// Returns short problem notes; when non-empty, /api/tailor runs one fix-up pass with these spelled out.
export function tailorProblems(out, source) {
  const problems = [];
  const { resume, keywords } = out;
  const text = `${resume.headline || ''} ${resume.summary || ''}`.toLowerCase();
  const hay = norm(text);
  const top = (keywords?.covered || []).slice(0, 8);
  const missing = top.filter((k) => !hay.includes(norm(k)));
  if (missing.length >= 4) problems.push(`work ${missing.length} of the job's top keywords into the headline or summary verbatim: ${missing.slice(0, 5).join(', ')}`);
  const words = String(resume.summary || '').split(/\s+/).filter(Boolean).length;
  if (words && (words < 40 || words > 95)) problems.push(`summary is ${words} words: rewrite it at 50-85 words in 3 sentences`);
  const total = (keywords?.covered?.length || 0) + (keywords?.missing?.length || 0);
  if (total >= 8 && keywords.covered.length / total < 0.5) problems.push(`only ${keywords.covered.length} of ${total} job keywords are genuinely covered: choose closer-matching bullets and name the job's tools where the original work used them`);
  const noNumbers = (resume.experience || [])
    .map((e, i) => ({ e, src: source?.experience?.[i] }))
    .filter(({ e, src }) => e.bullets?.length && !e.bullets.some((b) => /\d/.test(b)) && (src?.bullets || []).some((b) => /\d/.test(b)))
    .map(({ e }) => String(e.company || e.title).split(',')[0]);
  if (noNumbers.length) problems.push(`these roles lost every real number even though the originals have some (keep each bullet's metric): ${noNumbers.join(', ')}`);
  return problems;
}

// "Software Development Engineer I – Payments (Remote)" -> "Software Development Engineer I"// "Intern - Bachelors - AI Engineering" -> "AI Engineering Intern"
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

// Internships screen FOR enrollment: "intent to return to degree program" is a qualification, so the
// no-grad-talk rule must not apply to them. Full-time roles keep hiding graduation timing.
export const isInternship = (job) => /\bintern(ship)?\b/i.test(String(job?.title || ''));

// "B.Tech" -> "Bachelor of Technology (B.Tech)": ATS screeners at US companies may not expand Indian
// degree abbreviations, and "Bachelor's degree in an engineering field" must be verifiable on the page.
export const degreeName = (d) =>
  String(d || '')
    .replace(/\bB\.?\s*Tech\b\.?/i, 'Bachelor of Technology (B.Tech)')
    .replace(/\bM\.?\s*Tech\b\.?/i, 'Master of Technology (M.Tech)')
    .replace(/\bB\.?\s*E\b\.?/i, 'Bachelor of Engineering (B.E.)')
    .replace(/\bM\.?\s*E\b\.?/i, 'Master of Engineering (M.E.)');
