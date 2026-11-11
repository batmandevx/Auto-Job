import { chatJSON } from './llm.js';
import { ANSWER_SYSTEM } from './prompts.js';
import { bankKey } from './store.js';
import { withoutGradSentences } from './tailor.js';
import { researchFor } from './research.js';

const POSTGRAD_TEXT = /post\s*-?\s*graduat\w*\s*(year|date|passing)|year\s*of\s*post\s*-?\s*graduat/i;
const TEXTLIKE = ['text', 'email', 'tel', 'url', 'search', 'date', 'number', 'combobox', 'tags', ''];
const first = (p) => p.name.split(/\s+/)[0];
const last = (p) => p.name.split(/\s+/).slice(1).join(' ');
const LINK_LABEL = /portfolio|personal\s*(web)?site|^website|^url\b|other\s*(website|url|link)|your\s*website|work\s*links?|^(other\s*)?links?\b|profile\s*links?|social\s*(links?|profiles?)/i;
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
const LANG_LEVEL = /proficiency|fluency|^level$|^overall$|language\s*level|how well|^(spoken|written|reading|writing|speaking)$/i;
const nativeLang = (lang) => /hindi/i.test(lang);
const LEVEL_WORDS = {
  native: ['native', 'native or bilingual', 'native or bilingual proficiency', 'native speaker', 'mother tongue', 'bilingual', 'fluent', 'expert', 'advanced'],
  fluent: ['fluent', 'full professional proficiency', 'full professional', 'professional working proficiency', 'professional', 'advanced', 'proficient', 'expert'],
};
// "How did you hear about us?": LinkedIn first, then the company's own site, then a job board.
const HEAR_LABEL = /how did you (hear|find|learn|come)|where did you (hear|find|see)|^(source|referral source)(\s*of\s*(application|referral|hire))?$|how did you (come|get) to know|hear about (us|this)|know about (the|this) (opportunity|job|role|position)/i;
const SOURCE_LADDER = ['linkedin', 'linkedinjobs', 'companywebsite', 'careerswebsite', 'careersite', 'companycareersite', 'corporatewebsite', 'careerspage', 'jobboard', 'jobboards', 'onlinejobboard', 'jobsite', 'socialmedia', 'socialnetwork', 'internet', 'online', 'website', 'other'];
// "S.O.", "S/O", "D/O", "C/O" read as "son of" etc.: never typed into an address.
// Did you work for the company the question names ("employed by Samsung…"), or this job's company?
const worksHere = (p, job, label = '') => (p.experience || []).some((e) => {
  const co = normT(String(e.company || '').split(',')[0]);
  if (co.length < 3) return false;
  if (/\bcurrently\b/i.test(label) && !/\b(or|and) (have you )?(ever|previously|in the past)\b/i.test(label) && !/present|current|now/i.test(String(e.end || ''))) return false; // "currently employed": only a role you still hold
  const c = normT(job?.company).slice(0, 6);
  return normT(label).includes(co) || (c.length > 2 && co.includes(c));
});
// "mention full no - example 500000", "Annual CTC in INR": a plain number, not "₹12–18 LPA".
const FULL_NUMBER = /annual|per annum|yearly|in inr|in rupees|lpa|full\s*(no|number|amount)|example\s*-?\s*\d{4,}|numbers? only|digits/i;
// The job is outside India (from the question or the job's location): you'd need a visa there.
const ABROAD = /united states|\busa?\b|america|canada|\buk\b|united kingdom|england|germany|ireland|netherlands|france|singapore|australia|japan|uae|dubai|europe/i;
// "Lucknow, Uttar Pradesh, India" -> part 0 city, 1 state, 2 country
const birthPart = (p, i) => String(p.personal?.placeOfBirth || '').split(',').map((x) => x.trim())[i] || undefined;
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
const cur = (p, k, fallback) => p.personal?.[k] || p.personal?.[fallback];
const safeText = (t) => String(t || '').replace(/["“”]/g, "'").replace(/[<>[\]{}\\]/g, '');
const noRelation = (a) => String(a || '').replace(/,?\s*\b[SDWC]\s*[./]\s*O\b\.?/gi, '').replace(/\s{2,}/g, ' ').replace(/^[,\s]+|[,\s]+$/g, '').trim();
const digits = (s) => String(s || '').replace(/\D/g, '');
const locationAliases = [
  ['bangalore', 'bengaluru'],
  ['delhi ncr', 'new delhi', 'delhi'],
  ['pan india', 'pan- india', 'pan-india'],
];
const locationNorm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
function locationOption(options, wanted, used = []) {
  const target = locationNorm(wanted);
  if (!target) return undefined;
  const group = locationAliases.find((g) => g.includes(target)) || [target];
  return options.find((o) => used.every((u) => locationNorm(o) !== locationNorm(u)) && group.some((a) => locationNorm(o) === a || locationNorm(o).startsWith(`${a} `)));
}
function cgpaValue(profile) {
  const configured = profile.answers?.currentCGPA;
  if (configured) return configured;
  const raw = String(profile.education?.[0]?.gpa || '');
  return (raw.match(/^\s*(\d+(?:\.\d+)?)/) || [])[1];
}
function cgpaScaleValue(profile) {
  if (profile.answers?.cgpaScale) return profile.answers.cgpaScale;
  const raw = String(profile.education?.[0]?.gpa || '');
  return (raw.match(/\/\s*(\d+(?:\.\d+)?)/) || [])[1];
}

// Eightfold-style voluntary self-ID ("Voluntary Self-Identification of Disability", PayPal / Eightfold forms):
// the statements come as one checkbox each or one group of options ("I DON'T WISH TO ANSWER (India)",
// "NO, I DON'T HAVE A DISABILITY (India)", "YES, I HAVE A DISABILITY (or previously had a disability) (India)").
// The statement matching your saved answer is picked; with nothing saved, "I don't wish to answer" is the safe default.
const SELFID_SECTION = /self[- ]?identification|voluntary|disability/i;
function selfIdValue(field, profile) {
  if (!SELFID_SECTION.test(`${field.section || ''} ${field.label}`)) return undefined;
  const want = String(profile.answers?.disabilityStatus || '').trim().toLowerCase();
  const yes = /^yes\b/.test(want);
  const no = /^no\b/.test(want);
  const isDecline = (t) => /don'?t wish to answer|prefer (not|to)|decline|not wish/i.test(t);
  const isNo = (t) => /^(no\b|i\s+don'?t have)/i.test(t) || /don'?t have a disability/i.test(t);
  const isYes = (t) => /^yes\b/i.test(t) || (/\bhave a disability\b/i.test(t) && !/don'?t\b/i.test(t));
  const pickFrom = (opts) => (yes ? opts.find(isYes) : no ? opts.find(isNo) : opts.find(isDecline));
  if (field.options?.length && (field.options.some((o) => /disability/i.test(o)) || /disability/i.test(field.label))) return pickFrom(field.options);
  if (field.type === 'checkbox') {
    const t = String(field.label);
    if (isDecline(t)) return !(yes || no);
    if (isNo(t)) return no;
    if (isYes(t)) return yes;
  }
  return undefined;
}

// Common fields are filled from the profile directly: instant, free and never hallucinated.
// Order matters: more specific patterns first. Everything else goes to the model in one batch.
const RULES = [
  // Current / correspondence address (where you live now) vs permanent address: separate when your profile has both.
  [/(current|present|correspondence|communication|mailing|local|temporary)\s*(residential\s*)?(address|addr)(\s*line)?\s*1?\b(?!.*(2|two))/i, (p) => cur(p, 'currentAddressLine1', 'addressLine1')],
  [/(current|present|correspondence|mailing)\s*(residential\s*)?(city|town)\b/i, (p) => cur(p, 'currentCity', 'city')],
  [/(current|present|correspondence|mailing)\s*(residential\s*)?(state|province)\b/i, (p) => cur(p, 'currentState', 'state')],
  [/(current|present|correspondence|mailing)\s*(residential\s*)?(pin|postal|zip)\s*(code)?\b/i, (p) => cur(p, 'currentPostalCode', 'postalCode')],
  // EEO self-identification: your saved answers.
  [/^(race|ethnicity|race\s*\/\s*ethnicity|race and ethnicity)\b/i, (p) => p.answers.race],
  [/veteran\s*status|protected veteran/i, (p) => p.answers.veteranStatus],
  [/disability\s*status|have a disability/i, (p) => p.answers.disabilityStatus],
  [/academic standing|current (academic )?(year|status) (of|in) (study|college|university)|year of study|which year are you in|current year of (your )?(degree|study)/i, (p) => academicStanding(p)],
  // Notice questions mention "your current employer" too ("How much notice must you provide your current
  // employer…"), so they're answered before the employer-name rule below can take them.
  [/\bnotice\b.{0,60}(employer|leaving|resign|period|give|provide)|how much notice/i, (p, f) => (numericField(f) || /\bdays?\b/i.test(f.label) ? p.answers.noticeDays || '1' : p.answers.noticePeriod)],
  // Workday says "Region" for the state of your address; "Region of Birth" is the state you were born in.
  [/(region|state|province)\s*(\/\s*\w+\s*)?of\s*birth/i, (p) => birthPart(p, 1)],
  [/country(\s*\/\s*territory)?\s*of\s*birth|birth\s*country/i, (p) => birthPart(p, 2) || p.personal.nationality],
  [/^region\b|^state\s*\/\s*region|^county\b/i, (p) => p.personal.state],
  [/(aware|understand|acknowledge|agree).{0,80}(expected|required) to work (in|from) india|expected to work in india/i, () => 'Yes'],
  [/willing (and able )?to travel|able to travel|travel (as|per) (the job|required|needed)|open to travel/i, () => 'Yes'],
  [/current\s*(company|employer|organi[sz]ation)(\s*name)?/i, (p, f) => (/^\s*yes/i.test(p.answers.currentlyEmployed || '') || f.required ? String(p.experience?.[0]?.company || '').split(',')[0] || undefined : null)],
  [/^(today'?s\s*)?date$|signature date|date signed|enter today'?s date|today'?s date/i, (p, f) => (f.type === 'date' ? localToday() : toHintFormat(localToday(), `${f.placeholder || ''} ${f.label}`, 'MM/DD/YYYY'))],
  // Screening questions with fixed answers from your profile.
  [/non-?compet|non-?solicit|(agreement|bond|contract).{0,80}restrict|restrict.{0,40}(ability|perform)/i, () => 'No'],
  [/sponsor(ship)?/i, (p, f, job) => (abroad(f, job) ? 'Yes' : 'No')],
  [/younger than 18|under (the age of )?18|below 18|less than 18|minor\b/i, () => 'No'],
  [/(18|eighteen) (years|yrs)( of age)? or (older|above|over)|at least 18|over (the age of )?18/i, () => 'Yes'],
  [/(were|are|have) you (ever |currently |now )?(been |worked as )?(a |an )?(former |current(ly)? |present )?government (employee|official|servant)|ever (a|been a|worked as a) government|civil service or military/i, (p, f) => (/family|relative|spouse|parent|sibling/i.test(f.label) ? undefined : 'No')],
  // Conflict-of-interest questions are facts about you, never guessed: no family at the company, never worked for it
  // (unless it is in your experience), happy to work from the posted location.
  // Only relationship *questions* ("Do you have any relatives working here?"), never "Family name" or "Spouse name".
  [/(family|relative|spouse|in-law|related to).{0,240}(relationship|related|relatives?|member|employ|work(s|ing)?|board|director|reporting)|(relationship|related|relatives?).{0,120}(family|employee|board|director|reporting|work(s|ing)? (at|for|in))/i, () => 'No'],
  [/(currently|previously|in the past|ever).{0,60}(worked|employed|been an? (employee|contractor)).{0,80}(consult|affiliat|subsidiar|project|this company|for us|with us|any of)/i, (p, f, job) => (worksHere(p, job, f.label) ? 'Yes' : 'No')],
  // "Are you a previous Employee of PayPal or any of its subsidiaries?" (Eightfold): Yes only if your profile says you worked there.
  [/previous(ly)?\b.{0,60}\b(employee|employed|staff)|former(ly)?\b.{0,60}\b(employee|staff|member of)|ex-?employee/i, (p, f, job) => (worksHere(p, job, f.label) ? 'Yes' : 'No')],
  // Work authorisation: you're an Indian citizen, so Yes for India, and No for other countries
  // (the answers say you hold no visa for them).
  [/legally (authori[sz]ed|eligible|permitted|allowed) to work|authori[sz]ed to work|right to work|eligible to work/i, (p, f, job) => (abroad(f, job) ? 'No' : 'Yes')],
  [/(are you )?currently (employed|working)(\?|$)|current employment status/i, (p) => yesNo(p.answers.currentlyEmployed)],
  // "Do you hold the certifications … as outlined in the job description?": that's about the job's own
  // requirements (often a clearance), not your course certificates.
  [/certifications?.{0,40}(clearance|as (outlined|listed|described|mentioned)|in the job description|required for (this|the) (role|job|position))/i, () => 'Not Applicable'], // no such option -> the AI picks
  // Career breaks: none (studying, then internships), and the "reason" box stays empty.
  [/(taken|take|had) a (career )?break|career (break|gap)\??$|gap in (your )?(career|employment)/i, () => 'No'],
  [/reason for (the |your )?(career )?(break|gap)/i, () => null],
  // "Do you have any professional licenses or certifications?": Yes / No from your profile, or the list for a text box.
  [/(professional\s*)?licen[cs]es?\s*(or|and|\/)\s*certifications?|any (professional )?certifications?|certifications? (do you have|held)/i, (p, f) => (CHOICE.includes(f.type) ? ((p.certifications || []).length ? 'Yes' : 'No') : (p.certifications || []).join('; ') || 'None')],
  [/available (for|to attend) (an? )?(personal|in[\s-]?person|face[\s-]?to[\s-]?face|f2f|onsite|on[\s-]?site|walk[\s-]?in)?\s*interview|attend (an? )?(personal|in[\s-]?person|face[\s-]?to[\s-]?face|f2f) interview/i, () => 'Yes'],
  [/willing to (work|commute).{0,30}(location|office|site|city)|work from the location/i, () => 'Yes'],
  [/first\s*name|given\s*name|fname|forename/i, first],
  [/middle\s*name/i, (p) => p.personal?.middleName || null], // usually none: left empty on purpose, not asked of the AI
  [/last\s*name|surname|family\s*name|lname/i, last],
  [/mother'?s?\s*(maiden\s*)?name/i, (p) => p.personal.motherName],
  [/father'?s?\s*name|parent.*name|guardian.*name/i, (p) => p.personal.fatherName],
  [/preferred\s*(first\s*)?name|nick\s*name/i, first],
  [/^(full\s*)?name\b|your\s*name|legal\s*name|candidate\s*name|applicant\s*name/i, (p) => p.name],
  [/confirm.*e-?mail|e-?mail.*(again|confirm)/i, (p) => p.email],
  [/e-?mail/i, (p) => p.email],
  [/^code$|country\s*(phone\s*)?code|dial(l)?ing\s*code|isd/i, (p) => (p.phone.match(/^\+\d{1,3}/) || ['+91'])[0]],
  [/phone\s*ext|^ext(ension)?\b|extension/i, () => null], // left empty on purpose (desk lines only), never asked of the AI
  [/phone|mobile|contact\s*(no|number)|cell|whatsapp/i, (p, f) => (f.codeBeside ? digits(p.phone).slice(-10) : p.phone)],
  [/linked\s*in/i, (p) => p.links?.linkedin],
  [/git\s*hub/i, (p) => p.links?.github],
  [/leet\s*code/i, (p) => p.links?.other?.find((l) => /leetcode/i.test(l))],
  // Rows of link boxes ("Work Link / Online Portfolio" with a "+"): portfolio first, then LinkedIn, GitHub…
  [LINK_LABEL, (p, f) => linkList(p)[linkIndex(f)]],
  [/date\s*of\s*birth|\bdob\b|birth\s*date|birthday/i, (p) => p.personal.dateOfBirth],
  [/nationality|citizenship/i, (p) => p.personal.nationality],
  [/city\s*of\s*birth|birth\s*city/i, (p) => birthPart(p, 0)], // just "Lucknow": state and country have their own boxes
  [/place\s*of\s*birth|birth\s*place/i, (p) => p.personal.placeOfBirth],
  [/fluent in this language/i, () => true],
  // A skills picker ("Type to Add Skills"): your skills, the job's ones first, one item each.
  [/^(type to add |add |your |key |technical )?skills?\b(?!.*(describe|explain|rate|years))/i, (p, f, job) => {
    const all = [...new Set((p.skills || []).flatMap((g) => g.items || []))];
    const jd = ` ${String(job?.description || '').toLowerCase()} `;
    const inJd = (x) => new RegExp(`[^a-z0-9+#]${String(x).toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^a-z0-9+#]`).test(jd);
    const ranked = [...all.filter(inJd), ...all.filter((x) => !inJd(x))].slice(0, 15);
    return ['tags', 'combobox', 'checkbox-group'].includes(f.type) ? ranked : ranked.join(', ');
  }],
  [{ test: (l) => LANG_NAME.test(l) }, (p, f) => (/language/i.test(f.section || '') || f.entry ? spoken(p)[(f.entry || 1) - 1] : spoken(p)[0])],
  [{ test: (l) => LANG_LEVEL.test(l) }, (p, f) => (/language/i.test(`${f.section || ''} ${f.label}`) ? (nativeLang(spoken(p)[(f.entry || 1) - 1]) ? 'Native' : 'Fluent') : undefined)],
  [HEAR_LABEL, (p) => p.answers?.howDidYouHear || 'LinkedIn'],
  // "Are you a referral of a) an existing merchant, b) a third party, c) a government official?" (PayPal): not referred.
  [/\bare you a referral\b|\breferred (you|by)\b|\breferral of (an?|the )?(existing|potential)/i, () => 'No'],
  [/^(languages?\s*(known|spoken)?|spoken\s*languages?|languages you (speak|know))$/i, (p) => p.personal.languages],
  [/are you interested|interested in (this|the) (opportunity|role|project)|would you like to proceed/i, () => 'Yes'],
  // Enrollment: a degree that ends in the future means you are enrolled and intend to return after an internship.
  [/return to (your )?(degree|university|college|studies|program)|currently enrolled|enrolled in (a|an|your)?\s*(degree|bachelor)|intend to (return|continue|resume)|pursuing (your |a |an )?(degree|bachelor|b\.?\s*tech|master)|returning to (college|university)/i, (p) => (graduated(p) ? undefined : 'Yes')],
  [/completed your (degree|bachelor'?s?|graduation)|already graduated|degree (completed|received|conferred)/i, (p) => (graduated(p) ? 'Yes' : 'No')],
  [/enrolled in or.*completed.*bachelor|completed.*bachelor.*degree|have.*bachelor.*degree/i, (p) => (p.education || []).length ? 'Yes' : undefined],
  [/computer science fundamentals|object[- ]oriented|operating systems|algorithms|data structures|complexity analysis/i, (p) => yesNo(p.answers.computerScienceFundamentals)],
  [/active (arrears|backlogs?)|backlogs?|arrears?/i, (p) => yesNo(p.answers.activeBacklogs)],
  [/current\s*cgpa|cumulative.*cgpa|cgpa.*cumulative/i, (p) => cgpaValue(p)],
  [/cgpa\s*scale|cgpa.*out of|how much.*cgpa/i, (p) => cgpaScaleValue(p)],
  [/first location preference|location preference.*first/i, (p) => p.answers.firstLocationPreference],
  [/second location preference|location preference.*second/i, (p) => p.answers.secondLocationPreference],
  [/third location preference|location preference.*third/i, (p) => p.answers.thirdLocationPreference],
  [/availability|type of availability|time commitment|commitment required|hours?\s*(per|\/)\s*week|full[\s-]?time.*hours/i, (p) => p.answers.availability],
  [/notice period|how soon can you join|when can you (start|join)|joining/i, (p, f) => (numericField(f) || /\bdays?\b/i.test(f.label) ? p.answers.noticeDays || '0' : p.answers.noticePeriod)],
  [/confirm (your )?time\s*zone|timezone|time zone|local time zone/i, (p) => p.answers.timezone],
  [/overlap.*pst|pst.*overlap|overlap.*(pacific|customer work)|work.*overlap/i, (p) => yesNo(p.answers.overlapPst)],
  [/confirm (your )?rate|rate in usd|hourly rate|pay rate|billing rate/i, (p, f) => numericField(f) ? digits(p.answers.hourlyRate) : p.answers.hourlyRate],
  [/employment type|engagement type|contract(or)? assignment|freelance|independent contractor/i, (p, f) => {
    const opts = f.options || [];
    return p.answers.employmentType || opts.find((o) => /contract|freelance/i.test(o)) || (opts.length ? undefined : 'Contractor');
  }],
  [/remote|work from home|work location|work arrangement|work mode/i, (p) => p.answers.workMode || 'Remote'],
  [/eligible to work|legally authorized|right to work|work authorization|authorized to work/i, (p) => p.answers.workAuthorization],
  [/country.*(eligible|available)|available.*country|location.*eligible/i, (p) => p.personal.country || p.answers.currentLocation],
  [/commit.*(hours?|week)|hours?.*(per|\/)\s*week|minimum.*hours?/i, (p) => p.answers.availability],
  [/\bc?gpa\b|grade\s*point|cumulative\s*grade/i, (p) => p.education?.[0]?.gpa],
  [/^\s*gender\b|\bgender identity\b|^\s*sex\b/i, (p) => p.personal.gender || p.answers.gender],
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
  [/(total|overall|relevant)?\s*(years?|yrs)\s*(of)?\s*(work\s*)?experience|experience\s*\(?\s*(in\s*)?years|^experience$/i, (p) => (fresher(p) ? '0' : (String(p.answers?.yearsOfExperience || '').match(/\d+(\.\d+)?/) || [])[0])],
  [/(months?)\s*(of)?\s*(work\s*)?experience|experience.*months/i, (p) => (fresher(p) ? '0' : undefined)],
  [/current\s*(annual\s*)?(ctc|salary|compensation)/i, (p, f) => (numericField(f) || FULL_NUMBER.test(f.label) ? p.answers.currentSalaryAnnual : p.answers.currentSalary)],
  [/expected\s*(annual\s*|yearly\s*)?(ctc|salary|compensation|pay)|salary\s*expectations?|desired\s*(total\s*)?(annual\s*)?(salary|pay|compensation|ctc)|ctc.*expect/i, (p, f) => (numericField(f) || FULL_NUMBER.test(f.label) ? p.answers.expectedSalaryAnnual : p.answers.expectedSalary)],
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
// True when the newest education entry ends in a future year (still enrolled / not yet graduated).
const graduated = (p) => {
  const years = (p.education || []).map((e) => Number(String(e.end || '').match(/(20\d\d)/)?.[1])).filter(Boolean);
  const last = years.length ? Math.max(...years) : 0;
  return last > 0 && last < new Date().getFullYear();
};
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
  const jobLabel = last.length <= 60 && !/ctc|cost to|salary|compensation/i.test(last) && /job\s*title|position\s*title|^title$|designation|^(current|most recent|previous|latest)?[\s/]*(most recent\s*)?(company|employer)(\s*name)?\W*$|currently work|role description/i.test(last);
  if (!EXP_SECTION.test(field.section || '') && !jobLabel) return undefined;
  if (/years|total|how many|months of/i.test(last)) return undefined;
  if (field.roleIndex === -1) return undefined; // an extra entry on the page: none of your roles is left for it
  const e = profile.experience?.[field.roleIndex ?? (field.entry || 1) - 1];
  if (!e) return undefined;
  if (/currently work|current(ly)?\s*(employed|role|job)|i work here|still work/i.test(last)) return isPresent(e.end);
  // Workday (and others) reject < > [ ] " { } \ in free text: straight double quotes become single ones.
  if (/description|responsibilit|duties|summary|achievements?|what did you do/i.test(last)) return safeText((e.bullets || []).map((b) => `• ${b}`).join('\n')) || undefined;
  if (/job\s*title|position|^title$|designation|^role$/i.test(last)) return String(e.title || '').replace(/\s*\([^)]*\)/g, '').trim() || e.title; // "(promoted from …)" is a note, not the title
  if (/^(current|most recent|previous|latest)?[\s/]*(most recent\s*)?(company|employer|organi[sz]ation)(\s*name)?\W*$|name of (the )?(company|employer)/i.test(last)) return String(e.company || '').split(',')[0].trim() || e.company;
  if (/location|city/i.test(last)) return e.location || undefined;
  if (/^(from|start)|start\s*date|date\s*from/i.test(last)) return e.start;
  if (/^(to|end)\b|end\s*date|date\s*to/i.test(last)) return isPresent(e.end) ? undefined : e.end;
  return undefined;
}

function ruleValue(field, profile, job) {
  const exp = experienceValue(field, profile);
  if (exp !== undefined && exp !== '') return CHOICE.includes(field.type) && field.options?.length ? field.options.find((o) => normT(o) === normT(exp)) : exp;
  const last = clean(String(field.label).split('›').pop());
  const linkRow = LINK_LABEL.test(last) || LANG_NAME.test(last) || /fluent in this language/i.test(last) || (LANG_LEVEL.test(last) && /language/i.test(`${field.section || ''} ${field.label}`));
  if (field.entry > 1 && !linkRow) return undefined; // later entries of repeated sections: the AI maps them by order (link rows: next link)
  const selfId = selfIdValue(field, profile);
  if (selfId !== undefined) return selfId;
  // Dropdowns too, as long as the profile fact is one of the real options ("2027" in a passout-year list).
  if (CHOICE.includes(field.type) && field.options?.length) {
    if (asksPostgradOnly(field.label) && !hasPostgrad(profile)) return field.options.find((o) => NA_OPTION.test(String(o).trim()));
    const label = clean(String(field.label).split('›').pop());
    if (/enrolled in or.*completed.*bachelor|completed.*bachelor.*degree|have.*bachelor.*degree/i.test(label)) {
      return field.options.find((o) => /^yes\b/i.test(o)) || field.options.find((o) => /bachelor|enrolled|completed/i.test(o));
    }
    if (/computer science fundamentals|object[- ]oriented|operating systems|algorithms|data structures|complexity analysis/i.test(label)) {
      const want = yesNo(profile.answers.computerScienceFundamentals);
      return want && (field.options.find((o) => new RegExp(`^${want}\\b`, 'i').test(o)) || field.options.find((o) => normT(o) === normT(want)));
    }
    if (/active (arrears|backlogs?)|backlogs?|arrears?/i.test(label)) {
      const want = yesNo(profile.answers.activeBacklogs);
      return want && (field.options.find((o) => new RegExp(`^${want}\\b`, 'i').test(o)) || field.options.find((o) => normT(o) === normT(want)));
    }
    if (/cgpa\s*scale|cgpa.*out of|how much.*cgpa/i.test(label)) {
      const want = cgpaScaleValue(profile);
      return want && (field.options.find((o) => normT(o) === normT(want)) || field.options.find((o) => new RegExp(`\\b${String(want).replace('.', '\\.')}\\b`).test(o)));
    }
    const locMatch = label.match(/\b(first|second|third)\s+location preference\b/i);
    if (locMatch) {
      const key = `${locMatch[1].toLowerCase()}LocationPreference`;
      const used = ['first', 'second', 'third'].slice(0, ['first', 'second', 'third'].indexOf(locMatch[1].toLowerCase())).map((x) => profile.answers?.[`${x}LocationPreference`]).filter(Boolean);
      return locationOption(field.options, profile.answers?.[key], used);
    }
    if (/licen[cs]es?\s*(or|and|\/)\s*certifications?|any (professional )?certifications?/i.test(label)) {
      const want = (profile.certifications || []).length ? /^yes\b/i : /^no\b/i;
      const hit = field.options.find((o) => want.test(String(o).trim()));
      if (hit) return hit;
    }
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
      field.options.find((o) => /^\+\d{1,3}$/.test(String(v).trim()) && normT(o).endsWith(want)) || // "+91" -> "India +91"
      field.options.find((o) => normT(o).length === 1 && want.startsWith(normT(o))) // "M" / "F" style lists
    );
  }
  // Workday asks short facts in multi-line boxes ("notice period (in days)", "expected Annual CTC"): those come from the profile too.
  if (field.type === 'textarea' && /notice|ctc|cost to company|salary|compensation|stipend|how soon|join|in days/i.test(clean(String(field.label).split('›').pop())) && !/describe|explain|why|tell us/i.test(field.label)) field = { ...field, type: 'text' };
  if (field.type === 'checkbox' && /fluent in this language/i.test(String(field.label))) return true;
  if (!TEXTLIKE.includes(field.type)) return undefined;
  const label = clean(String(field.label).split('›').pop()) || clean(field.name); // "Education #1 › School" -> "School"
  for (const [re, get] of RULES) {
    if (!re.test(label)) continue;
    let v = get(profile, field, job);
    if (v === null) return null; // deliberately left empty (e.g. optional "Current company" while not employed)
    if (v === undefined || v === '') return undefined; // unknown: let the model / human handle it
    // "(MM/YYYY)", "MM-YYYY", "YYYY-MM" in the question: dates in exactly that shape.
    if (/graduat|complet|date|month and year|when/i.test(label)) v = toHintFormat(v, `${field.placeholder || ''} ${label}`);
    if (field.type === 'number' && !(/^\d+$/.test(String(v).trim()) || (/cgpa|gpa|grade|score|rating/i.test(label) && /^\d+(?:\.\d+)?$/.test(String(v).trim())))) return undefined; // salary ranges stay with the model; academic scores may be decimal
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

// Which of your roles each Work Experience entry on the page is: by title, company (typos allowed: "Microsfot") and
// start date, each role used once. Entries that match nothing take your remaining roles in order.
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const monthYear = (s) => {
  const t = String(s || '').toLowerCase();
  const y = t.match(/(19|20)\d{2}/)?.[0];
  const m = MONTHS.findIndex((x) => t.includes(x)) + 1 || Number(t.match(/^\s*(\d{1,2})\s*[/.\- ]/)?.[1]) || 0;
  return y ? `${m}/${y}` : '';
};
function editDistance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}
function roleScore(entry, role) {
  let score = 0;
  const co = normT(entry.company), mine = normT(String(role.company || '').split(',')[0]), full = normT(role.company);
  if (co && mine) {
    if (co === mine || (co.length >= 4 && (full.includes(co) || co.includes(mine)))) score += 4;
    else if (Math.min(co.length, mine.length) >= 5 && editDistance(co, mine) <= 2) score += 3; // "microsfot"
  }
  const t = normT(entry.title), rt = normT(role.title);
  if (t && rt) {
    if (t === rt) score += 4;
    else if (t.length >= 6 && (rt.startsWith(t) || t.startsWith(rt) || rt.includes(t))) score += 3;
  }
  const from = monthYear(entry.from);
  if (from && from === monthYear(role.start)) score += 2;
  else if (from && from.split('/')[1] === monthYear(role.start).split('/')[1]) score += 0.5;
  return score;
}
function assignRoles(fields, profile) {
  const roles = profile.experience || [];
  const entries = new Map();
  for (const f of fields) {
    if (!f.entry || !EXP_SECTION.test(f.section || '')) continue;
    const key = `${f.section}#${f.entry}`;
    const e = entries.get(key) || { company: '', title: '', from: '', entry: f.entry };
    e.company ||= f.entryCompany || '';
    e.title ||= f.entryTitle || '';
    e.from ||= f.entryFrom || '';
    entries.set(key, e);
  }
  const pairs = [];
  for (const [key, e] of entries) roles.forEach((r, i) => { const s = roleScore(e, r); if (s >= 3) pairs.push({ key, i, s }); });
  pairs.sort((a, b) => b.s - a.s);
  const byKey = new Map(), used = new Set();
  for (const p of pairs) if (!byKey.has(p.key) && !used.has(p.i)) { byKey.set(p.key, p.i); used.add(p.i); }
  const free = roles.map((_, i) => i).filter((i) => !used.has(i));
  for (const [key] of [...entries].sort((a, b) => a[1].entry - b[1].entry)) if (!byKey.has(key)) byKey.set(key, free.length ? free.shift() : -1);
  return fields.map((f) => (byKey.has(`${f.section}#${f.entry}`) ? { ...f, roleIndex: byKey.get(`${f.section}#${f.entry}`) } : f));
}

export async function answerFields({ fields, profile, job, coverLetter, errors = {}, pageErrors = [] }) {
  fields = assignRoles(fields, profile);
  const values = {};
  const source = {};
  const pending = [];
  const consentIds = [];
  const { answerBank = {}, ...forModel } = profile;
  for (const f of fields) {
    if (f.type === 'file') continue;
    if (f.roleIndex === -1) continue; // an extra work entry: keep what the site has, never let the AI invent a role
    const err = errors[f.id];
    let v = err ? quickFix(f, err) : ruleValue(f, profile, job);
    if (err && v !== undefined) source[f.id] = 'auto-fix';
    // "I have read the privacy information", "I agree to the terms": tick, and flag for your review.
    if (v === undefined && f.type === 'checkbox' && CONSENT.test(f.label)) {
      v = true;
      consentIds.push(f.id);
    }
    if (v === undefined && !err && f.type === 'checkbox' && /\bfresher\b|no (prior|work) experience|i have no experience/i.test(f.label)) v = fresher(profile);
    // "I have a preferred name" (Eightfold legal-name section): you don't, so the box stays unticked.
    if (v === undefined && !err && f.type === 'checkbox' && /\b(i have|do you have) a preferred name\b/i.test(f.label)) v = false;
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
      ...(researchFor(job || {}) ? { COMPANY_FACTS: researchFor(job || {}) } : {}),
      FIELDS: pending.map(({ id, label, type, options, required, maxLength, maxWords, placeholder, help, min, max, format, section, entry }) => ({
        id, label, type, options, required, maxLength, maxWords, placeholder, help, min, max, format, section, entry,
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
      let text = typeof v === 'string' ? polish(v) : v;
      if (typeof text === 'string' && f.maxWords) text = fitWords(text, f.maxWords);
      values[id] = typeof text === 'string' && f.maxLength ? fitLength(text, f.maxLength) : text;
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

// Keep within a word limit ("max 150 words"), ending on a whole sentence when possible.
function fitWords(text, max) {
  const words = text.split(/\s+/);
  if (words.length <= max) return text;
  const cut = words.slice(0, max).join(' ');
  const end = Math.max(cut.lastIndexOf('. '), cut.endsWith('.') ? cut.length - 1 : -1);
  return end > cut.length * 0.6 ? cut.slice(0, end + 1) : cut.replace(/[,;:]?$/, '.');
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
  // "Contains illegal characters < > [ ] \" { } \\", "special characters are not allowed: …": drop those characters.
  if (/(illegal|invalid|special|not allowed|forbidden|unsupported)[^.]{0,30}characters?|characters?[^.]{0,30}(not allowed|are invalid)/.test(m)) {
    const listed = String(message).split(/characters?:?/i).pop().replace(/\b(are|is|not|allowed|invalid|the|following)\b/gi, '').replace(/[a-z0-9\s.,]/gi, '');
    const bad = new Set(listed ? [...listed] : ['<', '>', '[', ']', '"', '{', '}', '\\', '|', '^', '~', '`']);
    const fixed = [...v.replace(/[“”]/g, '"').replace(/[‘’]/g, "'")].map((ch) => (bad.has(ch) ? (ch === '"' ? "'" : '') : ch)).join('').replace(/'/g, bad.has("'") ? '' : "'");
    if (fixed !== v) return fixed;
  }
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
