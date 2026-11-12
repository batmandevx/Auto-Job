// One Excel workbook of everything you're looking at: your Jobs list, open hackathons and your tracker.
// Colour-coded (match score, deadline, status), with clickable Apply links, frozen headers and filters.
import ExcelJS from 'exceljs';

const STATUS = {
  saved: ['To apply', '8B8FA3'], applied: ['Applied', '5B5BF6'], assessment: ['Assessment', '0EA5E9'],
  interview1: ['Interview 1', 'A855F7'], interview2: ['Interview 2', '9333EA'], interview3: ['Interview 3', '7E22CE'],
  hr: ['HR round', 'D97706'], offer: ['Offer', '16A34A'], accepted: ['Accepted', '0F9D58'], rejected: ['Rejected', 'E0384A'], withdrawn: ['Withdrawn', '6B7280'],
};
const GOOD = ['DCFCE7', '166534'], MID = ['FEF3C7', '92400E'], BAD = ['FEE2E2', '991B1B'], NONE = ['F3F4F6', '4B5563'];
const fill = (argb) => ({ type: 'pattern', pattern: 'solid', fgColor: { argb: `FF${argb}` } });
const chip = (cell, [bg, fg]) => Object.assign(cell, { fill: fill(bg), font: { bold: true, color: { argb: `FF${fg}` } }, alignment: { horizontal: 'center', vertical: 'middle' } });
// Only real web links become clickable (a posting can't smuggle in a javascript: or file: link).
const webUrl = (u) => (/^https?:\/\//i.test(String(u || '')) ? String(u) : '');
const day = (d) => (d && !isNaN(new Date(d)) ? new Date(d) : null);

function sheet(wb, name, color, columns, rows, paint) {
  const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }], properties: { tabColor: { argb: `FF${color}` } } });
  ws.columns = columns.map(([header, key, width]) => ({ header, key, width }));
  const head = ws.getRow(1);
  head.height = 24;
  head.eachCell((c) => Object.assign(c, { fill: fill(color), font: { bold: true, color: { argb: 'FFFFFFFF' }, size: 12 }, alignment: { vertical: 'middle', horizontal: 'center' } }));
  rows.forEach((r, i) => {
    const row = ws.addRow(r); // no fixed height: Excel sizes rows to the wrapped text
    row.eachCell({ includeEmpty: true }, (c) => {
      c.alignment = { vertical: 'middle', wrapText: true };
      c.border = { bottom: { style: 'thin', color: { argb: 'FFE5E7EB' } } };
      if (i % 2) c.fill = fill('F9FAFB');
    });
    const link = row.getCell('link');
    const url = webUrl(r.link);
    link.value = url ? { text: 'Apply ↗', hyperlink: url } : '';
    if (url) link.font = { color: { argb: 'FF2563EB' }, underline: true, bold: true };
    link.alignment = { horizontal: 'center', vertical: 'middle' };
    paint(row, r);
  });
  for (const c of ws.columns) if (c.key && rows.some((r) => r[c.key] instanceof Date)) c.numFmt = 'dd mmm yyyy';
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
  if (!rows.length) ws.addRow([`Nothing here yet`]).font = { italic: true, color: { argb: 'FF6B7280' } };
}

// only: 'jobs' | 'hackathons' | 'tracker' for one sheet; omitted for all three.
export async function exportWorkbook({ jobs = [], hackathons = [], applications = [], only }) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Auto Job';
  wb.created = new Date();

  if (!only || only === 'jobs') sheet(wb, 'Jobs', '5B5BF6',
    [['Match', 'score', 9], ['Role', 'title', 42], ['Company', 'company', 22], ['Details', 'meta', 46], ['Source', 'source', 20], ['Tracker', 'tracked', 14], ['Apply', 'link', 12]],
    jobs.slice(0, 5000).map((j) => ({ score: Number(j.score) || 0, title: String(j.title || ''), company: String(j.company || ''), meta: String(j.meta || ''), source: String(j.source || ''), tracked: STATUS[j.status]?.[0] || '', link: j.url })),
    (row, r) => {
      chip(row.getCell('score'), r.score >= 70 ? GOOD : r.score >= 40 ? MID : BAD);
      if (r.tracked) chip(row.getCell('tracked'), ['EEF2FF', '3730A3']);
    });

  const now = Date.now();
  if (!only || only === 'hackathons') sheet(wb, 'Hackathons', '7C3AED',
    [['Hackathon', 'title', 44], ['Platform', 'platform', 14], ['Mode', 'mode', 11], ['Location', 'location', 18], ['Closes', 'deadline', 14], ['Days left', 'days', 10], ['Prize', 'prize', 22], ['Perks', 'perks', 16], ['Themes', 'themes', 24], ['Apply', 'link', 12]],
    hackathons.slice(0, 5000).map((h) => {
      const deadline = day(h.deadline || h.end);
      return { title: String(h.title || ''), platform: String(h.organizer || h.platform || ''), mode: String(h.mode || ''), location: String(h.location || ''), deadline, days: deadline ? Math.max(0, Math.ceil((deadline - now) / 86400000)) : '', prize: String(h.prize || ''), perks: (h.perks || []).join(', '), themes: (h.themes || []).join(', '), link: h.url };
    }),
    (row, r) => {
      if (r.days !== '') chip(row.getCell('days'), r.days <= 3 ? BAD : r.days <= 7 ? MID : GOOD);
      chip(row.getCell('mode'), r.mode === 'online' ? ['E0F2FE', '075985'] : r.mode ? ['FCE7F3', '9D174D'] : NONE);
      if (r.perks) chip(row.getCell('perks'), GOOD);
      if (r.prize) row.getCell('prize').font = { bold: true, color: { argb: 'FFB45309' } };
    });

  if (!only || only === 'tracker') sheet(wb, 'Tracker', '0F9D58',
    [['Status', 'status', 14], ['Company', 'company', 22], ['Role', 'title', 40], ['Applied', 'applied', 14], ['Updated', 'updated', 14], ['Location', 'location', 18], ['Via', 'via', 10], ['Contact', 'contact', 24], ['Notes', 'notes', 40], ['Apply', 'link', 12]],
    applications.map((a) => ({ status: STATUS[a.status]?.[0] || String(a.status || ''), key: a.status, company: String(a.company || ''), title: String(a.title || ''), applied: a.status === 'saved' ? null : day(a.appliedAt || a.createdAt), updated: day(a.updatedAt), location: String(a.location || ''), via: String(a.via || ''), contact: String(a.contact || ''), notes: String(a.notes || '').slice(0, 2000), link: a.url })),
    (row, r) => chip(row.getCell('status'), STATUS[r.key] ? [STATUS[r.key][1], 'FFFFFF'] : NONE));

  return wb.xlsx.writeBuffer();
}
