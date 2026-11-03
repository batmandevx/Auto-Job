(async () => {
  const delay = (ms) => new Promise((res) => setTimeout(res, ms));

  const waitForElement = async (selector, timeout = 5000) => {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const el = document.querySelector(selector);
      if (el) return el;
      await delay(100);
    }
    return null;
  };

  // Skip jobs older than 7 days
  const isJobRecent = (modal) => {
    const oneWeekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const timeElements = modal.querySelectorAll(
      'time[datetime], [data-test*="time"], [data-test*="date"]'
    );

    for (const el of timeElements) {
      const dateTime = el.getAttribute("datetime");
      if (dateTime) {
        const jobDate = new Date(dateTime).getTime();
        if (jobDate < oneWeekAgo) return false;
      }
    }

    const textContent = modal.textContent.toLowerCase();
    const weekMatch = textContent.match(/(\d+)\s*(?:week|w)/);
    const dayMatch = textContent.match(/(\d+)\s*(?:day|d)(?:\s|ago)/);

    if (weekMatch && parseInt(weekMatch[1], 10) >= 1) return false;
    if (dayMatch && parseInt(dayMatch[1], 10) > 7) return false;

    return true;
  };

  // Generates a customized pitch (dynamically injects company name if detected)
  const buildApplicationText = (companyName) => {
    const greeting = companyName ? `Hey ${companyName} team,` : `Hey team,`;
    return `${greeting}

I'm Ayush Upadhyay, an AI/ML & Full-Stack Engineer (B.Tech CSE - AI & ML at VIT Chennai) who loves building and shipping high-impact systems from 0 to 1.

Quick highlights of my work:
• Applied Scientist Intern @ Microsoft (MSIDC): Engineered recommendation systems and production model optimizations at scale.
• Proven Builder: Built NeuroDrive (Edge AI for EV fault detection — 2nd Place at Tata Technologies InnoVent), AuraTwin (3D Gaussian Splatting spatial platform — AWS 10,000 AIdeas Semi-Finalist), and Crisp Roots (Agri-AI with IIT Ropar — Annam AI Hackathon Winner).
• Full-Stack & AI Execution: Deep hands-on experience across Python, PyTorch, C++, CUDA, OpenCV, RAG/Agentic workflows, and React / Next.js / TypeScript / AWS.

I thrive in fast-paced startup environments where you own the problem from architecture to deployment, and I'd love to contribute to what you're building.

🔗 Portfolio: https://ayushzupadhyay.netlify.app/
💻 GitHub: https://github.com/batmandevx
💼 LinkedIn: https://www.linkedin.com/in/ayushdevai/

Best,
Ayush Upadhyay`;
  };

  // Native setter to ensure React 18+ registers textarea changes reliably
  const setReactInputValue = (element, value) => {
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      "value"
    )?.set;
    if (nativeInputValueSetter) {
      nativeInputValueSetter.call(element, value);
    } else {
      element.value = value;
    }
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  };

  let appliedCount = 0;
  let skippedCount = 0;
  let oldJobSkippedCount = 0;
  let scrollCount = 0;
  const processedButtons = new Set();

  console.log(
    "%c🚀 Starting Ayush's Smart Auto-Apply on Wellfound...",
    "color: #10B981; font-size: 14px; font-weight: bold;"
  );

  const handleRelocationQuestion = async () => {
    try {
      const firstRadio = document.querySelector(
        'input[name="qualification.location.action"]'
      );
      if (firstRadio) firstRadio.click();

      const dropdownContainer = document.querySelector(
        "#form-input--qualification.location.locationId .select__control"
      );
      if (dropdownContainer) {
        dropdownContainer.click();
        await delay(500);
        const firstOption = document.querySelector(".select__menu-list div");
        if (firstOption) firstOption.click();
        await delay(1500);
        return true;
      }
    } catch (err) {
      console.log("%c❌ Error handling relocation question", "color: red", err);
    }
    return false;
  };

  const handleCustomQuestions = () => {
    const allGroups = document.querySelectorAll(
      '[data-test^="RadioGroup-customQuestionAnswers"]'
    );
    allGroups.forEach((group) => {
      const options = group.querySelectorAll('input[type="radio"]');
      if (options.length === 3) {
        options[1].click(); // Intermediate / Mid option
      } else if (options.length === 2) {
        options[0].click(); // Yes / First option
      }
    });
  };

  const extractCompanyName = (modal) => {
    if (!modal) return null;
    const companyEl = modal.querySelector(
      '[data-test*="CompanyName"], a[href^="/company/"] h2, a[href^="/company/"] span'
    );
    const name = companyEl?.textContent?.trim();
    return name && name.length < 40 ? name : null;
  };

  const processBatch = async () => {
    let buttons = [
      ...document.querySelectorAll('button[data-test="LearnMoreButton"]'),
    ];
    buttons = buttons.filter((btn) => !processedButtons.has(btn));

    if (buttons.length === 0) return false;

    for (const learnMoreBtn of buttons) {
      processedButtons.add(learnMoreBtn);
      learnMoreBtn.scrollIntoView({ behavior: "smooth", block: "center" });
      await delay(400);
      learnMoreBtn.click();

      console.log(
        `%c🔍 [${appliedCount + skippedCount + oldJobSkippedCount + 1}] Opened job modal...`,
        "color: dodgerblue"
      );

      const applyBtn = await waitForElement(
        'button[data-test="JobDescriptionSlideIn--SubmitButton"]'
      );
      if (!applyBtn) {
        console.log("%c❌ Modal failed to load — skipping", "color: red");
        skippedCount++;
        continue;
      }

      const modal = document.querySelector(
        '[data-test*="JobDescriptionSlideIn"], [role="dialog"]'
      );

      if (modal && !isJobRecent(modal)) {
        console.log("%c⏭️ Skipping — Job older than 1 week", "color: gray");
        oldJobSkippedCount++;
        const closeBtn = await waitForElement('button[data-test="closeButton"]');
        if (closeBtn) closeBtn.click();
        await delay(600);
        continue;
      }

      if (applyBtn.disabled) {
        const isFormFilled = await handleRelocationQuestion();
        if (!isFormFilled) {
          console.log("%c⏭️ Apply button is disabled — skipping", "color: gray");
          const closeBtn = await waitForElement('button[data-test="closeButton"]');
          if (closeBtn) closeBtn.click();
          skippedCount++;
          await delay(600);
          continue;
        }
      }

      handleCustomQuestions();

      const companyName = extractCompanyName(modal);
      const textarea = document.querySelector("textarea:not([disabled])");
      if (textarea) {
        setReactInputValue(textarea, buildApplicationText(companyName));
        console.log(
          `%c📝 Autofilled pitch${companyName ? ` for ${companyName}` : ""}`,
          "color: #A855F7"
        );
      }

      await delay(1000);
      applyBtn.click();
      await delay(3000);

      appliedCount++;
      console.log(
        `%c✅ Applied successfully! (Total: ${appliedCount})`,
        "color: #14B8A6; font-weight: bold;"
      );

      const closeBtn = await waitForElement('button[data-test="closeButton"]');
      if (closeBtn) closeBtn.click();
      await delay(1200);
    }

    return true;
  };

  const maxScrolls = 10;
  while (scrollCount < maxScrolls) {
    const found = await processBatch();
    if (!found) {
      window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
      console.log("%c📜 Scrolling to load more jobs...", "color: darkcyan");
      scrollCount++;
      await delay(2500);
    } else {
      scrollCount = 0;
    }
  }

  console.log(
    "%c🎉 Auto-apply run complete!",
    "color: limegreen; font-size: 16px; font-weight: bold;"
  );
  console.log(`📌 Jobs Applied: ${appliedCount}`);
  console.log(`📌 Jobs Skipped (custom forms/disabled): ${skippedCount}`);
  console.log(`📌 Jobs Skipped (older than 1 week): ${oldJobSkippedCount}`);
})();
