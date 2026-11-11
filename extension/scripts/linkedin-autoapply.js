// LinkedIn Easy Apply: a console script for linkedin.com/jobs/search with the Easy Apply filter on.
//
// HOW TO USE
//   1. Fill in the "YOUR DETAILS" block below (or let Auto Job do it: its "Copy LinkedIn script" button fills it
//      in from your Auto Job profile when these fields still hold placeholders).
//   2. Open https://www.linkedin.com/jobs/search/?f_AL=true , sign in, and set your filters (role, location...).
//      (f_AL=true is the "Easy Apply" filter.)
//   3. Open the browser console (Cmd+Option+J on Mac, Ctrl+Shift+J on Windows), paste the whole script, press Enter.
//   4. To stop at any time, type  window.linkedinStop = true  in the console and press Enter.
//
// HEADS UP — TWO THINGS TO KNOW:
//   * Unlike Auto Job's form filling, this script SUBMITS applications by itself. Start with CONFIG.dryRun = true
//     (fills every step, submits nothing) to check what it would send.
//   * LinkedIn's terms restrict automation: bulk Easy Apply runs can get your account restricted. The defaults are
//     deliberately conservative (dry run, 10 applications, 20-40 s pacing). Don't raise them and walk away.
//
// Keep a copy with your real details next to this file as  linkedin-autoapply.local.js : Auto Job's Copy button
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
      [/notice period|how soon|when can you start/i, 'Immediate'],
    ],
    // Questions with no obvious answer (salary, "why us", essay boxes) are left empty; the job is skipped
    // if any required field is unanswered — an incomplete application is never submitted.
  };
  // ======================================================================================================

  const CONFIG = {
    dryRun: true,           // true: fill every step, never press Submit. Check it once, then set false.
    maxApplications: 10,    // stop after this many applications in one run
    maxAgeDays: 7,          // skip jobs posted longer ago than this
    skipTitles: [],         // skip jobs whose title contains any of these words, e.g. ['senior', 'staff', 'manager']
    pauseMs: [20000, 40000],// pause between applications (randomised)
    maxSteps: 8,            // max pages inside one Easy Apply modal
  };

  // Refuse to run with placeholders: "YOUR FULL NAME" must never be sent to a real employer.
  if (/YOUR[ -][A-Z]|YOUR-USERNAME|YOUR-PROFILE|YOUR-PORTFOLIO/.test(JSON.stringify(ME))) {
    console.log('%c✋ Fill in the YOUR DETAILS block at the top of the script first (name, email, phone, city, links), then paste it again.', 'color: #F59E0B; font-size: 14px; font-weight: bold;');
    return;
  }

  const delay = (ms) => new Promise((res) => setTimeout(res, ms));
  const stopped = () => window.linkedinStop === true;
  window.linkedinStop = false;
  const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const visible = (el) => !!el && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  const textOf = (el) => String(el?.innerText || el?.textContent || '').replace(/\s+/g, ' ').trim();
  const click = (el) => el && el.click();

  // LinkedIn's fields listen to native input events (React).
  const setValue = (el, value) => {
    const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
  };

  const labelOf = (el) => {
    const l = el.labels?.[0] || el.closest('label') || (el.id && document.querySelector(`label[for="${el.id}"]`));
    if (l) return textOf(l);
    const wrap = el.closest('fieldset, .fb-form-element, .jobs-easy-apply-form-element');
    return textOf(wrap?.querySelector('legend, label, .fb-form-element-label')) || textOf(wrap).slice(0, 200);
  };

  // Answer one visible field from ME; returns false when it has no honest answer.
  function answerField(el) {
    const label = labelOf(el);
    if (!visible(el) || el.disabled || el.type === 'hidden' || el.type === 'file') return true; // uploads stay for you
    if (el.type === 'radio' || el.type === 'checkbox') return true; // groups handled separately
    if (el.tagName === 'SELECT') {
      const rule = ME.answers.find(([re]) => re.test(label));
      if (!rule) return !el.required;
      const options = [...el.options];
      const want = String(rule[1]);
      const opt = options.find((o) => textOf(o).toLowerCase() === want.toLowerCase()) || options.find((o) => textOf(o).toLowerCase().startsWith(want.toLowerCase()));
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
      else if (/linkedin|linkedin profile/i.test(label)) v = ME.links.LinkedIn;
      else if (/your name|full name/i.test(label)) v = ME.name;
    }
    if (!v) return !el.required;
    setValue(el, v);
    return true;
  }

  // Yes/No (and other) radio groups: matched by the question text against ME.answers.
  function answerGroups(step) {
    for (const fs of step.querySelectorAll('fieldset, [role="radiogroup"]')) {
      const radios = [...fs.querySelectorAll('input[type="radio"]')];
      if (!radios.length || radios.some((r) => r.checked)) continue;
      const q = textOf(fs.querySelector('legend, .fb-form-element-label') || fs).slice(0, 300);
      const rule = ME.answers.find(([re]) => re.test(q));
      if (!rule) continue;
      const want = String(rule[1]).toLowerCase();
      const hit = radios.find((r) => {
        const lab = textOf(r.labels?.[0] || r.closest('label') || document.querySelector(`label[for="${r.id}"]`)).toLowerCase();
        return lab === want || lab.startsWith(want);
      });
      if (hit) hit.click();
    }
  }

  // One page of the modal. Returns { ok, unanswered } — never proceed with a required field empty.
  async function fillStep(step) {
    answerGroups(step);
    const unanswered = [];
    for (const el of step.querySelectorAll('input:not([type="hidden"]):not([type="radio"]):not([type="checkbox"]), textarea, select')) {
      if (!visible(el) || el.disabled) continue;
      if (el.value) continue; // the site pre-filled it: keep
      if (!answerField(el) && el.required) unanswered.push(labelOf(el) || el.name || el.type);
      await delay(150);
    }
    return { ok: !unanswered.length, unanswered };
  }

  const modal = () => document.querySelector('.jobs-easy-apply-modal, [role="dialog"]:not([hidden])');
  const btnIn = (root, re) => [...root.querySelectorAll('button')].find((b) => visible(b) && re.test(textOf(b)));

  const applied = [];
  const counts = { skipped: 0, old: 0, filtered: 0, unanswered: 0 };
  const processed = new Set();

  console.log(`%c🚀 LinkedIn Easy Apply for ${ME.name}${CONFIG.dryRun ? ' (dry run: nothing is submitted)' : ''} — type  window.linkedinStop = true  to stop.`, 'color: #10B981; font-size: 14px; font-weight: bold;');

  const processCard = async (card) => {
    const title = textOf(card.querySelector('.job-card-list__title, a[href*="/jobs/view/"]')).split('\n')[0].trim();
    if (CONFIG.skipTitles.some((w) => title.toLowerCase().includes(String(w).toLowerCase()))) {
      counts.filtered++;
      return;
    }
    const posted = textOf(card).match(/(\d+)\s*(day|week|month)/i);
    if (posted) {
      const days = Number(posted[1]) * ({ day: 1, week: 7, month: 30 }[posted[2].toLowerCase()]);
      if (days > CONFIG.maxAgeDays) {
        counts.old++;
        return;
      }
    }
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    await delay(800);
    card.querySelector('.job-card-list__title, a[href*="/jobs/view/"]')?.click();
    await delay(1500);
    const easyBtn = [...document.querySelectorAll('button')].find((b) => visible(b) && /easy apply/i.test(textOf(b)));
    if (!easyBtn) {
      console.log('%c⏭️ Not an Easy Apply job (external application): skipping', 'color: gray');
      counts.skipped++;
      return;
    }
    easyBtn.click();
    const box = await (async () => {
      for (let i = 0; i < 30; i++) {
        const m = modal();
        if (m && visible(m)) return m;
        await delay(300);
      }
      return null;
    })();
    if (!box) {
      counts.skipped++;
      return;
    }

    // Walk the steps: fill → Next → … → Review → Submit (or stop on an unanswered required field).
    for (let step = 0; step < CONFIG.maxSteps && !stopped(); step++) {
      await delay(900);
      const r = await fillStep(box);
      if (!r.ok) {
        console.log(`%c⏭️ Skipping ${title}: unanswered required field(s): ${r.unanswered.join(' | ')}`, 'color: #F59E0B');
        counts.unanswered++;
        btnIn(box, /^cancel$/i)?.click();
        await delay(500);
        btnIn(document, /^(discard|cancel|yes, discard)/i)?.click();
        return;
      }
      const next = btnIn(box, /^(next|continue)$/i);
      if (next) {
        next.click();
        continue;
      }
      const review = btnIn(box, /^review$/i);
      if (review) {
        review.click();
        await delay(1000);
      }
      const submit = btnIn(box, /^(submit application|submit)$/i);
      if (CONFIG.dryRun) {
        console.log(`%c📝 Dry run: ${title} is fully filled, not submitted`, 'color: #A855F7');
      } else if (submit) {
        submit.click();
        await delay(1500);
        console.log(`%c✅ Applied: ${title} (total ${applied.length + 1})`, 'color: #14B8A6; font-weight: bold;');
      }
      applied.push({ job: title, submitted: !CONFIG.dryRun, at: new Date().toLocaleTimeString() });
      // Close the modal and any follow-up dialog.
      btnIn(box, /^cancel$/i)?.click();
      await delay(500);
      btnIn(document, /^(discard|cancel|yes, discard)/i)?.click();
      await delay(CONFIG.pauseMs[0] + Math.random() * (CONFIG.pauseMs[1] - CONFIG.pauseMs[0]));
      return;
    }
    counts.skipped++;
  };

  // Walk the result list, paginating through LinkedIn's search pages.
  for (let page = 0; page < 20 && !stopped() && applied.length < CONFIG.maxApplications; page++) {
    const cards = [...document.querySelectorAll('li:has(.job-card-list__title), .job-card-container, .scaffold-layout__list-item')].filter((c) => visible(c) && !processed.has(c));
    for (const card of cards) {
      if (stopped() || applied.length >= CONFIG.maxApplications) break;
      processed.add(card);
      try {
        await processCard(card);
      } catch (err) {
        console.log('%c❌ Card failed: ' + err.message, 'color: red');
        counts.skipped++;
        btnIn(document, /^cancel$/i)?.click();
      }
    }
    const nextPage = [...document.querySelectorAll('button[aria-label*="next" i], .artdeco-pagination button')].find((b) => visible(b) && /next/i.test(b.getAttribute('aria-label') || textOf(b)));
    if (!nextPage || nextPage.disabled) break;
    nextPage.click();
    await delay(2500);
  }

  console.log(`%c🎉 Done${stopped() ? ' (stopped by you)' : ''}.`, 'color: limegreen; font-size: 16px; font-weight: bold;');
  if (applied.length) console.table(applied);
  console.log(`📌 ${CONFIG.dryRun ? 'Filled (dry run)' : 'Applied'}: ${applied.length} · skipped: ${counts.skipped} · unanswered required fields: ${counts.unanswered} · older than ${CONFIG.maxAgeDays} days: ${counts.old} · title filter: ${counts.filtered}`);
})();
