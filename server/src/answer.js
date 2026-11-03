import { chatJSON } from './llm.js';
import { ANSWER_SYSTEM } from './prompts.js';
import { bankKey } from './store.js';
import { withoutGradSentences } from './tailor.js';

const POSTGRAD_TEXT = /post\s*-?\s*graduat\w*\s*(year|date|passing)|year\s*of\s*post\s*-?\s*graduat/i;
const TEXTLIKE = ['text', 'email', 'tel', 'url', 'search', 'date', 'number', 'combobox', ''];
const first = (p) => p.name.split(/\s+/)[0];
const last = (p) => p.name.split(/\s+/).slice(1).join(' ');
const LINK_LABEL = /portfolio|personal\s*(web)?site|^website|other\s*(website|url|link)|your\s*website|work\s*links?|^(other\s*)?links?\b|profile\s*links?|social\s*(links?|profiles?)/i;
// Degree lists rarely have your exact degree ("B.Tech" in a list with only "Bachelor of Engineering", "Bachelors"…):
// try the closest equivalents in order. Education-level lists get the level ("Bachelor's degree", "Undergraduate").
const DEGREE_LABEL = /^degree\b|degree\s*(type|name|obtained|pursued)|highest\s*(degree|qualification)|^qualification$/i;
const LEVEL_LABEL = /education(al)?\s*level|level\s*of\s*(education|study|degree)|highest\s*(level\s*of\s*)?education|degree\s*level|qualification\s*level/i;
const linkList = (p) => [...new Set([p.links?.portfolio, p.links?.linkedin, p.links?.github, ...(p.links?.other || []).filter((l) => !/leetcode/i.test(l))].filter(Boolean))];
// "Link 2", "URL 3", "Website 2": the number picks the link; repeated identical boxes use their entry number.
const linkIndex = (f) => Number((clean(String(f.label).split('›').pop()).match(/\b(?:link|url|website)\s*#?\s*(\d)\b/i) || [])[1] || f.entry || 1) - 1;
// Spoken languages ("English, Hindi") and how well: Hindi native, English fluent.
const spoken = (p) => String(p.personal?.languages || '').split(/\s*[,;/]\s*|\s+and\s+/i).filter(Boolean);
const LANG_NAME = /^(spoken\s*)?language(\s*name)?$/i;
const LANG_LEVEL = /proficiency|fluency|^level$|language\s*level|how well/i;
const nativeLang = (lang) => /hindi/i.test(lang);
const LEVEL_WORDS = {
  native: ['native', 'native or bilingual', 'native or bilingual proficiency', 'native speaker', 'mother tongue', 'bilingual', 'fluent', 'expert', 'advanced'],
  fluent: ['fluent', 'full professional proficiency', 'full professional', 'professional working proficiency', 'professional', 'advanced', 'proficient', 'expert'],
};
// "How did you hear about us?": LinkedIn first, then the company's own site, then a job board.
const HEAR_LABEL = /how did you (hear|find|learn|come)|where did you (hear|find|see)|^(source|referral source)(\s*of\s*(application|referral|hire))?$|how did you (come|get) to know|hear about (us|this)|know about (the|this) (opportunity|job|role|position)/i;
const SOURCE_LADDER = ['linkedin', 'linkedinjobs', 'companywebsite', 'careerswebsite', 'careersite', 'companycareersite', 'corporatewebsite', 'careerspage', 'jobboard', 'jobboards', 'onlinejobboard', 'jobsite', 'socialmedia', 'socialnetwork', 'internet', 'online', 'website', 'other'];
// "S.O.", "S/O", "D/O", "C/O" read as "son of" etc.: never typed into an address.
const worksHere = (p, job) => { const c = normT(job?.company).slice(0, 6); return c.length > 2 && (p.experience || []).some((e) => normT(e.company).includes(c)); };
// "mention full no - example 500000", "Annual CTC in INR": a plain number, not "₹12–18 LPA".
const FULL_NUMBER = /annual|per annum|yearly|in inr|in rupees|lpa|full\s*(no|number|amount)|example\s*-?\s*\d{4,}|numbers? only|digits/i;
// The job is outside India (from the question or the job's location): you'd need a visa there.
const ABROAD = /united states|\busa?\b|america|canada|\buk\b|united kingdom|england|germany|ireland|netherlands|france|singapore|australia|japan|uae|dubai|europe/i;
const abroad = (f, job) => (/india/i.test(f.label) ? false : ABROAD.test(f.label) || (!!job?.location && !/india|remote/i.test(job.location) && ABROAD.test(job.location)));
const localToday = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
// Year of study from your degree's start ("2023", classes from August): 3 years done in Nov 2026 -> senior year.
function academicStanding(p, now = new Date()) {
  const start = Number((String(p.education?.[0]?.start || '').match(/\d{4}/) || [])[0]);
  if (!start) return undefined;
  const done = Math.max(0, now.getFullYear() - start - (now.getMonth() < 7 ? 1 : 0));
  return ['Currently studying in Freshman year', 'Completed Freshman year, currently studying in Sophomore year', 'Completed Sophomore year, currently studying in Junior year', 'Completed Junior year, currently studying in Senior year'][Math.min(done, 3)];
}
// "May 2027" / "2027-05" / "1999-03-30" into the shape the question asks for ("MM/YYYY", "DD/MM/YYYY"…).
function toHintFormat(v, hint, fallback = '') {
  const fmt = (String(hint).match(/\b(MM|DD|YYYY)([/.\-])(MM|DD|YYYY)(?:\2(MM|DD|YYYY))?\b/i) || [])[0] || fallback;
  if (!fmt) return v;
  const t = String(v).trim();
  const MON = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  let y, mo, d;
  const iso = t.match(/^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?/);
  if (iso) [, y, mo, d] = iso;
  else {
    y = (t.match(/\b(19|20)\d{2}\b/) || [])[0];
    const i = MON.findIndex((x) => t.toLowerCase().includes(x));
    if (i >= 0) mo = String(i + 1);
  }
  if (!y || (!mo && /MM/i.test(fmt))) return v;
  const parts = { YYYY: y, MM: String(mo || '').padStart(2, '0'), DD: String(d || '1').padStart(2, '0') };
  const sep = fmt.match(/[/.\-]/)[0];
  return fmt.toUpperCase().split(/[/.\-]/).map((x) => parts[x]).join(sep);
}
const noRelation = (a) => String(a || '').replace(/,?\s*\b[SDWC]\s*[./]\s*O\b\.?/gi, '').replace(/\s{2,}/g, ' ').replace(/^[,\s]+|[,\s]+$/g, '').trim();
const digits = (s) => String(s || '').replace(/\D/g, '');

// Common fields are filled from the profile directly: instant, free and never hallucinated.
// Order matters: more specific patterns first. Everything else goes to the model in one batch.
const RULES = [
  // EEO self-identification: your saved answers.
  [/^(race|ethnicity|race\s*\/\s*ethnicity|race and ethnicity)\b/i, (p) => p.answers.race],
  [/veteran\s*status|protected veteran/i, (p) => p.answers.veteranStatus],
  [/disability\s*status|have a disability/i, (p) => p.answers.disabilityStatus],
  [/academic standing|current (academic )?(year|status) (of|in) (study|college|university)|year of study|which year are you in|current year of (your )?(degree|study)/i, (p) => academicStanding(p)],
  [/current\s*(company|employer|organi[sz]ation)(\s*name)?/i, (p, f) => (/^\s*yes/i.test(p.answers.currentlyEmployed || '') || f.required ? String(p.experience?.[0]?.company || '').split(',')[0] || undefined : null)],
  [/^(today'?s\s*)?date$|signature date|date signed/i, (p, f) => toHintFormat(localToday(), `${f.placeholder || ''} ${f.label}`, 'MM/DD/YYYY')],
  // Screening questions with fixed answers from your profile.
  [/non-?compet|non-?solicit|(agreement|bond|contract).{0,80}restrict|restrict.{0,40}(ability|perform)/i, () => 'No'],
  [/sponsor(ship)?/i, (p, f, job) => (abroad(f, job) ? 'Yes' : 'No')],
  [/younger than 18|under (the age of )?18|below 18|less than 18|minor\b/i, () => 'No'],
  [/(18|eighteen) (years|yrs)( of age)? or (older|above|over)|at least 18|over (the age of )?18/i, () => 'Yes'],
  [/(were|are|have) you (ever |currently )?(been |worked as )?(a |an )?(former )?government (employee|official|servant)|ever (a|been a|worked as a) government|civil service or military/i, (p, f) => (/family|relative|spouse|parent|sibling/i.test(f.label) ? undefined : 'No')],
  // Conflict-of-interest questions are facts about you, never guessed: no family at the company, never worked for it
  // (unless it is in your experience), happy to work from the posted location.
  [/family|relative|related to|spouse|in-law/i, (p, f) => (/\?|^do you|^are you|^is any/i.test(f.label) && /relationship|related|relative|member|employ|board|director|reporting/i.test(f.label) ? 'No' : undefined)],
  [/(currently|previously|in the past|ever).{0,60}(worked|employed|been an? (employee|contractor)).{0,80}(consult|affiliat|subsidiar|project|this company|for us|with us|any of)/i, (p, f, job) => (worksHere(p, job) ? 'Yes' : 'No')],
  // Work authorisation: you're an Indian citizen, so Yes for India, and No for other countries
  // (the answers say you hold no visa for them).
  [/legally (authori[sz]ed|eligible|permitted|allowed) to work|authori[sz]ed to work|right to work|eligible to work/i, (p, f, job) => (abroad(f, job) ? 'No' : 'Yes')],
  [/(are you )?currently (employed|working)(\?|$)|current employment status/i, (p) => yesNo(p.answers.currentlyEmployed)],
  [/willing to (work|commute).{0,30}(location|office|site|city)|work from the location/i, () => 'Yes'],
  [/first\s*name|given\s*name|fname|forename/i, first],
  [/middle\s*name/i, () => ''],
  [/last\s*name|surname|family\s*name|lname/i, last],
  [/mother'?s?\s*(maiden\s*)?name/i, (p) => p.personal.motherName],
  [/father'?s?\s*name|parent.*name|guardian.*name/i, (p) => p.personal.fatherName],
  [/preferred\s*(first\s*)?name|nick\s*name/i, first],
  [/^(full\s*)?name\b|your\s*name|legal\s*name|candidate\s*name|applicant\s*name/i, (p) => p.name],
  [/confirm.*e-?mail|e-?mail.*(again|confirm)/i, (p) => p.email],
  [/e-?mail/i, (p) => p.email],
  [/country\s*(phone\s*)?code|dial(l)?ing\s*code|isd/i, (p) => (p.phone.match(/^\+\d{1,3}/) || ['+91'])[0]],
  [/phone\s*ext|^ext(ension)?\b|extension/i, () => undefined],
  [/phone|mobile|contact\s*(no|number)|cell|whatsapp/i, (p, f) => (f.codeBeside ? digits(p.phone).slice(-10) : p.phone)],
  [/linked\s*in/i, (p) => p.links?.linkedin],
  [/git\s*hub/i, (p) => p.links?.github],
  [/leet\s*code/i, (p) => p.links?.other?.find((l) => /leetcode/i.test(l))],
  // Rows of link boxes ("Work Link / Online Portfolio" with a "+"): portfolio first, then LinkedIn, GitHub…
  [LINK_LABEL, (p, f) => linkList(p)[linkIndex(f)]],
  [/date\s*of\s*birth|\bdob\b|birth\s*date|birthday/i, (p) => p.personal.dateOfBirth],
  [/nationality|citizenship/i, (p) => p.personal.nationality],
  [/place\s*of\s*birth|birth\s*place|city\s*of\s*birth/i, (p) => p.personal.placeOfBirth],
  [{ test: (l) => LANG_NAME.test(l) }, (p, f) => (/language/i.test(f.section || '') || f.entry ? spoken(p)[(f.entry || 1) - 1] : spoken(p)[0])],
  [{ test: (l) => LANG_LEVEL.test(l) }, (p, f) => (/language/i.test(`${f.section || ''} ${f.label}`) ? (nativeLang(spoken(p)[(f.entry || 1) - 1]) ? 'Native' : 'Fluent') : undefined)],
  [HEAR_LABEL, () => 'LinkedIn'],
  [/^(languages?\s*(known|spoken)?|spoken\s*languages?|languages you (speak|know))$/i, (p) => p.personal.languages],
  [/\bc?gpa\b|grade\s*point|cumulative\s*grade/i, (p) => p.education?.[0]?.gpa],
  [/^(gender|sex|gender identity)\b/i, (p) => p.personal.gender || p.answers.gender],
  [/pronouns?/i, (p) => p.personal.pronouns],
  [/marital\s*status/i, (p) => p.personal.maritalStatus],
  [/address\s*(line)?\s*1|street\s*address|^address$|permanent\s*address|residential\s*address/i, (p) => noRelation(p.personal.addressLine1)],
  [/address\s*(line)?\s*2/i, (p) => noRelation(p.personal.addressLine2)],
  [/^(postal|zip|pin)\s*code|^zip\b|pin\s*code|pincode|postcode/i, (p) => p.personal.postalCode],
  [/^state\b|^province\b|state\s*\/\s*province/i, (p) => p.personal.state],
  [/^city$|^town$|city\s*of\s*residence|home\s*city/i, (p) => p.personal.city],
  [/^(current\s*)?(location|city)\b|where are you (based|located)/i, (p) => p.answers.currentLocation || p.location],
  [/^country(\s*of\s*residence)?$/i, (p) => p.personal.country],
  [{ test: (l) => POSTGRAD_TEXT.test(l) && asksPostgradOnly(l) }, (p) => (hasPostgrad(p) ? undefined : 'Not applicable')],
  ...schoolRules(),
  [/graduation\s*(month|date)|(month|date)\s*of\s*graduation|expected\s*graduation\s*date|degree\s*completion\s*date/i, (p) => p.personal.graduationDate || p.personal.graduationYear],
  [/graduation\s*year|year\s*of\s*(graduation|passing)|expected\s*graduation|passing\s*year|pass\s*-?\s*out\s*year|passed\s*out|batch/i, (p) => p.personal.graduationYear],
  [/(university|college|school|institution)(\s*name)?$/i, (p) => p.education?.[0]?.school],
  [LEVEL_LABEL, () => "Bachelor's degree"],
  [/^degree|highest\s*(degree|qualification)/i, (p) => p.education?.[0]?.degree],
  [/field\s*of\s*study|major|discipline|specialization/i, (p) => p.education?.[0]?.field],
  // Joining time: a number of days when the question asks in days or the box is numeric.
  [/how soon can you join|notice\s*period|joining\s*(time|period|date)|days to join|can you join|when can you (start|join)/i, (p, f) => (numericField(f) || /\bdays?\b/i.test(f.label) ? p.answers.noticeDays || '1' : p.answers.noticePeriod)],
  [/willing to relocate|open to relocat|relocation|ready to relocate/i, (p) => yesNo(p.answers.willingToRelocate)],
  [/(total|overall|relevant)?\s*(years?|yrs)\s*(of)?\s*(work\s*)?experience|experience\s*\(?\s*(in\s*)?years|^experience$/i, (p) => (fresher(p) ? '0' : undefined)],
  [/(months?)\s*(of)?\s*(work\s*)?experience|experience.*months/i, (p) => (fresher(p) ? '0' : undefined)],
  [/current\s*(annual\s*)?(ctc|salary|compensation)/i, (p, f) => (numericField(f) || FULL_NUMBER.test(f.label) ? p.answers.currentSalaryAnnual : p.answers.currentSalary)],
  [/expected\s*(annual\s*|yearly\s*)?(ctc|salary|compensation|pay)|salary\s*expectation|desired\s*(salary|pay)|ctc.*expect/i, (p, f) => (numericField(f) || FULL_NUMBER.test(f.label) ? p.answers.expectedSalaryAnnual : p.answers.expectedSalary)],
];

// "Class 10 percentage", "12th board", "Year of passing Class XII", "HSC school name"...
function schoolRules() {
  const levels = [
    [/\b(class|std|standard|grade)?\s*(xii|12|12th|twelfth)\b|\bhsc\b|senior\s*secondary|intermediate|higher\s*secondary|\bpuc\b/i, /12|senior/i],
    [/\b(class|std|standard|grade)?\s*(x|10|10th|tenth)\b|\bssc\b|matric|(?<!senior\s|higher\s)secondary/i, /10|^class 10|\(secondary\)/i],
  ];
  const attrs = [
    [/percent|marks|score|cgpa|gpa|grade|result|aggregate/i, 'percentage'],
    [/board/i, 'board'],
    [/year|passing|passed|completion/i, 'year'],
    [/school|institut|college|name/i, 'school'],
    [/stream|subjects?|specialization/i, 'stream'],
  ];
  const rules = [];
  for (const [levelRe, pick] of levels) {
    for (const [attrRe, key] of attrs) {
      rules.push([
        { test: (l) => levelRe.test(l) && attrRe.test(l) },
        (p) => (p.personal.schooling || []).find((s) => pick.test(s.level))?.[key],
      ]);
    }
  }
  return rules;
}

const CHOICE = ['select', 'dropdown', 'radio', 'checkbox-group'];
const POSTGRAD = /post\s*-?\s*graduat|\bpg\b|master'?s?\s*(degree|year|passing)/i;
const NA_OPTION = /^(not applicable|n\s*\/\s*a|na|none|nil|-+|not available|no)$/i;
// "Post Graduation Year" alone, not "Graduation or Post Graduation, whichever is latest".
const asksPostgradOnly = (label) => POSTGRAD.test(label) && !/(graduation|ug|bachelor'?s?)\s*(or|\/|&|and)\s*(post|pg)|whichever|latest|highest/i.test(label);
const hasPostgrad = (p) => (p.education || []).some((e) => /master|m\.?\s?tech|m\.?\s?s\b|mba|m\.?sc|post\s*grad|ph\.?d/i.test(`${e.degree} ${e.field}`));
const normT = (x) => String(x ?? '').toLowerCase().replace(/[^a-z0-9+]/g, '');

// A box that only takes a number: type=number, a numeric placeholder ("850,000"), or a CTC/salary amount field.
const numericField = (f) => f.type === 'number' || /^[\d,.\s]+$/.test(String(f.placeholder || '').trim()) || /ctc|lakh|salary|amount|in_days|days/i.test(f.name || '');
const yesNo = (v) => (/^\s*no\b/i.test(String(v)) ? 'No' : /^\s*yes\b/i.test(String(v)) ? 'Yes' : undefined);
const fresher = (p) => /^\s*yes/i.test(p.answers.isFresher || '');

const DEGREE_LADDERS = [
  [/b\.?\s*tech|bachelor of technology/i, ['bachelor of technology', 'btech', 'b tech', 'bachelor of engineering', 'be', 'bachelor of science in engineering', 'bachelor of science', 'bs', 'bsc']],
  [/b\.?\s*e\b|bachelor of engineering/i, ['bachelor of engineering', 'be', 'bachelor of technology', 'btech', 'bachelor of science']],
  [/b\.?\s*sc|b\.?\s*s\b|bachelor of science/i, ['bachelor of science', 'bsc', 'bs']],
];
const LEVEL_LADDER = ['bachelors degree', 'bachelors', 'bachelor degree', 'bachelor', 'undergraduate degree', 'undergraduate', 'ug', 'graduate', 'college degree', '4 year degree', 'four year degree'];
function degreeOption(options, degree) {
  const ladder = [...(DEGREE_LADDERS.find(([re]) => re.test(String(degree || '')))?.[1] || []), ...LEVEL_LADDER].map(normT);
  const opts = options.map((o) => [o, normT(o)]);
  const exact = ladder.map((w) => opts.find(([, n]) => n === w)).find(Boolean);
  if (exact) return exact[0];
  // "Bachelor of Technology (B.Tech)", "Bachelor's Degree or equivalent"
  const prefix = ladder.filter((w) => w.length >= 9).map((w) => opts.find(([, n]) => n.startsWith(w) && !/master|doctor|associate|diploma/.test(n))).find(Boolean);
  return prefix?.[0];
}

// Work Experience #n fields come straight from your profile's n-th role (most recent first), not from the AI.
const EXP_SECTION = /experience|employment|work history|positions?|jobs?/i;
const isPresent = (end) => /present|current|now|ongoing/i.test(String(end || ''));
function experienceValue(field, profile) {
  const last = clean(String(field.label).split('›').pop()).replace(/\s*\((month|year|day)\)$/i, '');
  const jobLabel = last.length <= 40 && !/ctc|cost to|salary|compensation/i.test(last) && /job\s*title|position\s*title|^title$|designation|^(company|employer)(\s*name)?\W*$|currently work|role description/i.test(last);
  if (!EXP_SECTION.test(field.section || '') && !jobLabel) return undefined;
  if (/years|total|how many|months of/i.test(last)) return undefined;
  const e = profile.experience?.[(field.entry || 1) - 1];
  if (!e) return undefined;
  if (/currently work|current(ly)?\s*(employed|role|job)|i work here|still work/i.test(last)) return isPresent(e.end);
  if (/description|responsibilit|duties|summary|achievements?|what did you do/i.test(last)) return (e.bullets || []).map((b) => `• ${b}`).join('\n') || undefined;
  if (/job\s*title|position|^title$|designation|^role$/i.test(last)) return e.title;
  if (/^(company|employer|organi[sz]ation)(\s*name)?\W*$|name of (the )?(company|employer)/i.test(last)) return String(e.company || '').split(',')[0].trim() || e.company;
  if (/location|city/i.test(last)) return e.location || undefined;
  if (/^(from|start)|start\s*date|date\s*from/i.test(last)) return e.start;
  if (/^(to|end)\b|end\s*date|date\s*to/i.test(last)) return isPresent(e.end) ? undefined : e.end;
  return undefined;
}

function ruleValue(field, profile, job) {
  const exp = experienceValue(field, profile);
  if (exp !== undefined && exp !== '') return CHOICE.includes(field.type) && field.options?.length ? field.options.find((o) => normT(o) === normT(exp)) : exp;
  const last = clean(String(field.label).split('›').pop());
  const linkRow = LINK_LABEL.test(last) || LANG_NAME.test(last) || (LANG_LEVEL.test(last) && /language/i.test(`${field.section || ''} ${field.label}`));
  if (field.entry > 1 && !linkRow) return undefined; // later entries of repeated sections: the AI maps them by order (link rows: next link)
  // Dropdowns too, as long as the profile fact is one of the real options ("2027" in a passout-year list).
  if (CHOICE.includes(field.type) && field.options?.length) {
    if (asksPostgradOnly(field.label) && !hasPostgrad(profile)) return field.options.find((o) => NA_OPTION.test(String(o).trim()));
    const label = clean(String(field.label).split('›').pop());
    if (HEAR_LABEL.test(label)) {
      const opts = field.options.map((o) => [o, normT(o)]);
      const hit = SOURCE_LADDER.map((w) => opts.find(([, n]) => n === w) || opts.find(([, n]) => n.startsWith(w))).find(Boolean) || SOURCE_LADDER.map((w) => opts.find(([, n]) => n.includes(w))).find(Boolean);
      if (hit) return hit[0];
    }
    if (LANG_LEVEL.test(label) && /language/i.test(`${field.section || ''} ${field.label}`)) {
      const words = LEVEL_WORDS[nativeLang(spoken(profile)[(field.entry || 1) - 1]) ? 'native' : 'fluent'].map(normT);
      const hit = words.map((w) => field.options.find((o) => normT(o) === w) || field.options.find((o) => w.length > 5 && normT(o).startsWith(w))).find(Boolean);
      if (hit) return hit;
    }
    if (DEGREE_LABEL.test(label) || LEVEL_LABEL.test(label)) {
      const pick = degreeOption(field.options, LEVEL_LABEL.test(label) ? '' : profile.education?.[0]?.degree);
      if (pick) return pick;
    }
    const v = ruleValue({ ...field, type: 'text', options: undefined }, profile, job);
    if (v === undefined || v === null) return v;
    const want = normT(v);
    return (
      field.options.find((o) => normT(o) === want) ||
      field.options.find((o) => want.length > 2 && (normT(o).startsWith(want) || normT(o).includes(want))) ||
      field.options.find((o) => normT(o).length === 1 && want.startsWith(normT(o))) // "M" / "F" style lists
    );
  }
  // Workday asks short facts in multi-line boxes ("notice period (in days)", "expected Annual CTC"): those come from the profile too.
  if (field.type === 'textarea' && /notice|ctc|cost to company|salary|compensation|stipend|how soon|join|in days/i.test(clean(String(field.label).split('›').pop())) && !/describe|explain|why|tell us/i.test(field.label)) field = { ...field, type: 'text' };
  if (!TEXTLIKE.includes(field.type)) return undefined;
  const label = clean(String(field.label).split('›').pop()) || clean(field.name); // "Education #1 › School" -> "School"
  for (const [re, get] of RULES) {
    if (!re.test(label)) continue;
    let v = get(profile, field, job);
    if (v === null) return null; // deliberately left empty (e.g. optional "Current company" while not employed)
    if (v === undefined || v === '') return undefined; // unknown: let the model / human handle it
    // "(MM/YYYY)", "MM-YYYY", "YYYY-MM" in the question: dates in exactly that shape.
    if (/graduat|complet|date|month and year|when/i.test(label)) v = toHintFormat(v, `${field.placeholder || ''} ${label}`);
    if (field.type === 'number' && !/^\d+$/.test(String(v).trim())) return undefined; // e.g. "₹12–18 LPA" into a number box: let the model convert
    if (/birth|dob/i.test(label) && field.type !== 'date') v = formatDate(v, `${field.placeholder} ${label}`);
    if (field.type === 'tel' && field.maxLength && field.maxLength <= 10) v = digits(v).slice(-field.maxLength);
    if (/phone|mobile/i.test(label) && /without|10.digit|exclud.*code/i.test(label)) v = digits(v).slice(-10);
    return v;
  }
  return undefined;
}
// Profile dates are YYYY-MM-DD; text fields often want DD/MM/YYYY or MM/DD/YYYY.
function formatDate(iso, hint) {
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return iso;
  const [, y, mo, d] = m;
  const h = hint.toLowerCase();
  const sep = (h.match(/(?:dd|mm)([/.-])(?:dd|mm)/) || [, '/'])[1];
  if (/mm[/.-]dd/.test(h)) return `${mo}${sep}${d}${sep}${y}`;
  if (/dd[/.-]mm/.test(h)) return `${d}${sep}${mo}${sep}${y}`;
  if (/yyyy[/.-]mm/.test(h)) return iso;
  return `${d}/${mo}/${y}`;
}
const clean = (s) => String(s || '').replace(/\s+/g, ' ').replace(/\*/g, '').trim();

// A remembered answer only counts if it is still a valid option for this field.
function bankValue(field, bank) {
  const hit = bank[bankKey(field.label)];
  if (!hit) return undefined;
  if (!field.options?.length) return hit.value;
  const v = String(hit.value).toLowerCase();
  const match = field.options.find((o) => o.toLowerCase() === v);
  return match;
}

const COVER = /cover\s*letter|letter\s*of\s*(motivation|interest)|motivation\s*letter/i;
const CONSENT = /\b(i have read|i've read|i agree|i accept|i consent|i acknowledge|i certify|i confirm|i declare|i understand|i commit|i hereby|i will (comply|adhere|abide|follow)|privacy (policy|information|notice|statement)|terms (and|&) conditions|terms of (use|service))\b/i;
// The "yes" choice of an agreement dropdown / radio: "I Agree", "Agree", "Yes", "I accept", "I understand"…
const AGREE_OPTION = /^(i\s+)?(agree|accept|consent|acknowledge|understand|confirm|yes)\b/i;

export async function answerFields({ fields, profile, job, coverLetter, errors = {}, pageErrors = [] }) {
  const values = {};
  const source = {};
  const pending = [];
  const consentIds = [];
  const { answerBank = {}, ...forModel } = profile;
  for (const f of fields) {
    if (f.type === 'file') continue;
    const err = errors[f.id];
    let v = err ? quickFix(f, err) : ruleValue(f, profile, job);
    if (err && v !== undefined) source[f.id] = 'auto-fix';
    // "I have read the privacy information", "I agree to the terms": tick, and flag for your review.
    if (v === undefined && f.type === 'checkbox' && CONSENT.test(f.label)) {
      v = true;
      consentIds.push(f.id);
    }
    if (v === undefined && !err && f.type === 'checkbox' && /\bfresher\b|no (prior|work) experience|i have no experience/i.test(f.label)) v = fresher(profile);
    // Agreement dropdowns / radios ("I understand that… *" with I Agree / I Disagree): pick the agree option.
    if (v === undefined && !err && f.options?.length && CONSENT.test(f.label)) {
      const agree = f.options.find((o) => AGREE_OPTION.test(String(o).trim()) && !/disagree|not|don/i.test(o));
      if (agree) {
        v = agree;
        consentIds.push(f.id);
      }
    }
    // Your profile says no family member *is* in government; "ever employed" is broader: filled, but you check it.
    if (v !== undefined && /family|relative|spouse|parent|sibling|business partner/i.test(f.label) && /government|civil service|military|public sector/i.test(f.label)) consentIds.push(f.id);
    if (v !== undefined) source[f.id] = source[f.id] || 'profile';
    else if (!err && (v = bankValue(f, answerBank)) !== undefined) source[f.id] = 'memory';
    else if (coverLetter && COVER.test(f.label) && ['textarea', 'text'].includes(f.type)) {
      v = coverLetter;
      source[f.id] = 'cover-letter';
    }
    if (v !== undefined) values[f.id] = v;
    else pending.push(f);
  }

  let needsReview = [];
  if (pending.length) {
    const user = JSON.stringify({
      TODAY: new Date().toISOString().slice(0, 10),
      PROFILE: forModel,
      JOB: { title: job?.title, company: job?.company, location: job?.location, description: (job?.description || '').slice(0, 12000) },
      FIELDS: pending.map(({ id, label, type, options, required, maxLength, placeholder, min, max, format, section, entry }) => ({
        id, label, type, options, required, maxLength, placeholder, min, max, format, section, entry,
        ...(errors[id] ? { rejectedValue: errors[id].previous, siteError: errors[id].message } : {}),
      })),
      ...(pageErrors.length ? { PAGE_ERRORS: pageErrors.slice(0, 10) } : {}),
    });
    let out;
    try {
      out = await chatJSON(ANSWER_SYSTEM, user, { temperature: 0.3, budgetMs: 45000 });
    } catch (e) {
      // The AI being slow or out of quota must not block the page: fill what's known, flag the rest for you.
      return { values, needsReview: [...consentIds, ...pending.map((f) => f.id)], source, aiError: String(e.message || e).slice(0, 160) };
    }
    const byId = new Map(pending.map((f) => [f.id, f]));
    for (const [id, v] of Object.entries(out.values || {})) {
      const f = byId.get(id);
      if (!f || v === null) continue;
      values[id] = typeof v === 'string' && f.maxLength ? fitLength(polish(v), f.maxLength) : typeof v === 'string' ? polish(v) : v;
      source[id] = 'ai';
    }
    needsReview = (out.needsReview || []).filter((id) => byId.has(id));
    // Always ask the human about AI-written prose, unanswered required fields and legal consent boxes.
    for (const f of pending) {
      const v = values[f.id];
      const prose = typeof v === 'string' && (f.type === 'textarea' || v.length > 120);
      const consent = /agree|consent|certify|acknowledge|attest|confirm that|declare/i.test(f.label);
      const missing = v === undefined || v === '' || (Array.isArray(v) && !v.length);
      if ((prose || consent || (missing && f.required)) && !needsReview.includes(f.id)) needsReview.push(f.id);
    }
  }
  for (const f of fields) if (source[f.id] === 'cover-letter' && !needsReview.includes(f.id)) needsReview.push(f.id);
  for (const id of consentIds) if (!needsReview.includes(id)) needsReview.push(id);
  return { values, needsReview, source };
}

// Trim to the field's limit at a sentence boundary when possible.
function fitLength(text, max) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('.\n'));
  return end > max * 0.6 ? cut.slice(0, end + 1) : cut.slice(0, max - 1).trimEnd() + '…';
}

// Written answers: no graduation-timing sentences (you asked to lead with "can start immediately"),
// and the stock phrases recruiters skim past are toned down.
function polish(text) {
  if (text.length < 120) return text;
  const trimmed = withoutGradSentences(text);
  return (trimmed.length > 60 ? trimmed : text)
    .replace(/\bI am (very )?(eager|excited|thrilled) to\b/gi, 'I want to')
    .replace(/\b(eager|excited|thrilled) to\b/gi, 'keen to')
    .replace(/\bpassionate about\b/gi, 'focused on')
    .replace(/\bI am writing to express my (strong )?interest in\b/gi, "I'm applying for");
}

// Deterministic fixes for the validation errors forms show most often, so a rejected value gets
// corrected instantly (and even when the AI is unavailable). Returns undefined when it can't help.
export function quickFix(field, { message = '', previous = '' }) {
  const m = String(message).toLowerCase();
  const v = String(previous ?? '').trim();
  if (!v) return undefined;
  const digits = v.replace(/\D/g, '');
  const n = Number((m.match(/(\d+)\s*(?:-|\s)?digits?/) || [])[1]);
  if (/phone|mobile|contact number|whatsapp/.test(m) || /\d+\s*-?\s*digit/.test(m) || /without (the )?(country|isd) code/.test(m)) {
    const len = n || (digits.startsWith('91') && digits.length === 12 ? 10 : digits.length > 10 ? 10 : digits.length);
    if (digits.length >= len) return digits.slice(-len);
  }
  if (/(numbers?|digits?|numeric) only|only (numbers|digits)|must be a number|enter a number/.test(m) && digits) return digits;
  const fmt = (message.match(/\b(MM|DD|YYYY)[/.\-](MM|DD|YYYY)[/.\-](MM|DD|YYYY)\b/i) || [])[0];
  if (fmt) {
    const iso = v.match(/^(\d{4})-(\d{2})-(\d{2})/);
    const dmy = v.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
    const [y, mo, d] = iso ? [iso[1], iso[2], iso[3]] : dmy ? [dmy[3], dmy[2].padStart(2, '0'), dmy[1].padStart(2, '0')] : [];
    if (y) {
      const sep = fmt.match(/[/.\-]/)[0];
      return fmt.toUpperCase().split(/[/.\-]/).map((p) => ({ YYYY: y, MM: mo, DD: d })[p]).join(sep);
    }
  }
  if (/url|link|http|website/.test(m) && !/^https?:\/\//i.test(v) && /\.[a-z]{2,}/i.test(v)) return `https://${v.replace(/^\/+/, '')}`;
  if (/e-?mail/.test(m) && /@/.test(v)) return v.trim().toLowerCase();
  const max = Number((m.match(/(?:maximum|max|at most|up to|no more than|less than)\s*(?:of\s*)?(\d+)\s*char/) || m.match(/(\d+)\s*characters?\s*(?:max|maximum|or less|limit)/) || [])[1]) || field.maxLength;
  if (max && v.length > max && /long|characters|limit|max/.test(m)) {
    const cut = v.slice(0, max);
    const end = cut.lastIndexOf('. ');
    return end > max * 0.6 ? cut.slice(0, end + 1) : cut.slice(0, max - 1).trimEnd() + '…';
  }
  return undefined;
}
