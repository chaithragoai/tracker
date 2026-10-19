/**
 * Chrome MV3 service worker — tab sessions + operation relay to local server.
 */
import { domainOf, isProtectedUrl, isExcluded as hostExcluded, sanitizeMetadata } from './lib/privacy.js';

const SERVER = 'http://127.0.0.1:8787';
const BROWSER = 'Chrome';

/** @type {Map<number, { sessionId: string, url: string, title: string, domain: string, startedAt: string }>} */
const tabSessions = new Map();
let trackingEnabled = true;
let excludedDomains = new Set();

chrome.runtime.onInstalled.addListener(async () => {
  const stored = await chrome.storage.local.get(['trackingEnabled', 'excludedDomains']);
  trackingEnabled = stored.trackingEnabled !== false;
  excludedDomains = new Set(stored.excludedDomains || []);
  await syncActiveTabs();
});

chrome.storage.onChanged.addListener((changes) => {
  if (changes.trackingEnabled) trackingEnabled = changes.trackingEnabled.newValue !== false;
  if (changes.excludedDomains) excludedDomains = new Set(changes.excludedDomains.newValue || []);
});

chrome.tabs.onCreated.addListener(async (tab) => {
  if (!trackingEnabled || tab.id == null) return;
  // Session starts when URL is known / activated
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  if (!trackingEnabled) return;
  await endOtherWindowSessions(tabId);
  try {
    const tab = await chrome.tabs.get(tabId);
    await startOrUpdateTabSession(tab, 'activated');
  } catch {
    // Tab may be gone
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (!trackingEnabled) return;
  if (changeInfo.status === 'complete' || changeInfo.url || changeInfo.title) {
    await startOrUpdateTabSession(tab, changeInfo.url ? 'navigated' : 'updated');
    if (changeInfo.status === 'complete') {
      await postEvent({
        type: 'navigation',
        outcome: 'success',
        browser: BROWSER,
        tabSessionId: tabSessions.get(tabId)?.sessionId,
        tab: tabPayload(tab),
        metadata: { phase: 'complete' },
      });
    }
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  await endTabSession(tabId, 'closed');
});

chrome.webNavigation?.onErrorOccurred?.addListener(async (details) => {
  if (details.frameId !== 0) return;
  const session = tabSessions.get(details.tabId);
  await postEvent({
    type: 'navigation',
    outcome: 'failure',
    browser: BROWSER,
    tabSessionId: session?.sessionId,
    metadata: {
      error: details.error,
      url: details.url,
      semantic: 'page_load_error',
    },
  });
});

chrome.downloads?.onCreated?.addListener(async (item) => {
  if (!trackingEnabled) return;
  await postEvent({
    type: 'download',
    outcome: 'unknown',
    browser: BROWSER,
    metadata: {
      semantic: 'download_started',
      filename: item.filename ? item.filename.split('/').pop() : undefined,
      mime: item.mime,
      // Never store full local paths beyond basename
    },
  });
});

chrome.downloads?.onChanged?.addListener(async (delta) => {
  if (!trackingEnabled || !delta.state) return;
  const state = delta.state.current;
  let outcome = 'unknown';
  if (state === 'complete') outcome = 'success';
  if (state === 'interrupted') outcome = 'failure';
  await postEvent({
    type: 'download',
    outcome,
    browser: BROWSER,
    metadata: { semantic: 'download_state', state },
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    if (message?.type === 'getStatus') {
      sendResponse({ trackingEnabled, server: SERVER });
      return;
    }
    if (message?.type === 'setTracking') {
      trackingEnabled = !!message.enabled;
      await chrome.storage.local.set({ trackingEnabled });
      sendResponse({ trackingEnabled });
      return;
    }
    if (message?.type === 'pageOperation') {
      if (!trackingEnabled) {
        sendResponse({ ok: false });
        return;
      }
      const tab = sender.tab;
      const session = tab?.id != null ? tabSessions.get(tab.id) : null;
      if (tab && isExcluded(tab.url)) {
        sendResponse({ ok: false, reason: 'excluded' });
        return;
      }
      await postEvent({
        type: message.operationType || 'operation',
        outcome: message.outcome || 'unknown',
        browser: BROWSER,
        tabSessionId: session?.sessionId,
        tab: tab ? tabPayload(tab) : undefined,
        metadata: sanitizeMetadata(message.metadata || {}),
      });
      sendResponse({ ok: true });
      return;
    }
    sendResponse({ ok: false });
  })();
  return true;
});

async function syncActiveTabs() {
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  for (const tab of tabs) {
    await startOrUpdateTabSession(tab, 'sync');
  }
}

async function endOtherWindowSessions(activeTabId) {
  for (const [tabId] of tabSessions) {
    if (tabId !== activeTabId) {
      // Keep sessions for background tabs; only end on close/navigate away.
    }
  }
}

async function startOrUpdateTabSession(tab, reason) {
  if (!tab?.id || !tab.url) return;
  if (isProtectedUrl(tab.url) || isExcluded(tab.url)) return;

  const domain = domainOf(tab.url);
  const existing = tabSessions.get(tab.id);

  if (existing && existing.url === tab.url) {
    // Title-only update
    existing.title = tab.title || existing.title;
    tabSessions.set(tab.id, existing);
    return;
  }

  if (existing) {
    await endTabSession(tab.id, reason === 'navigated' ? 'navigated' : 'replaced');
  }

  const sessionId = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  const record = {
    sessionId,
    url: tab.url,
    title: tab.title || '',
    domain,
    startedAt,
  };
  tabSessions.set(tab.id, record);

  await postEvent({
    type: 'tabSessionStarted',
    outcome: 'success',
    browser: BROWSER,
    tabSessionId: sessionId,
    tab: tabPayload(tab),
    domain,
    url: tab.url,
    title: tab.title,
    metadata: { reason },
  });
}

async function endTabSession(tabId, reason) {
  const existing = tabSessions.get(tabId);
  if (!existing) return;
  tabSessions.delete(tabId);
  const endedAt = new Date().toISOString();
  const durationSeconds = Math.max(0, (Date.parse(endedAt) - Date.parse(existing.startedAt)) / 1000);
  await postEvent({
    type: 'tabSessionEnded',
    outcome: 'success',
    browser: BROWSER,
    tabSessionId: existing.sessionId,
    durationSeconds,
    url: existing.url,
    title: existing.title,
    domain: existing.domain,
    tab: {
      tabId,
      title: existing.title,
      url: existing.url,
      domain: existing.domain,
      browser: BROWSER,
    },
    metadata: { reason },
  });
}

function tabPayload(tab) {
  return {
    tabId: tab.id,
    title: tab.title || '',
    url: tab.url || '',
    domain: domainOf(tab.url || ''),
    browser: BROWSER,
  };
}

function isExcluded(url) {
  return hostExcluded(url, [...excludedDomains]);
}

async function postEvent(event) {
  const payload = {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    source: 'chrome-extension',
    ...event,
  };
  try {
    await fetch(`${SERVER}/api/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch {
    // Server may be offline — drop for now (local queue can be added later)
  }
}
