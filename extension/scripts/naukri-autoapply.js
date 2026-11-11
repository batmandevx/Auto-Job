// Naukri auto-apply: a console script for naukri.com search results (and single job pages).
//
// HOW TO USE
//   1. Fill in the "YOUR DETAILS" block below (or let Auto Job do it: its "Copy Naukri script" button fills it in
//      from your Auto Job profile when these fields still hold placeholders).
//   2. Open a Naukri search page (e.g. https://www.naukri.com/software-engineer-jobs-in-india), sign in, set filters.
//   3. Open the browser console (Cmd+Option+J on Mac, Ctrl+Shift+J on Windows), paste the whole script, press Enter.
//   4. To stop at any time, type  window.naukriStop = true  in the console and press Enter.
//
// HOW IT WORKS (Naukri opens each job as a new page, which would kill a normal console script): the script loads
// each job page into a hidden same-origin iframe instead (Naukri allows same-origin framing), applies inside it,
// then removes it. Nothing navigates your real tab. On a single job page (/job-listings-...) it just applies there.
//
// HEADS UP — TWO THINGS TO KNOW:
//   * Unlike Auto Job's form filling, this script SUBMITS applications by itself. Start with CONFIG.dryRun = true
//     (fills every step, submits nothing) to check what it would send.
//   * Naukri's terms restrict automation: bulk runs can get your account restricted. The defaults are conservative
//     (dry run, 10 applications, 20-40 s pacing). Don't raise them and walk away.
//
// Keep a copy with your real details next to this file as  naukri-autoapply.local.js : Auto Job's Copy button
// prefers it, and *.local.js files are git-ignored, so your details are never committed.

(async () => {
  // ============================ YOUR DETAILS: edit everything in this block ============================
  const ME = {
    name: 'YOUR FULL NAME',
    email: 'YOUR EMAIL',
    phone: 'YOUR PHONE WITH COUNTRY CODE',   // e.g. "+919305183418"
    city: 'YOUR CITY',                       // e.g. "Lucknow, Uttar Pradesh, India"
    links: {
      LinkedIn: 'https://www.linkedin.com/in/YOUR-PROFILE',
      Portfolio: 'https://YOUR-PORTFOLIO.example',
      GitHub: 'https://github.com/YOUR-USERNAME',
    },
    // Label → answer, matched case-insensitively against the question text. Edit to fit you.
    answers: [
      [/legally (authorized|authorised|eligible) to work|right to work/i, 'Yes'],
      [/sponsor(ship)?|require.*visa/i, 'No'],
      [/relocat|willing to move/i, 'Yes'],
      [/non[- ]?compete/i, 'No'],
      [/previous(ly)? (worked|employed)|former employee/i, 'No'],
      [/18 years|at least 18/i, 'Yes'],
      [/how many years|years of experience/i, '1'],
      [/notice period|how soon|when can you start|joining/i, 'Immediate'],
      [/expected (ctc|salary)|salary expectation/i, ''],
    ],
    // Questions with no answer here (salary, "why us", essay boxes) are left empty; the job is skipped if
    // any required field is unanswered — an incomplete application is never submitted.
  };
  // ======================================================================================================

  const CONFIG = {
    dryRun: true,           // true: fill every step, never press the final Apply. Check once, then set false.
    maxApplications: 10,    // stop after this many applications in one run
    maxAgeDays: 7,          // skip jobs posted longer ago than this
    skipTitles: [],         // skip jobs whose title contains any of these words, e.g. ['senior', 'staff', 'manager']
    pauseMs: [20000, 40000],// pause between applications (randomised)
    maxSteps: 8,            // max pages inside one apply modal
  };

  // Refuse to run with placeholders: "YOUR FULL NAME" must never be sent to a real employer.
  if (/YOUR[ -][A-Z]|YOUR-USERNAME|YOUR-PROFILE|YOUR-PORTFOLIO/.test(JSON.stringify(ME))) {
    console.log('%c✋ Fill in the YOUR DETAILS block at the top of the script first (name, email, phone, city, links), then paste it again.', 'color: #F59E0B; font-size: 14px; font-weight: bold;');
    return;
  }

  const delay = (ms) => new Promise((res) => setTimeout(res, ms));
  const stopped = () => window.naukriStop === true;
  window.naukriStop = false;
  const textOf = (el) => String(el?.innerText || el?.textContent || '').replace(/\s+/g, ' ').trim();
  const visible = (el) => {
    try {
      return !!el && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    } catch {
      return false;
    }
  };

  // Naukri's React forms listen to native input events.
  const setValue = (el, value) => {
    const proto = el.tagName === 'TEXTAREA' ? el.ownerDocument.defaultView.HTMLTextAreaElement.prototype : el.ownerDocument.defaultView.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
  };

  const labelOf = (el) => {
    const l = el.labels?.[0] || el.closest('label') || (el.id && el.ownerDocument.querySelector(`label[for="${el.id}"]`));
    if (l) return textOf(l);
    const wrap = el.closest('fieldset, [class*="formElement"], [class*="form-element"], [class*="question"]');
    return textOf(wrap?.querySelector('legend, label, [class*="label"]')) || textOf(wrap).slice(0, 200);
  };

  // Answer one field from ME; false when there is no honest answer for a required field.
  function answerField(el) {
    const label = labelOf(el);
    if (!visible(el) || el.disabled || el.type === 'hidden' || el.type === 'file') return true; // uploads stay for you
    if (el.type === 'radio' || el.type === 'checkbox') return true; // groups handled separately
    if (el.tagName === 'SELECT') {
      const rule = ME.answers.find(([re]) => re.test(label));
      if (!rule) return !el.required;
      const want = String(rule[1]).toLowerCase();
      const opt = [...el.options].find((o) => textOf(o).toLowerCase() === want) || [...el.options].find((o) => textOf(o).toLowerCase().startsWith(want));
      if (!opt) return false;
      setValue(el, opt.value);
      return true;
    }
    const rule = ME.answers.find(([re]) => re.test(label));
    let v = rule?.[1];
    if (!v) {
      if (/e-?mail/i.test(label)) v = ME.email;
      else if (/phone|mobile/i.test(label)) v = ME.phone;
      else if (/city|location|current location/i.test(label)) v = ME.city;
      else if (/portfolio|website/i.test(label)) v = ME.links.Portfolio;
      else if (/github/i.test(label)) v = ME.links.GitHub;
      else if (/linkedin/i.test(label)) v = ME.links.LinkedIn;
      else if (/your name|full name/i.test(label)) v = ME.name;
    }
    if (!v) return !el.required;
    setValue(el, v);
    return true;
  }

  function answerGroups(root) {
    for (const fs of root.querySelectorAll('fieldset, [role="radiogroup"], [class*="radio"]')) {
      const radios = [...fs.querySelectorAll('input[type="radio"]')];
      if (radios.length < 2 || radios.some((r) => r.checked)) continue;
      const q = textOf(fs.querySelector('legend, [class*="label"]') || fs).slice(0, 300);
      const rule = ME.answers.find(([re]) => re.test(q));
      if (!rule) continue;
      const want = String(rule[1]).toLowerCase();
      const hit = radios.find((r) => {
        const lab = textOf(r.labels?.[0] || r.closest('label') || r.ownerDocument.querySelector(`label[for="${r.id}"]`)).toLowerCase();
        return lab === want || lab.startsWith(want);
      });
      if (hit) hit.click();
    }
  }

  // One modal page: fill every field; required fields left unanswered mean this job is skipped.
  async function fillStep(root) {
    answerGroups(root);
    const unanswered = [];
    for (const el of root.querySelectorAll('input:not([type="hidden"]):not([type="radio"]):not([type="checkbox"]), textarea, select')) {
      if (!visible(el) || el.disabled || el.value) continue;
      if (!answerField(el) && el.required) unanswered.push(labelOf(el) || el.name || el.type);
      await delay(150);
    }
    return { ok: !unanswered.length, unanswered };
  }

  const btnIn = (root, re) => [...root.querySelectorAll('button')].find((b) => visible(b) && re.test(textOf(b)));

  // Apply to the job whose page is in `doc` (the real page, or a hidden iframe's document).
  async function applyOnPage(doc, label) {
    const applyBtn = await (async () => {
      for (let i = 0; i < 40; i++) {
        const b = doc.getElementById('apply-button') || doc.querySelector('.apply-button');
        if (b) return b;
        await delay(400);
      }
      return null;
    })();
    if (!applyBtn) throw new Error('no Apply button on the page');
    if (/company website|apply on company|external/i.test(textOf(applyBtn))) {
      console.log(`%c⏭️ ${label}: external application (company website), skipping`, 'color: gray');
      return 'external';
    }
    applyBtn.click();
    await delay(1800);

    // Custom-question modal (Naukri's employer questions), or an instant "applied" state.
    for (let step = 0; step < CONFIG.maxSteps && !stopped(); step++) {
      const modal = [...doc.querySelectorAll('[role="dialog"], [class*="modal"], [class*="Modal"]')].find(visible);
      const success = /applied|application (sent|submitted)|you('ve| have) applied|application received/i.test(textOf(modal || doc.body).slice(0, 4000));
      if (success && !modal) return CONFIG.dryRun ? 'dry' : 'applied';
      const root = modal || doc;
      const r = await fillStep(root);
      if (!r.ok) {
        console.log(`%c⏭️ ${label}: unanswered required field(s): ${r.unanswered.join(' | ')}`, 'color: #F59E0B');
        btnIn(root, /^(cancel|close)$/i)?.click();
        return 'unanswered';
      }
      const next = btnIn(root, /^(next|continue)$/i);
      if (next) {
        next.click();
        await delay(1200);
        continue;
      }
      const submit = btnIn(root, /^(submit|apply|apply now|submit application)$/i);
      if (CONFIG.dryRun) return 'dry';
      if (submit) {
        submit.click();
        await delay(1800);
        return 'applied';
      }
      // No submit and no next: Naukri often applies on the first click — a success banner means done.
      if (success) return 'applied';
      return 'skipped';
    }
    return 'skipped';
  }

  // Load a job page in a hidden same-origin iframe, apply inside it, then remove the iframe.
  const withFrame = async (url, fn) => {
    const iframe = document.createElement('iframe');
    iframe.style.cssText = 'position:fixed;left:-10000px;top:0;width:1100px;height:800px;visibility:hidden;';
    iframe.src = url;
    document.body.appendChild(iframe);
    try {
      for (let i = 0; i < 50 && !(iframe.contentDocument && iframe.contentDocument.readyState === 'complete'); i++) await delay(300);
      await delay(1200);
      return await fn(iframe.contentDocument);
    } finally {
      iframe.remove();
    }
  };

  const applied = [];
  const counts = { skipped: 0, old: 0, filtered: 0, unanswered: 0, external: 0 };
  const processed = new Set();

  console.log(`%c🚀 Naukri auto-apply for ${ME.name}${CONFIG.dryRun ? ' (dry run: nothing is submitted)' : ''} — type  window.naukriStop = true  to stop.`, 'color: #10B981; font-size: 14px; font-weight: bold;');

  // Single-job mode: pasted on a /job-listings-... page, apply right there (no iframe needed).
  if (/\/job-listings-/.test(location.pathname)) {
    try {
      const title = textOf(document.querySelector('h1')) || location.pathname.slice(15, 60);
      const outcome = await applyOnPage(document, title);
      console.log(`%c${outcome === 'applied' ? '✅ Applied' : outcome === 'dry' ? '📝 Dry run: filled, not submitted' : '⏭️ ' + outcome}: ${title}`, 'color: #14B8A6; font-weight: bold;');
      applied.push({ job: title, outcome, at: new Date().toLocaleTimeString() });
    } catch (err) {
      console.log('%c❌ ' + err.message, 'color: red');
    }
    console.table(applied);
    return;
  }

  // Search-page mode: collect job links from the cards (scrolling loads more).
  const collectCards = () =>
    [...document.querySelectorAll('.srp-jobtuple-wrapper')].map((card) => {
      const link = card.querySelector('a.title')?.href;
      const title = textOf(card.querySelector('.row1')) || textOf(card.querySelector('a.title'));
      const posted = textOf(card).match(/(\d+)\s*(day|week|month)s?\s*ago/i);
      return { link, title, card, posted };
    });

  for (let page = 0; page < 20 && !stopped() && applied.length < CONFIG.maxApplications; page++) {
    let cards = collectCards().filter((c) => c.link && !processed.has(c.link));
    if (!cards.length) {
      window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
      await delay(2500);
      cards = collectCards().filter((c) => c.link && !processed.has(c.link));
      if (!cards.length) break;
    }
    for (const { link, title, card, posted } of cards) {
      if (stopped() || applied.length >= CONFIG.maxApplications) break;
      processed.add(link);
      if (CONFIG.skipTitles.some((w) => title.toLowerCase().includes(String(w).toLowerCase()))) {
        counts.filtered++;
        continue;
      }
      if (posted) {
        const days = Number(posted[1]) * ({ day: 1, week: 7, month: 30 }[posted[2].toLowerCase()]);
        if (days > CONFIG.maxAgeDays) {
          counts.old++;
          continue;
        }
      }
      try {
        const outcome = await withFrame(link, (doc) => applyOnPage(doc, title));
        console.log(`%c${outcome === 'applied' ? '✅ Applied' : outcome === 'dry' ? '📝 Dry run: filled, not submitted' : '⏭️ ' + outcome}: ${title} (${applied.length + (outcome === 'applied' || outcome === 'dry' ? 1 : 0)} done)`, `color: ${outcome === 'applied' || outcome === 'dry' ? '#14B8A6' : 'gray'}; font-weight: bold;`);
        if (outcome === 'unanswered') counts.unanswered++;
        else if (outcome === 'external') counts.external++;
        else if (outcome !== 'skipped') applied.push({ job: title, outcome, at: new Date().toLocaleTimeString() });
      } catch (err) {
        console.log(`%c❌ ${title}: ${err.message}`, 'color: red');
        counts.skipped++;
      }
      await delay(CONFIG.pauseMs[0] + Math.random() * (CONFIG.pauseMs[1] - CONFIG.pauseMs[0]));
    }
  }

  console.log(`%c🎉 Done${stopped() ? ' (stopped by you)' : ''}.`, 'color: limegreen; font-size: 16px; font-weight: bold;');
  if (applied.length) console.table(applied);
  console.log(`📌 ${CONFIG.dryRun ? 'Filled (dry run)' : 'Applied'}: ${applied.length} · unanswered required fields: ${counts.unanswered} · external: ${counts.external} · older than ${CONFIG.maxAgeDays} days: ${counts.old} · title filter: ${counts.filtered} · errors: ${counts.skipped}`);
})();
