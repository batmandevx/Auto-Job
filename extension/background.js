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
    if (msg.mode === 'sidepanel') {
      chrome.storage.session.set({ panelAliveAt: Date.now() });
      // The real side panel just loaded, so this browser supports it (Chrome, Edge, Brave; never Arc):
      // from now on the toolbar icon opens the sidebar instead of the popup.
      chrome.storage.local.set({ sidePanelWorks: true });
      useSidePanelForIcon();
    }
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

// Toolbar icon: the popup by default (the one thing Arc shows), the real side panel once we know it works here.
// The choice is applied every time the worker starts, since action settings don't survive a browser restart.
async function useSidePanelForIcon() {
  await chrome.action.setPopup({ popup: '' }).catch(() => {});
  await chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true }).catch(() => {});
}
async function applyIconMode() {
  const { sidePanelWorks } = await chrome.storage.local.get('sidePanelWorks');
  if (sidePanelWorks && typeof chrome.sidePanel?.setPanelBehavior === 'function') return useSidePanelForIcon();
  // Popup mode: we handle side panel opening ourselves, otherwise Arc swallows the click and nothing opens.
  await chrome.action.setPopup({ popup: 'sidepanel.html' }).catch(() => {});
  await chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: false }).catch(() => {});
}
applyIconMode();
chrome.runtime.onStartup.addListener(applyIconMode);

chrome.windows.onRemoved.addListener(async (id) => {
  if (id === (await getWin())) setWin(null);
});

// Menus persist across restarts, so they only need creating on install / update.
chrome.runtime.onInstalled.addListener(() => {
  applyIconMode();
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'open-window', title: 'Open Auto Job in a window', contexts: ['action'] });
    if (typeof chrome.sidePanel?.open === 'function') chrome.contextMenus.create({ id: 'open-sidebar', title: 'Open Auto Job as sidebar', contexts: ['action'] });
  });
});
// Menu clicks and shortcuts count as your own action, so the side panel can open from here.
// open() is called first thing: Chrome refuses it once anything has been awaited.
function openSidebar(windowId) {
  if (typeof chrome.sidePanel?.open !== 'function' || windowId == null) return openPanelWindow();
  chrome.sidePanel.open({ windowId }).catch(() => openPanelWindow());
}
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'open-window') openPanelWindow();
  if (info.menuItemId === 'open-sidebar') openSidebar(tab?.windowId);
});
chrome.commands.onCommand.addListener((cmd, tab) => {
  if (cmd === 'open-window') openPanelWindow();
  if (cmd === 'open-sidebar') openSidebar(tab?.windowId);
});
