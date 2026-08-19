// 后台：访问统计、角标、右键菜单快捷入口。
// Edge / Chrome 均使用 chrome.* API。

const KEEP_DAYS = 7;
const COUNT_DEBOUNCE_MS = 3000;
const GROUP_COLORS = ['blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];

let writeQueue = Promise.resolve();
const lastCountedAt = new Map();

function tabUrlKey(url) {
  return (url || '').split('#')[0];
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function recordVisit(tab) {
  if (!tab || !tab.url || !/^https?:/.test(tab.url)) return;
  const url = tabUrlKey(tab.url);
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

async function openManager() {
  try {
    if (chrome.action.openPopup) {
      await chrome.action.openPopup();
      return;
    }
  } catch {
    // 部分浏览器不支持从右键直接打开 action popup
  }
  await chrome.windows.create({
    url: 'popup.html',
    type: 'popup',
    width: 440,
    height: 620,
  });
}

async function applyGroup(windowId, host, tabIds, existingGroups) {
  if (tabIds.length < 2) return;
  try {
    const found = (existingGroups || []).find((g) => g.title === host);
    if (found) {
      await chrome.tabs.group({ tabIds, groupId: found.id });
      return;
    }
    const groupId = await chrome.tabs.group({ tabIds, createProperties: { windowId } });
    let hash = 0;
    for (const ch of host) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
    await chrome.tabGroups.update(groupId, {
      title: host,
      color: GROUP_COLORS[hash % GROUP_COLORS.length],
    });
  } catch (err) {
    console.warn('分组失败:', host, err);
  }
}

async function groupByDomain(filterWindowId, filterHost) {
  const query = filterWindowId != null ? { windowId: filterWindowId } : {};
  const tabs = await chrome.tabs.query(query);
  const pending = new Map();

  for (const tab of tabs) {
    if (tab.pinned || !tab.url || !/^https?:/.test(tab.url)) continue;
    const host = hostOf(tab.url);
    if (!host) continue;
    if (filterHost && host !== filterHost) continue;
    const key = `${tab.windowId}|${host}`;
    if (!pending.has(key)) pending.set(key, { windowId: tab.windowId, host, tabIds: [] });
    pending.get(key).tabIds.push(tab.id);
  }

  const existingByWindow = new Map();
  for (const { windowId } of pending.values()) {
    if (existingByWindow.has(windowId)) continue;
    existingByWindow.set(windowId, await chrome.tabGroups.query({ windowId }));
  }

  for (const { windowId, host, tabIds } of pending.values()) {
    await applyGroup(windowId, host, tabIds, existingByWindow.get(windowId));
  }
}

const autoGroupTimers = new Map();

function scheduleAutoGroup(windowId, host) {
  if (windowId == null || !host) return;
  const key = `${windowId}|${host}`;
  const prev = autoGroupTimers.get(key);
  if (prev) clearTimeout(prev);
  autoGroupTimers.set(
    key,
    setTimeout(async () => {
      autoGroupTimers.delete(key);
      try {
        const { prefs = {} } = await chrome.storage.local.get('prefs');
        if (prefs.autoGroup === false) return;
        await groupByDomain(windowId, host);
      } catch (err) {
        console.warn('自动分组失败:', host, err);
      }
    }, 700)
  );
}

const autoDedupeTimers = new Map();
const tabOpenedAt = new Map();

async function rememberOpenTabs() {
  try {
    const tabs = await chrome.tabs.query({});
    const now = Date.now();
    for (const tab of tabs) {
      if (!tabOpenedAt.has(tab.id)) tabOpenedAt.set(tab.id, now - (tabs.length - tab.index) * 10);
    }
  } catch {
    // ignore
  }
}

async function closeDuplicateTabs(keepTabId) {
  const tabs = await chrome.tabs.query({});
  const byUrl = new Map();
  for (const tab of tabs) {
    if (tab.pinned || !/^https?:/.test(tab.url || '')) continue;
    const key = tabUrlKey(tab.url);
    if (!byUrl.has(key)) byUrl.set(key, []);
    byUrl.get(key).push(tab);
  }

  const toClose = [];
  for (const list of byUrl.values()) {
    if (list.length < 2) continue;
    // 越早打开的优先关掉，保留最新打开的（或明确指定要保留的标签页）
    list.sort((a, b) => (tabOpenedAt.get(a.id) ?? a.id) - (tabOpenedAt.get(b.id) ?? b.id));
    const keepId =
      keepTabId && list.some((t) => t.id === keepTabId)
        ? keepTabId
        : list[list.length - 1].id;
    for (const tab of list) {
      if (tab.id !== keepId) toClose.push(tab.id);
    }
  }
  if (toClose.length) await chrome.tabs.remove(toClose);
}

function scheduleAutoDedupe(tab) {
  if (!tab?.id || tab.pinned || !/^https?:/.test(tab.url || '')) return;
  const urlKey = tabUrlKey(tab.url);
  const prev = autoDedupeTimers.get(urlKey);
  if (prev) clearTimeout(prev);
  autoDedupeTimers.set(
    urlKey,
    setTimeout(async () => {
      autoDedupeTimers.delete(urlKey);
      try {
        const { prefs = {} } = await chrome.storage.local.get('prefs');
        if (prefs.autoDedupe === false) return;
        await closeDuplicateTabs(tab.id);
      } catch (err) {
        console.warn('自动去重失败:', urlKey, err);
      }
    }, 500)
  );
}

async function closeUnvisitedToday() {
  const [tabs, stored] = await Promise.all([
    chrome.tabs.query({}),
    chrome.storage.local.get(['stats']),
  ]);
  const today = new Date().toLocaleDateString('sv');
  const todayStats = (stored.stats || {})[today] || {};
  const ids = tabs
    .filter((t) => !t.pinned && !t.active && !todayStats[tabUrlKey(t.url)])
    .map((t) => t.id);
  if (ids.length) await chrome.tabs.remove(ids);
}

async function closeSameDomainTabs(tab, keepCurrent) {
  const host = hostOf(tab?.url);
  if (!host) return;
  const tabs = await chrome.tabs.query({ windowId: tab.windowId });
  const ids = tabs
    .filter((t) => {
      if (t.pinned) return false;
      if (keepCurrent && t.id === tab.id) return false;
      return hostOf(t.url) === host;
    })
    .map((t) => t.id);
  if (ids.length) await chrome.tabs.remove(ids);
}

async function setupContextMenus() {
  try {
    await chrome.contextMenus.removeAll();

    // 'all' 覆盖链接/图片/选中文字等；单独加 'action' 让工具栏图标右键也能看到
    const contexts = ['all', 'action'];

    await chrome.contextMenus.create({
      id: 'tab-manager',
      title: '标签页管家',
      contexts,
    });

    const items = [
      { id: 'open-manager', title: '打开标签页管家' },
      { id: 'group-by-domain', title: '按域名分组' },
      { id: 'close-duplicates', title: '关闭重复（保留最新）' },
      { id: 'close-unvisited', title: '关闭今日未访问' },
      { id: 'sep-1', type: 'separator' },
      { id: 'close-same-domain-others', title: '关闭同域名其他标签页' },
      { id: 'close-same-domain-all', title: '关闭同域名全部标签页' },
    ];

    for (const item of items) {
      await chrome.contextMenus.create({
        id: item.id,
        parentId: 'tab-manager',
        title: item.title || undefined,
        type: item.type || 'normal',
        contexts,
      });
    }
  } catch (err) {
    console.error('注册右键菜单失败:', err);
  }
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  try {
    switch (info.menuItemId) {
      case 'open-manager':
        await openManager();
        break;
      case 'group-by-domain':
        await groupByDomain();
        break;
      case 'close-duplicates':
        await closeDuplicateTabs();
        break;
      case 'close-unvisited':
        await closeUnvisitedToday();
        break;
      case 'close-same-domain-others':
        await closeSameDomainTabs(tab, true);
        break;
      case 'close-same-domain-all':
        await closeSameDomainTabs(tab, false);
        break;
      default:
        break;
    }
  } catch (err) {
    console.warn('右键菜单操作失败:', info.menuItemId, err);
  }
  updateBadge();
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'group-all-now') {
    groupByDomain()
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }
  if (message?.type === 'dedupe-all-now') {
    closeDuplicateTabs()
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }
  return false;
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    recordVisit(await chrome.tabs.get(tabId));
  } catch {
    // 标签页可能已被关闭
  }
});

chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.active) recordVisit(tab);
  if (tab.pinned) return;
  if (changeInfo.status === 'complete' && /^https?:/.test(tab.url || '')) {
    scheduleAutoDedupe(tab);
  }
  if (changeInfo.url || changeInfo.status === 'complete') {
    const host = hostOf(tab.url);
    if (host && /^https?:/.test(tab.url || '')) scheduleAutoGroup(tab.windowId, host);
  }
});

chrome.tabs.onCreated.addListener((tab) => {
  tabOpenedAt.set(tab.id, Date.now());
  updateBadge();
  if (tab.pinned) return;
  const host = hostOf(tab.url);
  if (host && /^https?:/.test(tab.url || '')) scheduleAutoGroup(tab.windowId, host);
  if (/^https?:/.test(tab.url || '')) scheduleAutoDedupe(tab);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabOpenedAt.delete(tabId);
  updateBadge();
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

chrome.runtime.onStartup.addListener(() => {
  rememberOpenTabs();
  updateBadge();
  setupContextMenus();
});
chrome.runtime.onInstalled.addListener(() => {
  rememberOpenTabs();
  updateBadge();
  setupContextMenus();
});

rememberOpenTabs();
updateBadge();
setupContextMenus();
