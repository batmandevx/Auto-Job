// Injected into every frame of the job page by the side panel.
// Exposes window.__jobfill: scan / fill / upload / next / submit helpers. Never submits on its own.
(() => {
  if (window.__jobfill?.version === 8) return;

  const SKIP_TYPES = new Set(['hidden', 'submit', 'button', 'reset', 'image', 'password']);
  const clean = (s) => (s || '').replace(/[\u200B-\u200D\u2060\uFEFF]/g, '').replace(/\s+/g, ' ').trim(); // zero-width padding (PyjamaHR) is not text
  const norm = (s) => clean(s).toLowerCase().replace(/[^a-z0-9+ ]/g, '').trim();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---------- DOM access, including open shadow roots ----------
  function deepAll(selector, root = document) {
    const out = [...root.querySelectorAll(selector)];
    for (const el of root.querySelectorAll('*')) if (el.shadowRoot) out.push(...deepAll(selector, el.shadowRoot));
    return out;
  }
  const rootOf = (el) => el.getRootNode?.() || document;
  const byIdIn = (el, id) => rootOf(el).getElementById?.(id) || document.getElementById(id);

  const shown = (el) => {
    if (!el.isConnected) return false;
    const st = getComputedStyle(el);
    return st.visibility !== 'hidden' && st.display !== 'none' && el.getClientRects().length > 0;
  };
  // Native radios / checkboxes / file inputs are often hidden behind custom UI; judge them by their label.
  const usable = (el) => {
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') return false;
    if (['radio', 'checkbox', 'file'].includes(el.type)) return shown(el) || [...(el.labels || [])].some(shown) || shown(el.parentElement);
    // Read-only inputs are usually display-only, except date pickers, which are read-only so you use the calendar.
    const datePicker = el.readOnly && /date|calendar|picker/i.test(`${el.className} ${el.placeholder} ${el.id} ${el.name}`) || /(dd|mm|yy)/i.test(el.placeholder || '');
    return shown(el) && !(el.readOnly && el.getAttribute('role') !== 'combobox' && !datePicker);
  };

  const CONTROL = 'input, select, textarea, [contenteditable="true"], [role="combobox"], [role="radio"], [role="checkbox"], [role="switch"], [role="listbox"], button[aria-haspopup="listbox"]';

  const textOf = (node) => {
    if (!node) return '';
    const copy = node.cloneNode(true);
    copy.querySelectorAll('input, select, textarea, script, style, option, [role="listbox"], [role="option"], svg').forEach((n) => n.remove());
    return clean(copy.textContent);
  };

  // The question text for a control: explicit labels first, then the nearest container that holds only this control.
  function labelFor(el) {
    const ids = el.getAttribute('aria-labelledby');
    if (ids) {
      const t = clean(ids.split(/\s+/).map((id) => textOf(byIdIn(el, id))).join(' '));
      if (t) return t;
    }
    if (el.labels?.length) {
      const t = clean([...el.labels].map(textOf).join(' '));
      if (t) return t;
    }
    if (el.getAttribute('aria-label')) return clean(el.getAttribute('aria-label'));
    let node = el.parentElement;
    let best = '';
    for (let i = 0; node && i < 6; i++, node = node.parentElement) {
      if ([...node.querySelectorAll(CONTROL)].filter((c) => c !== el && !el.contains(c)).length > 0 && best) break;
      const t = textOf(node);
      if (t) best = t;
      if (best.length > 2) break;
    }
    return (best || clean(el.placeholder || el.name || el.id)).slice(0, 300);
  }

  function groupLabel(members) {
    const first = members[0];
    const fs = first.closest('fieldset');
    if (fs?.querySelector('legend')) return textOf(fs.querySelector('legend'));
    const rg = first.closest('[role="radiogroup"], [role="group"]');
    if (rg?.getAttribute('aria-labelledby')) return textOf(byIdIn(rg, rg.getAttribute('aria-labelledby').split(' ')[0]));
    if (rg?.getAttribute('aria-label')) return clean(rg.getAttribute('aria-label'));
    let node = first.parentElement;
    while (node && !members.every((m) => node.contains(m))) node = node.parentElement;
    for (let i = 0; node && i < 4; i++, node = node.parentElement) {
      let t = textOf(node);
      for (const m of members) t = t.replace(optionLabel(m), '');
      t = clean(t);
      if (t.length > 1) return t.slice(0, 300);
    }
    return clean(first.name);
  }

  const optionLabel = (el) => {
    if (el.tagName === 'INPUT') return clean(el.labels?.[0] ? textOf(el.labels[0]) : el.getAttribute('aria-label') || el.value);
    return clean(el.getAttribute('aria-label') || el.textContent);
  };

  const isRequired = (el, label) => el.required || el.getAttribute('aria-required') === 'true' || /\*\s*$|\(required\)/i.test(label);

  // A country-code box or prefix next to a phone input ("+91", a dial-code dropdown).
  function codeBeside(el) {
    let n = el.parentElement;
    for (let i = 0; n && i < 3; i++, n = n.parentElement) {
      if (n.querySelectorAll('input:not([type=hidden]), textarea').length > 2) break;
      const others = [...n.querySelectorAll('*')].filter((x) => x !== el && !x.contains(el) && shown(x));
      if (others.some((x) => (x.tagName === 'SELECT' ? /\+\d{1,4}/.test(x.selectedOptions[0]?.text || '') : /^\+\d{1,4}$/.test(clean(x.tagName === 'INPUT' ? x.value : x.childElementCount ? '' : x.textContent))))) return true;
    }
    return false;
  }
  // CAPTCHAs are left to you: they exist to check that a person is applying.
  const CAPTCHA_RE = /captcha|text (you see )?in the image|characters (you see|shown)|security code shown|type the (text|characters)/i;
  function captchaFields() {
    return deepAll('input:not([type=hidden])').filter((e) => shown(e) && CAPTCHA_RE.test(`${labelFor(e)} ${e.placeholder} ${e.name} ${e.id}`));
  }
  // Account passwords are yours to type (Chrome can suggest a strong one); point at the empty one.
  function focusPassword() {
    const el = deepAll('input[type="password"]').find((e) => shown(e) && !e.value);
    if (!el) return { waiting: false };
    el.scrollIntoView({ block: 'center' });
    mark(el, true);
    el.focus();
    return { waiting: true, count: deepAll('input[type="password"]').filter((e) => shown(e) && !e.value).length };
  }
  function focusCaptcha() {
    const el = captchaFields().find((e) => !clean(e.value));
    if (!el) return { waiting: false };
    el.scrollIntoView({ block: 'center' });
    mark(el, true);
    el.focus();
    return { waiting: true, label: labelFor(el).slice(0, 80) };
  }

  // Not part of an application: the site's search box, menus, and "Save job" / "Share" toggles.
  const CHROME_LABEL = /^(save|saved|save job|save this job|bookmark|follow|share|like|favou?rite|search|keywords?)\b/i;
  function siteChrome(el) {
    if (el.closest('[role="search"], nav, header, footer, [role="navigation"], [role="banner"]')) return true;
    // A search-looking input is the site's search only when its question is a search too: Workday's
    // "How Did You Hear About Us?" prompt is a "searchBox" input under a real question.
    if (el.tagName === 'INPUT' && (el.type === 'search' || el.getAttribute('role') === 'searchbox' || /search/i.test(`${el.placeholder} ${el.name} ${el.id} ${el.getAttribute('aria-label') || ''}`))) return /^(search|keywords?|find|what|where)\b|search/i.test(labelFor(el));
    return el.tagName === 'BUTTON' && CHROME_LABEL.test(btnText(el));
  }

  // "How did you hear about us?": your usual source, in order of preference.
  const HEAR_RE = /how did you (hear|find|learn|come)|where did you (hear|find|see)|(source|referral source)\s*(of\s*(application|referral|hire))?$|how did you (come|get) to know|hear about (us|this)|know about (the|this) (opportunity|job|role|position)/i;
  const SOURCE_LADDER = ['linkedin', 'linked in', 'linkedin jobs', 'company website', 'careers website', 'career site', 'company career site', 'corporate website', 'careers page', 'job board', 'job boards', 'online job board', 'job site', 'social media', 'social network', 'internet', 'online', 'website', 'other'];
  function ladderIndex(texts, ladder) {
    const n = texts.map(norm);
    for (const w of ladder) {
      const j = n.findIndex((t) => t === w || t.startsWith(`${w} `) || t.includes(w));
      if (j >= 0) return j;
    }
    return -1;
  }

  // Split date boxes (Workday "MM" / "YYYY" sections): each gets only its part of the date.
  function dateSection(el) {
    if (el.tagName !== 'INPUT') return null;
    const sig = `${el.getAttribute('data-automation-id') || ''} ${el.getAttribute('aria-label') || ''}`;
    const ph = clean(el.placeholder).toUpperCase();
    if (/dateSectionMonth|^\s*month\s*$/i.test(sig) || ph === 'MM') return 'month';
    if (/dateSectionYear|^\s*year\s*$/i.test(sig) || ph === 'YYYY' || ph === 'YY') return 'year';
    if (/dateSectionDay|^\s*day\s*$/i.test(sig) || ph === 'DD') return 'day';
    return null;
  }
  const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  function datePart(value, part) {
    const v = String(value || '').trim().toLowerCase();
    if (!v || /present|current|now|ongoing/.test(v)) return '';
    let y = (v.match(/\b(19|20)\d{2}\b/) || [''])[0];
    let m = '';
    let d = '';
    const iso = v.match(/^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?/);
    const mmyy = v.match(/^(\d{1,2})[/.\-](\d{4})$/);
    const dmy = v.match(/^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4})$/);
    if (iso) [, y, m, d] = iso;
    else if (mmyy) [, m, y] = mmyy;
    else if (dmy) [, d, m, y] = dmy;
    else {
      const name = MONTHS.findIndex((x) => v.includes(x));
      if (name >= 0) m = String(name + 1);
    }
    const out = { year: y, month: m && String(m).padStart(2, '0'), day: d && String(d).padStart(2, '0') }[part];
    return out || '';
  }
  // The question for a date box ("To"), not its section name ("Month").
  function dateGroupLabel(el) {
    let n = el.parentElement;
    for (let i = 0; n && i < 7; i++, n = n.parentElement) {
      const t = clean(textOf(n).replace(/\b(MM|DD|YYYY|YY|month|year|day)\b/gi, '').replace(/current value is\s*\S*/gi, '').replace(/[/\-]/g, ' '));
      if (t.length > 1) return t.slice(0, 120);
    }
    return labelFor(el);
  }
  // Leaving a box the way a person does: React 17+ (Workday) listens for focusout, older code for blur / change.
  function leave(el) {
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    el.dispatchEvent(new FocusEvent('blur'));
    el.blur();
  }
  // Replace the box's text through the browser's own editing (what a paste does): fires trusted input events.
  function insertText(el, text) {
    try {
      el.focus();
      if (typeof el.select === 'function') el.select();
      const ok = document.execCommand('insertText', false, text);
      return ok && el.value === text;
    } catch {
      return false;
    }
  }
  function caretToEnd(el) {
    try {
      const n = el.value.length;
      el.setSelectionRange?.(n, n);
      if (el.tagName === 'TEXTAREA') el.scrollTop = el.scrollHeight;
    } catch {
      // number / email inputs have no selection
    }
  }
  // Keys one at a time, for widgets that ignore pasted values.
  async function typeChars(el, text) {
    el.focus();
    el.click();
    setNativeValue(el, '');
    for (const ch of String(text)) {
      // Split date boxes move the cursor on their own (MM -> YYYY); insertText types into whatever has
      // focus, so put it back first or a month digit ends up in the year ("05" -> 2005).
      if (document.activeElement !== el) el.focus();
      el.dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keypress', { key: ch, bubbles: true }));
      caretToEnd(el);
      let typed = false;
      try {
        typed = document.activeElement === el && document.execCommand('insertText', false, ch) && el.value.endsWith(ch);
      } catch {
        typed = false;
      }
      if (!typed) {
        const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, el.value + ch);
        el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ch }));
      }
      el.dispatchEvent(new KeyboardEvent('keyup', { key: ch, bubbles: true }));
      await sleep(25);
    }
    caretToEnd(el);
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function searchQueries(v, label) {
    const base = v.split(/\s*[(,]/)[0].trim();
    const words = base.split(/\s+/);
    const acronym = words.filter((w) => /^[A-Z]/.test(w) && !/^(of|and|the|for)$/i.test(w)).map((w) => w[0]).join('');
    const school = /school|university|college|institut/i.test(label);
    const q = [v, base];
    if (school && acronym.length >= 2) q.push(`${acronym} University`, acronym);
    if (!school && words.length > 2) q.push(words.slice(0, 2).join(' ')); // "Computer Science and Engineering" -> "Computer Science"
    return [...new Set(q.filter((x) => x && x.length > 1))];
  }
  async function searchWithEnter(el, v) {
    const label = labelFor(el);
    for (const q of searchQueries(v, label)) {
      await typeInto(el, q);
      press(el, 'Enter');
      const opts = (await waitOptions(el, 2500)).filter((o) => !/^(no items|no results|no matches)/i.test(clean(o.textContent)));
      const texts = optionTexts(opts);
      let i = bestMatch(texts, v);
      if (i < 0 || scoreOption(texts[i], v) < 55) i = bestMatch(texts, q);
      if (i >= 0 && scoreOption(texts[i], q) >= 55) return { opts, i };
    }
    // Your school isn't listed: the page's own fallback ("School Not Listed", "Other"…).
    if (/school|university|college|institut/i.test(label)) {
      for (const q of ['School Not Listed', 'Not Listed', 'Other']) {
        await typeInto(el, q);
        press(el, 'Enter');
        const opts = await waitOptions(el, 2500);
        const i = optionTexts(opts).findIndex((t) => /^(school )?not listed|^others?\b|^none of the above/i.test(t));
        if (i >= 0) return { opts, i, other: true };
      }
    }
    return null;
  }

  // ---------- scan ----------
  let counter = 0;
  const groups = new Map(); // field id -> member elements (radio / checkbox groups, button groups)
  const newId = (el) => (el.dataset.jfId ||= `f${++counter}_${Math.random().toString(36).slice(2, 6)}`);

  const comboKind = (el) => {
    if (el.dataset?.jfCustom === '1') return 'dropdown'; // a div-based "Search & Select" dropdown found by customDropdowns()
    if (el.matches('button[aria-haspopup="listbox"], [role="combobox"]:not(input)')) return 'dropdown'; // click-to-open list
    if (el.matches('input[role="combobox"], input[aria-autocomplete]')) return el.readOnly || el.getAttribute('aria-readonly') === 'true' ? 'dropdown' : 'combobox';
    return null;
  };

  // Open a custom dropdown just long enough to read its options.
  async function probeOptions(el) {
    open(el);
    const opts = await waitOptions(el, 900);
    const texts = [...new Set(opts.map((o) => clean(o.textContent)).filter(Boolean))].slice(0, 250);
    close(el);
    return texts;
  }

  const OPTION_SEL = '[role="option"], .select__option, [class*="option" i][id*="option"], [data-automation-id="promptOption"], li[data-value], .pac-item';
  // Options that belong to this control: its aria-controls list, else a list inside the field's own container,
  // else (menus rendered at the end of <body>) any visible list on the page.
  const visibleOptions = () => deepAll(OPTION_SEL).filter((o) => shown(o) && !o.closest('select'));
  // The list a control opened, remembered from "options that appeared when I clicked it".
  const openedList = new WeakMap();
  function optionNodes(el) {
    const ok = (o) => shown(o) && !o.closest('select') && o.getAttribute('aria-disabled') !== 'true';
    const mine = openedList.get(el);
    if (mine?.isConnected && shown(mine)) {
      const own = [...mine.querySelectorAll(OPTION_SEL)].filter(ok);
      if (own.length) return own;
      const rows = genericRows(mine);
      if (rows.length) return rows;
    }
    const ctl = el.getAttribute('aria-controls') || el.getAttribute('aria-owns');
    const list = ctl && byIdIn(el, ctl);
    if (list) return [...list.querySelectorAll(OPTION_SEL)].filter(ok);
    let box = el.parentElement;
    for (let i = 0; box && i < 4; i++, box = box.parentElement) {
      const own = [...box.querySelectorAll(OPTION_SEL)].filter(ok);
      if (own.length) return own;
      if (box.querySelectorAll('[data-jf-id]').length > 2) break; // reached a container of several fields
    }
    return deepAll(OPTION_SEL).filter(ok).filter((o) => !o.closest('[data-jf-owner]') || o.closest('[data-jf-owner]') === el);
  }
  const listOpen = (el) => optionNodes(el).length > 0;

  // Rows of a popup that uses no option markup (<div class="opt">, <li>…): the largest group of sibling
  // elements with short visible text, excluding the popup's own search box.
  function genericRows(container) {
    if (!container?.isConnected || !shown(container)) return [];
    const leaves = [...container.querySelectorAll('*')].filter((n) => {
      if (!shown(n) || n.matches('input, textarea, select, button[aria-label*="clear" i], svg, path')) return false;
      const t = clean(n.innerText);
      if (!t || t.length > 100) return false;
      return ![...n.children].some((c) => clean(c.innerText) === t && shown(c)); // the innermost element carrying the text
    });
    const byParent = new Map();
    for (const n of leaves) {
      const key = n.parentElement;
      if (!byParent.has(key)) byParent.set(key, []);
      byParent.get(key).push(n);
    }
    let best = [];
    for (const rows of byParent.values()) if (rows.length > best.length) best = rows;
    return best.length >= 2 || (best.length === 1 && leaves.length === 1) ? best : [];
  }

  async function waitOptions(el, ms) {
    const end = Date.now() + ms;
    let opts = [];
    while (Date.now() < end) {
      // Options that weren't there before this control was opened belong to it.
      if (el._jfBefore) {
        const fresh = visibleOptions().filter((o) => !el._jfBefore.has(o));
        if (fresh.length) openedList.set(el, fresh[0].closest('[role="listbox"], ul, [class*="menu" i], [class*="dropdown" i], [class*="options" i]') || fresh[0].parentElement);
        else if (!openedList.get(el)?.isConnected && el._jfAppeared?.length) {
          // No option markup: the largest new visible element is the popup.
          const pop = el._jfAppeared.filter((n) => n.isConnected && shown(n) && !n.contains(el) && clean(n.innerText)).sort((a, b) => b.querySelectorAll('*').length - a.querySelectorAll('*').length)[0];
          if (pop && genericRows(pop).length) openedList.set(el, pop);
        }
      }
      opts = optionNodes(el);
      if (opts.length) {
        await sleep(120); // async lists keep adding rows for a moment
        return optionNodes(el);
      }
      await sleep(80);
    }
    return opts;
  }

  // An "outside click", the way most dropdown libraries listen for one.
  function clickOutside() {
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      document.body.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window, clientX: 1, clientY: 1 }));
    }
  }
  // Another field's list left open would hand its options to this one: shut everything first.
  function closeOtherLists(el) {
    const ours = [...lastOpened.keys()].filter((t) => t !== el && t.isConnected && openedList.get(t)?.isConnected && shown(openedList.get(t)));
    if (!visibleOptions().length && !ours.length) return;
    const esc = { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true };
    (document.activeElement || document.body).dispatchEvent(new KeyboardEvent('keydown', esc));
    document.dispatchEvent(new KeyboardEvent('keydown', esc));
    if (visibleOptions().length) clickOutside();
    for (const t of ours) if (listOpen(t) && t.tagName !== 'INPUT') t.click();
  }
  const lastOpened = new Map(); // trigger -> opened at

  // Toggle-style dropdowns close when clicked while open, so only click when the list isn't showing.
  function open(el) {
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    closeOtherLists(el);
    el.focus();
    if (listOpen(el) && openedList.get(el)?.isConnected) return;
    const before = new Set(visibleOptions());
    // Record what this click adds or reveals: that is the dropdown's popup, whatever its markup.
    el._jfAppeared = [];
    el._jfObserver?.disconnect();
    el._jfObserver = new MutationObserver((muts) => {
      for (const m of muts) {
        if (m.type === 'childList') for (const n of m.addedNodes) if (n.nodeType === 1) el._jfAppeared.push(n);
        if (m.type === 'attributes' && m.target.nodeType === 1 && m.target !== el && !m.target.contains(el)) el._jfAppeared.push(m.target);
      }
    });
    el._jfObserver.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'style', 'hidden', 'aria-hidden', 'aria-expanded'] });
    setTimeout(() => el._jfObserver?.disconnect(), 2500);
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
    }
    if (el.tagName === 'INPUT') el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40, bubbles: true }));
    lastOpened.set(el, Date.now());
    el._jfBefore = before; // waitOptions uses it to see which list is new
  }
  function close(el) {
    const esc = { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true };
    el.dispatchEvent(new KeyboardEvent('keydown', esc));
    document.dispatchEvent(new KeyboardEvent('keydown', esc));
    if (listOpen(el)) clickOutside();
    // Widgets that ignore Escape / outside clicks: toggle them shut with their own button.
    if (listOpen(el) && el.tagName !== 'INPUT') el.click();
    el.blur();
    el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
  }

  async function scan() {
    groups.clear();
    const fields = [];
    const seen = new Set();
    const all = deepAll(CONTROL);

    for (const el of all) {
      if (seen.has(el) || el.closest('[data-jf-ignore]') || siteChrome(el)) continue;
      const tag = el.tagName.toLowerCase();
      const role = el.getAttribute('role');
      const type = tag === 'input' ? (el.type || 'text').toLowerCase() : tag;
      if (tag === 'input' && SKIP_TYPES.has(type)) continue;
      if (role === 'listbox' && el.closest('[role="combobox"], select')) continue;
      // An open search popup next to its search box (Workday prompts) is part of that field, not a field of its own.
      if (role === 'listbox' && (el.querySelector('[data-automation-id="promptOption"]') || el.parentElement?.querySelector(':scope > input[role="combobox"], :scope > input[data-automation-id="searchBox"]'))) continue;
      if (role === 'option') continue;
      if (!usable(el)) continue;
      if (el.closest('[aria-hidden="true"]') && type !== 'file') continue;

      // Native radios / checkboxes, grouped by name.
      if (type === 'radio' || type === 'checkbox') {
        const scope = el.form || rootOf(el);
        const members = el.name ? [...scope.querySelectorAll(`input[type="${type}"][name="${CSS.escape(el.name)}"]`)].filter(usable) : [el];
        members.forEach((m) => seen.add(m));
        addChoice(fields, members, type);
        continue;
      }
      // ARIA radios / checkboxes / switches (div-based widgets).
      if (role === 'radio' || ((role === 'checkbox' || role === 'switch') && tag !== 'input')) {
        const group = el.closest('[role="radiogroup"], [role="group"]');
        const members = group ? [...group.querySelectorAll(`[role="${role}"]`)].filter(shown) : [el];
        members.forEach((m) => seen.add(m));
        addChoice(fields, members, role === 'radio' ? 'radio' : 'checkbox');
        continue;
      }

      const sectionPart = dateSection(el);
      const label = sectionPart ? `${dateGroupLabel(el)} (${sectionPart})` : labelFor(el);
      const id = newId(el);
      const f = { id, label, name: el.name || '', placeholder: el.placeholder || '', required: isRequired(el, label) };
      if (sectionPart) f.datePart = sectionPart;
      const kind = comboKind(el);
      if (kind) {
        f.type = kind;
        f.filled = !!clean(el.value || (kind === 'dropdown' ? selectedText(el) : ''));
        if (kind === 'dropdown' && !f.filled) f.options = await probeOptions(el);
      } else if (tag === 'select') {
        f.type = el.multiple ? 'select-multiple' : 'select';
        f.options = [...el.options].filter((o) => o.value !== '' && !/^(select|choose|please select|--)/i.test(clean(o.text))).map((o) => clean(o.text));
        f.filled = el.selectedIndex > 0 && el.options[el.selectedIndex]?.value !== '';
      } else if (el.isContentEditable) {
        f.type = 'textarea';
        f.filled = !!clean(el.textContent);
      } else if (role === 'listbox') {
        f.type = 'select';
        f.options = [...el.querySelectorAll('[role="option"]')].map((o) => clean(o.textContent));
        f.filled = !!el.querySelector('[aria-selected="true"]');
      } else if (tagInput(el, label)) {
        f.type = 'tags';
        f.filled = chipsOf(el).length > 0;
      } else {
        f.type = type;
        if (type === 'text' && dateLike(el, label)) f.format = dateFormatHint(el, label);
        f.maxLength = el.maxLength > 0 ? el.maxLength : undefined;
        if (type === 'number' || type === 'range') Object.assign(f, { min: el.min || undefined, max: el.max || undefined });
        if (['tel', 'text', 'number'].includes(type) && codeBeside(el)) f.codeBeside = true; // "+91 [__________]": enter the number without the code
        if (CAPTCHA_RE.test(`${label} ${el.placeholder} ${el.name} ${el.id}`)) f.type = 'captcha';
        if (type === 'file') {
          f.accept = el.accept || '';
          f.filled = el.files?.length > 0;
        } else f.filled = !!clean(el.value) && !LINK_RE.test(label) && !/required|must have a value|cannot be (empty|blank)/i.test(errorFor(el)); // link boxes are always set from your profile; a box the site calls empty isn't filled
      }
      if (editingCard?.box?.contains(el)) f.inEditor = true;
      fields.push(f);
    }

    // Div-based dropdowns with no role or <select> ("Search & Select", vue-multiselect, ng-select…).
    for (const el of customDropdowns()) {
      if (seen.has(el)) continue;
      seen.add(el);
      el.dataset.jfCustom = '1';
      const label = labelFor(el);
      const id = newId(el);
      const shownText = clean(el.innerText);
      const filled = !PLACEHOLDER_RE.test(shownText) && !!shownText;
      fields.push({ id, type: 'dropdown', label, required: isRequired(el, label), filled, options: filled ? [] : await probeOptions(el) });
    }

    // Yes/No style button groups (aria-pressed toggles).
    for (const grp of deepAll('[role="group"], [class*="button-group" i], [class*="btn-group" i]')) {
      const btns = [...grp.querySelectorAll('button[aria-pressed]')].filter((b) => shown(b) && !siteChrome(b));
      if (btns.length < 2 || btns.some((b) => seen.has(b))) continue;
      btns.forEach((b) => seen.add(b));
      addChoice(fields, btns, 'radio');
    }

    // A separate "Country Phone Code" field (Workday): the phone number goes in without the code.
    // ("Mobile Phone Number With Area Code" is the number itself, not the code box.)
    const CODE_BOX = /country\s*(phone\s*)?code|dial(l)?ing\s*code|phone\s*country|\bisd\b/i;
    if (fields.some((f) => CODE_BOX.test(f.label))) for (const f of fields) if (/phone|mobile|contact\s*(no|number)/i.test(f.label) && !CODE_BOX.test(f.label) && !/\bext/i.test(f.label)) f.codeBeside = true;
    // A full postal address (street + postal code on the page): every part comes from your profile together, even
    // when the site prefilled some of it from your resume (a Lucknow street with a Chennai city would be wrong).
    const ADDR = /street|address\s*(line)?\s*[12]?\b|^address\b|^city\b|^town\b|^state\b|province|postal|zip|pin\s*code|pincode/i;
    const base = (f) => String(f.label).split('›').pop();
    if (fields.some((f) => /street|address/i.test(base(f))) && fields.some((f) => /postal|zip|pin\s*code|pincode/i.test(base(f)))) for (const f of fields) if (ADDR.test(base(f)) && !/e-?mail|current location|city of birth/i.test(base(f))) f.filled = false;
    // Phone extensions are for office desk lines: never filled (and never asked of the AI).
    for (let i = fields.length - 1; i >= 0; i--) if (/phone\s*ext|^ext(ension)?\b|\bextension\b/i.test(fields[i].label) && !fields[i].required) fields.splice(i, 1);
    mergeSplitCodeBoxes(fields);
    labelRepeatedSections(fields);
    // Each Work Experience entry carries the company already in it, so answers go to that role even when the site's
    // own resume import put the entries in a different order than your profile.
    for (const f of fields) {
      if (!f.entry || !f.section) continue;
      const co = fields.find((x) => x.section === f.section && x.entry === f.entry && /company|employer|organi[sz]ation/i.test(base(x)) && !/title|position/i.test(base(x)));
      const shown = co && clean(readFieldValue(co.id));
      if (shown) f.entryCompany = shown.slice(0, 80);
    }
    return { url: location.href, fields, next: nextLabel(), submit: submitLabel(), errors: errorTexts(), checkEmail: checkEmailPage() };
  }

  // 6 single-character boxes ("Enter the code we sent you") -> one field the panel fills with the whole code.
  // A row of 4-8 small inputs ("Enter the code we sent you") -> one field the panel fills with the whole code.
  // Some widgets set maxlength=1; others (e.g. Oracle Cloud) enforce one digit in JavaScript, so size counts too.
  const codeBoxLike = (el) => {
    if (!el || el.tagName !== 'INPUT') return false;
    if (el.maxLength === 1) return true;
    const w = el.getBoundingClientRect().width;
    const hint = `${el.getAttribute('inputmode') || ''} ${el.autocomplete || ''} ${el.getAttribute('aria-label') || ''} ${el.name || ''} ${el.id || ''} ${el.className || ''}`;
    return w > 0 && w <= 72 && (/numeric|one-time-code|digit|otp|code|pin|passcode/i.test(hint) || el.maxLength > 0 && el.maxLength <= 2 || w <= 60);
  };
  function mergeSplitCodeBoxes(fields) {
    const single = fields.filter((f) => ['text', 'tel', 'number', 'password'].includes(f.type) && codeBoxLike(findById(f.id)));
    const byParent = new Map();
    for (const f of single) {
      const el = findById(f.id);
      // Boxes are siblings, or each sits in its own small wrapper: group by the nearest shared row.
      let row = el.parentElement;
      for (let i = 0; row && i < 3 && row.querySelectorAll('input').length < 4; i++) row = row.parentElement;
      if (!byParent.has(row)) byParent.set(row, []);
      byParent.get(row).push(f);
    }
    for (const [, group] of byParent) {
      if (group.length < 4 || group.length > 8) continue;
      const els = group.map((f) => findById(f.id));
      // Real code boxes sit on one line with similar sizes.
      const tops = els.map((e) => Math.round(e.getBoundingClientRect().top / 10));
      if (new Set(tops).size > 1) continue;
      const id = group[0].id;
      groups.set(id, els);
      const at = fields.indexOf(group[0]);
      for (const f of group) fields.splice(fields.indexOf(f), 1);
      fields.splice(at, 0, { id, type: 'otp-split', label: 'Verification code', count: group.length, required: true, filled: els.every((e) => e.value) });
    }
  }

  // Type a code into split boxes the way a person would; returns true only if every box really holds its digit.
  async function typeCode(boxes, code) {
    const chars = String(code).replace(/\s+/g, '').split('');
    const done = () => boxes.slice(0, chars.length).every((b, i) => b.value === chars[i]) || boxes.map((b) => b.value).join('') === chars.join('');
    // 1) Paste the whole code into the first box: most code widgets spread a paste across the boxes.
    const first = boxes[0];
    first.focus();
    first.click();
    try {
      const dt = new DataTransfer();
      dt.setData('text/plain', chars.join(''));
      first.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    } catch {}
    await sleep(250);
    if (done()) return true;
    // 2) Type digit by digit with full key events (keydown → beforeinput → input → keyup).
    for (const b of boxes) if (b.value) setNativeValue(b, '');
    for (let i = 0; i < boxes.length && i < chars.length; i++) {
      const box = boxes[i];
      const ch = chars[i];
      const keyInit = { key: ch, code: /\d/.test(ch) ? `Digit${ch}` : `Key${ch.toUpperCase()}`, keyCode: ch.charCodeAt(0), which: ch.charCodeAt(0), bubbles: true, cancelable: true };
      box.focus();
      box.dispatchEvent(new KeyboardEvent('keydown', keyInit));
      box.dispatchEvent(new KeyboardEvent('keypress', keyInit));
      box.dispatchEvent(new InputEvent('beforeinput', { data: ch, inputType: 'insertText', bubbles: true, cancelable: true }));
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(box, ch);
      box.dispatchEvent(new InputEvent('input', { data: ch, inputType: 'insertText', bubbles: true }));
      box.dispatchEvent(new KeyboardEvent('keyup', keyInit));
      box.dispatchEvent(new Event('change', { bubbles: true }));
      await sleep(70);
    }
    await sleep(200);
    return done();
  }

  const checkEmailPage = () =>
    /verify your email|check your (e-?mail|inbox)|we(?:'ve| have)? sent (?:you )?(?:an? )?(?:verification |confirmation )?(?:e-?mail|code|link)|confirm your e-?mail|activation (?:link|e-?mail)/i.test(
      (document.body?.innerText || '').slice(0, 20000),
    );

  function addChoice(fields, members, type) {
    const id = newId(members[0]);
    members.forEach((m) => (m.dataset.jfId = id));
    const checked = (m) => m.checked ?? (m.getAttribute('aria-checked') === 'true' || m.getAttribute('aria-pressed') === 'true');
    if (type === 'checkbox' && members.length === 1) {
      // A lone ARIA switch's own text is its state ("Off"), not its question.
      const el = members[0];
      const aria = el.tagName !== 'INPUT' && (el.getAttribute('aria-labelledby') || el.getAttribute('aria-label'));
      const label = (aria ? labelFor(el) : optionLabel(el)) || labelFor(el);
      fields.push({ id, type: 'checkbox', label, filled: checked(members[0]), required: isRequired(members[0], label) });
      return;
    }
    groups.set(id, members);
    const label = groupLabel(members);
    fields.push({
      id,
      type: type === 'radio' ? 'radio' : 'checkbox-group',
      label,
      options: members.map(optionLabel),
      filled: members.some(checked),
      required: members.some((m) => isRequired(m, '')) || /\*\s*$/.test(label),
    });
  }

  const selectedText = (el) => {
    const t = clean(el.textContent || el.value);
    return /^(select|choose|please select|--|select one)/i.test(t) ? '' : t;
  };

  // ---------- fill ----------
  const findById = (id) => deepAll(`[data-jf-id="${CSS.escape(id)}"]`)[0];

  function setNativeValue(el, value) {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // Exact, then prefix, then containment, then word overlap.
  // Same meaning, different wording, across forms (countries, yes/no, degrees, EEO answers…).
  const SYNONYMS = [
    ['india', 'in', 'ind', 'bharat', 'republic of india', 'india +91', '+91'],
    ['united states', 'us', 'usa', 'united states of america', 'america'],
    ['united kingdom', 'uk', 'gb', 'great britain', 'england'],
    ['united arab emirates', 'uae', 'ae'],
    ['yes', 'y', 'true', 'i am', 'i do', 'i will', 'agree', 'i agree'],
    ['no', 'n', 'false', 'i am not', 'i do not', 'i will not', 'i dont', 'not applicable'],
    ['male', 'man', 'm', 'he him'],
    ['female', 'woman', 'f', 'she her'],
    ['decline to self identify', 'prefer not to say', 'prefer not to answer', 'i dont wish to answer', 'i do not wish to answer', 'decline to answer', 'not disclosed', 'choose not to disclose'],
    ["bachelors degree", 'bachelors', 'bachelor', 'b tech', 'btech', 'b e', 'be', 'bachelor of technology', 'bachelor of engineering', 'undergraduate', 'ug', 'b sc', 'bs'],
    ["masters degree", 'masters', 'master', 'm tech', 'mtech', 'ms', 'm s', 'postgraduate', 'pg'],
    ['computer science', 'cse', 'computer science and engineering', 'computer engineering', 'cs'],
    ['tamil nadu', 'tn'], ['uttar pradesh', 'up'], ['karnataka', 'ka'], ['maharashtra', 'mh'], ['telangana', 'ts'], ['delhi', 'new delhi', 'nct of delhi'],
    ['bengaluru', 'bangalore'], ['gurugram', 'gurgaon'], ['mumbai', 'bombay'], ['chennai', 'madras'],
    ['immediately', 'immediate', 'immediate joiner', '0 days', 'no notice period', 'available immediately'],
    ['full time', 'full-time', 'permanent'], ['internship', 'intern'],
    ['linkedin', 'linked in'], ['company website', 'careers page', 'company career site', 'website'],
  ].map((g) => g.map((x) => norm(x)));
  const synGroup = (x) => SYNONYMS.find((g) => g.includes(x));

  // Score every option against the wanted value; the best clear winner is chosen.
  // "India" vs ["Indiana", "India (+91)"]: a word-boundary prefix beats a letter-continuing prefix.
  function scoreOption(option, wanted) {
    const o = norm(option);
    const w = norm(wanted);
    if (!o || !w) return 0;
    if (o === w) return 100;
    const g = synGroup(w);
    if (g && g.includes(o)) return 96;
    const first = (x) => x.split(' ')[0];
    if (g && g.some((s) => o === s || o.startsWith(`${s} `))) return 90; // "Yes, I am authorized" for "Yes"
    if (o.startsWith(`${w} `)) return 88; // "India +91"
    if (w.startsWith(`${o} `)) return 80; // option "India" for "India (Bengaluru)"
    if (new RegExp(`(^| )${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}( |$)`).test(o)) return 70; // whole word inside
    if (g && first(o) && g.includes(first(o))) return 68;
    const ow = new Set(o.split(' ').filter((t) => t.length > 2));
    const ww = w.split(' ').filter((t) => t.length > 2);
    const overlap = ww.length ? ww.filter((t) => ow.has(t)).length / ww.length : 0;
    if (overlap >= 0.6) return 40 + overlap * 20;
    if (o.startsWith(w) && w.length >= 4) return 35; // "Indiana" for "India": weak, only if nothing better
    return 0;
  }
  function bestMatch(options, wanted) {
    let best = -1;
    let bestScore = 0;
    options.forEach((opt, i) => {
      const sc = scoreOption(opt, wanted);
      if (sc > bestScore) [best, bestScore] = [i, sc];
    });
    return bestScore >= 35 ? best : -1;
  }
  const sameValue = (actual, wanted) => {
    const a = norm(actual);
    const w = norm(wanted);
    if (!w) return true;
    if (!a) return false;
    return a === w || scoreOption(actual, wanted) >= 68 || a.includes(w) || (w.length > 6 && w.includes(a));
  };

  // The box a person sees for a control (a radio's group, React-Select's visible box rather than its tiny search input).
  function visualBox(el) {
    let target = ['radio', 'checkbox'].includes(el.type) || /radio|checkbox|switch/.test(el.getAttribute('role') || '') ? el.closest('fieldset, [role="radiogroup"], [role="group"], div') || el : el;
    // Search inputs inside a select (React-Select) are a few pixels wide: outline the visible box instead.
    if (target.getBoundingClientRect().width < 60) target = el.closest('[class*="control" i], [class*="container" i], [class*="select" i], [class*="input" i]') || target;
    return target;
  }
  function mark(el, review) {
    const target = visualBox(el);
    target.style.outline = `2px solid ${review ? '#f59e0b' : '#22c55e'}`;
    target.style.outlineOffset = '2px';
  }

  const isChecked = (m) => m.checked ?? (m.getAttribute('aria-checked') === 'true' || m.getAttribute('aria-pressed') === 'true');
  const truthy = (v) => v === true || /^(true|yes|y|1|agree|checked|on)$/i.test(String(v).trim());

  function formatFor(el, value) {
    const v = String(value).trim();
    if (el.type === 'number' || el.type === 'range') return (v.match(/-?\d+(\.\d+)?/) || [''])[0];
    if (el.type === 'tel' && el.maxLength > 0 && el.maxLength <= 10) return v.replace(/\D/g, '').slice(-el.maxLength);
    if (['date', 'month', 'week', 'datetime-local', 'time'].includes(el.type)) return toDateValue(el.type, v);
    return v;
  }

  function toDateValue(type, v) {
    let y, m, d;
    let mt = v.match(/^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?/);
    if (mt) [, y, m, d] = mt;
    else if ((mt = v.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/))) [, d, m, y] = mt; // DD/MM/YYYY (Indian / EU)
    else {
      const t = new Date(v);
      if (!isNaN(t)) [y, m, d] = [t.getFullYear(), t.getMonth() + 1, t.getDate()];
    }
    if (!y) return v;
    const p = (n) => String(n || 1).padStart(2, '0');
    if (type === 'month') return `${y}-${p(m)}`;
    if (type === 'datetime-local') return `${y}-${p(m)}-${p(d)}T09:00`;
    if (type === 'time') return v;
    return `${y}-${p(m)}-${p(d)}`;
  }

  const press = (target, key) => {
    const init = { key, code: key.length === 1 ? `Key${key.toUpperCase()}` : key, keyCode: { Enter: 13, ArrowDown: 40, Escape: 27, Tab: 9 }[key] || key.toUpperCase().charCodeAt(0), bubbles: true, cancelable: true };
    target.dispatchEvent(new KeyboardEvent('keydown', init));
    target.dispatchEvent(new KeyboardEvent('keyup', init));
  };
  const clickLikeUser = (node) => {
    node.scrollIntoView({ block: 'nearest' });
    const r = node.getBoundingClientRect();
    const at = { bubbles: true, cancelable: true, view: window, clientX: r.left + Math.min(12, r.width / 2), clientY: r.top + r.height / 2, button: 0 };
    for (const type of ['pointerover', 'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      // Widgets built on pointer events (Workday's newer lists) check for a real PointerEvent.
      const Ev = type.startsWith('pointer') && typeof PointerEvent === 'function' ? PointerEvent : MouseEvent;
      node.dispatchEvent(new Ev(type, { ...at, buttons: /down/.test(type) ? 1 : 0, ...(Ev === PointerEvent ? { pointerType: 'mouse', isPrimary: true } : {}) }));
    }
  };
  async function typeInto(input, text) {
    input.focus();
    setNativeValue(input, '');
    // Progressively, so debounced search boxes fire for each step.
    for (const part of [text.slice(0, 3), text]) {
      setNativeValue(input, part);
      input.dispatchEvent(new KeyboardEvent('keyup', { key: part.slice(-1), bubbles: true }));
      await sleep(200);
    }
  }
  // A search box that appears inside an opened dropdown (Workday, MUI, many country pickers).
  function popupSearch(el) {
    const a = document.activeElement;
    if (a && a !== el && a.tagName === 'INPUT' && shown(a) && !a.dataset.jfId) return a;
    return deepAll('[role="listbox"] input, [role="dialog"] input[type="search"], [class*="menu" i] input, [class*="popover" i] input, [class*="dropdown" i] input[type="search"], input[type="search"]').find((i) => shown(i) && i !== el && !i.dataset.jfId) || null;
  }
  const optionTexts = (opts) => opts.map((o) => clean(o.getAttribute('aria-label') || o.textContent));
  // Long lists render lazily: scroll the list to reveal more options.
  async function scrollForOption(el, value) {
    const list = deepAll('[role="listbox"]').find(shown);
    if (!list) return -1;
    for (let k = 0; k < 25; k++) {
      const opts = optionNodes(el);
      const i = bestMatch(optionTexts(opts), value);
      if (i >= 0 && scoreOption(optionTexts(opts)[i], value) >= 68) return { opts, i };
      const before = list.scrollTop;
      list.scrollTop += Math.max(200, list.clientHeight * 0.9);
      list.dispatchEvent(new Event('scroll', { bubbles: true }));
      await sleep(120);
      if (list.scrollTop === before) break;
    }
    return -1;
  }

  async function chooseFromList(el, value, typeFirst) {
    const v = String(value);
    const sourceQ = HEAR_RE.test(labelFor(el));
    const pick = async (opts, i) => {
      let before = optionTexts(opts).join('|');
      clickLikeUser(opts[i]);
      await sleep(450);
      // Two-level lists (Workday "Job Board ›" then "LinkedIn"): a new set of options opens and nothing is chosen yet.
      for (let depth = 0; depth < 2 && !clean(readValue(el)); depth++) {
        const sub = optionNodes(el).filter(shown);
        const texts = optionTexts(sub);
        if (!sub.length || texts.join('|') === before) break;
        let j = bestMatch(texts, v);
        // Second level of a source list ("Job Board" › …): only a close match, else the ladder ("Other"),
        // never the nearest-looking board ("LinkedIn" is not "Jobstreet").
        if (j >= 0 && sourceQ && scoreOption(texts[j], v) < 68) j = -1;
        if (j < 0 && sourceQ) j = ladderIndex(texts, SOURCE_LADDER);
        if (j < 0) break;
        before = texts.join('|');
        clickLikeUser(sub[j]);
        await sleep(450);
      }
      // Check it took: some lists (Workday) ignore scripted clicks and keep "Select One" or the old answer.
      const wanted = clean(opts[i]?.textContent) || v;
      const took = () => {
        const now = clean(readValue(el));
        return !!now && (sourceQ || sameValue(now, wanted) || sameValue(now, v) || !!el.dataset.jfOther);
      };
      if (took()) return 'filled';
      // Click its checkbox / radio, if it has one, then try the keyboard: open, arrow down to it, Enter.
      const inner = opts[i]?.isConnected && opts[i].querySelector('input, [role="checkbox"], [role="radio"], [data-automation-id="checkboxPanel"]');
      if (inner) {
        clickLikeUser(inner);
        await sleep(400);
        if (took()) return 'filled';
      }
      el.focus();
      open(el);
      await sleep(400);
      const list = optionNodes(el).filter(shown);
      const k = bestMatch(optionTexts(list), wanted);
      if (k >= 0) {
        for (let n = 0; n <= k; n++) press(document.activeElement || el, 'ArrowDown');
        press(document.activeElement || el, 'Enter');
        await sleep(450);
        if (took()) return 'filled';
      }
      close(el);
      const shows = clean(readValue(el));
      return `didn't stick: picked "${wanted.slice(0, 40)}" but it shows "${(shows || 'nothing').slice(0, 40)}"`;
    };
    // Source questions (Workday "How Did You Hear About Us?"): open the list and walk its categories
    // (Job Boards › LinkedIn); typing only searches the top level there.
    if (sourceQ) typeFirst = false;
    // 1) Open; for type-to-search boxes, type first.
    open(el);
    if (typeFirst && el.tagName === 'INPUT') await typeInto(el, v);
    let opts = await waitOptions(el, typeFirst ? 2500 : 1200);
    let i = bestMatch(optionTexts(opts), v);
    if (i >= 0 && scoreOption(optionTexts(opts)[i], v) >= 68) return pick(opts, i);
    if (sourceQ && opts.length) {
      const j = ladderIndex(optionTexts(opts), SOURCE_LADDER);
      if (j >= 0) return pick(opts, j);
    }

    // 1b) Search boxes that only search on Enter (Workday prompts: school, field of study), trying
    // shorter / alternative names: "Vellore Institute of Technology, Chennai" -> "Vellore Institute of Technology" -> "VIT University".
    if (el.tagName === 'INPUT' && (el.getAttribute('data-automation-id') === 'searchBox' || el.closest('[data-automation-id="multiselectInputContainer"]'))) {
      const found = await searchWithEnter(el, v);
      if (found) {
        // "Other" when your school isn't listed, as the page says: a correct answer, but one for you to check.
        if (found.other) el.dataset.jfOther = '1';
        return pick(found.opts, found.i);
      }
    }

    // 2) A search box inside the opened dropdown, or the field itself if it's an input.
    const search = popupSearch(el) || (el.tagName === 'INPUT' ? el : null);
    if (search) {
      if (search !== el || !typeFirst) {
        await typeInto(search, v);
        opts = await waitOptions(el, 2500);
        i = bestMatch(optionTexts(opts), v);
      }
      // Searches often only match the first word: "Chennai, Tamil Nadu, India" -> "Chennai", "India (+91)" -> "India".
      const short = v.split(/[,(]/)[0].trim();
      if (i < 0 && short && short !== v) {
        await typeInto(search, short);
        opts = await waitOptions(el, 3000);
        i = bestMatch(optionTexts(opts), v);
        if (i < 0) i = bestMatch(optionTexts(opts), short);
        if (i < 0 && opts.length === 1) i = 0;
      }
      if (i >= 0) return pick(opts, i);
    }

    // 3) Long lazy lists: scroll through them.
    const found = await scrollForOption(el, v);
    if (found !== -1) return pick(found.opts, found.i);

    // 4) Type-ahead: many listboxes jump to an option when you type its first letters.
    const target = deepAll('[role="listbox"]').find(shown) || el;
    for (const ch of v.slice(0, 4)) press(target, ch);
    await sleep(300);
    opts = optionNodes(el);
    const active = opts.find((o) => o.getAttribute('aria-selected') === 'true' || o.classList.contains('active') || o.matches(':focus'));
    if (active && sameValue(active.textContent, v)) return pick([active], 0);
    i = bestMatch(optionTexts(opts), v);
    if (i >= 0) return pick(opts, i);

    // 5) Last resort for type-to-search inputs: Enter on the first suggestion.
    if (el.tagName === 'INPUT' && opts.length) {
      press(el, 'ArrowDown');
      press(el, 'Enter');
      await sleep(250);
      if (sameValue(readValue(el), v)) return 'filled';
    }
    close(el);
    if (opts.length) return `no option matches "${v}": pick it yourself`;
    return typeFirst || el.tagName === 'INPUT' ? `no match for "${v}" in this list: pick it yourself` : `could not open the list for "${v}"`;
  }

  async function fillOne(id, value, review) {
    const members = groups.get(id);
    if (members && members[0].tagName === 'INPUT' && members.length >= 4 && members.every((m) => m.type !== 'radio' && m.type !== 'checkbox')) {
      const ok = await typeCode(members, value);
      if (ok) mark(members[0].parentElement || members[0], false);
      return ok ? 'filled' : 'the boxes did not accept the code: type it yourself';
    }
    if (members) {
      const opts = members.map(optionLabel);
      const wanted = Array.isArray(value) ? value : [value];
      let hit = false;
      for (const w of wanted) {
        const i = bestMatch(opts, String(w));
        if (i < 0) continue;
        if (!isChecked(members[i])) members[i].click();
        if (!isChecked(members[i])) {
          clickLikeUser(members[i].labels?.[0] || members[i].closest('label') || members[i]);
          await sleep(200);
        }
        if (!isChecked(members[i]) && (members[i].type === 'radio' || members[i].getAttribute('role') === 'radio'))
          return `didn't stick: "${opts[i]}" isn't selected`;
        hit = true;
      }
      if (hit) mark(members[0], review);
      return hit ? 'filled' : `no option matches "${wanted.join(', ')}"`;
    }

    const el = findById(id);
    if (!el) return 'field disappeared';
    // Phone extensions are for office desk lines: keep them empty, whatever the answer says ("+91" there breaks the number).
    if (el.tagName === 'INPUT' && /phone\s*ext|extension/i.test(`${labelFor(el)} ${el.getAttribute('data-automation-id') || ''} ${el.name || ''} ${el.id || ''}`)) {
      if (el.value) setNativeValue(el, '');
      return 'filled';
    }
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    const role = el.getAttribute('role');
    const kind = comboKind(el);
    let status = 'filled';

    if (el.type === 'checkbox' || role === 'checkbox' || role === 'switch') {
      if (isChecked(el) !== truthy(value)) el.click();
      if (isChecked(el) !== truthy(value)) {
        const lab = el.labels?.[0] || el.closest('label') || (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`));
        clickLikeUser(lab || el);
        await sleep(200);
      }
      if (isChecked(el) !== truthy(value)) status = `didn't stick (the box is still ${isChecked(el) ? 'ticked' : 'unticked'})`;
    } else if (kind && Array.isArray(value) && (el.getAttribute('data-automation-id') === 'searchBox' || el.closest('[data-automation-id="multiselectInputContainer"]'))) {
      // A multi-select prompt (Workday "Type to Add Skills"): search and pick each item; ones not in their list are skipped.
      let picked = 0;
      for (const item of value.slice(0, 15)) {
        const r = await searchWithEnter(el, String(item));
        if (r && !r.other) {
          const n = chipsOf(el).length;
          clickLikeUser(r.opts[r.i]);
          await sleep(350);
          // Workday may ignore a scripted click on the text: try its checkbox, then Enter on the highlighted result.
          const inner = r.opts[r.i].isConnected && r.opts[r.i].querySelector('input, [role="checkbox"], [data-automation-id="checkboxPanel"]');
          if (chipsOf(el).length <= n && inner) {
            clickLikeUser(inner);
            await sleep(350);
          }
          if (chipsOf(el).length <= n) {
            el.focus();
            for (let k = 0; k < r.i; k++) press(el, 'ArrowDown');
            press(el, 'Enter');
            await sleep(450);
          }
          if (chipsOf(el).length > n) picked++;
        }
      }
      close(el);
      status = picked ? 'filled' : `none of these are in the site's list: ${value.slice(0, 3).join(', ')}…`;
      if (picked) el.dataset.jfPicked = String(picked);
    } else if (kind) {
      status = await chooseFromList(el, Array.isArray(value) ? value[0] : value, kind === 'combobox');
    } else if (el.tagName === 'SELECT') {
      const opts = [...el.options].map((o) => clean(o.text));
      const wanted = Array.isArray(value) ? value : [value];
      let hit = false;
      for (const w of wanted) {
        let i = bestMatch(opts, String(w));
        if (i < 0) i = [...el.options].findIndex((o) => norm(o.value) === norm(w));
        if (i < 0) continue;
        if (el.multiple) el.options[i].selected = true;
        else setNativeValue(el, el.options[i].value);
        hit = true;
      }
      if (el.multiple) el.dispatchEvent(new Event('change', { bubbles: true }));
      if (!hit) return `no option matches "${value}"`;
    } else if (role === 'listbox') {
      const opts = [...el.querySelectorAll('[role="option"]')];
      const i = bestMatch(opts.map((o) => clean(o.textContent)), String(value));
      if (i < 0) return `no option matches "${value}"`;
      opts[i].click();
    } else if (el.isContentEditable) {
      el.focus();
      document.execCommand('selectAll');
      document.execCommand('insertText', false, String(value));
    } else if (tagInput(el, labelFor(el))) {
      status = await fillTags(el, value);
    } else {
      // Split date boxes: type just this box's part ("07" into the month of "Jul 2026").
      const part = dateSection(el);
      if (part) {
        const want = datePart(value, part);
        if (!want) return `no ${part} in "${value}"`;
        if (Number(readValue(el)) === Number(want)) return 'filled'; // already right: retyping can only break it
        // The other boxes of this date (MM / YYYY): typing here must not change them.
        const group = el.closest('[role="group"], [data-automation-id="dateInputWrapper"]') || el.parentElement;
        const others = [...(group?.querySelectorAll('input') || [])].filter((i) => i !== el && dateSection(i));
        const before = others.map((o) => o.value);
        await typeChars(el, want);
        await sleep(150);
        if (Number(readValue(el)) !== Number(want)) {
          setNativeValue(el, want);
          el.dispatchEvent(new Event('blur', { bubbles: true }));
        }
        for (const [k, o] of others.entries()) {
          if (before[k] && o.value !== before[k]) {
            await typeChars(o, before[k]);
            leave(o);
          }
        }
        mark(el, review);
        if (Number(readValue(el)) !== Number(want)) return `didn't stick (the ${part} box shows "${readValue(el)}")`;
        return 'filled';
      }
      // Date text fields: use the field's own format; date pickers often make the input read-only.
      if (el.type === 'text' && dateLike(el, labelFor(el))) value = formatDateTo(value, dateFormatHint(el, labelFor(el)));
      const wasReadOnly = el.readOnly;
      if (wasReadOnly) el.readOnly = false;
      el.focus();
      el.dispatchEvent(new Event('focus', { bubbles: true }));
      el.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
      const text = formatFor(el, value);
      // Type it the way the browser does for a real keyboard (trusted input events, cursor at the end);
      // sites like Workday ignore values that are only set from script.
      if (!insertText(el, text)) setNativeValue(el, text);
      caretToEnd(el);
      el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'End' }));
      // Address / city autocompletes (Google Places, etc.) want a suggestion picked.
      const placesBox = el.classList.contains('pac-target-input') || !!document.querySelector('.pac-container');
      if (placesBox && el.type !== 'email' && !/e-?mail/i.test(labelFor(el)) && /address|city|location|street|town/i.test(labelFor(el))) {
        await sleep(700);
        const sug = deepAll('.pac-item').filter(shown);
        const i = bestMatch(sug.map((x) => clean(x.textContent)), String(value));
        if (i >= 0) clickLikeUser(sug[i]);
      }
      leave(el);
      await sleep(60);
      // Still flagged after leaving the box: type it the slow way once.
      if (errorFor(el) && /required|must have a value|cannot be (empty|blank)/i.test(errorFor(el))) {
        await typeChars(el, text);
        leave(el);
      }
      if (wasReadOnly) el.readOnly = true;
    }
    if (status === 'filled') mark(el, review || el.dataset.jfOther === '1');
    return status;
  }

  async function fill(values, needsReview = []) {
    const results = {};
    for (const [id, value] of Object.entries(values)) {
      if (value === '' || value === null || value === undefined || (Array.isArray(value) && !value.length)) continue;
      try {
        let status = await fillOne(id, value, needsReview.includes(id));
        // Trust but verify: read the field back; if it didn't take, try the other strategies once.
        if (status === 'filled' && !holds(id, value)) {
          await sleep(300);
          if (!holds(id, value)) {
            const el = findById(id);
            if (el && comboKind(el)) status = await chooseFromList(el, Array.isArray(value) ? value[0] : value, true);
            else status = await fillOne(id, value, needsReview.includes(id));
            await sleep(250);
            if (status === 'filled' && !holds(id, value)) {
              const shows = readFieldValue(id);
              status = `didn't stick (shows "${String(shows).slice(0, 40)}")`;
            }
          }
        }
        results[id] = status;
      } catch (e) {
        results[id] = `error: ${e.message}`;
      }
      await sleep(80);
    }
    return results;
  }



  // ---------- div-based dropdowns ----------
  const PLACEHOLDER_RE = /^(search\s*(&|and)\s*select|select(\s+(one|an option|option|\.\.\.|…))?|select\.\.\.|choose(\s+(one|an option))?|-+\s*select\s*-+|please (select|choose)|pick (one|an option)|search\.*)\s*[⇕▾▼⌄˅v^]*$/i;
  // A clickable box showing a placeholder (or with select-like classes) that has no visible control inside.
  function customDropdowns() {
    const cands = deepAll('[class*="select" i], [class*="dropdown" i], [class*="picker" i], [class*="combo" i], [tabindex], [role="button"], div, span');
    const out = [];
    for (const el of cands) {
      if (!shown(el) || el.dataset.jfId || el.closest('[data-jf-custom="1"]') || el.matches('select, input, textarea, button, a, label, option, [role="option"], [role="listbox"]')) continue;
      const text = clean(el.innerText);
      if (!text || text.length > 60) continue;
      const placeholder = PLACEHOLDER_RE.test(text);
      const selectish = /(^|[-_ ])(select|multiselect|dropdown|picker|combobox|choices)([-_ ]|$)/i.test(el.className || '') && (el.tabIndex >= 0 || getComputedStyle(el).cursor === 'pointer');
      if (!placeholder && !selectish) continue;
      if ([...el.querySelectorAll('input, select, textarea, button')].some((c) => shown(c) && c.type !== 'hidden')) continue;
      // Use the outermost box: skip a match whose parent would also match with the same text.
      const p = el.parentElement;
      if (p && clean(p.innerText) === text && p.offsetHeight - el.offsetHeight < 12 && !p.matches('label, [class*="field" i]')) continue;
      // A box that only decorates a real control (e.g. wraps a <select>) isn't a separate field.
      if (el.querySelector('select')) continue;
      if (out.some((o) => o.contains(el) || el.contains(o))) continue;
      out.push(el);
    }
    return out;
  }

  // ---------- page settling, sections, tags, dates ----------
  // Resolve once the page has stopped changing for `quiet` ms (fields that load in stages), or after `max`.
  function waitStable(quiet = 500, max = 4000) {
    return new Promise((resolve) => {
      let timer;
      const done = () => {
        obs.disconnect();
        clearTimeout(timer);
        clearTimeout(cap);
        resolve(true);
      };
      const obs = new MutationObserver(() => {
        clearTimeout(timer);
        timer = setTimeout(done, quiet);
      });
      obs.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'style', 'hidden', 'aria-hidden', 'disabled'] });
      timer = setTimeout(done, quiet);
      const cap = setTimeout(done, max);
    });
  }

  // The heading of the section a control sits in ("Work Experience", "Education 2"…).
  function sectionOf(el) {
    let n = el.parentElement; // the control itself is never its own section (Workday "dateSectionMonth-input")
    for (let i = 0; n && i < 10; i++, n = n.parentElement) {
      if (n.matches?.('input, select, textarea, [role="group"]:has(> * > input[data-automation-id^="dateSection"])')) continue;
      if (!n.matches?.('fieldset, section, [role="group"], [role="region"], [data-automation-id*="ection" i], [class*="section" i], [class*="panel" i], [class*="card" i]')) continue;
      const h = n.querySelector(':scope > legend, :scope > h2, :scope > h3, :scope > h4, :scope > header, :scope > div > h2, :scope > div > h3, :scope > div > h4, [data-automation-id*="Title" i]');
      const t = clean(h?.innerText || n.getAttribute('aria-label'));
      if (t && t.length < 60) return t;
    }
    return '';
  }

  // The nearest heading above a control ("Work Experience 1"), for forms without section containers.
  function headingBefore(el) {
    let n = el;
    for (let i = 0; n && i < 8; i++, n = n.parentElement) {
      for (let p = n.previousElementSibling, k = 0; p && k < 6; p = p.previousElementSibling, k++) {
        const h = p.matches('h1, h2, h3, h4, h5, [role="heading"]') ? p : p.querySelector?.('h2, h3, h4, h5, [role="heading"]');
        const t = clean(h?.textContent);
        if (t && t.length < 60) return t;
      }
    }
    return '';
  }
  // Repeated groups (two "Job Title" fields) get "Work Experience #1 › Job Title" so answers go to the right entry.
  function labelRepeatedSections(fields) {
    const base = (f) => f.label.replace(/\s*\*$/, '').toLowerCase();
    const counts = new Map();
    for (const f of fields) counts.set(base(f), (counts.get(base(f)) || 0) + 1);
    const seen = new Map();
    for (const f of fields) {
      if (counts.get(base(f)) < 2 || f.type === 'file') continue;
      const el = findById(f.id) || groups.get(f.id)?.[0];
      const sec = (el && (sectionOf(el) || headingBefore(el)).replace(/\s*\d+$/, '')) || 'Entry';
      const k = `${sec}|${base(f)}`;
      const n = (seen.get(k) || 0) + 1;
      seen.set(k, n);
      f.section = sec;
      f.entry = n;
      f.label = `${sec} #${n} › ${f.label}`;
    }
  }

  // "Add" buttons of repeating sections.
  const SECTION_WORDS = {
    experience: /work experience|experience|employment|work history|positions?|jobs?/i,
    education: /education|school|degree|qualification|academic/i,
    languages: /languages?/i,
  };
  function addButtonFor(kind) {
    return buttons().find((b) => {
      const t = btnText(b);
      if (new RegExp(`^(add|\\+)\\s*(another|more|new)?\\s*(${SECTION_WORDS[kind].source})`, 'i').test(t)) return true;
      return /^(\+\s*)?(add|add another|add more|add new|\+)$/i.test(t) && SECTION_WORDS[kind].test(sectionOf(b) || clean(b.getAttribute('aria-label')));
    });
  }
  function sectionEntries(kind) {
    const re = { experience: /job title|position title|role title|^title\b|designation/i, education: /school|university|institution|college/i, languages: /^(spoken\s*)?language(\s*name)?\b/i }[kind];
    const open = deepAll('input, select, [role="combobox"], button[aria-haspopup="listbox"]').filter((e) => shown(e) && re.test(labelFor(e))).length;
    return Math.max(open, savedCards(kind));
  }
  // Entries already saved as cards (imported from your resume): count their remove buttons inside the section.
  function savedCards(kind) {
    const b = addButtonFor(kind);
    let sec = b?.parentElement;
    for (let i = 0; sec && i < 6; i++, sec = sec.parentElement) if (SECTION_WORDS[kind].test(clean(sec.innerText).slice(0, 40))) break;
    if (!sec) return 0;
    return [...sec.querySelectorAll('button, [role="button"]')].filter((x) => shown(x) && !x.closest('input, select') && (/^[×✕x]$/i.test(clean(x.textContent)) || /delete|remove|trash/i.test(editSig(x)))).length;
  }
  async function addEntry(kind) {
    const b = addButtonFor(kind);
    if (!b) return { ok: false };
    const before = new Set(deepAll(CONTROL).filter(shown));
    click(b);
    await waitStable(400, 3000);
    // Some sites open an editor box (fields + Cancel / "Add Language") instead of adding the fields straight away.
    const fresh = deepAll(CONTROL).filter((e) => shown(e) && !before.has(e));
    const cancel = fresh.length && buttons().find((x) => /^cancel$/i.test(btnText(x)));
    if (cancel) {
      let box = fresh[0].parentElement;
      while (box && !fresh.every((e) => box.contains(e))) box = box.parentElement;
      editingCard = { top: Math.min(...fresh.map((e) => e.getBoundingClientRect().top)) + scrollY - 5, label: btnText(b), box };
    }
    return { ok: true, label: btnText(b), editor: !!cancel };
  }

  // "Work Link / Online Portfolio [+]": rows of link boxes. Press the row's "+" until there are `want` boxes.
  const LINK_RE = /portfolio|personal\s*(web)?site|^website|^url\b|work\s*links?|^(other\s*)?links?\b|profile\s*links?|social\s*(links?|profiles?)/i;
  const linkInputs = () => deepAll('input').filter((e) => ['text', 'url'].includes(e.type) && usable(e) && LINK_RE.test(labelFor(e)) && !/linked\s*in|git\s*hub/i.test(labelFor(e)));
  function plusButtonNear(el) {
    let n = el.parentElement;
    for (let i = 0; n && i < 5; i++, n = n.parentElement) {
      const b = [...n.querySelectorAll('button, [role="button"]')].find((x) => {
        if (!shown(x) || x.contains(el)) return false;
        const t = clean(x.innerText || x.getAttribute('aria-label'));
        const sig = `${x.getAttribute('data-testid') || ''} ${x.className} ${x.getAttribute('aria-label') || ''} ${x.title || ''} ${[...x.querySelectorAll('i, svg, span')].map((c) => c.getAttribute('class') || '').join(' ')}`;
        if (/remove|delete|minus|close|clear|trash/i.test(sig)) return false;
        return /^(\+|add( more| another| link)?)$/i.test(t) || (!t && /add|plus/i.test(sig));
      });
      if (b) return b;
      if (n.querySelectorAll('input').length > 3) break; // left the row
    }
    return null;
  }
  async function addLinkRows(want) {
    let added = 0;
    for (let k = 0; k < want; k++) {
      const list = linkInputs();
      if (!list.length || list.length >= want) break;
      const b = plusButtonNear(list[list.length - 1]) || buttons().find((x) => /^(\+\s*)?add\s*(another|more|new)?\s*(link|url|website)s?$/i.test(btnText(x)));
      if (!b) break;
      b.click();
      for (let t = 0; t < 15 && linkInputs().length <= list.length; t++) await sleep(150); // the row renders a moment later
      if (linkInputs().length <= list.length) break;
      added++;
    }
    return added;
  }

  // Collapsed entry cards the site flags ("Fields to fix: 1", "Incomplete"): open the editor so its fields can be filled,
  // then press the editor's own Save / "Add Education" button.
  const FIX_RE = /fields?\s*to\s*fix|\bincomplete\b|needs?\s*(attention|review)|missing\s*(info|information|fields?|details)|required\s*fields?\s*missing/i;
  const SAVE_RE = /^(save|update|done|ok|save changes|save entry|save and close|add|add (education|experience|entry|degree|school|position|job|work experience|employment|language|certificate|certification|license|skill))$/i;
  const NOT_EDIT = /remove|delete|close|trash|cancel/i;
  let editingCard = null;
  const opened = new WeakSet();
  const editSig = (b) => `${btnText(b)} ${b.getAttribute('aria-label') || ''} ${b.title || ''} ${b.getAttribute('data-testid') || ''} ${b.className?.baseVal ?? b.className} ${[...b.querySelectorAll('i, svg, span, use')].map((c) => `${c.getAttribute('class') || ''} ${c.getAttribute('href') || ''}`).join(' ')}`;
  function fixCards() {
    const flags = deepAll('div, span, p, small, li').filter((n) => shown(n) && n.childElementCount <= 3 && FIX_RE.test(clean(n.textContent).slice(0, 120)) && !n.closest('[data-jf-ignore]'));
    const cards = [];
    for (const f of flags.filter((n) => !flags.some((m) => m !== n && n.contains(m)))) { // the flag text itself, not its containers
      let card = f.parentElement;
      for (let i = 0; card && i < 5 && !card.querySelector('button, [role="button"]'); i++) card = card.parentElement;
      if (card && !opened.has(card) && !card.querySelector('input:not([type=hidden]), select, textarea') && !cards.includes(card)) cards.push(card);
    }
    return cards;
  }
  async function openFixCard() {
    for (const card of fixCards()) {
      opened.add(card);
      const btns = [...card.querySelectorAll('button, [role="button"], a')].filter(shown);
      const edit = btns.find((b) => /edit|pencil|modify|update/i.test(editSig(b)) && !NOT_EDIT.test(editSig(b)));
      const target = edit || (card.matches('[role="button"], button') ? card : null) || card.querySelector('[role="button"]:not([aria-label*="delete" i]):not([aria-label*="remove" i])');
      if (!target) continue;
      const top = card.getBoundingClientRect().top + scrollY;
      const label = clean(card.innerText.replace(FIX_RE, '')).slice(0, 80);
      const before = deepAll(CONTROL).filter(shown).length;
      target.scrollIntoView({ block: 'center' });
      clickLikeUser(target);
      await waitStable(400, 3000);
      if (deepAll(CONTROL).filter(shown).length <= before) continue; // nothing opened
      editingCard = { top, label };
      return { ok: true, label: editingCard.label };
    }
    return { ok: false };
  }
  async function saveOpenCard() {
    if (!editingCard) return { ok: false };
    const near = buttons()
      .filter((b) => SAVE_RE.test(btnText(b)))
      .filter((b) => { let n = b.parentElement; for (let i = 0; n && i < 6; i++, n = n.parentElement) if (n.querySelectorAll('input, select, textarea, [role="combobox"]').length >= 2) return true; return false; })
      .map((b) => ({ b, d: b.getBoundingClientRect().top + scrollY - editingCard.top }))
      .filter((x) => x.d > 0)
      .sort((a, c) => a.d - c.d)[0];
    const label = editingCard.label;
    editingCard = null;
    if (!near) return { ok: false, label };
    near.b.scrollIntoView({ block: 'center' });
    near.b.click();
    await waitStable(400, 3000);
    return { ok: true, label, button: btnText(near.b) };
  }

  // Values that were filled but no longer show (sites that re-render after a resume upload wipe earlier answers).
  const lostValues = (values) => Object.keys(values).filter((id) => (findById(id) || groups.get(id)) && !holds(id, values[id]));

  // Skills-style inputs: type an item, Enter, it becomes a chip.
  const chipsOf = (el) => {
    const box = el.closest('[class*="tag" i], [class*="chip" i], [class*="token" i], [class*="multi" i], [data-automation-id*="multiselect" i]') || el.parentElement;
    return box ? [...box.querySelectorAll('[class*="tag" i]:not(input), [class*="chip" i]:not(input), [class*="token" i]:not(input), [class*="multiValue" i], [data-automation-id="selectedItem"]')].filter((c) => clean(c.textContent)) : [];
  };
  function tagInput(el, label) {
    if (el.tagName !== 'INPUT' || !['text', 'search', ''].includes(el.type)) return false;
    if (el.getAttribute('aria-multiselectable') === 'true') return true;
    const box = el.closest('[class*="tag" i], [class*="chip" i], [class*="token" i], [class*="multi-select" i], [class*="multiselect" i], [data-automation-id*="multiselect" i]');
    return !!box && /skill|tag|technolog|language|tool|interest|keyword/i.test(`${label} ${el.placeholder}`);
  }
  async function fillTags(el, value) {
    const items = (Array.isArray(value) ? value : String(value).split(/\s*[,;]\s*/)).map((x) => String(x).trim()).filter(Boolean).slice(0, 15);
    const have = chipsOf(el).map((c) => norm(c.textContent));
    for (const item of items) {
      if (have.some((h) => h === norm(item))) continue;
      await typeInto(el, item);
      const opts = await waitOptions(el, 900);
      const i = bestMatch(optionTexts(opts), item);
      if (i >= 0) clickLikeUser(opts[i]);
      else {
        press(el, 'Enter');
        el.dispatchEvent(new KeyboardEvent('keydown', { key: ',', bubbles: true }));
      }
      await sleep(200);
      if (el.value && norm(el.value) === norm(item)) setNativeValue(el, ''); // widget wanted Enter only via keypress; clear the leftover text
    }
    return chipsOf(el).length ? 'filled' : 'could not add the items: add them yourself';
  }

  // Text inputs that hold dates ("DD/MM/YYYY" placeholders, datepicker classes).
  const dateLike = (el, label) => /date|dob|birth|joining|available from|start|end|from|to\b/i.test(label) && /(dd|mm|yy)|date|calendar|picker/i.test(`${el.placeholder} ${el.className} ${el.id} ${el.name} ${el.getAttribute('data-date-format') || ''}`);
  const dateFormatHint = (el, label) => (`${el.placeholder} ${el.getAttribute('data-date-format') || ''} ${label}`.match(/\b(dd|mm|yyyy|yy)[\/.\- ](dd|mm|yyyy|yy)[\/.\- ](dd|mm|yyyy|yy)\b|\b(mm|yyyy)[\/.\- ](yyyy|mm)\b/i) || [''])[0].toUpperCase();
  function formatDateTo(value, fmt) {
    const v = String(value).trim();
    let y, m, d;
    let mt = v.match(/^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?/);
    if (mt) [, y, m, d] = mt;
    else if ((mt = v.match(/^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4})$/))) [, d, m, y] = mt;
    else {
      const t = new Date(v);
      if (!isNaN(t)) [y, m, d] = [t.getFullYear(), t.getMonth() + 1, t.getDate()];
    }
    if (!y || !fmt) return v;
    const p = (n) => String(n || 1).padStart(2, '0');
    const sep = (fmt.match(/[\/.\- ]/) || ['/'])[0];
    return fmt.split(/[\/.\- ]/).map((part) => ({ DD: p(d), MM: p(m), YYYY: String(y), YY: String(y).slice(-2) })[part] ?? part).join(sep);
  }

  // ---------- read back & validation ----------
  // What a field shows right now (dropdowns often keep the choice outside the input).
  function readValue(el) {
    if (!el) return '';
    if (el.tagName === 'SELECT') return [...el.selectedOptions].map((o) => clean(o.text)).join(', ');
    if (el.type === 'checkbox' || /checkbox|switch/.test(el.getAttribute('role') || '')) return isChecked(el) ? 'true' : 'false';
    if (el.isContentEditable) return clean(el.textContent);
    if (tagInput(el, labelFor(el))) return chipsOf(el).map((c) => clean(c.textContent)).join(', ');
    if (el.dataset?.jfCustom === '1') {
      const t = clean(el.innerText).replace(/\s*[⇕▾▼⌄˅×✕]+\s*$/, '');
      return PLACEHOLDER_RE.test(t) ? '' : t;
    }
    const kind = comboKind(el);
    if (kind) {
      // Workday keeps the chosen chip in the prompt's container, not next to its search input.
      const box = el.closest('[data-automation-id="multiselectInputContainer"], [data-automation-id^="formField"]') || el.closest('[class*="select" i], [class*="combo" i], [class*="dropdown" i], [class*="autocomplete" i], [data-automation-id]:not(input), .combo') || el.parentElement;
      const chip = box && [...box.querySelectorAll('[class*="singleValue" i], [class*="single-value" i], [class*="multiValue" i] [class*="label" i], [class*="selected" i], [data-automation-id="selectedItem"], [class*="chip" i]')].map((n) => clean(n.textContent)).filter(Boolean).join(', ');
      return clean(el.value) || chip || selectedText(el) || '';
    }
    return clean(el.value ?? el.textContent);
  }
  function readFieldValue(id) {
    const members = groups.get(id);
    if (members) {
      if (members.length >= 4 && members[0].type !== 'radio' && members[0].type !== 'checkbox' && !members[0].getAttribute('role')) return members.map((m) => m.value).join('');
      return members.filter(isChecked).map(optionLabel).join(', ');
    }
    return readValue(findById(id));
  }
  // "05/2026" holds "2026-05-01"; "30/03/1999" holds "1999-03-30": compare dates as dates.
  const dateParts = (x) => {
    const t = String(x).trim();
    let m = t.match(/^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?/);
    if (m) return { y: +m[1], m: +m[2], d: m[3] ? +m[3] : null };
    m = t.match(/^(\d{1,2})[/.\- ](\d{4})$/); // MM/YYYY
    if (m) return { y: +m[2], m: +m[1], d: null };
    m = t.match(/^(\d{1,2})[/.\- ](\d{1,2})[/.\- ](\d{2,4})$/);
    if (m) {
      const [a, b] = [+m[1], +m[2]];
      // DD/MM vs MM/DD: unambiguous only when one part is over 12; otherwise accept either reading.
      return { y: +m[3] < 100 ? 2000 + +m[3] : +m[3], m: a > 12 ? b : a, d: a > 12 ? a : b, alt: a <= 12 && b <= 12 ? { m: b, d: a } : null };
    }
    return null;
  };
  const sameDate = (actual, wanted) => {
    const a = dateParts(actual);
    const w = dateParts(wanted);
    if (!a || !w || a.y !== w.y) return false;
    const fits = (p) => p.m === w.m && (p.d === null || w.d === null || p.d === w.d);
    return fits(a) || (a.alt && fits({ ...a.alt }));
  };
  const holds = (id, value) => {
    const actual = readFieldValue(id);
    const box = findById(id);
    const part = box && dateSection(box);
    if (part) return !!datePart(value, part) && Number(actual) === Number(datePart(value, part));
    if (box?.dataset.jfOther === '1' && /^(school )?not listed|^others?\b|^none of the above/i.test(String(actual).trim())) return true; // the "not listed" fallback took
    const one = groups.get(id)?.length === 1 ? groups.get(id)[0] : !groups.get(id) && box && (box.type === 'checkbox' || /checkbox|switch/.test(box.getAttribute('role') || '')) ? box : null;
    if (typeof value === 'boolean' && one) return isChecked(one) === value; // a single checkbox: ticked or not
    if (typeof value === 'string' && dateParts(value) && sameDate(actual, value)) return true;
    if (typeof value === 'boolean') return actual === String(value) || (value === false && !actual);
    if (box?.dataset.jfPicked) return true; // multi-select prompt: counted as it picked
    if (Array.isArray(value)) return value.every((v) => sameValue(actual, v) || norm(actual).includes(norm(v)));
    return sameValue(actual, value);
  };

  // Per-field validation messages: native validity, aria-invalid + its message, or an error text next to the field.
  function errorFor(el) {
    if (!el) return '';
    let msg = '';
    if (el.matches?.('input, select, textarea') && el.willValidate && !el.checkValidity()) msg = el.validationMessage;
    const invalid = el.getAttribute('aria-invalid') === 'true';
    const ids = `${el.getAttribute('aria-errormessage') || ''} ${invalid ? el.getAttribute('aria-describedby') || '' : ''}`.trim();
    if (ids) msg = clean(ids.split(/\s+/).map((i) => textOf(byIdIn(el, i))).join(' ')) || msg;
    // An error element inside the field's own container.
    let box = el.parentElement;
    for (let i = 0; box && i < 4; i++, box = box.parentElement) {
      if ([...box.querySelectorAll(CONTROL)].filter((c) => !c.contains(el) && c !== el && c.dataset.jfId !== el.dataset.jfId).length) break;
      const err = [...box.querySelectorAll('[role="alert"], [class*="error" i]:not(input):not(select):not(textarea), [class*="invalid-feedback" i], [class*="validation" i], [data-automation-id*="error" i]')].find((n) => shown(n) && clean(n.textContent) && clean(n.textContent).length < 200);
      if (err) {
        msg = clean(err.textContent) || msg;
        break;
      }
    }
    return invalid && !msg ? 'This field is invalid' : msg;
  }
  function fieldErrors() {
    const out = [];
    const seen = new Set();
    for (const el of deepAll('[data-jf-id]')) {
      const id = el.dataset.jfId;
      if (seen.has(id) || !(usable(el) || shown(el.parentElement || el))) continue;
      seen.add(id);
      const members = groups.get(id);
      const error = members ? members.map(errorFor).find(Boolean) || '' : errorFor(el);
      if (error) out.push({ id, label: members ? groupLabel(members) : labelFor(el), error: error.slice(0, 200), value: readFieldValue(id) });
    }
    return out;
  }

  // ---------- uploads ----------
  function uploadFile(id, base64, filename, mime) {
    const input = findById(id);
    if (!input) return { ok: false, reason: 'upload field disappeared' };
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], filename, { type: mime, lastModified: Date.now() }));
    input.files = dt.files;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    // Drop-zone widgets often listen only for a drop.
    const zone = input.closest('[class*="drop" i], [class*="upload" i], [data-automation-id*="drop" i]');
    if (zone) for (const t of ['dragenter', 'dragover', 'drop']) zone.dispatchEvent(new DragEvent(t, { bubbles: true, cancelable: true, dataTransfer: dt }));
    mark(input.closest('div') || input, false);
    return { ok: true, label: labelFor(input) };
  }

  // ---------- navigation buttons ----------
  const buttons = () =>
    deepAll('button, input[type="submit"], input[type="button"], a[role="button"], [role="button"], a.button, a.btn').filter(
      (b) => shown(b) && !b.disabled && b.getAttribute('aria-disabled') !== 'true' && !b.closest('[data-jf-ignore]'),
    );
  const btnText = (b) =>
    clean(b.value || b.innerText || b.textContent || b.getAttribute('aria-label'))
      .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '') // "NEXT ▸", "‹ Back", "Continue →"
      .slice(0, 60);

  const SUBMIT_RE = /^(submit( application| my application| your application)?|send( application)?|apply|finish|complete( application)?|submit & finish|confirm and submit)$/i;
  const NEXT_RE = /^(next( step| page)?|continue|verify( code| email| otp)?|confirm code|submit code|save (and|&) continue|save (and|&) next|proceed|review( application| your application)?|next:.*|continue to .*|→|>)$/i;

  function findSubmit() {
    const list = buttons();
    return list.find((b) => SUBMIT_RE.test(btnText(b))) || list.find((b) => b.type === 'submit' && /submit|apply|send/i.test(btnText(b))) || null;
  }
  function findNext() {
    const list = buttons().filter((b) => !/back|previous|cancel|save draft|save for later/i.test(btnText(b)) && !SUBMIT_RE.test(btnText(b)));
    return list.find((b) => NEXT_RE.test(btnText(b))) || list.find((b) => b.matches('[data-automation-id="bottom-navigation-next-button"], [data-testid*="next" i]')) || null;
  }
  const submitLabel = () => (findSubmit() ? btnText(findSubmit()) : null);
  const nextLabel = () => (findNext() ? btnText(findNext()) : null);

  function click(b) {
    b.scrollIntoView({ block: 'center' });
    b.click();
    return { ok: true, label: btnText(b) };
  }
  const clickNext = () => (findNext() ? click(findNext()) : { ok: false, reason: 'no Next button' });
  const clickSubmit = () => (findSubmit() ? click(findSubmit()) : { ok: false, reason: 'no submit button found' });

  // Validation messages the site shows after a failed Next / Submit.
  function errorTexts() {
    const sel = '[role="alert"], [aria-live="assertive"], .error, .errors, [class*="error-message" i], [class*="field-error" i], [class*="invalid-feedback" i], [data-automation-id="errorMessage"]';
    return [...new Set(deepAll(sel).filter(shown).map((e) => clean(e.textContent)).filter((t) => t && t.length < 200))].slice(0, 10);
  }

  // On a job description page: the "Apply" button / link that opens the form.
  function clickApply() {
    // Never a form's own submit button (some final pages say "Apply"): that would send the application.
    const isFormSubmit = (b) => { const f = b.closest('form'); return !!f && [...f.querySelectorAll('input:not([type=hidden]):not([type=search]), select, textarea')].filter(shown).length >= 2; };
    const cands = [...buttons(), ...deepAll('a')].filter((b) => shown(b) && !isFormSubmit(b)); // Apply buttons often sit in a sticky header, so no chrome filter here
    const b =
      cands.find((b) => /^(apply( now)?|apply for (this )?(job|position|role)|easy apply|i'?m interested|start application|apply on company site)$/i.test(btnText(b))) ||
      cands.find((b) => /\bapply\b/i.test(btnText(b)) && btnText(b).length < 40);
    if (!b) return { ok: false };
    if (b.tagName === 'A' && b.target === '_blank' && b.href && /^https?:/.test(b.href)) location.href = b.href; // keep it in this tab so the panel follows
    else b.click();
    return { ok: true, label: btnText(b) };
  }

  // Final values of every filled field, used to remember your answers for next time.
  async function snapshot() {
    const { fields } = await scan();
    const out = [];
    for (const f of fields) {
      if (f.type === 'file' || !f.filled) continue;
      const members = groups.get(f.id);
      let value;
      if (members) value = members.filter(isChecked).map(optionLabel).join(', ');
      else {
        const el = findById(f.id);
        if (!el) continue;
        if (el.tagName === 'SELECT') value = [...el.selectedOptions].map((o) => clean(o.text)).join(', ');
        else if (el.type === 'checkbox' || /checkbox|switch/.test(el.getAttribute('role') || '')) value = isChecked(el) ? 'Yes' : 'No';
        else if (comboKind(el) === 'dropdown') value = selectedText(el);
        else value = el.isContentEditable ? clean(el.textContent) : el.value;
      }
      if (value) out.push({ label: f.label, type: f.type, options: f.options, value });
    }
    return out;
  }

  // ---------- job info ----------
  // Recruiter emails on a job page ("send your CV to hr@acme.com"), minus the board's own contact addresses.
  function recruiterEmails(description) {
    const site = location.hostname.replace(/^www\./, '').split('.').slice(-2).join('.');
    const found = new Set();
    for (const a of document.querySelectorAll('a[href^="mailto:"]')) found.add(decodeURIComponent(a.getAttribute('href').slice(7).split('?')[0]).trim());
    for (const m of String(description || '').matchAll(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi)) found.add(m[0]);
    return [...found]
      .map((e) => e.toLowerCase().replace(/[.,;:)]+$/, ''))
      .filter((e) => /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/.test(e))
      .filter((e) => !/^(no-?reply|support|help|info|contact|admin|privacy|feedback|hello|team|care|webmaster)@/.test(e) || !e.endsWith(site))
      .filter((e) => !e.endsWith(`@${site}`) || /hr|career|recruit|talent|hiring|jobs/.test(e))
      .slice(0, 5);
  }

  function extractJob() {
    const job = extractJobBase();
    job.emails = recruiterEmails(job.description);
    return job;
  }

  function extractJobBase() {
    for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const data = [JSON.parse(s.textContent)].flat().flatMap((d) => d['@graph'] || d);
        const jp = data.find((d) => [d['@type']].flat().includes('JobPosting'));
        if (jp) {
          // Keep paragraph / bullet breaks; DOMParser does not run scripts or load images.
          const html = (jp.description || '').replace(/<(br|\/p|\/li|\/h\d|\/div|\/ul)[^>]*>/gi, '\n').replace(/<li[^>]*>/gi, '• ');
          const text = new DOMParser().parseFromString(html, 'text/html').body.textContent || '';
          const description = text.split('\n').map(clean).filter(Boolean).join('\n');
          const loc = [jp.jobLocation].flat()[0]?.address;
          const place = clean([loc?.addressLocality, loc?.addressRegion, loc?.addressCountry?.name || loc?.addressCountry].filter(Boolean).join(', '));
          return { title: clean(jp.title), company: clean(jp.hiringOrganization?.name), location: place, description, url: window.location.href, source: 'json-ld' };
        }
      } catch {}
    }
    const meta = (n) => document.querySelector(`meta[property="${n}"], meta[name="${n}"]`)?.content || '';
    // Only what you can see: sites like Oracle Cloud keep hidden dialogs ("Are you still there?") with their own headings.
    const hiddenUi = (n) => !shown(n) || n.closest('[role="dialog"], [role="alertdialog"], [aria-modal="true"], [aria-hidden="true"], dialog:not([open]), [hidden]');
    const sel = '[class*="job-description" i], [class*="jobdescription" i], [id*="job-description" i], [class*="description" i], [data-automation-id="jobPostingDescription"], [class*="posting" i], [class*="job-details" i], article, main, [role="main"]';
    const blocks = [...document.querySelectorAll(sel)].filter((n) => !hiddenUi(n)).map((n) => n.innerText || '').filter((t) => t.length > 300);
    const description = (blocks.sort((a, b) => b.length - a.length)[0] || document.body.innerText).slice(0, 20000);
    const heading = [...document.querySelectorAll('h1, h2, [class*="job-title" i], [data-automation-id="jobPostingHeader"]')].find((h) => !hiddenUi(h) && clean(h.innerText).length > 3 && !/^(are you still|session|sign in|log in|cookie)/i.test(clean(h.innerText)));
    const pageTitle = clean(document.title.split(/\s[|–—-]\s/)[0]);
    return {
      title: clean(heading?.innerText || meta('og:title') || pageTitle || document.title),
      company: clean(meta('og:site_name') || location.hostname.replace(/^www\.|^jobs\.|^careers\.|^boards\./, '').split('.')[0]),
      location: '',
      description: description.replace(/\n{3,}/g, '\n\n').trim(),
      url: location.href,
      source: 'page',
    };
  }

  // On a careers page / job board: the individual job postings.
  // Handles ATS boards (Greenhouse, Lever…), Indian aggregators whose detail pages look like
  // job_details.php?job_id=, /jobs/<id>, /career/internships/<id>, and boards whose cards are buttons (no links).
  const ROLE_WORDS = /engineer|intern|developer|analyst|sde|scientist|manager|designer|associate|trainee|consultant|architect|lead|specialist|executive|programmer|graduate|fresher|apprentice|tester|qa\b|devops|administrator|analytics/i;
  const GENERIC_LINK = /^(apply( now| here)?|view( details| job)?|details|read more|know more|more|see job|open|click here|learn more|\d+)$/i;
  // Card badges (pay, work mode, batch, age) are details, never a job title.
  const BADGE = /^(premium job|hiring now|verified|new|featured|job|internship|full[- ]?time|part[- ]?time|contract|not disclosed|n\/?a|onsite|on-site|remote|hybrid|wfh|work from home|apply( now)?|\d+(\.\d+)?\s*(k|l|lakhs?|lpa|lac|cr|lakh per annum)\b.*|[₹$€£].*|\d{4}\s*batch|batch\s*:?.*|\d+\s*(minutes?|hours?|days?|weeks?|months?)\s*ago|today|yesterday|just now|\d+\s*-\s*\d+\s*(months?|yrs?|years?))$/i;
  const lineList = (el) => (el?.innerText || '').split('\n').map(clean).filter(Boolean).filter((l) => !BADGE.test(l));

  // Lines describing the job a link points to: its own text, else the nearest card heading above it.
  function linesFor(a) {
    const own = lineList(a);
    if (own.length && !GENERIC_LINK.test(own[0])) return own;
    let n = a.parentElement;
    for (let i = 0; n && i < 7; i++, n = n.parentElement) {
      const h = n.querySelector('h1, h2, h3, h4, h5, [class*="title" i]');
      const ht = clean(h?.innerText);
      if (ht && !BADGE.test(ht) && !GENERIC_LINK.test(ht)) return [ht, ...lineList(n).filter((l) => l !== ht)];
    }
    return [];
  }

  // "Teradata / Intern / Hyderabad" -> title "Intern — Teradata", meta "Hyderabad · …"
  function describeCard(lines) {
    if (!lines.length) return null;
    let [a, b, ...rest] = lines;
    if (b && /^[a-z][a-z ]{1,18}\s*:/i.test(b)) [b, rest] = [undefined, [b, ...rest]]; // "Batch : 2027" is detail, not a company
    if (b && /\s?[·•|]\s?/.test(b)) {
      const [company, ...more] = b.split(/\s*[·•|]\s*/).filter(Boolean); // "EY · Bengaluru" -> company + location
      [b, rest] = [company, [...more, ...rest]];
    }
    let title;
    if (b && !ROLE_WORDS.test(a) && ROLE_WORDS.test(b)) title = `${b} — ${a}`;
    else if (b && ROLE_WORDS.test(a) && !ROLE_WORDS.test(b) && b.length < 40) title = `${a} — ${b}`;
    else {
      title = a;
      rest = b ? [b, ...rest] : rest;
    }
    return { title: title.slice(0, 140), meta: rest.filter((l) => l.length < 50 && !GENERIC_LINK.test(l)).slice(0, 3).join(' · ') };
  }

  function collectJobLinks() {
    const ATS = /greenhouse\.io|lever\.co|ashbyhq\.com|myworkdayjobs\.com|workable\.com|smartrecruiters\.com|bamboohr\.com|recruitee\.com|icims\.com|jobvite\.com|wellfound\.com|instahyre\.com|naukri\.com|cutshort\.io|keka\.com|zohorecruit|darwinbox|freshteam/;
    const DETAIL =
      /job[_-]?details?|jobdetail|job-description|\/jobs?\/[^/?#]+|\/careers?\/(jobs?|internships?|openings?)\/[^/?#]+|\/internships?\/[^/?#]+|\/(openings?|positions?|vacanc(y|ies)|roles?)\/[^/?#]+|\/(posts?|p|blog)\/[^/?#]*(hiring|intern|engineer|developer|analyst|sde|recruit|job|off-?campus|freshers?)|[?&](gh_jid|jobid|job_id|jid|lever-source)=/i;
    const LISTING = /\/(job-categor(y|ies)|categor(y|ies)|locations?|batch(es)?|tags?|page|search|filter|premium|about(us)?|contact(us)?|login|sign-?up|register|privacy|terms|faq|experience|interview)(\/|$|\?|\.php)/i;
    const seen = new Map();
    for (const a of document.querySelectorAll('a[href]')) {
      let u;
      try {
        u = new URL(a.href, location.href);
      } catch {
        continue;
      }
      if (!/^https?:$/.test(u.protocol)) continue;
      const sameSite = u.hostname.replace(/^www\./, '') === location.hostname.replace(/^www\./, '');
      const isJob = ATS.test(u.hostname) ? u.pathname.split('/').filter(Boolean).length >= 2 : sameSite && DETAIL.test(u.pathname + u.search) && !LISTING.test(u.pathname);
      if (!isJob) continue;
      const key = u.origin + u.pathname + (u.search.match(/(gh_jid|jobid|job_id|jid|id)=[^&]+/i)?.[0] || '');
      if (key === location.origin + location.pathname + location.search) continue;
      const d = describeCard(linesFor(a));
      if (!d) continue;
      // Several links per card: keep the one whose title names a role.
      const prev = seen.get(key);
      const better = !prev || (!ROLE_WORDS.test(prev.title) && ROLE_WORDS.test(d.title)) || (GENERIC_LINK.test(prev.title) && !GENERIC_LINK.test(d.title));
      if (better) seen.set(key, { ...d, url: u.href });
    }
    // On aggregators the card's own page and its external "Apply" link are the same job: keep the board's page.
    const host = (u) => new URL(u).hostname.replace(/^www\./, '');
    const here = location.hostname.replace(/^www\./, '');
    let jobs = [...seen.values()];
    if (jobs.filter((j) => host(j.url) === here).length >= 2) jobs = jobs.filter((j) => host(j.url) === here);
    if (jobs.length >= 2) return jobs;

    // Cards without links (the site navigates in JavaScript): remember the card's position so it can be clicked open later.
    const cards = deepAll('[class*="job-card" i], [class*="jobcard" i], [class*="job_card" i], [data-job-id], [data-testid*="job-card" i]').filter(shown);
    return cards
      .map((c, i) => {
        const d = describeCard(lineList(c));
        return d && { ...d, card: i, premium: /premium|locked|unlock/i.test(c.innerText), board: location.href };
      })
      .filter(Boolean);
  }

  // Open the n-th link-less job card (clicks its title, or the card itself).
  function openCard(n) {
    const cards = deepAll('[class*="job-card" i], [class*="jobcard" i], [class*="job_card" i], [data-job-id], [data-testid*="job-card" i]').filter(shown);
    const c = cards[n];
    if (!c) return { ok: false };
    const target = c.querySelector('[class*="title" i] , h2, h3, button') || c;
    target.scrollIntoView({ block: 'center' });
    target.click();
    return { ok: true };
  }

  // Real typing (Chrome debugger): put the cursor in the field with its text selected, so the typed text replaces it.
  function prepareType(id) {
    const el = findById(id);
    if (!el) return { ok: false };
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    el.focus();
    if (el.isContentEditable) document.execCommand('selectAll');
    else if (typeof el.select === 'function') el.select();
    return { ok: document.activeElement === el || el.contains(document.activeElement), multiline: el.tagName === 'TEXTAREA' || el.isContentEditable };
  }
  // ---------- eyes: numbered field badges ----------
  // A small "#7" tag beside each field while the screenshots are taken, so the visual check can say
  // "#7 is empty" and the fix lands on exactly that field.
  function badgeFields(ids, start = 1) {
    clearBadges();
    const out = [];
    let n = start;
    for (const id of ids) {
      const el = findById(id) || groups.get(id)?.[0];
      if (!el || !shown(visualBox(el))) continue;
      const r = visualBox(el).getBoundingClientRect();
      const b = document.createElement('div');
      b.className = 'jf-badge';
      b.textContent = `#${n}`;
      Object.assign(b.style, { position: 'absolute', left: `${Math.max(0, r.left + scrollX - 6)}px`, top: `${Math.max(0, r.top + scrollY - 15)}px`, zIndex: '2147483647', background: '#7c3aed', color: '#fff', font: 'bold 11px/15px system-ui, sans-serif', padding: '0 5px', borderRadius: '5px', pointerEvents: 'none', boxShadow: '0 1px 3px rgba(0,0,0,.3)' });
      document.body.appendChild(b);
      out.push({ n, id });
      n++;
    }
    return out;
  }
  function clearBadges() {
    document.querySelectorAll('.jf-badge').forEach((b) => b.remove());
    return true;
  }

  // ---------- real clicks: where to click ----------
  // Points are in the top window's viewport (the debugger clicks there), so add the offsets of same-site iframes.
  // A cross-site iframe can't be measured from inside: no point, and the panel falls back to the normal fill.
  function topOffset() {
    let x = 0;
    let y = 0;
    try {
      for (let w = window; w !== w.top; w = w.parent) {
        const fe = w.frameElement;
        if (!fe) return null;
        const r = fe.getBoundingClientRect();
        x += r.left + fe.clientLeft;
        y += r.top + fe.clientTop;
      }
    } catch {
      return null;
    }
    return { x, y };
  }
  function centerOf(node) {
    const off = topOffset();
    if (!node || !off) return null;
    node.scrollIntoView({ block: 'center', behavior: 'instant' });
    const r = node.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    return { x: Math.round(off.x + r.left + Math.min(r.width / 2, 40)), y: Math.round(off.y + r.top + r.height / 2) };
  }
  // Where to click for a field: the matching radio / checkbox option, or the visible box of a dropdown.
  function clickPoint(id, value) {
    const members = groups.get(id);
    if (members) {
      const i = members.length === 1 ? 0 : bestMatch(members.map(optionLabel), String(Array.isArray(value) ? value[0] : value));
      if (i < 0) return null;
      const m = members[i];
      return centerOf(shown(m) ? m : m.labels?.[0] || m.closest('label') || m.parentElement);
    }
    const el = findById(id);
    if (!el) return null;
    // A single checkbox / radio / switch: click the control itself (its row may be a label the page ignores).
    if (['checkbox', 'radio'].includes(el.type) || /checkbox|radio|switch/.test(el.getAttribute('role') || '')) return centerOf(shown(el) ? el : el.labels?.[0] || el.parentElement);
    return centerOf(visualBox(el));
  }
  // The option to click in whatever list is open now.
  function optionPoint(value) {
    const opts = deepAll(OPTION_SEL).filter((o) => shown(o) && o.getAttribute('aria-disabled') !== 'true');
    const i = bestMatch(optionTexts(opts), String(value));
    return i < 0 ? null : centerOf(opts[i]);
  }
  const checkValue = (id, value) => holds(id, value);
  // What real typing should type into a box: just its part for split date boxes ("05" of "May 2026").
  const boxValue = (id, value) => {
    const el = findById(id);
    const part = el && dateSection(el);
    return part ? datePart(value, part) || value : value;
  };
  // Outbound links on the job page (a "company website" link is often among them), for company research.
  const pageLinks = () => [...new Set([...document.querySelectorAll('a[href^="http"]')].map((a) => a.href).filter((h) => { try { return new URL(h).hostname !== location.hostname; } catch { return false; } }))].slice(0, 25);
  // "Show me": bring a field you need to fix into view, outline it red and put the cursor in it.
  function jumpTo(id) {
    const el = findById(id) || groups.get(id)?.[0];
    if (!el) return false;
    const box = visualBox(el);
    box.scrollIntoView({ block: 'center', behavior: 'smooth' });
    box.style.outline = '3px solid #ef4444';
    box.style.outlineOffset = '3px';
    el.focus?.({ preventScroll: true });
    return true;
  }
  // The site's own error on one field right now ('' when it has none).
  const fieldError = (id) => { const m = groups.get(id); return m ? m.map(errorFor).find(Boolean) || '' : errorFor(findById(id)); };

  // For page screenshots: page height, viewport height, and scrolling to a slice.
  const pageMetrics = () => ({ height: Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0), view: innerHeight, y: scrollY });
  function scrollToY(y) {
    scrollTo({ top: y, behavior: 'instant' });
    return scrollY;
  }

  // Signature of the current form step, to tell whether Next actually moved on.
  const pageKey = () => deepAll(CONTROL).filter(shown).map((e) => e.name || e.id || labelFor(e).slice(0, 30)).join('|').slice(0, 2000) + '#' + location.href;

  window.__jobfill = {
    version: 8,
    scan,
    fill,
    uploadFile,
    snapshot,
    clickNext,
    clickSubmit,
    clickApply,
    nextLabel,
    submitLabel,
    errorTexts,
    pageKey,
    extractJob,
    collectJobLinks,
    openCard,
    fieldErrors,
    readFieldValue,
    waitStable,
    addEntry,
    sectionEntries,
    addLinkRows,
    lostValues,
    openFixCard,
    focusCaptcha,
    focusPassword,
    prepareType,
    badgeFields,
    clearBadges,
    clickPoint,
    optionPoint,
    checkValue,
    boxValue,
    pageLinks,
    jumpTo,
    fieldError,
    pageMetrics,
    scrollToY,
    saveOpenCard,
  };
})();
