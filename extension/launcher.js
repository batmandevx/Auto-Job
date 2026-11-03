// The toolbar popup: every Chromium browser (Arc included) shows extension popups, so this is the one
// entry point that always works. It opens Auto Job as a tab, a window, or the side panel.

const $ = (s) => document.querySelector(s);
const panelUrl = (mode) => chrome.runtime.getURL(`sidepanel.html?mode=${mode}`);

async function currentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

// Reuse an already-open Auto Job tab instead of opening a second one.
async function openAsTab() {
  const tab = await currentTab();
  const base = chrome.runtime.getURL('sidepanel.html');
  const existing = (await chrome.tabs.query({})).find((t) => t.url?.startsWith(base) && /mode=tab/.test(t.url));
  if (existing) {
    await chrome.tabs.update(existing.id, { active: true });
    await chrome.windows.update(existing.windowId, { focused: true }).catch(() => {});
    return;
  }
  await chrome.tabs.create({ url: panelUrl('tab'), index: tab ? tab.index + 1 : undefined, windowId: tab?.windowId });
}

async function openAsWindow() {
  const reply = await chrome.runtime.sendMessage({ type: 'open-window' }).catch(() => null);
  if (!reply?.ok) throw new Error(reply?.error || 'This browser did not open a window');
}

async function openSidePanel() {
  const tab = await currentTab();
  if (typeof chrome.sidePanel?.open !== 'function') throw new Error('This browser has no side panel');
  await chrome.sidePanel.open({ windowId: tab.windowId });
  // Arc accepts the call but never shows the panel: check that it really loaded.
  const since = Date.now();
  for (let i = 0; i < 8; i++) {
    await new Promise((r) => setTimeout(r, 125));
    const ok = await chrome.runtime.sendMessage({ type: 'side-panel-open?', since }).catch(() => false);
    if (ok) return;
  }
  throw new Error('The side panel did not appear in this browser');
}

const OPENERS = { tab: openAsTab, window: openAsWindow, sidepanel: openSidePanel };

async function go(mode, { remember } = {}) {
  $('#msg').textContent = '';
  try {
    await OPENERS[mode]();
    if (remember) await chrome.storage.local.set({ openMode: mode });
    window.close();
  } catch (e) {
    // Whatever failed, a tab always works.
    if (mode !== 'tab') {
      $('#msg').textContent = `${e.message}. Opening as a tab instead…`;
      await openAsTab().catch(() => {});
      if (remember) await chrome.storage.local.set({ openMode: 'tab' });
      setTimeout(() => window.close(), 900);
    } else $('#msg').textContent = e.message;
  }
}

document.querySelectorAll('button.opt').forEach((b) => b.addEventListener('click', () => go(b.dataset.mode, { remember: $('#remember').checked })));

// Hide the side-panel option where the API isn't there at all.
if (typeof chrome.sidePanel?.open !== 'function') $('#sideBtn').style.display = 'none';

// A remembered choice opens straight away. (Side panel needs the button press in some browsers, so it stays a click.)
chrome.storage.local.get('openMode').then(({ openMode }) => {
  if (openMode === 'tab' || openMode === 'window') go(openMode);
  else if (openMode === 'sidepanel') {
    $('#remember').checked = true;
    $('#sideBtn').classList.add('main');
  }
});
