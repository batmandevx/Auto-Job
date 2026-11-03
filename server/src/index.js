import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import mammoth from 'mammoth';
import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import { chatJSON, describeProvider, geminiStatus, usedFallbackRecently } from './llm.js';
import { PARSE_SYSTEM, COVER_SYSTEM, EMAIL_SYSTEM, VISION_SYSTEM } from './prompts.js';
import { tailorResume, withoutGradSentences, crisp, cleanRole } from './tailor.js';
import { profileSkillsInJD } from './keywords.js';
import { listHackathons } from './hackathons.js';
import { mailConfigured, mailStatus, findVerification, sendApplication, smtpCheck } from './mail.js';
import { renderResumePDF, renderCoverLetterPDF } from './pdf.js';
import { answerFields } from './answer.js';
import { getProfile, saveProfile, listApplications, upsertApplication, updateApplication, deleteApplication, STATUSES, rememberAnswers, getDocument, saveDocument, removeDocument, DOCUMENT_KINDS, DEFAULT_ANSWERS, RESUME_DIR } from './store.js';

const PORT = Number(process.env.PORT || 8787);
const app = express();
// Only the extension (and local pages) may call this server.
app.use(cors({ origin: (origin, cb) => cb(null, !origin || /^(chrome-extension:\/\/|http:\/\/localhost)/.test(origin)) }));
// Browsers still send "simple" cross-site POSTs (e.g. a form upload) even when CORS blocks the response,
// so any write from a web page that isn't the extension or localhost is refused outright.
const allowedOrigin = (o) => !o || /^(chrome-extension:\/\/|https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$)/.test(o);
app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'OPTIONS' && !allowedOrigin(req.headers.origin)) return res.status(403).json({ error: 'Forbidden origin' });
  next();
});
app.use(express.json({ limit: '15mb' })); // page screenshots for the visual check
// Dev aid: a sample application form, plus the content script so it can be tried without loading the extension.
app.use('/test', express.static(path.resolve(import.meta.dirname, '../test')));
app.use('/test/ext', express.static(path.resolve(import.meta.dirname, '../../extension')));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
const route = (fn) => (req, res) =>
  fn(req, res).catch((e) => {
    console.error(e);
    res.status(500).json({ error: e.message });
  });

app.get('/api/health', (req, res) => res.json({ ok: true, llm: describeProvider(), resting: geminiStatus(), usingLocalAI: usedFallbackRecently(), gmail: mailConfigured(), hasProfile: !!getProfile() }));

// Upload one or more resume versions (PDF / DOCX / TXT) and merge them into one structured profile.
async function resumeText(file) {
  const name = file.originalname.toLowerCase();
  if (name.endsWith('.pdf')) return (await pdfParse(file.buffer)).text;
  if (!name.endsWith('.docx')) return file.buffer.toString('utf8');
  let text = (await mammoth.extractRawText({ buffer: file.buffer })).value;
  // "LinkedIn", "GitHub"... are usually hyperlinks; raw text loses the URLs.
  const html = (await mammoth.convertToHtml({ buffer: file.buffer })).value;
  const links = [...html.matchAll(/href="([^"]+)"[^>]*>([^<]*)</g)].filter(([, url]) => !url.startsWith('mailto:'));
  if (links.length) text += `\n\nHYPERLINKS (link text -> URL):\n${links.map(([, url, label]) => `${label || '(icon)'} -> ${url}`).join('\n')}`;
  return text;
}

// Things you corrected by hand (links, CGPA, exact graduation date) win over what the resume files say.
const titleCase = (s) => String(s || '').toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase());
function keepManualEdits(parsed, old) {
  // "AYUSH UPADHYAY" in a resume header would become "AYUSH" in every first-name field.
  if (parsed.name && parsed.name === parsed.name.toUpperCase()) parsed.name = titleCase(parsed.name);
  if (!old) return;
  if (old.name && old.name.toLowerCase() === String(parsed.name).toLowerCase()) parsed.name = old.name;
  parsed.links ||= {};
  for (const k of ['linkedin', 'github', 'portfolio']) if (old.links?.[k]) parsed.links[k] = old.links[k];
  parsed.links.other = [...new Set([...(old.links?.other || []), ...(parsed.links.other || [])])].filter((u) => u !== parsed.links.portfolio);
  for (const e of parsed.education || []) {
    const prev = (old.education || []).find((o) => o.school && e.school && o.school.split(',')[0].toLowerCase() === e.school.split(',')[0].toLowerCase());
    if (!prev) continue;
    if (prev.gpa && !e.gpa) e.gpa = prev.gpa;
    if (prev.end && /[a-z]/i.test(prev.end) && String(prev.end).includes(String(e.end))) e.end = prev.end; // "May 2027" over "2027"
    if (prev.start && !e.start) e.start = prev.start;
  }
}

app.post('/api/profile/import', upload.array('resume', 20), route(async (req, res) => {
  if (!req.files?.length) return res.status(400).json({ error: 'No file uploaded' });
  const seen = new Set();
  const versions = [];
  for (const file of req.files) {
    const text = (await resumeText(file)).trim();
    const key = text.replace(/\s+/g, ' ').slice(0, 4000);
    if (!text || seen.has(key)) continue;
    seen.add(key);
    versions.push({ name: file.originalname, text });
  }
  if (!versions.length) return res.status(400).json({ error: 'Could not read any text from those files (scanned image PDF?)' });

  const sourceText = versions.map((v) => `===== RESUME VERSION: ${v.name} =====\n${v.text}`).join('\n\n');
  const parsed = await chatJSON(PARSE_SYSTEM, sourceText, { heavy: true });
  const old = getProfile();
  keepManualEdits(parsed, old);
  // Re-importing replaces the resume content but keeps personal details, answers, documents and remembered answers.
  const profile = { ...parsed, personal: old?.personal, documents: old?.documents, answerBank: old?.answerBank, answers: old?.answers || DEFAULT_ANSWERS, sourceText, sourceFiles: versions.map((v) => v.name) };
  saveProfile(profile);
  res.json(profile);
}));

app.get('/api/profile', (req, res) => res.json(getProfile()));

// "I have this skill": you confirm a job keyword the resume didn't show; it joins your skills for future tailoring.
app.post('/api/profile/skills', (req, res) => {
  const p = getProfile();
  const skill = String(req.body.skill || '').trim().slice(0, 60);
  if (!p || !skill) return res.status(400).json({ error: 'Nothing to add' });
  let cat = p.skills.find((x) => x.category === 'Additional skills');
  if (!cat) p.skills.push((cat = { category: 'Additional skills', items: [] }));
  if (!cat.items.some((i) => i.toLowerCase() === skill.toLowerCase())) cat.items.push(skill);
  p.sourceText = `${p.sourceText || ''}\nConfirmed skill: ${skill}`;
  saveProfile(p);
  res.json({ ok: true, skill });
});
app.put('/api/profile', (req, res) => {
  saveProfile(req.body);
  res.json(getProfile());
});

// Tailor the master resume to one job description and return the PDF.
app.post('/api/tailor', route(async (req, res) => {
  const profile = getProfile();
  if (!profile) return res.status(400).json({ error: 'Import your resume first' });
  const { title = '', company = '', description = '' } = req.body;
  if (description.trim().length < 80) return res.status(400).json({ error: 'Job description is missing or too short' });

  const { answers, sourceText, ...resume } = profile;
  const out = await tailorResume(resume, sourceText || '', { title, company, description }, { fillGaps: !!req.body.fillGaps });
  const tailored = out.resume;
  const pdf = await renderResumePDF(tailored);

  const safe = (s) => s.replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '');
  const filename = `${safe(resume.name || 'Resume')}_${safe(company || 'Resume')}.pdf`;
  fs.writeFileSync(path.join(RESUME_DIR, `${Date.now()}_${filename}`), pdf);

  res.json({
    filename,
    pdfBase64: pdf.toString('base64'),
    resume: tailored,
    changes: out.changes,
    matchScore: out.matchScore,
    missingKeywords: out.missingKeywords,
    keywords: out.keywords,
  });
}));

// Decide what to type into each detected form field.
app.post('/api/answer', route(async (req, res) => {
  const profile = getProfile();
  if (!profile) return res.status(400).json({ error: 'Import your resume first' });
  const { sourceText, ...rest } = profile;
  res.json(await answerFields({ fields: req.body.fields || [], profile: rest, job: req.body.job, coverLetter: req.body.coverLetter, errors: req.body.errors || {}, pageErrors: req.body.pageErrors || [] }));
}));

const STOCK = /I am (writing|applying)|validates? my|my capacity|leverag\w+|proves? my (ability|capability)|demonstrates? my|showcas\w+|my technical foundation|beyond these tools|passionate|excited|thrilled|perfect fit|I believe|I am confident|dream job|esteemed|leverage my|hit the ground running|from day one/gi;
function coverProblems(t) {
  const body = t.replace(/\n\s*(sincerely|regards|best regards)[\s\S]*$/i, '').replace(/^dear[^\n]*\n/i, '');
  const words = body.split(/\s+/).filter(Boolean).length;
  const paras = body.split(/\n\s*\n/).filter((x) => x.trim()).length;
  const stock = [...new Set((body.match(STOCK) || []).map((x) => x.toLowerCase()))];
  return [
    words > 340 && `${words} words: cut to 250-330`,
    words < 220 && `${words} words: expand to 250-330`,
    paras !== 4 && `${paras} paragraphs: use exactly 4`,
    stock.length && `remove these phrases: ${stock.join(', ')}`,
  ].filter(Boolean);
}

// Cover letter for one job: text (for text boxes) and a PDF (for upload fields).
app.post('/api/cover-letter', route(async (req, res) => {
  const profile = getProfile();
  if (!profile) return res.status(400).json({ error: 'Import your resume first' });
  const { title = '', company = '', location = '', description = '' } = req.body;
  if (description.trim().length < 80) return res.status(400).json({ error: 'Job description is missing or too short' });
  const { sourceText, answerBank, documents, personal, ...rest } = profile;
  const keywords = [...new Set([...(req.body.keywords || []), ...profileSkillsInJD(rest, description)])].slice(0, 16);
  const input = { PROFILE: rest, KEYWORDS_TO_USE: keywords, JOB: { title: cleanRole(title) || title, postedTitle: title, company, location, description: description.slice(0, 12000) } };
  let out = await chatJSON(COVER_SYSTEM, JSON.stringify(input), { temperature: 0.5, heavy: true });
  // Quality gate: length, four paragraphs, no stock phrases. One rewrite with the problems spelled out.
  const problems = coverProblems(String(out.text || ''));
  if (problems.length) out = await chatJSON(COVER_SYSTEM, JSON.stringify({ ...input, PREVIOUS_DRAFT: out.text, FIX_THESE: problems }), { temperature: 0.4, heavy: true }).catch(() => out);
  const text = crisp(String(out.text || '').trim()).replace(/ (?=\n)/g, '');
  if (text.length < 200) throw new Error('The AI returned an empty cover letter, try again');
  const pdf = await renderCoverLetterPDF(profile, text, { title: cleanRole(title) || title, company, location });
  const safe = (s) => s.replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '');
  const filename = `${safe(profile.name || 'Cover')}_Cover_Letter_${safe(company || 'Job')}.pdf`;
  fs.writeFileSync(path.join(RESUME_DIR, `${Date.now()}_${filename}`), pdf);
  const lower = text.toLowerCase();
  res.json({ text, filename, pdfBase64: pdf.toString('base64'), keywordsUsed: keywords.filter((k) => lower.includes(k.toLowerCase().split(' (')[0])) });
}));

// Your documents (photo, signature, marksheets, ID / address proof…): kept in data/documents on this Mac.
app.get('/api/documents', (req, res) => {
  const docs = getProfile()?.documents || {};
  res.json({ kinds: DOCUMENT_KINDS, saved: Object.fromEntries(DOCUMENT_KINDS.filter((k) => docs[k]).map((k) => [k, docs[k]])) });
});
app.post('/api/documents/:kind', upload.single('file'), route(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  res.json({ ok: true, name: saveDocument(req.params.kind, req.file.originalname, req.file.buffer) });
}));
app.delete('/api/documents/:kind', (req, res) => {
  removeDocument(req.params.kind);
  res.json({ ok: true });
});

app.get('/api/documents/:kind', (req, res) => {
  const doc = getDocument(req.params.kind);
  if (!doc) return res.status(404).json({ error: `No ${req.params.kind} saved in your profile` });
  res.json(doc);
});

// Remember the answers on a page (including your corrections) for the next application.
// Visual check: the panel sends screenshots of the filled page; Gemini says what looks wrong on screen.
app.post('/api/vision', route(async (req, res) => {
  const images = (req.body.images || []).filter((x) => typeof x === 'string' && x.length > 1000).slice(0, 4);
  if (!images.length) return res.json({ problems: [], summary: 'no screenshot' });
  const fields = (req.body.fields || []).slice(0, 150).map(({ n, label, type, required, filled }) => ({ n, label: String(label || '').slice(0, 140), type, required, filled }));
  const out = await chatJSON(VISION_SYSTEM, JSON.stringify({ URL: req.body.url || '', FIELDS: fields }), { temperature: 0.1, images, budgetMs: 70000 });
  const problems = (Array.isArray(out.problems) ? out.problems : []).filter((p) => p && p.problem).slice(0, 15).map((p) => ({ field: Number(p.field) || 0, label: String(p.label || ''), problem: String(p.problem), fix: String(p.fix || '') }));
  res.json({ problems, summary: String(out.summary || '') });
}));

app.post('/api/answer-bank', (req, res) => res.json({ saved: rememberAnswers(req.body.entries) }));

// Apply by email: draft (AI) → you review/edit in the panel → send (only on your confirm).
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;
app.post('/api/email/draft', route(async (req, res) => {
  const profile = getProfile();
  if (!profile) return res.status(400).json({ error: 'Import your resume first' });
  const { job = {}, recruiterName = '', keywords = [] } = req.body;
  const { sourceText, answerBank, documents, personal, ...rest } = profile;
  const kws = [...new Set([...keywords, ...profileSkillsInJD(rest, job.description || '')])].slice(0, 14);
  const out = await chatJSON(EMAIL_SYSTEM, JSON.stringify({ PROFILE: rest, RECRUITER_NAME: recruiterName, KEYWORDS_TO_USE: kws, JOB: { ...job, description: String(job.description || '').slice(0, 10000) } }), { temperature: 0.5 });
  const body = String(out.body || '').split('\n').map((line) => withoutGradSentences(line) || (line.trim() ? '' : line)).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!out.subject || body.length < 80) throw new Error('The AI returned an empty email, try again');
  res.json({ subject: String(out.subject).trim(), body });
}));

app.post('/api/email/send', route(async (req, res) => {
  const { to, cc, subject, body, attachments, job = {} } = req.body;
  const list = String(to || '').split(/[,;\s]+/).filter(Boolean);
  if (!list.length || !list.every((e) => EMAIL_RE.test(e))) return res.status(400).json({ error: 'Check the recipient email address' });
  if (!subject || !body) return res.status(400).json({ error: 'Subject and message are required' });
  const sent = await sendApplication({ to: list.join(', '), cc, subject, body, attachments });
  const tracked = upsertApplication({ title: job.title, company: job.company, url: job.url, location: job.location, status: 'applied', via: 'email', contact: list.join(', '), resume: attachments?.[0]?.filename });
  res.json({ ok: true, ...sent, application: tracked });
}));
app.get('/api/email/check', route(async (req, res) => res.json(await smtpCheck())));

// Gmail (read-only): find a verification code or link that arrived after `since`, waiting up to `wait` seconds.
app.get('/api/mail/status', route(async (req, res) => res.json(await mailStatus())));
app.get('/api/otp', route(async (req, res) => {
  const since = Number(req.query.since) || Date.now() - 10 * 60_000;
  const wait = Math.min(Number(req.query.wait) || 90, 180) * 1000;
  const end = Date.now() + wait;
  while (true) {
    const hit = await findVerification({ since, hint: String(req.query.hint || ''), want: String(req.query.want || 'any') });
    if (hit || Date.now() > end) return res.json(hit || { none: true });
    await new Promise((r) => setTimeout(r, 6000));
  }
}));

// Hackathons from 8 platforms, normalised and cached.
app.get('/api/hackathons', route(async (req, res) => res.json(await listHackathons({ refresh: req.query.refresh === '1' }))));

// Application tracker: saved → applied → assessment → interviews → offer / rejected.
app.get('/api/applications', (req, res) => res.json({ statuses: STATUSES, items: listApplications() }));
app.post('/api/applications', (req, res) => res.json(upsertApplication(req.body)));
app.post('/api/applications/bulk', (req, res) => res.json((req.body.items || []).map((a) => upsertApplication(a))));
app.patch('/api/applications/:id', (req, res) => {
  const a = updateApplication(req.params.id, req.body);
  if (!a) return res.status(404).json({ error: 'Not found' });
  res.json(a);
});
app.delete('/api/applications/:id', (req, res) => {
  deleteApplication(req.params.id);
  res.json({ ok: true });
});

const server = app.listen(PORT, '127.0.0.1', () => {
  const { provider, model } = describeProvider();
  console.log(`Auto Job server on http://localhost:${PORT}  (LLM: ${provider} / ${model})`);
});
server.on('error', (e) => {
  if (e.code !== 'EADDRINUSE') throw e;
  console.log(`Auto Job is already running on http://localhost:${PORT}. Nothing to do: the extension will use that one.`);
  console.log(`To restart it, stop the other one first:  lsof -ti tcp:${PORT} | xargs kill`);
  process.exit(0);
});
