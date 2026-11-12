// Excel export: three sheets, Apply links only for http(s) URLs, colour-coded match / status cells.
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { exportWorkbook } from '../src/export.js';

const buf = await exportWorkbook({
  jobs: [{ title: 'SDE Intern', company: 'Acme', url: 'https://acme.com/1', score: 82 }, { title: 'Bad link', url: 'javascript:alert(1)', score: 10 }],
  hackathons: [{ title: 'Hack', url: 'https://h.dev', deadline: new Date(Date.now() + 2 * 86400000).toISOString(), mode: 'online' }],
  applications: [{ company: 'Acme', title: 'SDE Intern', status: 'offer', url: 'https://acme.com/1', createdAt: new Date().toISOString() }],
});
const wb = new ExcelJS.Workbook();
await wb.xlsx.load(buf);
assert.deepEqual(wb.worksheets.map((w) => w.name), ['Jobs', 'Hackathons', 'Tracker']);
const jobs = wb.getWorksheet('Jobs');
assert.equal(jobs.getRow(2).getCell(7).value.hyperlink, 'https://acme.com/1');
assert.equal(jobs.getRow(3).getCell(7).value, '');
assert.equal(jobs.getRow(2).getCell(1).fill.fgColor.argb, 'FFDCFCE7'); // 82: green
assert.equal(jobs.getRow(3).getCell(1).fill.fgColor.argb, 'FFFEE2E2'); // 10: red
assert.equal(wb.getWorksheet('Hackathons').getRow(2).getCell(6).fill.fgColor.argb, 'FFFEE2E2'); // closes in 2 days: red
assert.equal(wb.getWorksheet('Tracker').getRow(2).getCell(1).value, 'Offer');
console.log('export: ok');

// Each tab's button exports only its own sheet.
const one = new ExcelJS.Workbook();
await one.xlsx.load(await exportWorkbook({ hackathons: [{ title: 'Hack', url: 'https://h.dev' }], only: 'hackathons' }));
assert.deepEqual(one.worksheets.map((w) => w.name), ['Hackathons']);
console.log('export (one sheet): ok');
