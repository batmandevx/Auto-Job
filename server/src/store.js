import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DATA_DIR = process.env.AUTOJOB_DATA ? path.resolve(process.env.AUTOJOB_DATA) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../data'); // AUTOJOB_DATA: a different data folder (tests)
export const RESUME_DIR = path.join(DATA_DIR, 'resumes');
export const DOCS_DIR = path.join(DATA_DIR, 'documents');
fs.mkdirSync(RESUME_DIR, { recursive: true });
fs.mkdirSync(DOCS_DIR, { recursive: true });

const PROFILE = path.join(DATA_DIR, 'profile.json');
const APPS = path.join(DATA_DIR, 'applications.json');

// Answers to the questions almost every application asks. The user edits these
// once in the side panel; the AI uses them instead of guessing.
export const DEFAULT_ANSWERS = {
  workAuthorization: '',
  needsSponsorship: '',
  willingToRelocate: '',
  noticePeriod: '',
  expectedSalary: '',
  currentSalary: '',
  currentLocation: '',
  earliestStartDate: '',
  yearsOfExperience: '',
  currentlyEmployed: '',
  isFresher: '',
  noticeDays: '',
  expectedSalaryAnnual: '',
  currentSalaryAnnual: '',
  gender: 'Decline to self-identify',
  race: 'Decline to self-identify',
  veteranStatus: 'I am not a protected veteran',
  disabilityStatus: 'I do not wish to answer',
  howDidYouHear: 'Company website',
  jobTypes: '',
  workMode: '',
  targetRoles: '',
  governmentEmployee: '',
  extra: '',
};

// Details that forms ask for but resumes don't contain.
export const DEFAULT_PERSONAL = {
  dateOfBirth: '', // YYYY-MM-DD
  gender: '',
  nationality: '',
  fatherName: '',
  motherName: '',
  addressLine1: '',
  addressLine2: '',
  city: '',
  state: '',
  postalCode: '',
  country: '',
  // Where you live now, when it differs from the permanent address above (hostel / rented flat in another city).
  currentAddressLine1: '',
  currentCity: '',
  currentState: '',
  currentPostalCode: '',
  graduationYear: '',
  graduationDate: '', // e.g. May 2027
  placeOfBirth: '',
  languages: '',
  pronouns: '',
  maritalStatus: '',
  schooling: [], // [{ level, school, board, year, percentage }]
};

const read = (file, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
};
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2));

export function getProfile() {
  const p = read(PROFILE, null);
  if (!p) return null;
  p.answers = { ...DEFAULT_ANSWERS, ...(p.answers || {}) };
  p.personal = { ...DEFAULT_PERSONAL, ...(p.personal || {}) };
  p.documents ||= {};
  p.answerBank ||= {};
  return p;
}

export const saveProfile = (profile) => write(PROFILE, profile);

// ---------- application tracker ----------
// One record per job (matched by URL, else company + title), with a status history.
export const STATUSES = ['saved', 'applied', 'assessment', 'interview1', 'interview2', 'interview3', 'hr', 'offer', 'accepted', 'rejected', 'withdrawn'];

const appKey = (a) => (a.url ? String(a.url).split('#')[0] : `${a.company || ''}|${a.title || ''}`.toLowerCase());

export function upsertApplication(entry) {
  const apps = read(APPS, []);
  const now = new Date().toISOString();
  const status = STATUSES.includes(entry.status) ? entry.status : 'applied';
  let app = apps.find((a) => (entry.id && a.id === entry.id) || appKey(a) === appKey(entry));
  if (!app) {
    app = { id: Math.random().toString(36).slice(2, 10), createdAt: now, history: [], notes: '' };
    apps.unshift(app);
  }
  const { id, history, ...fields } = entry;
  // Saving a job for later never downgrades one you already applied to.
  const keepStatus = status === 'saved' && app.status && app.status !== 'saved';
  Object.assign(app, Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined && v !== '')), { status: keepStatus ? app.status : status, updatedAt: now });
  if (!keepStatus && app.history.at(-1)?.status !== app.status) app.history.push({ status: app.status, at: now });
  if (app.status === 'applied' && !app.appliedAt) app.appliedAt = now;
  write(APPS, apps.slice(0, 2000));
  return app;
}

// Extra things kept on an application (follow-up draft, prep brief) without touching its status or history.
export function saveAppExtra(id, extra) {
  const apps = read(APPS, []);
  const app = apps.find((a) => a.id === id);
  if (!app) return null;
  Object.assign(app, extra);
  write(APPS, apps);
  return app;
}

export function updateApplication(id, patch) {
  const apps = read(APPS, []);
  const app = apps.find((a) => a.id === id);
  if (!app) return null;
  const now = new Date().toISOString();
  if (patch.status && STATUSES.includes(patch.status) && patch.status !== app.status) {
    app.status = patch.status;
    app.history.push({ status: patch.status, at: now });
    if (patch.status === 'applied' && !app.appliedAt) app.appliedAt = now;
  }
  for (const k of ['notes', 'title', 'company', 'url', 'location', 'contact']) if (k in patch) app[k] = patch[k];
  // An email that moved (or confirmed) this application: kept so it's never applied twice, and shown on the card.
  if (patch.mail?.id && !(app.mail || []).some((m) => m.id === patch.mail.id)) {
    app.mail = [...(app.mail || []), patch.mail].slice(-20);
    if (app.history.at(-1)) app.history.at(-1).source = patch.status ? `email: ${String(patch.mail.subject || '').slice(0, 80)}` : app.history.at(-1).source;
  }
  if (patch.status === 'rejected' && patch.mail) app.rejectedAt = patch.mail.date || now;
  app.updatedAt = now;
  write(APPS, apps);
  return app;
}

export function deleteApplication(id) {
  write(APPS, read(APPS, []).filter((a) => a.id !== id));
}

// Older logs were plain {title, company, url, at}; give them ids and a status.
export const listApplications = () => {
  const apps = read(APPS, []);
  let changed = false;
  for (const a of apps) {
    if (!a.id) {
      Object.assign(a, { id: Math.random().toString(36).slice(2, 10), status: 'applied', createdAt: a.at, appliedAt: a.at, history: [{ status: 'applied', at: a.at }], notes: '' });
      changed = true;
    }
  }
  if (changed) write(APPS, apps);
  return apps;
};

export const logApplication = (entry) => upsertApplication({ ...entry, status: entry.status || 'applied' });

// Photo / signature etc. live in data/documents; the profile stores the file name per kind.
export function getDocument(kind) {
  const name = getProfile()?.documents?.[kind];
  if (!name) return null;
  const file = path.join(DOCS_DIR, path.basename(name));
  if (!fs.existsSync(file)) return null;
  const ext = path.extname(file).toLowerCase();
  const mime = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.pdf': 'application/pdf' }[ext] || 'application/octet-stream';
  return { filename: path.basename(file), mime, base64: fs.readFileSync(file).toString('base64') };
}

export const DOCUMENT_KINDS = ['photo', 'signature', 'marksheet10', 'marksheet12', 'idProof', 'addressProof', 'panCard', 'degree', 'transcript'];

// Store one document (replaces the previous file of that kind).
export function saveDocument(kind, originalName, buffer) {
  if (!DOCUMENT_KINDS.includes(kind)) throw new Error('Unknown document type');
  const ext = (path.extname(originalName || '').toLowerCase().match(/^\.(pdf|png|jpe?g)$/) || [])[0];
  if (!ext) throw new Error('Use a PDF, PNG or JPG file');
  const p = getProfile();
  if (!p) throw new Error('Import your resume first');
  const old = p.documents[kind];
  if (old) fs.rmSync(path.join(DOCS_DIR, path.basename(old)), { force: true });
  const name = `${kind}${ext}`;
  fs.writeFileSync(path.join(DOCS_DIR, name), buffer);
  p.documents[kind] = name;
  saveProfile(p);
  return name;
}
export function removeDocument(kind) {
  const p = getProfile();
  if (!p?.documents?.[kind]) return;
  fs.rmSync(path.join(DOCS_DIR, path.basename(p.documents[kind])), { force: true });
  delete p.documents[kind];
  saveProfile(p);
}

// Remembered answers, keyed by the normalised question text.
export const bankKey = (label) =>
  String(label || '')
    .toLowerCase()
    .replace(/\*|\(required\)|\(optional\)/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);

export function rememberAnswers(entries) {
  const p = getProfile();
  if (!p) return 0;
  let n = 0;
  for (const e of entries || []) {
    const key = bankKey(e.label);
    const value = typeof e.value === 'string' ? e.value.trim() : e.value;
    // Job-specific prose ("why us?") is not worth remembering verbatim.
    if (!key || key.length < 3 || value === '' || value == null || (typeof value === 'string' && value.length > 200)) continue;
    // Answers that depend on the job (its country, pay, the company itself) must be decided fresh every time.
    if (/sponsor|visa|authori[sz]|work permit|relocat|salary|ctc|compensation|why|this (role|company|position)|cover letter/.test(key)) continue;
    // Facts that change over time or answers written for one job: always fresh from your profile / the AI.
    if (/currently (employed|working)|employment status|notice|years? of (experience|exp)|anything else|additional|tell us|describe|explain|certify|agree|declare|used in production/.test(key)) continue;
    p.answerBank[key] = { value, type: e.type, at: new Date().toISOString() };
    n++;
  }
  saveProfile(p);
  return n;
}
