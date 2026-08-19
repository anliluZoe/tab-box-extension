// 后台：访问统计、角标、右键菜单、自动分组/去重。
// 性能要点：内存缓存偏好、角标增量更新、跳过无变化写入与已分组域名。

const KEEP_DAYS = 7;
const COUNT_DEBOUNCE_MS = 3000;
const LAST_ACTIVE_WRITE_MS = 30000;
const AUTO_DEBOUNCE_MS = 800;
const GROUP_COLORS = ['blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];
const HTTP_RE = /^https?:/;

let writeQueue = Promise.resolve();
let tabCount = 0;
let badgeTimer = 0;
let prefs = { autoGroup: true, autoDedupe: true };
let cleanupDay = '';

const lastCountedAt = new Map();
const lastActiveWrittenAt = new Map();
const autoTimers = new Map();
const tabOpenedAt = new Map();

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

function todayKey() {
  return new Date().toLocaleDateString('sv');
}

async function loadPrefs() {
  try {
    const stored = await chrome.storage.local.get('prefs');
    const p = stored.prefs || {};
    prefs = {
      autoGroup: p.autoGroup !== false,
      autoDedupe: p.autoDedupe !== false,
    };
  } catch {
    // keep defaults
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.prefs) return;
  const p = changes.prefs.newValue || {};
  prefs = {
    autoGroup: p.autoGroup !== false,
    autoDedupe: p.autoDedupe !== false,
  };
});

function recordVisit(tab) {
  if (!tab || !tab.url || !HTTP_RE.test(tab.url)) return;
  const url = tabUrlKey(tab.url);
  const now = Date.now();
  const shouldCount = now - (lastCountedAt.get(url) || 0) >= COUNT_DEBOUNCE_MS;
  if (shouldCount) lastCountedAt.set(url, now);

  // 仅刷新活跃时间时节流，避免来回切标签频繁写盘
  if (!shouldCount && now - (lastActiveWrittenAt.get(url) || 0) < LAST_ACTIVE_WRITE_MS) return;

  writeQueue = writeQueue
    .then(async () => {
      const stored = await chrome.storage.local.get(['stats', 'lastActive']);
      const stats = stored.stats || {};
      const lastActive = stored.lastActive || {};
      const today = todayKey();

      if (!stats[today]) stats[today] = {};
      if (shouldCount) stats[today][url] = (stats[today][url] || 0) + 1;
      lastActive[url] = now;
      lastActiveWrittenAt.set(url, now);

      // 一天最多清理一次过期数据
      if (cleanupDay !== today) {
        cleanupDay = today;
        const cutoff = new Date(now - KEEP_DAYS * 86400000).toLocaleDateString('sv');
        for (const day of Object.keys(stats)) {
          if (day < cutoff) delete stats[day];
        }
        for (const [u, t] of Object.entries(lastActive)) {
          if (now - t > KEEP_DAYS * 86400000) delete lastActive[u];
        }
      }

      await chrome.storage.local.set({ stats, lastActive });
    })
    .catch(() => {});
}

function scheduleBadge() {
  if (badgeTimer) return;
  badgeTimer = setTimeout(async () => {
    badgeTimer = 0;
    try {
      const text = tabCount > 99 ? '99+' : String(Math.max(0, tabCount));
      await chrome.action.setBadgeText({ text });
      await chrome.action.setBadgeBackgroundColor({ color: '#0F6B6B' });
    } catch {
      // ignore
    }
  }, 120);
}

async function refreshTabCount() {
  try {
    tabCount = (await chrome.tabs.query({})).length;
    scheduleBadge();
  } catch {
    // ignore
  }
}

async function openManager() {
  try {
    if (chrome.action.openPopup) {
      await chrome.action.openPopup();
      return;
    }
  } catch {
    // fallback below
  }
  await chrome.windows.create({
    url: 'popup.html',
    type: 'popup',
    width: 440,
    height: 620,
  });
}

async function applyGroup(windowId, host, tabs, existingGroups) {
  const tabIds = tabs.map((t) => t.id);
  if (tabIds.length < 2) return;

  const found = (existingGroups || []).find((g) => g.title === host);
  // 已经在正确组里则跳过，避免无意义的 tabs.group 调用
  if (found && tabs.every((t) => t.groupId === found.id)) return;

  try {
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
    if (tab.pinned || !tab.url || !HTTP_RE.test(tab.url)) continue;
    const host = hostOf(tab.url);
    if (!host || (filterHost && host !== filterHost)) continue;
    const key = `${tab.windowId}|${host}`;
    if (!pending.has(key)) pending.set(key, { windowId: tab.windowId, host, tabs: [] });
    pending.get(key).tabs.push(tab);
  }

  const existingByWindow = new Map();
  for (const { windowId } of pending.values()) {
    if (existingByWindow.has(windowId)) continue;
    existingByWindow.set(windowId, await chrome.tabGroups.query({ windowId }));
  }

  for (const { windowId, host, tabs: hostTabs } of pending.values()) {
    await applyGroup(windowId, host, hostTabs, existingByWindow.get(windowId));
  }
}

async function closeDuplicateTabs(keepTabId, onlyUrlKey) {
  const tabs = await chrome.tabs.query({});
  const byUrl = new Map();

  for (const tab of tabs) {
    if (tab.pinned || !HTTP_RE.test(tab.url || '')) continue;
    const key = tabUrlKey(tab.url);
    if (onlyUrlKey && key !== onlyUrlKey) continue;
    if (!byUrl.has(key)) byUrl.set(key, []);
    byUrl.get(key).push(tab);
  }

  const toClose = [];
  for (const list of byUrl.values()) {
    if (list.length < 2) continue;
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

function scheduleAutoHousekeeping(tab) {
  if (!tab || tab.pinned || !HTTP_RE.test(tab.url || '')) return;
  const host = hostOf(tab.url);
  const urlKey = tabUrlKey(tab.url);
  if (!host || !urlKey) return;

  const key = `${tab.windowId}|${host}|${urlKey}`;
  const prev = autoTimers.get(key);
  if (prev) clearTimeout(prev);

  autoTimers.set(
    key,
    setTimeout(async () => {
      autoTimers.delete(key);
      try {
        // 先去重再分组，减少后续分组处理的标签数量
        if (prefs.autoDedupe) await closeDuplicateTabs(tab.id, urlKey);
        if (prefs.autoGroup) await groupByDomain(tab.windowId, host);
      } catch (err) {
        console.warn('自动整理失败:', host, err);
      }
    }, AUTO_DEBOUNCE_MS)
  );
}

async function closeUnvisitedToday() {
  const [tabs, stored] = await Promise.all([
    chrome.tabs.query({}),
    chrome.storage.local.get(['stats']),
  ]);
  const todayStats = (stored.stats || {})[todayKey()] || {};
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
    const contexts = ['all', 'action'];
    await chrome.contextMenus.create({
      id: 'tab-manager',
      title: '标签盒',
      contexts,
    });

    const items = [
      { id: 'open-manager', title: '打开标签盒' },
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

async function rememberOpenTabs() {
  try {
    const tabs = await chrome.tabs.query({});
    const now = Date.now();
    tabCount = tabs.length;
    for (const tab of tabs) {
      if (!tabOpenedAt.has(tab.id)) {
        tabOpenedAt.set(tab.id, now - (tabs.length - tab.index) * 10);
      }
    }
    scheduleBadge();
  } catch {
    // ignore
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
  refreshTabCount();
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
    // closed
  }
});

chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.active) recordVisit(tab);
  // 只在网址变化或加载完成时整理，忽略 title/favIcon 等噪声事件
  if (tab.pinned) return;
  if (changeInfo.url || changeInfo.status === 'complete') {
    scheduleAutoHousekeeping(tab);
  }
});

chrome.tabs.onCreated.addListener((tab) => {
  tabOpenedAt.set(tab.id, Date.now());
  tabCount += 1;
  scheduleBadge();
  scheduleAutoHousekeeping(tab);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabOpenedAt.delete(tabId);
  tabCount = Math.max(0, tabCount - 1);
  scheduleBadge();
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
  loadPrefs();
  rememberOpenTabs();
  setupContextMenus();
});
chrome.runtime.onInstalled.addListener(() => {
  loadPrefs();
  rememberOpenTabs();
  setupContextMenus();
});

loadPrefs();
rememberOpenTabs();
setupContextMenus();
