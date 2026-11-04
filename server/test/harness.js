// Test-only: runs the side panel's fill → upload → Next loop inside a single page (no chrome.* APIs),
// so the content script and server can be exercised in any browser. Progress goes to window.__harness.
(async () => {
  const H = (window.__harness = { log: [], done: false, error: null });
  const log = (m) => H.log.push(m);
  const api = async (p, body) => {
    const r = await fetch(p, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
    const d = await r.json();
    if (!r.ok) throw new Error(d.error);
    return d;
  };
  const jf = window.__jobfill;
  const COVER_RE = /cover\s*letter/i;
  const kind = (f, n) => {
    const l = `${f.label} ${f.name}`.toLowerCase();
    if (COVER_RE.test(l)) return 'cover';
    if (/signature/.test(l)) return 'signature';
    if (/photo|picture|headshot|passport\s*size/.test(l)) return 'photo';
    if (/resume|\bcv\b/.test(l)) return 'resume';
    return n === 1 ? 'resume' : 'other';
  };
  try {
    const job = jf.extractJob();
    log(`job: ${job.title} @ ${job.company} (${job.location})`);
    let resume, cover;
    for (let page = 1; page <= 6; page++) {
      const attempted = new Set();
      for (let round = 0; round < 3; round++) {
        const { fields } = await jf.scan();
        const todo = fields.filter((f) => !attempted.has(f.id) && !f.filled);
        if (!todo.length) break;
        todo.forEach((f) => attempted.add(f.id));
        const files = todo.filter((f) => f.type === 'file');
        const rest = todo.filter((f) => f.type !== 'file');
        log(`page ${page} round ${round}: ${rest.length} fields, ${files.length} uploads`);
        if (rest.length) {
          const t0 = Date.now();
          const { values, needsReview, source } = await api('/api/answer', { fields: rest, job });
          log(`  answers in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
          const res = await jf.fill(values, needsReview);
          for (const f of rest) log(`  [${res[f.id] || 'skipped'}${needsReview.includes(f.id) ? ', review' : ''}] (${f.type}) ${f.label.slice(0, 60)} = ${JSON.stringify(values[f.id])?.slice(0, 70)} <${source[f.id] || '-'}>`);
        }
        for (const f of files) {
          const k = kind(f, files.length);
          let doc = null;
          if (k === 'resume') doc = resume ||= await api('/api/tailor', job).then((r) => ({ base64: r.pdfBase64, filename: r.filename, mime: 'application/pdf' }));
          if (k === 'cover') doc = cover ||= await api('/api/cover-letter', job).then((r) => ({ base64: r.pdfBase64, filename: r.filename, mime: 'application/pdf' }));
          if (k === 'photo' || k === 'signature') doc = await api(`/api/documents/${k}`).catch(() => null); // not saved: "no document", like the panel
          const r = doc ? jf.uploadFile(f.id, doc.base64, doc.filename, doc.mime) : { ok: false, reason: 'no document' };
          log(`  [upload ${k}] ${f.label.slice(0, 50)} -> ${r.ok ? doc.filename : r.reason}`);
        }
        await new Promise((r) => setTimeout(r, 500));
      }
      const next = jf.nextLabel();
      if (!next) {
        log(`final page: submit button = "${jf.submitLabel()}"`);
        break;
      }
      const before = jf.pageKey();
      jf.clickNext();
      let moved = false;
      for (let i = 0; i < 20 && !moved; i++) {
        await new Promise((r) => setTimeout(r, 400));
        moved = jf.pageKey() !== before;
      }
      if (!moved) {
        log(`STUCK after "${next}": ${jf.errorTexts().join(' | ')}`);
        break;
      }
      log(`clicked "${next}" -> moved on`);
      await new Promise((r) => setTimeout(r, 600));
    }
  } catch (e) {
    H.error = e.message;
  }
  H.done = true;
})();
