// Regression run: every test form through the real content script + your running server, in headless Chrome.
//   cd server && npm start            (in one terminal)
//   node test/run-all.mjs             (in another; or: node test/run-all.mjs tricky workday  for just some pages)
// Env: AUTOJOB_URL (default http://localhost:8787), CHROME (path to Chrome; default: macOS Google Chrome).
// Uses your own profile from data/. heal.html and strict.html need the panel's self-healing / real typing,
// so they're expected to show "not filled" here: test those from the side panel.
import { spawn } from 'node:child_process';
const BASE = process.env.AUTOJOB_URL || 'http://localhost:8787', PORT = 9337;
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PAGES = process.argv.slice(2).length ? process.argv.slice(2) : ['form', 'hard', 'tricky', 'recruitcrm', 'sections', 'pyjama', 'fixcard', 'langs', 'workday', 'wdexp', 'wdstate', 'juspay', 'jobpage', 'otp', 'oracle', 'harman', 'pwc'];
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=/tmp/aj-suite-${Date.now()}`, 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let t; for (let i = 0; i < 50 && !t; i++) { await sleep(200); t = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json()).then((l) => l.find((x) => x.type === 'page')).catch(() => null); }
const ws = new WebSocket(t.webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
let id = 0; const w = new Map(); const errors = [];
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.method === 'Runtime.exceptionThrown') errors.push(d.params.exceptionDetails.exception?.description?.split('\n')[0] || d.params.exceptionDetails.text); if (w.has(d.id)) { w.get(d.id)(d); w.delete(d.id); } };
const send = (method, params = {}) => new Promise((r) => { const i = ++id; w.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const js = async (e) => (await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true })).result?.result?.value;
await send('Runtime.enable');
let failures = 0;
for (const p of PAGES) {
  errors.length = 0;
  await send('Page.navigate', { url: `${BASE}/test/${p}.html` }); await sleep(1800);
  await js(`(async () => { const load = (u) => new Promise((ok) => { const s = document.createElement('script'); s.src = u + '?' + Date.now(); s.onload = ok; s.onerror = ok; document.head.appendChild(s); }); await load('/test/ext/content.js'); await load('/test/harness.js'); })()`);
  let done = false;
  for (let i = 0; i < 150 && !done; i++) { await sleep(1000); done = await js(`!!(window.__harness && (window.__harness.done || window.__harness.error))`); }
  const h = await js(`JSON.stringify({ done: window.__harness?.done, error: window.__harness?.error, log: window.__harness?.log || [] })`).then((x) => JSON.parse(x || '{}'));
  const report = await js(`(() => { try { return JSON.stringify(window.report ? window.report() : null); } catch (e) { return 'report error ' + e.message; } })()`);
  const bad0 = (h.log || []).filter((l) => /^\s+\[(?!filled|upload)/.test(l) && !/skipped/.test(l));
  const bad = bad0;
  if (!done || h.error || bad.length || errors.length) failures++;
  console.log(`\n=== ${p}: ${done ? (h.error ? 'ERROR ' + h.error : 'done') : 'TIMEOUT'} · ${(h.log || []).filter((l) => /^\s+\[/.test(l)).length} fields · ${bad.length} not filled · page errors: ${errors.length}`);
  for (const b of bad.slice(0, 8)) console.log('   ✗', b.trim().slice(0, 160));
  for (const e of errors.slice(0, 3)) console.log('   ! JS', e.slice(0, 160));
  if (report && report !== 'null') console.log('   report:', String(report).slice(0, 900));
}
ws.close(); chrome.kill();
process.exitCode = failures ? 1 : 0;
