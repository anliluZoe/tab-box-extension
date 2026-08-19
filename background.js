// 后台统计：记录每个网页每天被“点开”的次数，以及最后一次活跃时间。数据保留 7 天。
// Edge / Chrome 均使用 chrome.* API（Edge Chromium 原生兼容）。

const KEEP_DAYS = 7;
const COUNT_DEBOUNCE_MS = 3000;

let writeQueue = Promise.resolve();
const lastCountedAt = new Map();

function recordVisit(tab) {
  if (!tab || !tab.url || !/^https?:/.test(tab.url)) return;
  const url = tab.url.split('#')[0];
  const now = Date.now();
  const shouldCount = now - (lastCountedAt.get(url) || 0) >= COUNT_DEBOUNCE_MS;
  lastCountedAt.set(url, now);

  writeQueue = writeQueue
    .then(async () => {
      const stored = await chrome.storage.local.get(['stats', 'lastActive']);
      const stats = stored.stats || {};
      const lastActive = stored.lastActive || {};

      const today = new Date().toLocaleDateString('sv');
      if (!stats[today]) stats[today] = {};
      if (shouldCount) stats[today][url] = (stats[today][url] || 0) + 1;
      lastActive[url] = now;

      const cutoff = new Date(now - KEEP_DAYS * 86400000).toLocaleDateString('sv');
      for (const day of Object.keys(stats)) {
        if (day < cutoff) delete stats[day];
      }
      for (const [u, t] of Object.entries(lastActive)) {
        if (now - t > KEEP_DAYS * 86400000) delete lastActive[u];
      }

      await chrome.storage.local.set({ stats, lastActive });
    })
    .catch(() => {});
}

async function updateBadge() {
  try {
    const tabs = await chrome.tabs.query({});
    const text = tabs.length > 99 ? '99+' : String(tabs.length);
    await chrome.action.setBadgeText({ text });
    await chrome.action.setBadgeBackgroundColor({ color: '#0F6B6B' });
  } catch {
    // 扩展刚装上或窗口尚未就绪时忽略
  }
}

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    recordVisit(await chrome.tabs.get(tabId));
  } catch {
    // 标签页可能已被关闭
  }
});

chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.active) recordVisit(tab);
});

chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  try {
    const [tab] = await chrome.tabs.query({ active: true, windowId });
    recordVisit(tab);
  } catch {
    // ignore
  }
});

chrome.tabs.onCreated.addListener(updateBadge);
chrome.tabs.onRemoved.addListener(updateBadge);
chrome.runtime.onStartup.addListener(updateBadge);
chrome.runtime.onInstalled.addListener(updateBadge);
updateBadge();
