import PDFDocument from 'pdfkit';
import { degreeName } from './tailor.js';

// Single-column, ATS-friendly layout: standard fonts, real text, no tables or images.
const MARGIN = 42;
const ACCENT = '#1f3a5f';

// Short, readable label for a URL ("github.com/batmandevx"); the full URL stays clickable.
const shortUrl = (u) => String(u || '').replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '');
const linkLabel = (u) => {
  const s = shortUrl(u);
  if (/^github\.com\//.test(s)) return 'GitHub';
  if (/linkedin\.com\/posts|builder\.aws|devpost|activity-/.test(s)) return 'Link';
  return s.length > 34 ? s.split('/')[0] : s;
};
// "3 patents: Indian Patent No. 2025XXXXXXXXX A (granted, ...)" -> "3 patents: Indian Patent No. 2025XXXXXXXXX A"
const condense = (t) => String(t).split(/\s\(|;\s/)[0].replace(/[:,\s]+$/, '').trim();
// Consistent punctuation: no trailing full stop on bullets / inline items, straight spacing.
const tidy = (s) => String(s || '').replace(/\s+/g, ' ').replace(/\s*\.\s*$/, '').trim();
const dot = (s) => String(s || '').replace(/\s+\|\s+/g, '  ·  ');


// Contact items as wrapped lines where every item stays its own clickable link (wrapping a single
// text run would lose the link annotations). align: 'center' | 'left'.
function linkedLine(doc, items, { x, width, sep = '  |  ', align = 'center', color = '#333', linkColor = ACCENT }) {
  const lines = [[]];
  let w = 0;
  for (const it of items) {
    const add = doc.widthOfString(it.t) + (lines.at(-1).length ? doc.widthOfString(sep) : 0);
    if (w + add > width && lines.at(-1).length) {
      lines.push([]);
      w = 0;
    }
    w += doc.widthOfString(it.t) + (lines.at(-1).length ? doc.widthOfString(sep) : 0);
    lines.at(-1).push(it);
  }
  for (const line of lines) {
    const lineW = line.reduce((a, it, i) => a + doc.widthOfString(it.t) + (i ? doc.widthOfString(sep) : 0), 0);
    let cx = align === 'center' ? x + (width - lineW) / 2 : x;
    const y = doc.y;
    line.forEach((it, i) => {
      if (i) {
        doc.fillColor(color).text(sep, cx, y, { lineBreak: false });
        cx += doc.widthOfString(sep);
      }
      doc.fillColor(it.l ? linkColor : color).text(it.t, cx, y, { lineBreak: false, link: it.l || null, underline: false });
      cx += doc.widthOfString(it.t);
    });
    doc.x = x;
    doc.y = y + doc.currentLineHeight(true);
  }
  doc.fillColor('#000');
}

// Every contact detail, each with its link (mailto:, tel:, https:).
export function contactItems(r) {
  const links = r.links || {};
  const web = (u) => (/^https?:/.test(u) ? u : `https://${u}`);
  return [
    r.email && { t: r.email, l: `mailto:${r.email}` },
    r.phone && { t: r.phone, l: `tel:${String(r.phone).replace(/[^\d+]/g, '')}` },
    r.location && { t: r.location },
    ...[links.linkedin, links.github, links.portfolio, ...(links.other || [])].filter((u) => u && String(u).trim()).map((u) => ({ t: shortUrl(u), l: web(u) })),
  ].filter(Boolean);
}

// Renders at the given density; reports how many pages it took so the caller can fit it to one.
function drawResume(r, k) {
  return new Promise((resolve, reject) => {
    const M = Math.round(MARGIN * k.margin);
    const doc = new PDFDocument({
      size: 'LETTER',
      margin: M,
      // Real, visible text only; the metadata just helps parsers file the document.
      info: { Title: `${r.name} - Resume${r.targetRole ? ` - ${r.targetRole}` : ''}`, Author: r.name, Subject: r.targetRole || 'Resume', Keywords: (r.skills?.[0]?.items || []).join(', ') },
    });
    const chunks = [];
    let pages = 1;
    doc.on('pageAdded', () => pages++);
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve({ pdf: Buffer.concat(chunks), pages }));
    doc.on('error', reject);

    const fs = k.font;
    const width = doc.page.width - M * 2;
    const has = (v) => (Array.isArray(v) ? v.some(has) : v && String(v).trim());
    const gap = (n) => doc.moveDown(n * k.space);

    doc.font('Helvetica-Bold').fontSize(fs + 10).fillColor(ACCENT).text(r.name || '', { align: 'center' });
    if (has(r.headline)) doc.font('Helvetica').fontSize(fs + 1).fillColor('#333').text(dot(r.headline), { align: 'center' });
    gap(0.2);
    doc.font('Helvetica').fontSize(fs - 0.5);
    linkedLine(doc, contactItems(r), { x: M, width });

    const section = (title) => {
      doc.x = M;
      gap(0.55);
      doc.font('Helvetica-Bold').fontSize(fs + 1.5).fillColor(ACCENT).text(title.toUpperCase(), M);
      const y = doc.y + 1.5;
      doc.moveTo(M, y).lineTo(M + width, y).lineWidth(0.6).strokeColor(ACCENT).stroke();
      doc.y = y + 3;
      gap(0.15);
      doc.fillColor('#000');
    };
    const row = (left, right, link) => {
      const y = doc.y;
      const rw = 120;
      doc.font('Helvetica-Bold').fontSize(fs + 0.5).fillColor('#000').text(left, M, y, { width: width - rw - 6 });
      const after = doc.y;
      if (has(right)) doc.font('Helvetica').fontSize(fs).fillColor(link ? ACCENT : '#000').text(right, M + width - rw, y, { width: rw, align: 'right', link: link || null });
      doc.fillColor('#000');
      doc.y = Math.max(after, doc.y);
      doc.x = M;
    };
    const sub = (text) => has(text) && doc.font('Helvetica-Oblique').fontSize(fs).fillColor('#333').text(text, M).fillColor('#000');
    // Hanging indent: wrapped lines line up with the text, not the bullet.
    const bullets = (items = []) =>
      items.filter(has).forEach((b) => {
        const y = doc.y;
        doc.font('Helvetica').fontSize(fs).text('•', M + 4, y, { lineBreak: false });
        doc.text(tidy(b), M + 14, y, { width: width - 14, lineGap: 0.6 * k.space });
        doc.x = M;
      });
    const dates = (a, b) => [a, b].filter(has).join(' – ');

    if (has(r.summary)) {
      section('Summary');
      doc.font('Helvetica').fontSize(fs).text(r.summary, M, doc.y, { width, lineGap: 0.6 * k.space });
    }
    if (has(r.skills?.map((s) => s.items))) {
      section('Skills');
      for (const s of r.skills.filter((s) => has(s.items))) {
        doc.font('Helvetica-Bold').fontSize(fs).text(`${s.category || 'Skills'}: `, M, doc.y, { continued: true, width });
        doc.font('Helvetica').text(s.items.filter(has).join(', '));
      }
    }
    if (has(r.experience?.map((e) => e.company))) {
      section('Experience');
      for (const e of r.experience) {
        row([e.title, e.company].filter(has).join(' — '), dates(e.start, e.end));
        if (k.locations) sub(e.location);
        bullets(e.bullets);
        gap(0.25);
      }
    }
    if (has(r.projects?.map((p) => p.name))) {
      section('Projects');
      for (const p of r.projects) {
        row([p.name, (p.tech || []).filter(has).slice(0, 4).join(', ')].filter(has).join('  ·  '), has(p.link) ? linkLabel(p.link) : '', has(p.link) ? (/^https?:/.test(p.link) ? p.link : `https://${p.link}`) : '');
        bullets(p.bullets);
        gap(0.25);
      }
    }
    if (has(r.education?.map((e) => e.school))) {
      section('Education');
      const future = (end) => Number(String(end || '').match(/(20\d\d)/)?.[1]) >= new Date().getFullYear();
      for (const e of r.education) {
        row(e.school, dates(e.start, future(e.end) ? `Expected ${e.end}` : e.end));
        sub([[degreeName(e.degree), e.field].filter(has).join(', '), has(e.gpa) ? `GPA: ${e.gpa}` : ''].filter(has).join('  |  '));
        bullets(e.details);
      }
    }
    // Certifications / achievements as compact paragraphs rather than long bullet lists.
    for (const [title, items] of [['Achievements', r.achievements], ['Publications & Patents', r.publications], ['Certifications', r.certifications]]) {
      if (!has(items)) continue;
      section(title);
      const list = items.filter(has);
      // Short items read best inline ("17x hackathon winner  ·  3 patents …"); long ones stay as bullets.
      if (title === 'Certifications' || (list.length > 3 && list.every((x) => String(x).length <= 70))) doc.font('Helvetica').fontSize(fs).text(list.map(tidy).join('  ·  '), M, doc.y, { width, lineGap: 0.6 * k.space });
      else bullets(list);
    }
    doc.end();
  });
}

// One page, always: first tighten spacing and type, then drop the least relevant content
// (the tailoring step already ordered bullets / projects by relevance, so we cut from the end).
export async function renderResumePDF(r) {
  const densities = [
    { font: 9.5, space: 1, margin: 1, locations: true },
    { font: 9.2, space: 0.8, margin: 0.85, locations: false },
    { font: 9, space: 0.6, margin: 0.75, locations: false },
  ];
  // Cut the least valuable content first: coursework, then extra certifications, then older bullets.
  // Achievements (hackathons, patents, papers) are never dropped, only shortened.
  const shortAch = (x) => (x.achievements || []).map(condense);
  const trims = [
    (x) => x,
    (x) => ({ ...x, education: (x.education || []).map((e) => ({ ...e, details: [] })), certifications: (x.certifications || []).slice(0, 6) }),
    (x) => ({ ...x, achievements: shortAch(x), projects: (x.projects || []).slice(0, 3), experience: x.experience.map((e, i) => ({ ...e, bullets: e.bullets.slice(0, i < 2 ? 3 : 2) })) }),
    (x) => ({ ...x, projects: (x.projects || []).slice(0, 2), experience: x.experience.map((e, i) => ({ ...e, bullets: e.bullets.slice(0, i < 2 ? 2 : 1) })) }),
    (x) => ({ ...x, certifications: (x.certifications || []).slice(0, 4), projects: (x.projects || []).slice(0, 2).map((p) => ({ ...p, bullets: p.bullets.slice(0, 1) })) }),
    // The job's key-skills line is never cut: it is what keyword filters look for.
    (x) => ({ ...x, certifications: [], skills: [...(x.skills || []).filter((s) => s.key), ...(x.skills || []).filter((s) => !s.key).slice(0, 2).map((s) => ({ ...s, items: s.items.slice(0, 10) }))], experience: x.experience.map((e, i) => ({ ...e, bullets: e.bullets.slice(0, i < 2 ? 2 : 1) })) }),
    (x) => ({ ...x, experience: x.experience.map((e) => ({ ...e, bullets: e.bullets.slice(0, 1) })) }),
    (x) => ({ ...x, achievements: (x.achievements || []).slice(0, 4), skills: [...(x.skills || []).filter((s) => s.key), ...(x.skills || []).filter((s) => !s.key).slice(0, 1)] }),
  ];
  let last;
  let cur = r;
  let fit = null;
  search: for (const trim of trims) {
    cur = trim(cur);
    for (const k of densities) {
      last = await drawResume(cur, k);
      if (last.pages === 1) {
        fit = { cur, k, pdf: last.pdf };
        break search;
      }
    }
  }
  if (!fit) return last.pdf;
  // Trimming cuts in big steps; give the freed space back: restore the most relevant bullets that were cut,
  // one at a time (recent roles first, then projects), as long as everything still fits on one page.
  const cap = (i) => (i < 2 ? 4 : 3);
  for (let level = 2; level <= 4; level++) {
    for (const [key, max] of [['experience', cap], ['projects', () => 2]]) {
      for (let i = 0; i < (fit.cur[key] || []).length; i++) {
        const full = r[key]?.[i]?.bullets || [];
        const have = fit.cur[key][i].bullets || [];
        if (have.length !== level - 1 || full.length < level || level > max(i)) continue;
        const next = { ...fit.cur, [key]: fit.cur[key].map((e, j) => (j === i ? { ...e, bullets: full.slice(0, level) } : e)) };
        const out = await drawResume(next, fit.k);
        if (out.pages === 1) fit = { ...fit, cur: next, pdf: out.pdf };
      }
    }
  }
  return fit.pdf;
}

export function renderCoverLetterPDF(r, text, job = {}) {
  return new Promise((resolve, reject) => {
    const M = 60;
    const doc = new PDFDocument({ size: 'LETTER', margin: M, info: { Title: `${r.name} - Cover Letter${job.company ? ` - ${job.company}` : ''}`, Author: r.name } });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    const width = doc.page.width - M * 2;

    // Letterhead: same look as the resume, every contact detail clickable.
    doc.font('Helvetica-Bold').fontSize(20).fillColor(ACCENT).text(r.name || '', M, M, { width });
    if (r.headline) doc.font('Helvetica').fontSize(10.5).fillColor('#333').text(dot(r.headline), { width });
    doc.moveDown(0.25).font('Helvetica').fontSize(9);
    linkedLine(doc, contactItems(r), { x: M, width, align: 'left' });
    const y = doc.y + 6;
    doc.moveTo(M, y).lineTo(M + width, y).lineWidth(0.8).strokeColor(ACCENT).stroke();
    doc.y = y + 16;

    doc.font('Helvetica').fontSize(10.5).fillColor('#000');
    doc.text(new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }), M, doc.y, { width });
    if (job.company) {
      doc.moveDown(0.8).font('Helvetica-Bold').text(job.company, { width });
      if (job.location) doc.font('Helvetica').fillColor('#333').text(job.location, { width });
    }
    if (job.title) doc.moveDown(0.8).font('Helvetica-Bold').fillColor('#000').text(`Re: Application for ${job.title}`, { width });
    doc.moveDown(1).font('Helvetica').fillColor('#000');

    // Body: paragraphs as written; the closing ("Sincerely, Name") is drawn below with links.
    const body = String(text).replace(/\n\s*(sincerely|regards|best regards|thank you),?[\s\S]*$/i, '').trim();
    for (const para of body.split(/\n\s*\n|\n/).map((x) => x.trim()).filter(Boolean)) {
      doc.text(para, { width, align: 'left', lineGap: 2.5 });
      doc.moveDown(0.75);
    }
    doc.moveDown(0.2).text('Sincerely,', { width });
    doc.moveDown(0.4).font('Helvetica-Bold').text(r.name || '', { width });
    doc.font('Helvetica').fontSize(9.5);
    const links = contactItems(r).filter((c) => /^https?:/.test(c.l || ''));
    if (links.length) linkedLine(doc, links, { x: M, width, align: 'left', sep: '   ·   ' });
    doc.end();
  });
}
