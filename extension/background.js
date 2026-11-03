// Toolbar icon → launcher popup (launcher.html), which every Chromium browser shows, Arc included.
// From there Auto Job opens as a tab, a window or (where it really works) the side panel.
// Arc exposes chrome.sidePanel but never displays it, so the API's presence proves nothing:
// we ask for the panel, check it actually loaded, and fall back to the window if it didn't.

const canOpenSidePanel = typeof chrome.sidePanel?.open === 'function';

// The worker can be stopped between clicks, so the open window's id lives in session storage.
const getWin = async () => (await chrome.storage.session.get('panelWindowId')).panelWindowId ?? null;
const setWin = (id) => chrome.storage.session.set({ panelWindowId: id });

async function openPanelWindow() {
  const existing = await getWin();
  if (existing !== null) {
    try {
      await chrome.windows.update(existing, { focused: true });
      return;
    } catch {
      await setWin(null); // it was closed
    }
  }
  const browser = await chrome.windows.getLastFocused({ windowTypes: ['normal'] }).catch(() => null);
  const width = 440;
  const height = Math.min(Math.max(browser?.height || 860, 640), 1100);
  const left = browser ? Math.max(0, browser.left + browser.width - width - 12) : undefined;
  const top = browser ? browser.top + 40 : undefined;
  const win = await chrome.windows.create({ url: chrome.runtime.getURL('sidepanel.html?mode=window'), type: 'popup', width, height, left, top, focused: true });
  await setWin(win.id);
}

// Is our side panel page actually running?
async function sidePanelIsOpen(since) {
  if (typeof chrome.runtime.getContexts === 'function') {
    const ctx = await chrome.runtime.getContexts({ contextTypes: ['SIDE_PANEL'] }).catch(() => []);
    if (ctx.length) return true;
  }
  return ((await chrome.storage.session.get('panelAliveAt')).panelAliveAt || 0) >= since;
}

// Messages from the panel and the launcher popup.
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg?.type === 'panel-alive') {
    if (msg.mode === 'sidepanel') chrome.storage.session.set({ panelAliveAt: Date.now() });
    return false;
  }
  if (msg?.type === 'side-panel-open?') {
    sidePanelIsOpen(msg.since).then(reply);
    return true; // async reply
  }
  if (msg?.type === 'open-window') {
    openPanelWindow().then(() => reply({ ok: true })).catch((e) => reply({ ok: false, error: e.message }));
    return true;
  }
  if (msg?.type === 'last-web-tab') {
    chrome.storage.session.get('lastWebTab').then(({ lastWebTab }) => reply(lastWebTab ?? null));
    return true;
  }
  return false;
});

// Remember the last real web page you looked at, so a panel opened as a tab or window
// still knows which page to work on while you're clicking inside it.
const rememberWebTab = (tab) => {
  if (tab?.id && /^https?:/.test(tab.url || '')) chrome.storage.session.set({ lastWebTab: { id: tab.id, windowId: tab.windowId, url: tab.url, at: Date.now() } });
};
chrome.tabs.onActivated.addListener(({ tabId }) => chrome.tabs.get(tabId).then(rememberWebTab).catch(() => {}));
chrome.tabs.onUpdated.addListener((id, info, tab) => {
  if (info.status === 'complete' && tab.active) rememberWebTab(tab);
});

async function openPanel(tab) {
  const since = Date.now();
  if (canOpenSidePanel && tab?.windowId !== undefined) {
    try {
      // First call in the click handler: sidePanel.open needs the user's click.
      await chrome.sidePanel.open({ windowId: tab.windowId });
      for (let i = 0; i < 8; i++) {
        await new Promise((r) => setTimeout(r, 125));
        if (await sidePanelIsOpen(since)) return;
      }
    } catch {
      // not supported here: use the window
    }
  }
  await openPanelWindow();
}

// Listeners are registered synchronously at load: an MV3 worker woken by a click only sees those.
chrome.action.onClicked.addListener((tab) => openPanel(tab));

// We handle the click ourselves (not openPanelOnActionClick), otherwise Arc swallows it and nothing opens.
if (typeof chrome.sidePanel?.setPanelBehavior === 'function') chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});

chrome.windows.onRemoved.addListener(async (id) => {
  if (id === (await getWin())) setWin(null);
});

// Menus persist across restarts, so they only need creating on install / update.
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'open-window', title: 'Open Auto Job in a window', contexts: ['action'] });
  });
});
chrome.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId === 'open-window') openPanelWindow();
});
chrome.commands.onCommand.addListener((cmd) => {
  if (cmd === 'open-window') openPanelWindow();
});
