// 后台：访问统计、右键菜单、自动分组/去重。
// 性能要点：
// 1. 统计只读一次 storage，访问先攒在内存里再批量写盘；
// 2. 自动整理合并成一个定时器、共用一次标签页快照；
// 3. 右键菜单只在安装/浏览器启动时注册，不在每次 Service Worker 唤醒时重建。

const KEEP_DAYS = 7;
const COUNT_DEBOUNCE_MS = 3000;
const LAST_ACTIVE_WRITE_MS = 30000;
const AUTO_DEBOUNCE_MS = 800;
const FLUSH_DELAY_MS = 2000;
const DAY_MS = 86400000;
const GROUP_COLORS = ['blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];
const HTTP_RE = /^https?:/;

// 界面文案走 chrome.i18n：语言跟随浏览器 UI，缺省回落英文
function msg(key) {
  return chrome.i18n.getMessage(key) || key;
}

let prefs = { autoGroup: true, autoDedupe: true };

// 访问统计：内存态 + 待写批次。state 为 null 表示还没从 storage 读过。
let state = null;
let flushTimer = 0;
let flushing = false;
let retryDelay = FLUSH_DELAY_MS;
const pendingVisits = new Map(); // `${day}|${url}` -> { day, url, add, last }
const lastCountedAt = new Map();
const lastActiveWrittenAt = new Map();

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

// 与 toLocaleDateString('sv') 等价，但不用走 Intl，热路径上快很多
function dayKey(ts = Date.now()) {
  const d = new Date(ts);
  const month = d.getMonth() + 1;
  const day = d.getDate();
  return `${d.getFullYear()}-${month < 10 ? `0${month}` : month}-${day < 10 ? `0${day}` : day}`;
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

async function getState() {
  if (state) return state;
  const stored = await chrome.storage.local.get(['stats', 'lastActive', 'cleanupDay']);
  state = {
    stats: stored.stats || {},
    lastActive: stored.lastActive || {},
    cleanupDay: stored.cleanupDay || '',
  };
  return state;
}

function recordVisit(tab) {
  if (!tab || !tab.url || !HTTP_RE.test(tab.url)) return;
  const url = tabUrlKey(tab.url);
  const now = Date.now();
  const shouldCount = now - (lastCountedAt.get(url) || 0) >= COUNT_DEBOUNCE_MS;
  if (shouldCount) lastCountedAt.set(url, now);

  // 仅刷新活跃时间时节流，避免来回切标签频繁写盘
  if (!shouldCount && now - (lastActiveWrittenAt.get(url) || 0) < LAST_ACTIVE_WRITE_MS) return;

  const day = dayKey(now);
  const key = `${day}|${url}`;
  const entry = pendingVisits.get(key);
  if (entry) {
    if (shouldCount) entry.add += 1;
    if (now > entry.last) entry.last = now;
  } else {
    pendingVisits.set(key, { day, url, add: shouldCount ? 1 : 0, last: now });
  }
  lastActiveWrittenAt.set(url, now);

  if (!flushTimer) flushTimer = setTimeout(flushVisits, FLUSH_DELAY_MS);
}

// 一天最多清理一次过期数据；cleanupDay 持久化，Service Worker 重启后不重复扫
function cleanupIfNeeded(stored, today) {
  if (stored.cleanupDay === today) return;
  stored.cleanupDay = today;
  const cutoffDay = dayKey(Date.now() - KEEP_DAYS * DAY_MS);
  const cutoffTs = Date.now() - KEEP_DAYS * DAY_MS;

  for (const day of Object.keys(stored.stats)) {
    if (day < cutoffDay) delete stored.stats[day];
  }
  for (const [url, t] of Object.entries(stored.lastActive)) {
    if (t < cutoffTs) delete stored.lastActive[url];
  }
  for (const [url, t] of lastCountedAt) {
    if (t < cutoffTs) lastCountedAt.delete(url);
  }
  for (const [url, t] of lastActiveWrittenAt) {
    if (t < cutoffTs) lastActiveWrittenAt.delete(url);
  }
}

async function flushVisits() {
  flushTimer = 0;
  if (flushing || !pendingVisits.size) return;
  flushing = true;

  const batch = Array.from(pendingVisits.values());
  pendingVisits.clear();
  let failed = false;

  try {
    const stored = await getState();
    const today = dayKey();

    for (const entry of batch) {
      if (entry.add) {
        const day = stored.stats[entry.day] || (stored.stats[entry.day] = {});
        day[entry.url] = (day[entry.url] || 0) + entry.add;
      }
      if (entry.last > (stored.lastActive[entry.url] || 0)) {
        stored.lastActive[entry.url] = entry.last;
      }
    }

    cleanupIfNeeded(stored, today);
    await chrome.storage.local.set({
      stats: stored.stats,
      lastActive: stored.lastActive,
      cleanupDay: stored.cleanupDay,
    });
  } catch {
    // 写失败时把这批并回队列，按退避间隔重试，避免把 Service Worker 一直唤醒
    failed = true;
    retryDelay = Math.min(60000, retryDelay * 2);
    for (const entry of batch) {
      const key = `${entry.day}|${entry.url}`;
      const prev = pendingVisits.get(key);
      if (prev) {
        prev.add += entry.add;
        if (entry.last > prev.last) prev.last = entry.last;
      } else {
        pendingVisits.set(key, entry);
      }
    }
  } finally {
    flushing = false;
    if (!failed) retryDelay = FLUSH_DELAY_MS;
    if (pendingVisits.size && !flushTimer) {
      flushTimer = setTimeout(flushVisits, failed ? retryDelay : FLUSH_DELAY_MS);
    }
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

// 按 windowId|host 聚合标签页；keys 非空时只处理指定分组
function collectHostBuckets(tabs, allowedKeys) {
  const pending = new Map();
  for (const tab of tabs) {
    if (tab.pinned || !tab.url || !HTTP_RE.test(tab.url)) continue;
    const host = hostOf(tab.url);
    if (!host) continue;
    const key = `${tab.windowId}|${host}`;
    if (allowedKeys && !allowedKeys.has(key)) continue;

    let bucket = pending.get(key);
    if (!bucket) {
      bucket = { windowId: tab.windowId, host, tabs: [] };
      pending.set(key, bucket);
    }
    bucket.tabs.push(tab);
  }
  return pending;
}

async function groupBuckets(buckets) {
  if (!buckets.size) return;

  const windows = new Set();
  for (const bucket of buckets.values()) windows.add(bucket.windowId);

  // 每个窗口只查一次分组列表，多个窗口并行
  const groupsByWindow = new Map();
  await Promise.all(
    Array.from(windows, async (windowId) => {
      try {
        groupsByWindow.set(windowId, await chrome.tabGroups.query({ windowId }));
      } catch {
        groupsByWindow.set(windowId, []);
      }
    })
  );

  for (const bucket of buckets.values()) {
    await applyGroup(
      bucket.windowId,
      bucket.host,
      bucket.tabs,
      groupsByWindow.get(bucket.windowId)
    );
  }
}

async function groupByDomain() {
  const tabs = await chrome.tabs.query({});
  await groupBuckets(collectHostBuckets(tabs));
}

// 返回被关掉的 tab id，供调用方过滤后续快照
async function closeDuplicatesFromTabs(tabs, preferredByUrl) {
  const byUrl = new Map();

  for (const tab of tabs) {
    if (tab.pinned || !HTTP_RE.test(tab.url || '')) continue;
    const key = tabUrlKey(tab.url);
    if (preferredByUrl && !preferredByUrl.has(key)) continue;
    let list = byUrl.get(key);
    if (!list) byUrl.set(key, (list = []));
    list.push(tab);
  }

  const toClose = [];
  for (const [key, list] of byUrl) {
    if (list.length < 2) continue;
    // tab.id 单调递增，越新越大：按 id 排序即可判断谁更早打开
    list.sort((a, b) => a.id - b.id);
    const preferred = preferredByUrl && preferredByUrl.get(key);
    const keepId =
      preferred != null && list.some((t) => t.id === preferred)
        ? preferred
        : list[list.length - 1].id;
    for (const tab of list) {
      if (tab.id !== keepId) toClose.push(tab.id);
    }
  }

  if (!toClose.length) return new Set();
  try {
    await chrome.tabs.remove(toClose);
  } catch {
    // 个别标签可能已被用户关掉，忽略后继续
  }
  return new Set(toClose);
}

async function closeDuplicateTabs(keepTabId, onlyUrlKey) {
  const tabs = await chrome.tabs.query({});
  const preferred = new Map();
  if (onlyUrlKey) preferred.set(onlyUrlKey, keepTabId);
  await closeDuplicatesFromTabs(tabs, preferred);
}

// 自动整理合并成一次防抖：一次 query 快照同时服务于去重和分组
let houseTimer = 0;
const dirtyHostKeys = new Set(); // `${windowId}|${host}`
const dirtyUrlKeep = new Map(); // urlKey -> 刚打开的 tabId

function scheduleAutoHousekeeping(tab) {
  if (!tab || tab.pinned || !HTTP_RE.test(tab.url || '')) return;
  if (!prefs.autoGroup && !prefs.autoDedupe) return;

  const host = hostOf(tab.url);
  const urlKey = tabUrlKey(tab.url);
  if (!host || !urlKey) return;

  if (prefs.autoGroup) dirtyHostKeys.add(`${tab.windowId}|${host}`);
  if (prefs.autoDedupe) dirtyUrlKeep.set(urlKey, tab.id);

  if (houseTimer) return;
  houseTimer = setTimeout(runAutoHousekeeping, AUTO_DEBOUNCE_MS);
}

async function runAutoHousekeeping() {
  houseTimer = 0;
  const hostKeys = new Set(dirtyHostKeys);
  const urlKeep = new Map(dirtyUrlKeep);
  dirtyHostKeys.clear();
  dirtyUrlKeep.clear();
  if (!hostKeys.size && !urlKeep.size) return;

  try {
    const tabs = await chrome.tabs.query({});
    let closed = new Set();
    if (prefs.autoDedupe) closed = await closeDuplicatesFromTabs(tabs, urlKeep);
    if (prefs.autoGroup) {
      const remaining = closed.size ? tabs.filter((t) => !closed.has(t.id)) : tabs;
      await groupBuckets(collectHostBuckets(remaining, hostKeys));
    }
  } catch (err) {
    console.warn('自动整理失败:', err);
  }
}

async function closeIdleTabs(days = 2) {
  const safeDays = Math.min(7, Math.max(1, Number(days) || 2));
  const [tabs, stored] = await Promise.all([
    chrome.tabs.query({}),
    chrome.storage.local.get(['stats', 'lastActive']),
  ]);
  const stats = stored.stats || {};
  const lastActive = stored.lastActive || {};
  const cutoff = Date.now() - safeDays * DAY_MS;
  const recentDays = [];
  for (let i = 0; i < safeDays; i += 1) {
    recentDays.push(dayKey(Date.now() - i * DAY_MS));
  }

  const ids = tabs
    .filter((tab) => {
      if (tab.pinned || tab.active || !HTTP_RE.test(tab.url || '')) return false;
      const url = tabUrlKey(tab.url);
      const last = lastActive[url] || tab.lastAccessed || 0;
      if (last && last >= cutoff) return false;
      for (const day of recentDays) {
        if (stats[day]?.[url]) return false;
      }
      // 没有任何活跃记录时，用浏览器 lastAccessed；仍没有则不关，避免误伤
      if (!last) return false;
      return true;
    })
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

let menuJob = null;

// 右键菜单是浏览器级持久化数据，只在安装/更新和浏览器启动时注册
function setupContextMenus() {
  if (menuJob) return menuJob;
  menuJob = (async () => {
    try {
      await chrome.contextMenus.removeAll();
      const contexts = ['all', 'action'];
      await chrome.contextMenus.create({
        id: 'tab-manager',
        title: msg('menuRoot'),
        contexts,
      });

      const items = [
        { id: 'open-manager', title: msg('menuOpen') },
        { id: 'group-by-domain', title: msg('menuGroup') },
        { id: 'close-duplicates', title: msg('menuCloseDuplicates') },
        { id: 'close-idle-1', title: msg('menuCloseIdle1') },
        { id: 'close-idle-2', title: msg('menuCloseIdle2') },
        { id: 'close-idle-3', title: msg('menuCloseIdle3') },
        { id: 'sep-1', type: 'separator' },
        { id: 'close-same-domain-others', title: msg('menuCloseSameSiteOthers') },
        { id: 'close-same-domain-all', title: msg('menuCloseSameSiteAll') },
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
  })().finally(() => {
    menuJob = null;
  });
  return menuJob;
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
      case 'close-idle-1':
        await closeIdleTabs(1);
        break;
      case 'close-idle-2':
        await closeIdleTabs(2);
        break;
      case 'close-idle-3':
        await closeIdleTabs(3);
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
  if (changeInfo.url || changeInfo.status === 'complete') {
    scheduleAutoHousekeeping(tab);
  }
});

chrome.tabs.onCreated.addListener((tab) => {
  scheduleAutoHousekeeping(tab);
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
  setupContextMenus();
});
chrome.runtime.onInstalled.addListener(() => {
  setupContextMenus();
});

// Service Worker 被挂起前尽量把待写批次落盘（不保证一定执行）
if (chrome.runtime.onSuspend) {
  chrome.runtime.onSuspend.addListener(() => {
    flushVisits();
  });
}

loadPrefs();
