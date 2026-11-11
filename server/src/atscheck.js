import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import { norm } from './keywords.js';

// An ATS reads the PDF's embedded text layer, not the rendered page. Parse the resume we just rendered
// and verify what a parser actually sees: contact details as literal text, no garbled glyphs, the job's
// keywords present. (Borrowed from the ai-job-search framework's /apply ATS check.)
export async function atsCheck(pdfBuffer, { profile, keywords = [] }) {
  const problems = [];
  let text = '';
  try {
    text = (await pdfParse(pdfBuffer)).text || '';
  } catch (e) {
    return { ok: false, problems: [`a parser could not read the PDF's text layer (${String(e.message).slice(0, 80)})`] };
  }
  const flat = text.replace(/\s+/g, ' ').toLowerCase();
  const hay = norm(text);
  if (/�|□/.test(text)) problems.push('the text layer contains garbled glyphs — a parser would read garbage where your contact details should be');
  if (!flat.trim()) problems.push('the PDF has no extractable text at all (image-only PDFs are invisible to ATS)');
  const name = String(profile?.name || '').trim().toLowerCase();
  if (name && !flat.includes(name)) problems.push(`your name ("${profile.name}") is not readable in the text layer`);
  const email = String(profile?.email || '').trim().toLowerCase();
  if (email && !flat.includes(email)) problems.push('your email is not readable in the text layer');
  const digits = (s) => String(s || '').replace(/\D/g, '');
  if (digits(profile?.phone) && !digits(text).includes(digits(profile.phone).slice(-10))) problems.push('your phone number is not readable in the text layer');
  const missingKeywords = keywords.filter((k) => !hay.includes(norm(k)));
  if (missingKeywords.length) problems.push(`these job keywords are not in the text layer: ${missingKeywords.slice(0, 5).join(', ')}`);
  return { ok: !problems.length, problems, chars: text.length };
}
