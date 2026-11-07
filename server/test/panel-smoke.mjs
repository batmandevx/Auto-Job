// Panel start-up check: loads the side panel page in headless Chrome with stand-ins for the chrome.* APIs and fails
// on any script error (a load-order mistake there silently disables every tab and button).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const ext = path.resolve(import.meta.dirname, '../../extension');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autojob-panel-'));
for (const f of fs.readdirSync(ext)) if (/\.(js|css|html|svg)$/.test(f)) fs.copyFileSync(path.join(ext, f), path.join(dir, f));
fs.writeFileSync(path.join(dir, 'stub.js'), `const ev = { addListener() {}, removeListener() {} }; const area = { get: async () => ({}), set: async () => {}, remove: async () => {} };
window.chrome = { runtime: { id: 'x', getURL: (p) => p, sendMessage: async () => null, onMessage: ev, getContexts: async () => [] }, storage: { local: area, session: area, onChanged: ev },
  tabs: { query: async () => [], get: async () => ({}), update: async () => ({}), create: async () => ({}), onUpdated: ev, onActivated: ev, captureVisibleTab: async () => null },
  windows: { getLastFocused: async () => ({ id: 1 }), getCurrent: async () => ({ id: 1 }), update: async () => ({}), create: async () => ({ id: 2 }) },
  scripting: { executeScript: async () => [] }, sidePanel: { open: async () => {} }, extension: { getViews: () => [] }, debugger: { attach: async () => {}, detach: async () => {}, sendCommand: async () => ({}) } };`);
fs.writeFileSync(path.join(dir, 'test.html'), fs.readFileSync(path.join(dir, 'sidepanel.html'), 'utf8').replace('<script src="sidepanel.js"></script>', '<script src="stub.js"></script><script src="sidepanel.js"></script>'));
const PORT = 9339, sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const c = spawn(CHROME, [...(process.env.CI ? ['--no-sandbox', '--disable-gpu'] : []), '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${dir}/profile`, '--allow-file-access-from-files', 'about:blank'], { stdio: 'ignore' });
let t; for (let i = 0; i < 75 && !t; i++) { await sleep(200); t = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json()).then((l) => l.find((x) => x.type === 'page')).catch(() => null); }
const ws = new WebSocket(t.webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
let id = 0; const w = new Map(); const errors = [];
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.method === 'Runtime.exceptionThrown') errors.push(`${d.params.exceptionDetails.exception?.description?.split('\n')[0] || d.params.exceptionDetails.text} (line ${d.params.exceptionDetails.lineNumber + 1})`); if (w.has(d.id)) { w.get(d.id)(d); w.delete(d.id); } };
const send = (method, params = {}) => new Promise((r) => { const i = ++id; w.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
await send('Runtime.enable');
await send('Page.navigate', { url: `file://${dir}/test.html` });
await sleep(2500);
const tabs = ['queue', 'hacks', 'tracker', 'profile', 'apply'];
const opened = (await send('Runtime.evaluate', { expression: `JSON.stringify(${JSON.stringify(tabs)}.map((k) => { document.querySelector('[data-tab="' + k + '"]').click(); return getComputedStyle(document.getElementById('tab-' + k)).display !== 'none'; }))`, returnByValue: true })).result.result.value;
// The tracker with a card that has an email timeline, and a Gmail result with added applications and recruiter mail.
const traced = (await send('Runtime.evaluate', { expression: `(() => { try {
  const mail = [{ id: 'm1', kind: 'applied', subject: 'Thanks for applying', date: '2026-09-01' }, { id: 'm2', kind: 'interview', subject: 'Interview invitation', date: '2026-09-10' }];
  state.apps = [{ id: 'a1', company: 'Acme', title: 'Intern', status: 'interview1', appliedAt: '2026-09-01', createdAt: '2026-09-01', history: [], mail }];
  renderTracker();
  renderTrace({ scanned: 3000, checked: 300, jobEmails: 120, at: new Date().toISOString(), updates: [], unmatched: [], applied: [],
    added: [{ appId: 'a1', company: 'Acme', title: 'Intern', status: 'interview1', mail: mail.map((m) => ({ ...m, mailId: m.id })) }],
    outreach: [{ mailId: 'o1', kind: 'outreach', subject: 'A role for you', from: 'Recruiter', company: 'Beta', date: '2026-09-12' }] });
  return [!!document.querySelector('.app-timeline'), /Added from your mail/.test(document.getElementById('traceOut').innerText), /Recruiters writing to you/.test(document.getElementById('traceOut').innerText)].join(',');
} catch (e) { return 'error ' + e.message; } })()`, returnByValue: true })).result.result.value;
if (traced !== 'true,true,true') errors.push(`tracker / Gmail result didn't render: ${traced}`);
// Hacks: "Best for you" puts the hackathon that fits the profile first and says why; the theme filter works.
const hacks = (await send('Runtime.evaluate', { expression: `(() => { try {
  state.profile = { skills: ['Python', 'PyTorch', 'React'], headline: 'AI engineer', experience: [], projects: [] };
  state.hacks = [
    { id: 'a', platform: 'devpost', title: 'Retail Analytics Jam', url: 'https://x.test/a', mode: 'in-person', location: 'Ohio', themes: [], tags: [], perks: [] },
    { id: 'b', platform: 'unstop', title: 'GenAI Build Sprint with PyTorch', url: 'https://x.test/b', mode: 'online', themes: ['AI / ML'], tags: ['Python'], perks: ['PPI'] },
  ];
  state.hackSources = {};
  $('#hackSort').value = 'match';
  renderHacks();
  const first = document.querySelector('#hackList .hack .t a')?.textContent;
  const badge = document.querySelector('#hackList .hb.match')?.textContent || '';
  $('#hackTheme').value = 'AI / ML'; renderHacks();
  const filtered = document.querySelectorAll('#hackList .hack').length;
  return [first === 'GenAI Build Sprint with PyTorch', /pytorch|python/i.test(badge), filtered === 1].join(',');
} catch (e) { return 'error ' + e.message; } })()`, returnByValue: true })).result.result.value;
if (hacks !== 'true,true,true') errors.push(`Hacks "Best for you" didn't rank or filter right: ${hacks}`);
ws.close(); c.kill();
const ok = JSON.parse(opened || '[]');
const bad = tabs.filter((_, i) => !ok[i]);
console.log(`PANEL: ${errors.length} script error(s), tabs that didn't open: ${bad.join(', ') || 'none'}`);
for (const e of errors) console.log(`   ! JS ${e}`);
process.exitCode = errors.length || bad.length ? 1 : 0;
