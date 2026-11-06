// Tracker helpers: a follow-up email draft for applications that went quiet, and an interview prep brief.
// Both are drafts for you to read; nothing here sends anything.
import { chatJSON } from './llm.js';
import { researchFor } from './research.js';

// The parts of your profile a recruiter conversation needs (no contact details, no documents).
function brief(profile) {
  return {
    name: profile.name,
    headline: profile.headline,
    skills: (profile.skills || []).slice(0, 40),
    experience: (profile.experience || []).slice(0, 6).map((e) => ({ title: e.title, company: e.company, start: e.start, end: e.end, bullets: (e.bullets || []).slice(0, 3) })),
    projects: (profile.projects || []).slice(0, 5).map((p) => ({ name: p.name, description: p.description || (p.bullets || []).slice(0, 2).join(' ') })),
    education: (profile.education || []).slice(0, 1).map((e) => ({ school: e.school, degree: e.degree, field: e.field, end: e.end })),
  };
}
const job = (app) => ({ title: app.title, company: app.company, location: app.location, appliedAt: app.appliedAt, description: String(app.description || '').slice(0, 8000) });

const FOLLOWUP_SYSTEM = `You write a short follow-up email from a job applicant whose application has had no reply.
Return JSON: {"subject": string, "body": string}.
- 80-130 words, warm and professional, no grovelling, no exclamation marks.
- Mention the exact role and when they applied (month and day), one concrete reason they fit (from PROFILE, true facts only),
  and a polite question about next steps or timeline.
- Address it to "Hiring Team" (you don't know the recruiter's name). Sign off with the applicant's name only.
- Never invent facts, numbers, contacts or links.`;

const PREP_SYSTEM = `You prepare a candidate for an interview. Use only facts from PROFILE, JOB and COMPANY_FACTS; never invent company facts.
Return JSON: {
 "summary": string (2 sentences: what the role is about and what they will probe),
 "likelyQuestions": [{"q": string, "angle": string (how to answer, naming the candidate's own experience)}] (6-8, mix of technical and behavioural),
 "yourStories": [{"story": string (a role or project from PROFILE), "use": string (which questions it answers)}] (3-4),
 "askThem": [string] (4 thoughtful questions to ask the interviewer),
 "checklist": [string] (4-6 things to revise or prepare the day before)
}`;

// Models occasionally return almost-JSON (an unquoted string): ask once more, stricter.
async function ask(system, user, opts) {
  try {
    return await chatJSON(system, user, opts);
  } catch (e) {
    if (!/json|unexpected token|unterminated/i.test(String(e.message))) throw e;
    return chatJSON(`${system}\nReturn strictly valid JSON: every string in double quotes, no comments, no trailing commas.`, user, { ...opts, temperature: 0.1 });
  }
}

export async function followUpDraft(app, profile) {
  return ask(FOLLOWUP_SYSTEM, JSON.stringify({ TODAY: new Date().toISOString().slice(0, 10), PROFILE: brief(profile), JOB: job(app) }), { temperature: 0.5, budgetMs: 40000 });
}

export async function interviewPrep(app, profile) {
  const facts = researchFor({ company: app.company, title: app.title });
  return ask(PREP_SYSTEM, JSON.stringify({ PROFILE: brief(profile), JOB: job(app), ...(facts ? { COMPANY_FACTS: facts } : {}) }), { temperature: 0.4, budgetMs: 60000 });
}
