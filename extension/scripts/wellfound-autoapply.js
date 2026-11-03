// Wellfound auto-apply: a console script for wellfound.com/jobs.
//
// HOW TO USE
//   1. Fill in the "YOUR DETAILS" block below (or let Auto Job do it: its "Copy script" button fills it in from
//      your Auto Job profile when these fields still hold placeholders).
//   2. Open https://wellfound.com/jobs, sign in, and set your filters (role, location, remote...).
//   3. Open the browser console (Cmd+Option+J on Mac, Ctrl+Shift+J on Windows), paste the whole script, press Enter.
//   4. To stop at any time, type  window.wellfoundStop = true  in the console and press Enter.
//
// HEADS UP: unlike Auto Job's form filling, this script SUBMITS applications by itself. Start with
// CONFIG.dryRun = true (fills the message, submits nothing) to check what it would send.
//
// Keep a copy with your real details next to this file as  wellfound-autoapply.local.js : Auto Job's Copy button
// prefers it, and *.local.js files are git-ignored, so your details are never committed.

(async () => {
  // ============================ YOUR DETAILS: edit everything in this block ============================
  const ME = {
    name: 'YOUR FULL NAME',                         // e.g. "Priya Sharma"
    pitch: 'YOUR ONE-LINE INTRO',                   // e.g. "a backend engineer (B.Tech CSE) who loves shipping products from 0 to 1"
    highlights: [                                   // 2-4 short, specific wins with real numbers; delete lines you don't need
      'YOUR STRONGEST ROLE OR RESULT',              // e.g. "SDE Intern @ Acme: cut API latency 40% for 2M daily users"
      'YOUR BEST PROJECT OR AWARD',                 // e.g. "Built QueueLens, an open-source Kafka CLI with 400+ GitHub stars"
      'YOUR CORE STACK',                            // e.g. "Python, Go, React, PostgreSQL, Docker, AWS"
    ],
    closing: "I thrive in fast-paced startup teams where you own the problem from architecture to deployment, and I'd love to contribute to what you're building.",
    links: {
      Portfolio: 'https://YOUR-PORTFOLIO.example',  // delete any line you don't have
      GitHub: 'https://github.com/YOUR-USERNAME',
      LinkedIn: 'https://www.linkedin.com/in/YOUR-PROFILE',
    },
  };
  // ======================================================================================================

  const CONFIG = {
    dryRun: false,          // true: fill the message and answers, but never press Apply
    maxApplications: 25,    // stop after this many applications in one run
    maxAgeDays: 7,          // skip jobs posted longer ago than this
    skipTitles: [],         // skip jobs whose title contains any of these words, e.g. ['senior', 'staff', 'manager']
    maxEmptyScrolls: 10,    // stop after scrolling this many times without finding new jobs
  };

  // Refuse to run with placeholders: a message that says "YOUR FULL NAME" would be sent to real companies.
  const unfilled = JSON.stringify(ME).match(/YOUR[ -][A-Z]|YOUR-USERNAME|YOUR-PROFILE|YOUR-PORTFOLIO/);
  if (unfilled) {
    console.log('%c✋ Fill in the YOUR DETAILS block at the top of the script first (name, intro, highlights, links), then paste it again.', 'color: #F59E0B; font-size: 14px; font-weight: bold;');
    return;
  }

  const delay = (ms) => new Promise((res) => setTimeout(res, ms));
  const stopped = () => window.wellfoundStop === true;
  window.wellfoundStop = false;

  const waitForElement = async (selector, timeout = 5000) => {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const el = document.querySelector(selector);
      if (el) return el;
      await delay(100);
    }
    return null;
  };

  // Skip jobs older than CONFIG.maxAgeDays.
  const isJobRecent = (modal) => {
    const cutoff = Date.now() - CONFIG.maxAgeDays * 24 * 60 * 60 * 1000;
    for (const el of modal.querySelectorAll('time[datetime], [data-test*="time"], [data-test*="date"]')) {
      const dateTime = el.getAttribute('datetime');
      if (dateTime && new Date(dateTime).getTime() < cutoff) return false;
    }
    const text = modal.textContent.toLowerCase();
    const weeks = text.match(/(\d+)\s*(?:week|w)\b/);
    const days = text.match(/(\d+)\s*(?:day|d)(?:\s|ago)/);
    if (weeks && parseInt(weeks[1], 10) * 7 > CONFIG.maxAgeDays) return false;
    if (days && parseInt(days[1], 10) > CONFIG.maxAgeDays) return false;
    return true;
  };

  // The message, with the company name when Wellfound shows one.
  const buildApplicationText = (companyName) => {
    const greeting = companyName ? `Hey ${companyName} team,` : 'Hey team,';
    const highlights = ME.highlights.filter(Boolean).map((h) => `• ${h}`).join('\n');
    const links = Object.entries(ME.links).filter(([, url]) => url).map(([label, url]) => `${label}: ${url}`).join('\n');
    return [greeting, `I'm ${ME.name}, ${ME.pitch}.`, highlights && `Quick highlights of my work:\n${highlights}`, ME.closing, links, `Best,\n${ME.name}`].filter(Boolean).join('\n\n');
  };

  // Native setter so React registers the textarea change.
  const setReactInputValue = (element, value) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
    if (setter) setter.call(element, value);
    else element.value = value;
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  };

  const handleRelocationQuestion = async () => {
    try {
      const firstRadio = document.querySelector('input[name="qualification.location.action"]');
      if (firstRadio) firstRadio.click();
      const dropdown = document.querySelector('#form-input--qualification\\.location\\.locationId .select__control') || document.querySelector('#form-input--qualification.location.locationId .select__control');
      if (dropdown) {
        dropdown.click();
        await delay(500);
        const firstOption = document.querySelector('.select__menu-list div');
        if (firstOption) firstOption.click();
        await delay(1500);
        return true;
      }
    } catch (err) {
      console.log('%c❌ Error handling the relocation question', 'color: red', err);
    }
    return false;
  };

  // Wellfound's radio questions: middle option of three ("Intermediate"), first of two ("Yes").
  const handleCustomQuestions = () => {
    document.querySelectorAll('[data-test^="RadioGroup-customQuestionAnswers"]').forEach((group) => {
      const options = group.querySelectorAll('input[type="radio"]');
      if (options.length === 3) options[1].click();
      else if (options.length === 2) options[0].click();
    });
  };

  const extractCompanyName = (modal) => {
    const el = modal?.querySelector('[data-test*="CompanyName"], a[href^="/company/"] h2, a[href^="/company/"] span');
    const name = el?.textContent?.trim();
    return name && name.length < 40 ? name : null;
  };
  const extractTitle = (modal) => modal?.querySelector('h1, h2, [data-test*="JobTitle"]')?.textContent?.trim() || '';

  const closeModal = async () => {
    const closeBtn = await waitForElement('button[data-test="closeButton"]');
    if (closeBtn) closeBtn.click();
    await delay(700);
  };

  const applied = [];
  const counts = { skipped: 0, old: 0, filtered: 0 };
  const processed = new Set();

  console.log(`%c🚀 Starting Wellfound auto-apply for ${ME.name}${CONFIG.dryRun ? ' (dry run: nothing is submitted)' : ''}... Type  window.wellfoundStop = true  to stop.`, 'color: #10B981; font-size: 14px; font-weight: bold;');

  const processBatch = async () => {
    const buttons = [...document.querySelectorAll('button[data-test="LearnMoreButton"]')].filter((b) => !processed.has(b));
    if (!buttons.length) return false;

    for (const learnMore of buttons) {
      if (stopped() || applied.length >= CONFIG.maxApplications) return true;
      processed.add(learnMore);
      learnMore.scrollIntoView({ behavior: 'smooth', block: 'center' });
      await delay(400);
      learnMore.click();

      const applyBtn = await waitForElement('button[data-test="JobDescriptionSlideIn--SubmitButton"]');
      if (!applyBtn) {
        console.log('%c❌ The job panel did not load: skipping', 'color: red');
        counts.skipped++;
        continue;
      }
      const modal = document.querySelector('[data-test*="JobDescriptionSlideIn"], [role="dialog"]');
      const company = extractCompanyName(modal);
      const title = extractTitle(modal);
      const label = [title, company].filter(Boolean).join(' @ ') || 'this job';

      if (CONFIG.skipTitles.some((w) => title.toLowerCase().includes(String(w).toLowerCase()))) {
        console.log(`%c⏭️ Skipping ${label}: title filter`, 'color: gray');
        counts.filtered++;
        await closeModal();
        continue;
      }
      if (modal && !isJobRecent(modal)) {
        console.log(`%c⏭️ Skipping ${label}: older than ${CONFIG.maxAgeDays} days`, 'color: gray');
        counts.old++;
        await closeModal();
        continue;
      }
      if (applyBtn.disabled && !(await handleRelocationQuestion())) {
        console.log(`%c⏭️ Skipping ${label}: the Apply button stays disabled (custom form)`, 'color: gray');
        counts.skipped++;
        await closeModal();
        continue;
      }

      handleCustomQuestions();
      const textarea = document.querySelector('textarea:not([disabled])');
      if (textarea) setReactInputValue(textarea, buildApplicationText(company));

      await delay(1000);
      if (CONFIG.dryRun) {
        console.log(`%c📝 Dry run: message filled for ${label}, not submitted`, 'color: #A855F7');
      } else {
        applyBtn.click();
        await delay(3000);
        console.log(`%c✅ Applied: ${label} (total ${applied.length + 1})`, 'color: #14B8A6; font-weight: bold;');
      }
      applied.push({ job: title || '(no title)', company: company || '', submitted: !CONFIG.dryRun, at: new Date().toLocaleTimeString() });
      await closeModal();
      await delay(500);
    }
    return true;
  };

  for (let emptyScrolls = 0; emptyScrolls < CONFIG.maxEmptyScrolls && !stopped() && applied.length < CONFIG.maxApplications; ) {
    if (await processBatch()) {
      emptyScrolls = 0;
    } else {
      window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
      console.log('%c📜 Scrolling to load more jobs...', 'color: darkcyan');
      emptyScrolls++;
      await delay(2500);
    }
  }

  console.log(`%c🎉 Done${stopped() ? ' (stopped by you)' : applied.length >= CONFIG.maxApplications ? ` (reached ${CONFIG.maxApplications} applications)` : ''}.`, 'color: limegreen; font-size: 16px; font-weight: bold;');
  if (applied.length) console.table(applied);
  console.log(`📌 ${CONFIG.dryRun ? 'Filled (dry run)' : 'Applied'}: ${applied.length} · skipped (custom forms): ${counts.skipped} · older than ${CONFIG.maxAgeDays} days: ${counts.old} · title filter: ${counts.filtered}`);
})();
