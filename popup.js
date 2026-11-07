'use strict';

/* ------------------------------------------------------------------ *
 * Tab Box — Tabs & Bookmarks
 * One popup, two independent data sources, shared interaction pieces.
 * ------------------------------------------------------------------ */

const $ = (id) => document.getElementById(id);

const topEl = $('top');
const brandTitle = $('brand-title');
const brandSub = $('brand-sub');
const moduleToggle = $('module-toggle');
const searchInput = $('search');
const themeSelect = $('theme');
const sortSelect = $('sort');
const idleDays = $('idle-days');
const groupToggle = $('group-toggle');
const tabsToolbar = $('tabs-toolbar');
const bookmarksToolbar = $('bookmarks-toolbar');
const tabsFooter = $('tabs-footer');
const bookmarksFooter = $('bookmarks-footer');
const selectionFooter = $('selection-footer');
const selectionCount = $('selection-count');
const selectionAllBtn = $('selection-all');
const selectionActions = $('selection-actions');
const selectionCancel = $('selection-cancel');
const homeFooter = $('home-footer');
const homeView = $('home-view');
const itemList = $('item-list');
const summaryEl = $('summary');
const selectModeBtn = $('select-mode');
const closeIdleBtn = $('close-idle');
const closeDuplicatesBtn = $('close-duplicates');
const autoDedupe = $('auto-dedupe');
const versionText = $('version-text');
const bookmarksDedupBtn = $('bookmarks-dedup');
const folderFilterBtn = $('folder-filter');
const newFolderBtn = $('new-folder');
const bookmarkCrumbs = $('bookmark-crumbs');
const crumbBack = $('crumb-back');
const crumbPath = $('crumb-path');
const pageView = $('page-view');
const pageBack = $('page-back');
const pageTitle = $('page-title');
const pageSubtitle = $('page-subtitle');
const pageBody = $('page-body');
const pageFooter = $('page-footer');
const toastEl = $('toast');

// 文案统一走 chrome.i18n：语言由浏览器 UI 语言决定，缺 en 时回落英文（默认语言）。
const i18nCache = new Map();
const t = (key, subs) => {
  const list = subs == null ? null : (Array.isArray(subs) ? subs : [subs]).map(String);
  const cacheKey = list ? `${key}\u0000${list.join('\u0001')}` : key;
  const cached = i18nCache.get(cacheKey);
  if (cached != null) return cached;
  const value = list ? chrome.i18n.getMessage(key, list) : chrome.i18n.getMessage(key);
  // 缺 key 时回显 key，方便发现漏翻译，而不是静默显示空字符串
  const text = value || key;
  i18nCache.set(cacheKey, text);
  return text;
};

function localizeDocument() {
  document.documentElement.lang = chrome.i18n.getUILanguage();
  document.title = t('extName');
  for (const el of document.querySelectorAll('[data-i18n]')) {
    el.textContent = t(el.dataset.i18n);
  }
  for (const el of document.querySelectorAll('[data-i18n-title]')) {
    el.title = t(el.dataset.i18nTitle);
  }
  for (const el of document.querySelectorAll('[data-i18n-placeholder]')) {
    el.placeholder = t(el.dataset.i18nPlaceholder);
  }
}

localizeDocument();
versionText.textContent = t('versionText', chrome.runtime.getManifest().version);

const supportsTabGroups = Boolean(
  chrome.tabGroups && chrome.tabs.group && chrome.tabs.ungroup
);
if (!supportsTabGroups) {
  groupToggle.disabled = true;
  groupToggle.closest('.group-switch').title = t('unsupportedTabGroups');
}

const MODULE_TABS = 'tabs';
const MODULE_BOOKMARKS = 'bookmarks';
const OTHER_HOST = '(other)';
const PAGE_SIZE = 300;
const MAX_SUMMARY_ITEMS = 6;

const state = {
  module: MODULE_TABS,
  tabs: {
    keyword: '',
    sort: 'recent',
    scrollTop: 0,
    selected: new Set(),
    selecting: false,
    renderLimit: PAGE_SIZE,
  },
  bookmarks: {
    keyword: '',
    sort: 'recent',
    scrollTop: 0,
    selected: new Set(),
    selecting: false,
    renderLimit: PAGE_SIZE,
    folderId: 'all',
  },
};

let prefs = {};
let themeMode = 'system';
let autoGroupOn = true;

// Tabs data
let allTabs = [];
let statsByDay = {};
let lastActive = {};
let collapsedHosts = new Set();
let idleIds = new Set();
let idleCacheDays = 0;
let cachedTabsView = null;
let cachedGroupIds = new Map();
let failedFavicons = new Set();

// Bookmarks data
let bookmarksLoaded = false;
let bookmarks = [];
let bookmarkMap = new Map();
let folderMap = new Map();
let childFolders = new Map();
let directBookmarks = new Map();
let topFolderIds = [];
let bookmarkRootId = '0';
let folderCountCache = new Map();
let cachedBookmarksView = null;

// UI state
let selectedIndex = 0;
let selectedEl = null;
let renderTimer = 0;
let homeReloadTimer = 0;
let toastTimer = 0;
let page = null;
let dedupState = null;
let folderPickerState = null;
let closePreview = null;
let confirmTarget = null;
let switchAnimating = false;
let switchTimer = 0;
let moduleCardFlipped = false;
const pickerMap = new Map();

const currentState = () => state[state.module];
const isPageOpen = () => Boolean(page);

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function urlKey(url) {
  return (url || '').split('#')[0];
}

function tabUrl(tab) {
  return tab?.url || tab?.pendingUrl || '';
}

function hostLabel(host) {
  return host === OTHER_HOST ? t('groupOther') : host;
}

function tabTitle(tab) {
  return tab.title || tabUrl(tab) || t('untitled');
}

function bookmarkTitle(bookmark) {
  return bookmark.title || bookmark.url || t('untitled');
}

function formatAgo(ago) {
  if (ago < 60000) return t('timeJustNow');
  if (ago < 3600000) return t('timeMinutes', Math.floor(ago / 60000));
  if (ago < 86400000) return t('timeHours', Math.floor(ago / 3600000));
  return t('timeDays', Math.floor(ago / 86400000));
}

function makeEl(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text != null) el.textContent = text;
  return el;
}

function makeButton(label, className, onClick, options = {}) {
  const btn = makeEl('button', className || '', label);
  btn.type = 'button';
  if (options.title) btn.title = options.title;
  if (options.disabled) btn.disabled = true;
  if (onClick) btn.addEventListener('click', onClick);
  return btn;
}

function appendHighlighted(el, text, keyword) {
  if (!keyword) {
    el.textContent = text;
    return;
  }
  const lower = text.toLowerCase();
  let start = 0;
  let matchCount = 0;
  while (start < text.length && matchCount < 8) {
    const idx = lower.indexOf(keyword, start);
    if (idx === -1) {
      el.append(text.slice(start));
      return;
    }
    if (idx > start) el.append(text.slice(start, idx));
    const mark = document.createElement('mark');
    mark.textContent = text.slice(idx, idx + keyword.length);
    el.append(mark);
    start = idx + keyword.length;
    matchCount += 1;
  }
  if (start < text.length) el.append(text.slice(start));
}

function showToast(message) {
  if (!message) return;
  toastEl.textContent = message;
  toastEl.classList.add('is-visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('is-visible'), 2400);
}

function makeFaviconFallback(host) {
  const fb = makeEl('div', 'favicon-fallback', (host[0] || '?').toUpperCase());
  return fb;
}

function makeFavicon(src, host) {
  if (!src || failedFavicons.has(src)) return makeFaviconFallback(host);
  const img = document.createElement('img');
  img.className = 'favicon';
  img.src = src;
  img.loading = 'lazy';
  img.decoding = 'async';
  img.alt = '';
  img.addEventListener(
    'error',
    () => {
      failedFavicons.add(src);
      img.replaceWith(makeFaviconFallback(host));
    },
    { once: true }
  );
  return img;
}

function bookmarkFavicon(bookmark) {
  try {
    return chrome.runtime.getURL(
      `_favicon/?pageUrl=${encodeURIComponent(bookmark.url)}&size=32`
    );
  } catch {
    return '';
  }
}

function makeCheck(checked, className) {
  const label = makeEl('label', 'check');
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.className = className;
  input.checked = Boolean(checked);
  label.addEventListener('click', (e) => e.stopPropagation());
  label.append(input);
  return { label, input };
}

function syncNativeSelect(select) {
  const picker = pickerMap.get(select);
  if (!picker) return;
  picker.trigger.title = select.title;
  picker.label.textContent = select.selectedOptions[0]?.textContent || '';
  picker.menu.querySelectorAll('.picker-option').forEach((btn) => {
    const on = btn.dataset.value === select.value;
    btn.classList.toggle('is-selected', on);
    btn.setAttribute('aria-selected', on ? 'true' : 'false');
  });
}

/* ------------------------------------------------------------------ *
 * Theme and preferences
 * ------------------------------------------------------------------ */

function resolveTheme(mode) {
  if (mode === 'light' || mode === 'dark') return mode;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyTheme(mode = themeMode) {
  themeMode = mode || 'system';
  document.documentElement.dataset.theme = resolveTheme(themeMode);
}

function selectedIdleDays() {
  const n = Number(idleDays.value);
  if (!n) return 2;
  return Math.min(7, Math.max(1, n));
}

function updateCloseIdleLabel() {
  const pending = idleDays.value !== 'all';
  const days = selectedIdleDays();
  const count = pending ? ensureIdleIds().size : 0;
  closeIdleBtn.disabled = !pending || count === 0;
  closeIdleBtn.textContent = count ? t('confirmRemoveMany', count) : t('confirmRemove');
  closeIdleBtn.title = !pending
    ? t('idleHintPick')
    : count
      ? t('idleHintCount', [count, days])
      : t('idleHintEmpty', days);
}

function sortStateFor(module) {
  return module === MODULE_BOOKMARKS ? state.bookmarks.sort : state.tabs.sort;
}

async function loadPrefs() {
  const stored = await chrome.storage.local.get('prefs');
  prefs = stored.prefs || {};
  state.module = prefs.module === MODULE_BOOKMARKS ? MODULE_BOOKMARKS : MODULE_TABS;

  const legacyStale = prefs.sort === 'least' || prefs.sort === 'stale';
  state.tabs.sort = legacyStale ? 'stale' : 'recent';
  if (prefs.tabsSort === 'stale' || prefs.tabsSort === 'recent') {
    state.tabs.sort = prefs.tabsSort;
  }
  state.bookmarks.sort = prefs.bookmarksSort === 'title' ? 'title' : 'recent';

  idleDays.value = ['1', '2', '3'].includes(String(prefs.idleDays))
    ? String(prefs.idleDays)
    : 'all';
  autoGroupOn = prefs.autoGroup !== false;
  groupToggle.checked = autoGroupOn;
  autoDedupe.checked = prefs.autoDedupe !== false;
  closeDuplicatesBtn.hidden = autoDedupe.checked;
  themeSelect.value = ['light', 'dark'].includes(prefs.theme) ? prefs.theme : 'system';
}

function savePrefs() {
  return chrome.storage.local.set({
    prefs: {
      module: state.module,
      tabsSort: state.tabs.sort,
      bookmarksSort: state.bookmarks.sort,
      idleDays: idleDays.value,
      autoGroup: autoGroupOn,
      autoDedupe: autoDedupe.checked,
      theme: themeSelect.value,
    },
  });
}

/* ------------------------------------------------------------------ *
 * Tabs data adapter
 * ------------------------------------------------------------------ */

function dayKey(ts = Date.now()) {
  const d = new Date(ts);
  const month = d.getMonth() + 1;
  const day = d.getDate();
  return `${d.getFullYear()}-${month < 10 ? `0${month}` : month}-${day < 10 ? `0${day}` : day}`;
}

function recentDayKeys(days) {
  const keys = [];
  const now = Date.now();
  for (let i = 0; i < days; i += 1) keys.push(dayKey(now - i * 86400000));
  return keys;
}

function computeIdleIds(days) {
  const cutoff = Date.now() - days * 86400000;
  const dayKeys = recentDayKeys(days);
  const ids = new Set();

  for (const tab of allTabs) {
    if (tab.pinned || tab.active || !/^https?:/.test(tabUrl(tab))) continue;
    const key = urlKey(tabUrl(tab));
    const last = lastActive[key] || tab.lastAccessed || 0;
    if (!last || last >= cutoff) continue;
    let seen = false;
    for (const day of dayKeys) {
      if (statsByDay[day]?.[key]) {
        seen = true;
        break;
      }
    }
    if (!seen) ids.add(tab.id);
  }
  return ids;
}

function refreshIdleIds() {
  idleCacheDays = selectedIdleDays();
  idleIds = computeIdleIds(idleCacheDays);
  return idleIds;
}

function ensureIdleIds() {
  if (selectedIdleDays() !== idleCacheDays) refreshIdleIds();
  return idleIds;
}

async function loadTabsData() {
  const [tabs, stored] = await Promise.all([
    chrome.tabs.query({}),
    chrome.storage.local.get(['stats', 'lastActive']),
  ]);
  allTabs = (tabs || []).filter((tab) => {
    // 从右键菜单降级打开时，弹窗自身也会以标签页形式出现，不把它当成待管理网页
    try {
      return tab.url !== chrome.runtime.getURL('popup.html');
    } catch {
      return true;
    }
  });
  statsByDay = stored.stats || {};
  lastActive = stored.lastActive || {};
  refreshIdleIds();
  pruneTabSelection();
}

function duplicateTabGroups() {
  const byUrl = new Map();
  for (const tab of allTabs) {
    if (tab.pinned || !/^https?:/.test(tabUrl(tab))) continue;
    const key = urlKey(tabUrl(tab));
    let list = byUrl.get(key);
    if (!list) byUrl.set(key, (list = []));
    list.push(tab);
  }

  const groups = [];
  for (const [key, tabs] of byUrl) {
    if (tabs.length < 2) continue;
    tabs.sort((a, b) => a.id - b.id);
    const active = tabs.find((tab) => tab.active);
    const keep = active || tabs[tabs.length - 1];
    groups.push({ key, host: hostOf(keep.url), items: tabs, keepId: keep.id });
  }
  groups.sort((a, b) => b.items.length - a.items.length);
  return groups;
}

function duplicateTabCount() {
  return duplicateTabGroups().reduce((total, group) => total + group.items.length - 1, 0);
}

// 手动“关闭重复标签页”沿用原逻辑：按 URL 分组，保留最新打开的标签页。
function duplicateTargets() {
  const byUrl = new Map();
  for (const tab of allTabs) {
    if (tab.pinned || !/^https?:/.test(tabUrl(tab))) continue;
    const key = urlKey(tabUrl(tab));
    let list = byUrl.get(key);
    if (!list) byUrl.set(key, (list = []));
    list.push(tab);
  }

  const toClose = [];
  for (const tabs of byUrl.values()) {
    if (tabs.length < 2) continue;
    tabs.sort((a, b) => a.id - b.id);
    for (let i = 0; i < tabs.length - 1; i += 1) toClose.push(tabs[i].id);
  }
  return toClose;
}

function clearClosePreview() {
  if (!closePreview && !confirmTarget) return;
  if (confirmTarget) confirmTarget.textContent = confirmTarget.dataset.label;
  closePreview = null;
  confirmTarget = null;
}

async function confirmAction(btn, count, run) {
  if (count === 0) {
    const hadPreview = Boolean(closePreview || confirmTarget);
    clearClosePreview();
    if (hadPreview) renderHome();
    summaryEl.textContent = t('confirmNothingDuplicates');
    return;
  }
  if (confirmTarget !== btn) {
    if (confirmTarget) confirmTarget.textContent = confirmTarget.dataset.label;
    confirmTarget = btn;
    closePreview = 'duplicates';
    btn.dataset.label = btn.dataset.label || btn.textContent;
    btn.textContent = t('confirmDuplicates');
    selectedIndex = 0;
    scheduleRender(true);
    return;
  }

  clearClosePreview();
  try {
    await run();
  } catch (err) {
    showToast(errorReason(err));
  }
  await loadTabsData();
  updateCloseIdleLabel();
  renderHome();
}

function buildTabsView() {
  const keyword = closePreview
    ? ''
    : currentState().keyword.trim().toLowerCase();
  const days = selectedIdleDays();
  const limitToIdle = idleDays.value !== 'all';
  const today = dayKey();
  const todayStats = statsByDay[today] || {};
  const idleSet = ensureIdleIds();
  const urlCounts = new Map();
  const dupeCloseIds =
    closePreview === 'duplicates' ? new Set(duplicateTargets()) : null;

  for (const tab of allTabs) {
    const key = urlKey(tabUrl(tab));
    urlCounts.set(key, (urlCounts.get(key) || 0) + 1);
  }

  const items = [];
  for (const tab of allTabs) {
    const key = urlKey(tabUrl(tab));
    const host = hostOf(tabUrl(tab));
    if (dupeCloseIds) {
      if (!dupeCloseIds.has(tab.id)) continue;
    } else if (limitToIdle && !idleSet.has(tab.id)) {
      continue;
    }

    const title = tabTitle(tab);
    if (keyword) {
      const hay = `${title}\n${tabUrl(tab)}\n${host}\n${key}`.toLowerCase();
      if (!hay.includes(keyword)) continue;
    }

    items.push({
      tab,
      host,
      url: key,
      title,
      count: todayStats[key] || 0,
      last: lastActive[key] || tab.lastAccessed || 0,
      dupes: urlCounts.get(key) || 1,
    });
  }

  const sortByStale = currentState().sort === 'stale';
  if (sortByStale) items.sort((a, b) => a.last - b.last);
  else items.sort((a, b) => b.last - a.last);

  const groups = [];
  const index = new Map();
  for (const item of items) {
    const key = item.host || OTHER_HOST;
    let g = index.get(key);
    if (g == null) {
      g = groups.length;
      index.set(key, g);
      groups.push({ host: key, items: [], minLast: item.last || 0, maxLast: item.last || 0 });
    }
    const group = groups[g];
    group.items.push(item);
    if ((item.last || 0) < group.minLast) group.minLast = item.last || 0;
    if ((item.last || 0) > group.maxLast) group.maxLast = item.last || 0;
  }

  if (sortByStale) groups.sort((a, b) => a.minLast - b.minLast);
  else groups.sort((a, b) => b.maxLast - a.maxLast);

  return {
    keyword,
    items,
    groups,
    idleTotal: idleSet.size,
    dupeTotal: duplicateTabCount(),
    days,
    filtered: Boolean(keyword) || limitToIdle || Boolean(closePreview),
  };
}

function pruneTabSelection() {
  const ids = new Set(allTabs.map((tab) => tab.id));
  for (const id of Array.from(state.tabs.selected)) {
    if (!ids.has(id)) state.tabs.selected.delete(id);
  }
}

/* ------------------------------------------------------------------ *
 * Tabs rendering
 * ------------------------------------------------------------------ */

function renderTabs() {
  const view = buildTabsView();
  cachedTabsView = view;
  cachedGroupIds = new Map();
  selectedEl = null;

  const base = t('summaryBase', [allTabs.length, view.idleTotal, view.days, view.dupeTotal]);
  summaryEl.textContent = view.filtered
    ? `${base} · ${t('summaryShown', view.items.length)}`
    : base;

  const frag = document.createDocumentFragment();

  if (view.items.length === 0) {
    const tip = makeEl('li', 'empty-tip');
    tip.textContent = view.keyword
      ? t('emptyNoMatch')
      : idleDays.value !== 'all'
        ? t('emptyIdle', view.days)
        : t('emptyGeneric');
    frag.appendChild(tip);
    itemList.replaceChildren(frag);
    itemList.scrollTop = currentState().scrollTop;
    return;
  }

  const selecting = currentState().selecting;
  const searching = Boolean(view.keyword);
  const now = Date.now();

  for (const group of view.groups) {
    const wrap = makeEl('li', 'domain-group');
    wrap.dataset.host = group.host;
    if (!searching && !selecting && collapsedHosts.has(group.host)) {
      wrap.classList.add('collapsed');
    }

    const header = makeEl('div', 'domain-header');
    const ids = group.items.map((item) => item.tab.id);
    cachedGroupIds.set(group.host, ids);

    if (selecting) {
      const { label, input } = makeCheck(false, 'group-check');
      input.dataset.host = group.host;
      label.title = t('selectGroup');
      header.append(label);
    }

    const name = makeEl('span', 'domain-name');
    appendHighlighted(name, hostLabel(group.host), view.keyword);

    const count = makeEl('span', 'domain-count', String(group.items.length));

    const closeGroupBtn = makeButton(t('closeGroup'), 'close-group-btn', null, {
      title: t('closeGroupTitle', hostLabel(group.host)),
    });
    closeGroupBtn.dataset.host = group.host;

    header.append(name, count);
    if (!selecting) header.append(closeGroupBtn);

    const inner = makeEl('ul', 'domain-tabs');
    for (const item of group.items) {
      inner.appendChild(renderTabRow(item, view.keyword, now, selecting));
    }

    wrap.append(header, inner);
    frag.appendChild(wrap);
  }

  itemList.replaceChildren(frag);
  restoreListScroll();
  syncGroupChecks();
  applySelection();
}

function renderTabRow(item, keyword, now, selecting) {
  const { tab, host, title, count, last, dupes } = item;
  const li = makeEl('li', 'tab-item' + (tab.active ? ' active-tab' : ''));
  li.dataset.tabId = String(tab.id);
  li.dataset.windowId = String(tab.windowId);
  li.title = tabUrl(tab);
  if (selecting && currentState().selected.has(tab.id)) li.classList.add('is-selected');

  if (selecting) {
    const { label, input } = makeCheck(currentState().selected.has(tab.id), 'row-check');
    input.dataset.tabId = String(tab.id);
    li.append(label);
  }

  li.appendChild(makeFavicon(tab.favIconUrl, host));

  const info = makeEl('div', 'tab-info');
  const titleEl = makeEl('div', 'tab-title');
  appendHighlighted(titleEl, title, keyword);
  info.appendChild(titleEl);

  const meta = makeEl('div', 'tab-meta');
  const hostSpan = makeEl('span', 'host');
  appendHighlighted(hostSpan, host || tabUrl(tab), keyword);
  meta.appendChild(hostSpan);
  if (last) meta.appendChild(makeEl('span', '', formatAgo(now - last)));
  info.appendChild(meta);
  li.appendChild(info);

  if (dupes > 1) {
    const dupe = makeEl('span', 'dupe-badge', t('dupeBadge', dupes));
    dupe.title = t('dupeBadgeTitle');
    li.appendChild(dupe);
  }

  const badge = makeEl('span', 'count-badge' + (count === 0 ? ' zero' : ''), t('todayCount', count));
  badge.title = t('todayCountTitle');
  li.appendChild(badge);

  if (!selecting) {
    const closeBtn = makeButton('×', 'close-btn', null, { title: t('closeTabTitle') });
    closeBtn.dataset.tabId = String(tab.id);
    li.appendChild(closeBtn);
  }

  return li;
}

function restoreListScroll() {
  const top = currentState().scrollTop || 0;
  itemList.scrollTop = top;
}

/* ------------------------------------------------------------------ *
 * Bookmarks data adapter
 * ------------------------------------------------------------------ */

function folderLabel(folderId) {
  if (folderId === 'all') return t('allBookmarks');
  if (folderId === bookmarkRootId) return t('bookmarksRoot');
  return folderMap.get(folderId)?.title || t('untitled');
}

function folderPathText(folderId) {
  if (folderId === 'all') return t('allBookmarks');
  if (folderId === bookmarkRootId) return t('bookmarksRoot');
  const folder = folderMap.get(folderId);
  if (!folder) return t('untitled');
  return folder.path.length ? folder.path.join(' / ') : folder.title;
}

function bookmarkFolderPathText(bookmark) {
  const path = bookmark.parentPath || [];
  return path.length ? path.join(' / ') : t('bookmarksRoot');
}

function folderContentCount(folderId) {
  if (folderCountCache.has(folderId)) return folderCountCache.get(folderId);
  const folder = folderMap.get(folderId);
  if (!folder) return 0;
  let total = (directBookmarks.get(folderId) || []).length;
  for (const childId of folder.childFolderIds) total += folderContentCount(childId);
  folderCountCache.set(folderId, total);
  return total;
}

function countBookmarkFolders() {
  let count = 0;
  for (const folder of folderMap.values()) {
    if (!folder.isRoot) count += 1;
  }
  return count;
}

async function loadBookmarksData() {
  const tree = await chrome.bookmarks.getTree();
  const root = tree[0];
  if (!root) throw new Error(t('bookmarksUnavailable'));

  bookmarkRootId = root.id;
  bookmarks = [];
  bookmarkMap = new Map();
  folderMap = new Map();
  childFolders = new Map();
  directBookmarks = new Map();
  topFolderIds = [];
  folderCountCache = new Map();

  const walkFolder = (node, parentPath) => {
    const isRoot = node.id === bookmarkRootId || !node.parentId;
    const title = node.title || (isRoot ? t('bookmarksRoot') : t('untitled'));
    const path = isRoot ? [] : [...parentPath, title];
    const folder = {
      id: node.id,
      title,
      parentId: node.parentId || '',
      path,
      isRoot,
      childFolderIds: [],
    };
    folderMap.set(node.id, folder);
    if (!isRoot) {
      if (!childFolders.has(folder.parentId)) childFolders.set(folder.parentId, []);
      childFolders.get(folder.parentId).push(folder.id);
    }
    if (!directBookmarks.has(folder.id)) directBookmarks.set(folder.id, []);

    for (const child of node.children || []) {
      if (child.url) {
        const bookmark = {
          id: child.id,
          title: child.title || '',
          url: child.url,
          parentId: folder.id,
          folderId: folder.id,
          parentPath: path,
          dateAdded: child.dateAdded || 0,
          host: hostOf(child.url),
        };
        bookmarks.push(bookmark);
        bookmarkMap.set(bookmark.id, bookmark);
        directBookmarks.get(folder.id).push(bookmark.id);
      } else {
        walkFolder(child, path);
        folder.childFolderIds.push(child.id);
      }
    }
  };

  walkFolder(root, []);
  topFolderIds = folderMap.get(bookmarkRootId)?.childFolderIds.slice() || [];
  bookmarksLoaded = true;

  if (
    state.bookmarks.folderId !== 'all' &&
    !folderMap.has(state.bookmarks.folderId)
  ) {
    state.bookmarks.folderId = 'all';
  }
  pruneBookmarkSelection();
}

function pruneBookmarkSelection() {
  const ids = new Set(bookmarks.map((bookmark) => bookmark.id));
  for (const id of Array.from(state.bookmarks.selected)) {
    if (!ids.has(id)) state.bookmarks.selected.delete(id);
  }
}

function bookmarkDuplicateGroups() {
  const byUrl = new Map();
  for (const bookmark of bookmarks) {
    if (!bookmark.url) continue;
    const key = urlKey(bookmark.url);
    let list = byUrl.get(key);
    if (!list) byUrl.set(key, (list = []));
    list.push(bookmark);
  }

  const groups = [];
  for (const [key, list] of byUrl) {
    if (list.length < 2) continue;
    list.sort((a, b) => (a.dateAdded || 0) - (b.dateAdded || 0) || a.id.localeCompare(b.id));
    groups.push({
      key,
      host: hostOf(list[0].url),
      items: list,
      keepId: list[0].id,
    });
  }
  groups.sort((a, b) => b.items.length - a.items.length);
  return groups;
}

function duplicateBookmarkCount() {
  return bookmarkDuplicateGroups().reduce((total, group) => total + group.items.length - 1, 0);
}

function buildBookmarksView() {
  const bm = state.bookmarks;
  const keyword = bm.keyword.trim().toLowerCase();
  const scope = bm.folderId;
  const scopeFolder = scope === 'all' ? null : folderMap.get(scope);

  let folderIds = [];
  if (keyword) {
    for (const folder of folderMap.values()) {
      if (folder.isRoot) continue;
      const hay = `${folder.title}\n${folder.path.join(' / ')}`.toLowerCase();
      if (hay.includes(keyword)) folderIds.push(folder.id);
    }
    folderIds.sort((a, b) => folderPathText(a).localeCompare(folderPathText(b)));
  } else if (scope === 'all') {
    folderIds = topFolderIds.slice();
  } else if (scopeFolder) {
    folderIds = scopeFolder.childFolderIds.slice();
  }

  const source = keyword
    ? bookmarks
    : scope === 'all'
      ? bookmarks
      : (directBookmarks.get(scope) || []).map((id) => bookmarkMap.get(id)).filter(Boolean);

  const matched = [];
  for (const bookmark of source) {
    if (keyword) {
      const hay = `${bookmarkTitle(bookmark)}\n${bookmark.url}\n${bookmark.host}\n${bookmarkFolderPathText(
        bookmark
      )}`.toLowerCase();
      if (!hay.includes(keyword)) continue;
    }
    matched.push(bookmark);
  }

  if (bm.sort === 'title') {
    matched.sort((a, b) =>
      bookmarkTitle(a).localeCompare(bookmarkTitle(b), chrome.i18n.getUILanguage())
    );
  } else {
    matched.sort((a, b) => (b.dateAdded || 0) - (a.dateAdded || 0));
  }

  const folderObjects = folderIds.map((id) => folderMap.get(id)).filter(Boolean);
  const totalDuplicates = duplicateBookmarkCount();
  const totalFolders = countBookmarkFolders();
  const filtered = Boolean(keyword);

  return {
    keyword,
    scope,
    folders: folderObjects,
    bookmarks: matched,
    bookmarkIds: matched.map((bookmark) => bookmark.id),
    totalDuplicates,
    totalFolders,
    filtered,
  };
}

/* ------------------------------------------------------------------ *
 * Bookmarks rendering
 * ------------------------------------------------------------------ */

function renderBookmarks() {
  const view = buildBookmarksView();
  cachedBookmarksView = view;
  selectedEl = null;

  const base = t('summaryBookmarks', [
    bookmarks.length,
    view.totalFolders,
    view.totalDuplicates,
  ]);
  summaryEl.textContent = view.filtered
    ? `${base} · ${t('summaryShown', view.bookmarks.length)}`
    : base;

  const frag = document.createDocumentFragment();
  const selecting = currentState().selecting;

  if (!view.folders.length && !view.bookmarks.length) {
    const tip = makeEl('li', 'empty-tip');
    if (view.keyword) tip.textContent = t('bookmarksEmptySearch');
    else if (view.scope !== 'all') tip.textContent = t('folderEmpty');
    else tip.textContent = t('bookmarksEmpty');
    frag.appendChild(tip);
    itemList.replaceChildren(frag);
    restoreListScroll();
    return;
  }

  if (view.folders.length) {
    frag.appendChild(makeSectionLabel(t('foldersSection'), view.folders.length));
    for (const folder of view.folders) {
      frag.appendChild(renderFolderRow(folder, view.keyword, true));
    }
  }

  if (view.bookmarks.length) {
    frag.appendChild(makeSectionLabel(t('bookmarksSection'), view.bookmarks.length));
    const limit = Math.min(view.bookmarks.length, state.bookmarks.renderLimit);
    for (let i = 0; i < limit; i += 1) {
      frag.appendChild(renderBookmarkRow(view.bookmarks[i], view.keyword, selecting));
    }
    if (view.bookmarks.length > limit) {
      const more = makeButton(
        t('loadMore', view.bookmarks.length - limit),
        'load-more-btn',
        () => {
          state.bookmarks.renderLimit += PAGE_SIZE;
          renderBookmarks();
        }
      );
      const li = document.createElement('li');
      li.appendChild(more);
      frag.appendChild(li);
    }
  }

  itemList.replaceChildren(frag);
  restoreListScroll();
  applySelection();
}

function makeSectionLabel(label, count) {
  const li = makeEl('li', 'section-label');
  li.append(makeEl('span', '', `${label} · ${count}`), makeEl('span', 'section-line'));
  return li;
}

function renderFolderRow(folder, keyword, withChevron) {
  const row = makeEl('li', 'folder-row');
  row.dataset.folderId = folder.id;
  row.append(makeEl('span', 'folder-icon'));

  const info = makeEl('div', 'folder-info');
  const name = makeEl('div', 'folder-name');
  appendHighlighted(name, folder.title, keyword);
  info.appendChild(name);

  const meta = makeEl('div', 'folder-meta');
  const count = folderContentCount(folder.id);
  meta.textContent = t('folderItems', count);
  if (keyword) meta.textContent += ` · ${folderPathText(folder.id)}`;
  info.appendChild(meta);
  row.appendChild(info);

  row.appendChild(makeEl('span', 'folder-count', String(count)));
  if (withChevron) row.appendChild(makeEl('span', 'folder-chevron'));
  return row;
}

function renderBookmarkRow(bookmark, keyword, selecting) {
  const row = makeEl('li', 'bookmark-item tab-item');
  row.dataset.bookmarkId = bookmark.id;
  row.dataset.url = bookmark.url;
  row.title = bookmark.url;
  if (selecting && currentState().selected.has(bookmark.id)) row.classList.add('is-selected');

  if (selecting) {
    const { label, input } = makeCheck(currentState().selected.has(bookmark.id), 'row-check');
    input.dataset.bookmarkId = bookmark.id;
    row.append(label);
  }

  row.appendChild(makeFavicon(bookmarkFavicon(bookmark), bookmark.host));

  const info = makeEl('div', 'tab-info');
  const title = makeEl('div', 'tab-title');
  appendHighlighted(title, bookmarkTitle(bookmark), keyword);
  info.appendChild(title);

  const meta = makeEl('div', 'tab-meta');
  const urlEl = makeEl('span', 'host bookmark-url');
  appendHighlighted(urlEl, bookmark.url, keyword);
  meta.appendChild(urlEl);

  if (state.bookmarks.keyword || state.bookmarks.folderId === 'all') {
    const path = makeEl('span', 'folder-path');
    appendHighlighted(path, bookmarkFolderPathText(bookmark), keyword);
    meta.appendChild(path);
  }
  info.appendChild(meta);
  row.appendChild(info);

  return row;
}

function renderCrumbs() {
  if (state.module !== MODULE_BOOKMARKS) {
    bookmarkCrumbs.hidden = true;
    return;
  }
  bookmarkCrumbs.hidden = false;
  const bm = state.bookmarks;
  crumbPath.replaceChildren();

  const allBtn = makeButton(t('allBookmarks'), 'crumb-btn', () => {
    navigateBookmarkFolder('all');
  });
  if (bm.folderId === 'all') allBtn.classList.add('is-current');
  crumbPath.appendChild(allBtn);

  if (bm.folderId !== 'all') {
    const chain = [];
    let folder = folderMap.get(bm.folderId);
    while (folder && !folder.isRoot) {
      chain.unshift(folder);
      folder = folderMap.get(folder.parentId);
    }
    for (const item of chain) {
      crumbPath.appendChild(makeEl('span', 'crumb-sep', '›'));
      const btn = makeButton(item.title, 'crumb-btn', () => {
        navigateBookmarkFolder(item.id);
      });
      if (item.id === bm.folderId) btn.classList.add('is-current');
      crumbPath.appendChild(btn);
    }
  }

  const current = folderMap.get(bm.folderId);
  crumbBack.hidden = !current || bm.folderId === 'all';
}

function navigateBookmarkFolder(folderId) {
  if (folderId !== 'all' && !folderMap.has(folderId)) return;
  const bm = state.bookmarks;
  bm.folderId = folderId;
  bm.keyword = '';
  bm.scrollTop = 0;
  bm.renderLimit = PAGE_SIZE;
  bm.selecting = false;
  bm.selected.clear();
  searchInput.value = '';
  selectedIndex = 0;
  if (isPageOpen()) closePage();
  else renderHome();
}

/* ------------------------------------------------------------------ *
 * Home rendering, selection, module switching
 * ------------------------------------------------------------------ */

function scheduleRender(immediate = false) {
  if (immediate) {
    if (renderTimer) {
      clearTimeout(renderTimer);
      renderTimer = 0;
    }
    renderHome();
    return;
  }
  if (renderTimer) return;
  renderTimer = setTimeout(() => {
    renderTimer = 0;
    renderHome();
  }, 70);
}

function renderHome() {
  if (isPageOpen()) return;
  updateSelectModeButton();
  if (state.module === MODULE_TABS) {
    renderTabs();
    bookmarkCrumbs.hidden = true;
  } else {
    renderBookmarks();
    renderCrumbs();
  }
  updateFooter();
}

function applySelection() {
  const items = visibleListItems();
  if (!items.length) {
    selectedEl = null;
    return;
  }
  selectedIndex = Math.max(0, Math.min(selectedIndex, items.length - 1));
  const next = items[selectedIndex];
  if (selectedEl && selectedEl !== next) selectedEl.classList.remove('selected');
  next.classList.add('selected');
  selectedEl = next;
  next.scrollIntoView({ block: 'nearest' });
}

function visibleListItems() {
  return Array.from(
    itemList.querySelectorAll('.tab-item, .bookmark-item, .folder-row')
  ).filter((el) => el.getClientRects().length > 0);
}

function updateSelectModeButton() {
  const active = currentState().selecting;
  selectModeBtn.classList.toggle('is-active', active);
  selectModeBtn.textContent = active ? t('cancel') : t('selectMode');
}

function setSelecting(on) {
  clearClosePreview();
  const st = currentState();
  st.selecting = Boolean(on);
  if (!st.selecting) st.selected.clear();
  renderHome();
}

function visibleSelectableIds() {
  if (state.module === MODULE_TABS) {
    return cachedTabsView ? cachedTabsView.items.map((item) => item.tab.id) : [];
  }
  return cachedBookmarksView ? cachedBookmarksView.bookmarkIds.slice() : [];
}

function allVisibleSelected() {
  const ids = visibleSelectableIds();
  if (!ids.length) return false;
  const selected = currentState().selected;
  return ids.every((id) => selected.has(id));
}

function updateFooter() {
  if (isPageOpen()) {
    homeFooter.hidden = true;
    return;
  }
  homeFooter.hidden = false;
  const st = currentState();

  tabsFooter.hidden = true;
  bookmarksFooter.hidden = true;
  selectionFooter.hidden = true;

  if (st.selecting) {
    selectionFooter.hidden = false;
    updateSelectionFooter();
    return;
  }

  tabsFooter.hidden = state.module !== MODULE_TABS;
  bookmarksFooter.hidden = state.module !== MODULE_BOOKMARKS;
}

function updateSelectionFooter() {
  const st = currentState();
  const count = st.selected.size;
  selectionCount.textContent = t('selectedCount', count);
  selectionAllBtn.disabled = visibleSelectableIds().length === 0;
  selectionAllBtn.textContent = allVisibleSelected() ? t('clearAll') : t('selectAll');
  selectionCancel.setAttribute('aria-label', t('cancel'));

  selectionActions.replaceChildren();
  if (state.module === MODULE_TABS) {
    const saveBtn = makeButton(t('saveSelected'), 'primary', () => {
      if (!st.selected.size) return;
      openFolderPicker({
        mode: 'save',
        startId: '0',
        count: st.selected.size,
      });
    });
    saveBtn.disabled = count === 0;
    const closeBtn = makeButton(t('closeSelected'), 'danger', () => {
      if (!st.selected.size) return;
      confirmCloseSelectedTabs();
    });
    closeBtn.disabled = count === 0;
    selectionActions.append(saveBtn, closeBtn);
  } else {
    const moveBtn = makeButton(t('moveSelected'), '', () => {
      if (!st.selected.size) return;
      const first = bookmarks.find((bookmark) => st.selected.has(bookmark.id));
      openFolderPicker({
        mode: 'move',
        startId: first?.parentId || '0',
        count: st.selected.size,
      });
    });
    moveBtn.disabled = count === 0;
    const deleteBtn = makeButton(t('deleteSelected'), 'danger', () => {
      if (!st.selected.size) return;
      confirmDeleteSelectedBookmarks();
    });
    deleteBtn.disabled = count === 0;
    selectionActions.append(moveBtn, deleteBtn);
  }
}

function syncRowCheckboxes() {
  const st = currentState();
  for (const input of itemList.querySelectorAll('.row-check')) {
    const id =
      state.module === MODULE_TABS
        ? Number(input.dataset.tabId)
        : input.dataset.bookmarkId;
    const on = st.selected.has(id);
    input.checked = on;
    input.closest('.tab-item')?.classList.toggle('is-selected', on);
  }
  syncGroupChecks();
}

function syncGroupChecks() {
  if (state.module !== MODULE_TABS) return;
  const st = state.tabs;
  for (const input of itemList.querySelectorAll('.group-check')) {
    const ids = cachedGroupIds.get(input.dataset.host) || [];
    const selected = ids.filter((id) => st.selected.has(id)).length;
    input.checked = ids.length > 0 && selected === ids.length;
    input.indeterminate = selected > 0 && selected < ids.length;
  }
}

function toggleVisibleSelection() {
  const ids = visibleSelectableIds();
  const st = currentState();
  if (allVisibleSelected()) {
    for (const id of ids) st.selected.delete(id);
  } else {
    for (const id of ids) st.selected.add(id);
  }
  syncRowCheckboxes();
  updateSelectionFooter();
}

function playModuleSwitchAnimation() {
  document.documentElement.classList.remove('is-module-switching');
  // 强制一次样式计算，确保连续切换时动画能重新播放
  void document.documentElement.offsetWidth;
  document.documentElement.classList.add('is-module-switching');

  clearTimeout(switchTimer);
  switchTimer = setTimeout(() => {
    document.documentElement.classList.remove('is-module-switching');
    switchAnimating = false;
  }, 360);
}

async function switchModule() {
  if (isPageOpen() || switchAnimating) return;
  switchAnimating = true;
  const toBookmarks = state.module === MODULE_TABS;

  // 先读好书签再切页面，保证切换过程中只渲染一次，避免空列表和真实列表
  // 先后出现造成的高度跳动。
  if (toBookmarks) {
    try {
      await loadBookmarksData();
    } catch (err) {
      showToast(err?.message || t('bookmarksUnavailable'));
    }
  }

  moduleCardFlipped = !moduleCardFlipped;
  moduleToggle.classList.toggle('is-flipped', moduleCardFlipped);
  playModuleSwitchAnimation();
  clearClosePreview();
  currentState().scrollTop = itemList.scrollTop;
  state.module = toBookmarks ? MODULE_BOOKMARKS : MODULE_TABS;
  for (const module of [state.tabs, state.bookmarks]) {
    module.selected.clear();
    module.selecting = false;
  }
  savePrefs();
  applyModuleChrome();
  renderHome();
  searchInput.focus();
}

function setSortOptions() {
  const tabs = state.module === MODULE_TABS;
  const items = tabs
    ? [
        ['recent', t('sortRecent')],
        ['stale', t('sortStale')],
      ]
    : [
        ['recent', t('sortBookmarksRecent')],
        ['title', t('sortBookmarksTitle')],
      ];
  const wanted = sortStateFor(state.module);
  sortSelect.replaceChildren(
    ...items.map(([value, label]) => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      return option;
    })
  );
  sortSelect.value = wanted;
  sortSelect.title = tabs ? t('sortTitle') : t('sortBookmarksTitleTip');
  if (pickerMap.has(sortSelect)) rebuildPickerOptions(sortSelect);
  syncNativeSelect(sortSelect);
}

function applyModuleChrome() {
  const tabs = state.module === MODULE_TABS;
  brandTitle.textContent = tabs ? t('tabsTitle') : t('bookmarksTitle');
  brandSub.textContent = tabs ? t('tabsSubtitle') : t('bookmarksSubtitle');
  searchInput.placeholder = tabs ? t('searchPlaceholder') : t('searchBookmarksPlaceholder');
  moduleToggle.title = tabs ? t('switchToBookmarks') : t('switchToTabs');
  moduleToggle.setAttribute('aria-label', moduleToggle.title);
  document.title = `${t('extName')} — ${brandTitle.textContent}`;

  tabsToolbar.hidden = !tabs;
  bookmarksToolbar.hidden = tabs;
  tabsFooter.hidden = !tabs || currentState().selecting;
  bookmarksFooter.hidden = tabs || currentState().selecting;
  closeDuplicatesBtn.hidden = autoDedupe.checked;

  searchInput.value = currentState().keyword;
  setSortOptions();
  updateSelectModeButton();
  updateFooter();
}

/* ------------------------------------------------------------------ *
 * Dedup flow
 * ------------------------------------------------------------------ */

async function openDedup(module) {
  if (isPageOpen()) return;
  const st = state[module];
  st.selecting = false;
  st.selected.clear();

  try {
    if (module === MODULE_TABS) await loadTabsData();
    else await loadBookmarksData();
  } catch (err) {
    showToast(err?.message || t('reasonUnknown'));
    return;
  }

  const groups = module === MODULE_TABS ? duplicateTabGroups() : bookmarkDuplicateGroups();
  const selected = new Set();
  for (const group of groups) {
    for (const item of group.items) {
      if ((item.id ?? item.tab?.id) !== group.keepId) {
        selected.add(item.id ?? item.tab?.id);
      }
    }
  }

  dedupState = { module, groups, selected };
  renderDedupPage();
}

function dedupItemId(item) {
  if (dedupState.module === MODULE_TABS) return (item.tab || item).id;
  return item.id;
}

function findDedupGroupFor(id) {
  return dedupState.groups.find((group) =>
    group.items.some((item) => dedupItemId(item) === id)
  );
}

function renderDedupPage() {
  const isTabs = dedupState.module === MODULE_TABS;
  const title = isTabs ? t('dedupeTabsTitle') : t('dedupeBookmarksTitle');
  const subtitle = dedupState.groups.length
    ? t('dedupeGroups', dedupState.groups.length)
    : t('dedupeNoneTitle');

  const body = document.createDocumentFragment();
  const hint = makeEl('div', 'dedup-hint');
  hint.id = 'dedup-hint';
  body.appendChild(hint);

  if (!dedupState.groups.length) {
    const empty = makeEl('div', 'empty-page');
    empty.append(
      makeEl('div', 'empty-icon', '✓'),
      makeEl('strong', '', t('dedupeNone')),
      makeEl('div', '', isTabs ? t('dedupeNoneTabsText') : t('dedupeNoneBookmarksText'))
    );
    body.appendChild(empty);
  } else {
    for (const group of dedupState.groups) {
      body.appendChild(renderDedupGroup(group, isTabs));
    }
  }

  const footer = [];
  if (dedupState.groups.length) {
    const removeBtn = makeButton(
      t('confirmRemoveMany', dedupState.selected.size),
      'danger',
      confirmDedupRemoval
    );
    removeBtn.disabled = dedupState.selected.size === 0;
    footer.push(
      makeButton(t('cancel'), '', () => closePage()),
      removeBtn
    );
  } else {
    footer.push(makeButton(t('done'), 'primary', () => closePage()));
  }

  showPage({
    type: 'dedup',
    title,
    subtitle,
    body,
    footer,
    onBack: () => closePage(),
  });
}

function renderDedupGroup(group, isTabs) {
  const wrap = makeEl('section', 'dedup-group');
  const head = makeEl('div', 'dedup-head');
  const host = group.host || t('groupOther');
  head.append(
    makeEl('span', 'dedup-host', host),
    makeEl('span', 'dedup-count', t('dupeBadge', group.items.length))
  );
  wrap.appendChild(head);

  const list = makeEl('ul', 'dedup-list');
  for (const item of group.items) {
    const id = dedupItemId(item);
    const selected = dedupState.selected.has(id);
    const row = makeEl('li', 'dedup-item' + (selected ? '' : ' is-keep'));
    row.dataset.dedupId = String(id);

    const { label, input } = makeCheck(selected, 'dedup-check');
    input.dataset.dedupId = String(id);
    input.addEventListener('change', () => onDedupToggle(id, input, row));
    row.append(label);

    if (isTabs) {
      const tab = item.tab || item;
      const itemHost = item.host || hostOf(tabUrl(tab));
      row.appendChild(makeFavicon(tab.favIconUrl, itemHost));
      const info = makeEl('div', 'tab-info');
      info.append(
        makeEl('div', 'tab-title', tabTitle(tab)),
        makeEl('div', 'tab-meta', tabUrl(tab))
      );
      row.appendChild(info);
    } else {
      row.appendChild(makeFavicon(bookmarkFavicon(item), item.host));
      const info = makeEl('div', 'tab-info');
      info.append(
        makeEl('div', 'tab-title', bookmarkTitle(item)),
        makeEl('div', 'tab-meta', bookmarkFolderPathText(item))
      );
      row.appendChild(info);
    }

    const keep = makeEl('span', 'keep-badge', t('dedupeKeep'));
    keep.hidden = selected;
    row.appendChild(keep);

    row.addEventListener('click', (e) => {
      if (e.target.closest('.check')) return;
      input.checked = !input.checked;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    list.appendChild(row);
  }
  wrap.appendChild(list);
  return wrap;
}

function onDedupToggle(id, input, row) {
  const group = findDedupGroupFor(id);
  if (!group) return;

  if (input.checked) {
    const selectedCount = group.items.filter((item) =>
      dedupState.selected.has(dedupItemId(item))
    ).length;
    if (selectedCount === group.items.length - 1) {
      input.checked = false;
      const hint = $('dedup-hint');
      if (hint) {
        hint.textContent = t('dedupeKeepOne');
        setTimeout(() => {
          if (hint.isConnected) hint.textContent = '';
        }, 2200);
      }
      return;
    }
    dedupState.selected.add(id);
  } else {
    dedupState.selected.delete(id);
  }

  row.classList.toggle('is-keep', !input.checked);
  const keepBadge = row.querySelector('.keep-badge');
  if (keepBadge) keepBadge.hidden = input.checked;
  updateDedupFooter();
}

function updateDedupFooter() {
  const btn = pageFooter.querySelector('button.danger');
  if (!btn) return;
  btn.textContent = t('confirmRemoveMany', dedupState.selected.size);
  btn.disabled = dedupState.selected.size === 0;
}

function confirmDedupRemoval() {
  if (!dedupState || !dedupState.selected.size) return;
  const isTabs = dedupState.module === MODULE_TABS;
  const ids = Array.from(dedupState.selected);
  const items = ids.map((id) => {
    if (isTabs) {
      const tab = allTabs.find((candidate) => candidate.id === id);
      return { id, label: tab ? tabTitle(tab) : String(id), sub: tab?.url || '' };
    }
    const bookmark = bookmarkMap.get(id);
    return {
      id,
      label: bookmark ? bookmarkTitle(bookmark) : String(id),
      sub: bookmark ? bookmark.url : '',
    };
  });

  openConfirm({
    title: t('confirmRemoveDuplicates'),
    message: isTabs
      ? t('dedupeConfirmTabs', ids.length)
      : t('dedupeConfirmBookmarks', ids.length),
    items,
    confirmLabel: t('confirmRemoveMany', ids.length),
    onConfirm: async () => {
      const results = await runBatch(
        items,
        isTabs ? closeTabItem : deleteBookmarkItem
      );
      showResultPage({
        title: isTabs ? t('resultClosedTabs') : t('resultDeletedBookmarks'),
        results,
        worker: isTabs ? closeTabItem : deleteBookmarkItem,
        afterDone: () => {
          dedupState = null;
        },
      });
    },
    onCancel: () => renderDedupPage(),
  });
}

/* ------------------------------------------------------------------ *
 * Batch operations
 * ------------------------------------------------------------------ */

function errorReason(err) {
  return err?.message || t('reasonUnknown');
}

async function runBatch(items, worker) {
  const results = [];
  for (const item of items) {
    try {
      const result = await worker(item);
      results.push({
        ...item,
        status: result?.status || 'ok',
        reason: result?.reason || '',
      });
    } catch (err) {
      results.push({ ...item, status: 'failed', reason: errorReason(err) });
    }
  }
  return results;
}

async function closeTabItem(item) {
  let tab;
  try {
    tab = await chrome.tabs.get(item.id);
  } catch {
    return { status: 'skipped', reason: t('reasonMissing') };
  }
  if (tab.pinned) return { status: 'skipped', reason: t('reasonPinned') };
  await chrome.tabs.remove(item.id);
  return { status: 'ok' };
}

async function deleteBookmarkItem(item) {
  try {
    await chrome.bookmarks.get(item.id);
  } catch {
    return { status: 'skipped', reason: t('reasonMissing') };
  }
  await chrome.bookmarks.remove(item.id);
  return { status: 'ok' };
}

async function moveBookmarkItem(item, folderId) {
  let nodes;
  try {
    nodes = await chrome.bookmarks.get(item.id);
  } catch {
    return { status: 'skipped', reason: t('reasonMissing') };
  }
  const bookmark = nodes[0];
  if (!bookmark) return { status: 'skipped', reason: t('reasonMissing') };
  if (bookmark.parentId === folderId) {
    return { status: 'skipped', reason: t('reasonSameFolder') };
  }
  await chrome.bookmarks.move(item.id, { parentId: folderId });
  return { status: 'ok' };
}

async function saveTabItem(item, folderId, existingUrls) {
  let tab;
  try {
    tab = await chrome.tabs.get(item.id);
  } catch {
    return { status: 'skipped', reason: t('reasonMissing') };
  }
  const url = tabUrl(tab);
  if (!/^https?:/.test(url)) {
    return { status: 'skipped', reason: t('reasonNoUrl') };
  }
  const key = urlKey(url);
  if (existingUrls.has(key)) {
    return { status: 'skipped', reason: t('reasonDuplicate') };
  }
  await chrome.bookmarks.create({
    parentId: folderId,
    title: tabTitle(tab),
    url,
  });
  existingUrls.add(key);
  return { status: 'ok' };
}

function confirmCloseSelectedTabs() {
  const ids = Array.from(state.tabs.selected);
  const items = ids.map((id) => {
    const tab = allTabs.find((candidate) => candidate.id === id);
    return { id, label: tab ? tabTitle(tab) : String(id), sub: tab?.url || '' };
  });
  openConfirm({
    title: t('confirmCloseTabsTitle'),
    message: t('confirmCloseTabsBody', ids.length),
    items,
    confirmLabel: t('confirmRemoveMany', ids.length),
    onConfirm: async () => {
      const results = await runBatch(items, closeTabItem);
      showResultPage({
        title: t('resultClosedTabs'),
        results,
        worker: closeTabItem,
        afterDone: resetSelections,
      });
    },
  });
}

function confirmDeleteSelectedBookmarks() {
  const ids = Array.from(state.bookmarks.selected);
  const items = ids.map((id) => {
    const bookmark = bookmarkMap.get(id);
    return {
      id,
      label: bookmark ? bookmarkTitle(bookmark) : String(id),
      sub: bookmark ? bookmark.url : '',
    };
  });
  openConfirm({
    title: t('confirmDeleteBookmarksTitle'),
    message: t('confirmDeleteBookmarksBody', ids.length),
    items,
    confirmLabel: t('confirmRemoveMany', ids.length),
    onConfirm: async () => {
      const results = await runBatch(items, deleteBookmarkItem);
      showResultPage({
        title: t('resultDeletedBookmarks'),
        results,
        worker: deleteBookmarkItem,
        afterDone: resetSelections,
      });
    },
  });
}

function confirmCloseGroup(host, closeBtn) {
  const ids = allTabs
    .filter((tab) => !tab.pinned && (hostOf(tabUrl(tab)) || OTHER_HOST) === host)
    .map((tab) => tab.id);
  if (!ids.length) return;
  const items = ids.map((id) => {
    const tab = allTabs.find((candidate) => candidate.id === id);
    return { id, label: tab ? tabTitle(tab) : String(id), sub: tab?.url || '' };
  });
  openConfirm({
    title: t('confirmCloseGroupTitle'),
    message: t('confirmCloseGroupBody', [ids.length, hostLabel(host)]),
    items,
    confirmLabel: t('confirmRemoveMany', ids.length),
    onConfirm: async () => {
      const results = await runBatch(items, closeTabItem);
      showResultPage({
        title: t('resultClosedTabs'),
        results,
        worker: closeTabItem,
        afterDone: resetSelections,
      });
    },
  });
}

function resetSelections() {
  for (const module of [state.tabs, state.bookmarks]) {
    module.selected.clear();
    module.selecting = false;
  }
  updateSelectModeButton();
}

async function reloadCurrentModule() {
  try {
    if (state.module === MODULE_TABS) {
      await loadTabsData();
      updateCloseIdleLabel();
    } else {
      await loadBookmarksData();
    }
  } catch (err) {
    showToast(err?.message || t('reasonUnknown'));
  }
  renderHome();
}

/* ------------------------------------------------------------------ *
 * Result flow
 * ------------------------------------------------------------------ */

function resultCounts(results) {
  return {
    ok: results.filter((result) => result.status === 'ok').length,
    skipped: results.filter((result) => result.status === 'skipped').length,
    failed: results.filter((result) => result.status === 'failed').length,
  };
}

function showResultPage({ title, results, worker, afterDone }) {
  const resultState = { title, results, worker, afterDone };
  renderResultPage(resultState);
}

function renderResultPage(resultState) {
  const counts = resultCounts(resultState.results);
  const finish = () => {
    closePage();
    resetSelections();
    resultState.afterDone?.();
    reloadCurrentModule();
  };

  const body = document.createDocumentFragment();
  const stats = makeEl('div', 'result-summary');
  stats.append(
    makeResultStat(counts.ok, t('resultSuccess'), 'is-ok'),
    makeResultStat(counts.skipped, t('resultSkipped'), 'is-skip'),
    makeResultStat(counts.failed, t('resultFailed'), 'is-fail')
  );
  body.appendChild(stats);

  const list = makeEl('ul', 'result-list');
  for (const result of resultState.results) {
    const row = makeEl('li', 'result-item');
    row.dataset.status = result.status;
    const mark = makeEl(
      'span',
      'result-mark',
      result.status === 'ok' ? '✓' : result.status === 'skipped' ? '–' : '!'
    );
    const text = makeEl('div', 'result-text');
    text.appendChild(makeEl('div', 'result-label', result.label || String(result.id)));
    const reason =
      result.status === 'ok' ? result.sub || '' : result.reason || result.sub || '';
    if (reason) text.appendChild(makeEl('div', 'result-reason', reason));
    row.append(mark, text);
    list.appendChild(row);
  }
  body.appendChild(list);

  const footer = [];
  if (counts.failed) {
    const retry = makeButton(t('retryFailed'), 'primary', async () => {
      retry.disabled = true;
      retry.textContent = t('retrying');
      const failed = resultState.results.filter((result) => result.status === 'failed');
      for (const result of failed) {
        try {
          const next = await resultState.worker(result);
          result.status = next?.status || 'ok';
          result.reason = next?.reason || '';
        } catch (err) {
          result.status = 'failed';
          result.reason = errorReason(err);
        }
      }
      renderResultPage(resultState);
    });
    footer.push(retry);
  }
  footer.push(makeButton(t('done'), counts.failed ? '' : 'primary', finish));

  showPage({
    type: 'result',
    title: resultState.title || t('resultTitle'),
    subtitle: t('resultSubtitle', [counts.ok, counts.skipped, counts.failed]),
    body,
    footer,
    onBack: finish,
  });
}

function makeResultStat(count, label, className) {
  const box = makeEl('div', 'result-stat ' + className);
  box.append(makeEl('strong', '', String(count)), makeEl('span', '', label));
  return box;
}

/* ------------------------------------------------------------------ *
 * Confirm flow
 * ------------------------------------------------------------------ */

function openConfirm({ title, message, items, confirmLabel, onConfirm, onCancel }) {
  const body = makeEl('div', 'confirm-card');
  body.append(makeEl('div', 'confirm-icon', '!'), makeEl('div', 'confirm-message', message));

  if (items?.length) {
    const list = makeEl('ul', 'confirm-list');
    for (const item of items.slice(0, MAX_SUMMARY_ITEMS)) {
      const li = document.createElement('li');
      li.append(makeEl('span', '', '•'), makeEl('span', '', item.label || String(item.id)));
      list.appendChild(li);
    }
    if (items.length > MAX_SUMMARY_ITEMS) {
      const li = document.createElement('li');
      li.append(
        makeEl('span', '', '•'),
        makeEl('span', '', t('andMore', items.length - MAX_SUMMARY_ITEMS))
      );
      list.appendChild(li);
    }
    body.appendChild(list);
  }

  const footer = [];
  const cancel = makeButton(t('cancel'), '', () => {
    if (onCancel) onCancel();
    else closePage();
  });
  const confirm = makeButton(confirmLabel, 'danger', async () => {
    cancel.disabled = true;
    confirm.disabled = true;
    confirm.textContent = t('working');
    try {
      await onConfirm();
    } catch (err) {
      cancel.disabled = false;
      confirm.disabled = false;
      confirm.textContent = confirmLabel;
      showToast(errorReason(err));
    }
  });
  footer.push(cancel, confirm);

  showPage({
    type: 'confirm',
    title: t('confirmTitle'),
    subtitle: title,
    body,
    footer,
    onBack: () => {
      if (onCancel) onCancel();
      else closePage();
    },
  });
}

/* ------------------------------------------------------------------ *
 * Folder picker and new folder
 * ------------------------------------------------------------------ */

function defaultCreateParent() {
  const bm = state.bookmarks;
  if (bm.folderId !== 'all' && folderMap.has(bm.folderId)) return bm.folderId;
  if (folderMap.has('2')) return '2';
  return topFolderIds[0] || bookmarkRootId;
}

function folderChildIds(folderId) {
  if (folderId === bookmarkRootId) return topFolderIds.slice();
  return folderMap.get(folderId)?.childFolderIds.slice() || [];
}

async function openFolderPicker({ mode, startId, count }) {
  if (!bookmarksLoaded) {
    try {
      await loadBookmarksData();
    } catch (err) {
      showToast(errorReason(err));
      return;
    }
  }
  const start = startId && folderMap.has(startId) ? startId : bookmarkRootId;
  folderPickerState = { mode, currentId: start, count: count || 0 };
  renderFolderPickerPage();
}

function folderPickerTitle(mode) {
  if (mode === 'save') return t('chooseSaveFolder');
  if (mode === 'move') return t('chooseMoveFolder');
  return t('browseFolder');
}

function renderFolderPickerPage() {
  const picker = folderPickerState;
  const current = folderMap.get(picker.currentId);
  const isRoot = picker.currentId === bookmarkRootId;
  const childIds = folderChildIds(picker.currentId);

  const body = document.createDocumentFragment();
  const tools = makeEl('div', 'folder-tools');
  const currentLabel = makeEl(
    'div',
    'folder-current',
    isRoot ? t('bookmarksRoot') : folderPathText(picker.currentId)
  );
  const newBtn = makeButton(t('newFolder'), 'tool-btn', () => {
    if (isRoot) return;
    openNewFolderPage(picker.currentId, {
      onCreated: (id) => {
        folderPickerState.currentId = id;
        renderFolderPickerPage();
      },
      onCancel: () => renderFolderPickerPage(),
    });
  });
  newBtn.disabled = isRoot;
  tools.append(newBtn, currentLabel);
  body.appendChild(tools);

  if (childIds.length) {
    const list = makeEl('ul', 'folder-list');
    for (const id of childIds) {
      const row = renderFolderRow(folderMap.get(id), '', true);
      row.addEventListener('click', () => {
        folderPickerState.currentId = id;
        renderFolderPickerPage();
      });
      list.appendChild(row);
    }
    body.appendChild(list);
  } else {
    const empty = makeEl('div', 'empty-page');
    empty.append(
      makeEl('div', 'empty-icon', '⌂'),
      makeEl('strong', '', t('folderEmpty')),
      makeEl('div', '', t('folderEmptyHint'))
    );
    body.appendChild(empty);
  }

  const footer = [];
  const primary = makeButton(
    folderPickerPrimaryLabel(),
    'primary',
    () => chooseFolderForPicker(),
    { disabled: isRoot }
  );
  footer.push(makeButton(t('cancel'), '', () => closePage()), primary);

  showPage({
    type: 'folder',
    title: folderPickerTitle(picker.mode),
    subtitle: picker.count
      ? t('folderPickerCount', picker.count)
      : isRoot
        ? t('bookmarksRoot')
        : folderPathText(picker.currentId),
    body,
    footer,
    onBack: () => {
      if (isRoot) {
        closePage();
      } else {
        folderPickerState.currentId = current?.parentId || bookmarkRootId;
        renderFolderPickerPage();
      }
    },
  });
}

function folderPickerPrimaryLabel() {
  const picker = folderPickerState;
  if (picker.mode === 'save') return t('saveHereCount', picker.count);
  if (picker.mode === 'move') return t('moveHereCount', picker.count);
  return t('browseHere');
}

async function chooseFolderForPicker() {
  const picker = folderPickerState;
  if (!picker || picker.currentId === bookmarkRootId) return;

  if (picker.mode === 'browse') {
    const id = picker.currentId;
    folderPickerState = null;
    closePage();
    navigateBookmarkFolder(id);
    return;
  }

  const isSave = picker.mode === 'save';
  const ids = isSave
    ? Array.from(state.tabs.selected)
    : Array.from(state.bookmarks.selected);
  const items = ids.map((id) => {
    if (isSave) {
      const tab = allTabs.find((candidate) => candidate.id === id);
      return { id, label: tab ? tabTitle(tab) : String(id), sub: tab?.url || '' };
    }
    const bookmark = bookmarkMap.get(id);
    return {
      id,
      label: bookmark ? bookmarkTitle(bookmark) : String(id),
      sub: bookmark ? bookmark.url : '',
    };
  });
  if (!items.length) return;

  const primary = pageFooter.querySelector('.primary');
  if (primary) {
    primary.disabled = true;
    primary.textContent = t('working');
  }

  const folderId = picker.currentId;

  try {
    let results;
    let worker;
    if (isSave) {
      await loadBookmarksData();
      const existing = new Set(bookmarks.map((bookmark) => urlKey(bookmark.url)));
      worker = (item) => saveTabItem(item, folderId, existing);
      results = await runBatch(items, worker);
      // 收藏写入后，书签缓存已过期；下次进入书签模块必须重新读取
      bookmarksLoaded = false;
    } else {
      worker = (item) => moveBookmarkItem(item, folderId);
      results = await runBatch(items, worker);
    }
    showResultPage({
      title: isSave ? t('resultSavedTabs') : t('resultMovedBookmarks'),
      results,
      worker,
      afterDone: resetSelections,
    });
    folderPickerState = null;
  } catch (err) {
    showToast(errorReason(err));
    renderFolderPickerPage();
  }
}

function openNewFolderPage(parentId, options = {}) {
  const parentLabel =
    parentId === bookmarkRootId ? t('bookmarksRoot') : folderPathText(parentId);

  const body = makeEl('div', 'page-form');
  const label = makeEl('label', '', t('folderParentLabel'));
  const path = makeEl('div', 'page-note', parentLabel);
  const input = document.createElement('input');
  input.type = 'text';
  input.maxLength = 120;
  input.placeholder = t('folderNamePlaceholder');
  input.autocomplete = 'off';
  body.append(label, path, input);

  const footer = [];
  const cancel = makeButton(t('cancel'), '', () => {
    if (options.onCancel) options.onCancel();
    else closePage();
  });

  let busy = false;
  const create = makeButton(t('createFolder'), 'primary', createFolder);
  async function createFolder() {
    const name = input.value.trim();
    if (!name || busy) {
      input.focus();
      return;
    }
    busy = true;
    create.disabled = true;
    cancel.disabled = true;
    create.textContent = t('working');
    try {
      const created = await chrome.bookmarks.create({ parentId, title: name });
      await loadBookmarksData();
      if (options.onCreated) options.onCreated(created.id);
      else {
        closePage();
        navigateBookmarkFolder(created.id);
      }
    } catch (err) {
      busy = false;
      create.disabled = false;
      cancel.disabled = false;
      create.textContent = t('createFolder');
      showToast(errorReason(err));
    }
  }

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') createFolder();
  });
  footer.push(cancel, create);

  showPage({
    type: 'new-folder',
    title: t('newFolderTitle'),
    subtitle: parentLabel,
    body,
    footer,
    onBack: () => {
      if (options.onCancel) options.onCancel();
      else closePage();
    },
  });
  setTimeout(() => input.focus(), 0);
}

function openNewFolderFromHome() {
  openNewFolderPage(defaultCreateParent(), {
    onCreated: (id) => {
      closePage();
      navigateBookmarkFolder(id);
    },
    onCancel: () => closePage(),
  });
}

/* ------------------------------------------------------------------ *
 * Page manager
 * ------------------------------------------------------------------ */

function showPage({ type, title, subtitle, body, footer, onBack }) {
  page = { type, onBack: onBack || (() => closePage()) };
  searchInput.blur();
  topEl.hidden = true;
  homeView.hidden = true;
  homeFooter.hidden = true;
  pageView.hidden = false;
  pageTitle.textContent = title || '';
  pageSubtitle.textContent = subtitle || '';
  pageSubtitle.hidden = !subtitle;
  pageBody.replaceChildren();
  if (body) pageBody.appendChild(body);
  pageFooter.replaceChildren();
  for (const btn of footer || []) pageFooter.appendChild(btn);
  pageBody.scrollTop = 0;
}

function closePage() {
  page = null;
  pageView.hidden = true;
  topEl.hidden = false;
  homeView.hidden = false;
  pageBody.replaceChildren();
  pageFooter.replaceChildren();
  updateFooter();
  renderHome();
  searchInput.focus();
}

/* ------------------------------------------------------------------ *
 * Search, keyboard and native select pickers
 * ------------------------------------------------------------------ */

function onSearchInput() {
  clearClosePreview();
  const st = currentState();
  if (st.selecting) {
    st.selecting = false;
    st.selected.clear();
    updateSelectModeButton();
  }
  st.keyword = searchInput.value.trim();
  st.scrollTop = 0;
  st.renderLimit = PAGE_SIZE;
  selectedIndex = 0;
  scheduleRender(false);
}

function saveScrollPosition() {
  if (isPageOpen()) return;
  currentState().scrollTop = itemList.scrollTop;
}

function setupPickers() {
  for (const select of document.querySelectorAll('select')) {
    const picker = makeEl('div', 'picker' + (select.id === 'theme' ? ' picker-compact' : ''));
    select.parentNode.insertBefore(picker, select);
    picker.appendChild(select);
    select.classList.add('picker-native');
    select.tabIndex = -1;

    const trigger = makeButton('', 'picker-trigger', null, { title: select.title });
    trigger.setAttribute('aria-haspopup', 'listbox');
    trigger.setAttribute('aria-expanded', 'false');
    const label = makeEl('span', 'picker-label');
    const chevron = makeEl('span', 'picker-chevron');
    chevron.setAttribute('aria-hidden', 'true');
    trigger.append(label, chevron);

    const menu = makeEl('div', 'picker-menu');
    menu.hidden = true;
    menu.setAttribute('role', 'listbox');

    picker.append(trigger, menu);
    pickerMap.set(select, { picker, trigger, label, menu });
    rebuildPickerOptions(select);
    syncNativeSelect(select);

    trigger.addEventListener('click', () => {
      const willOpen = menu.hidden;
      closePickers(picker);
      if (!willOpen) return;
      menu.hidden = false;
      picker.classList.add('is-open');
      trigger.setAttribute('aria-expanded', 'true');
      const triggerRect = trigger.getBoundingClientRect();
      picker.classList.toggle(
        'is-up',
        window.innerHeight - triggerRect.bottom < menu.offsetHeight + 12
      );
      menu.style.left = '0';
      menu.style.right = 'auto';
      if (menu.getBoundingClientRect().right > window.innerWidth - 8) {
        menu.style.left = 'auto';
        menu.style.right = '0';
      }
    });

    menu.addEventListener('click', (e) => {
      const item = e.target.closest('.picker-option');
      if (!item || item.dataset.value === select.value) {
        closePickers();
        return;
      }
      select.value = item.dataset.value;
      syncNativeSelect(select);
      closePickers();
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }
}

function rebuildPickerOptions(select) {
  const entry = pickerMap.get(select);
  if (!entry) return;
  entry.menu.replaceChildren();
  for (const option of select.options) {
    const item = makeButton(option.textContent, 'picker-option', null);
    item.dataset.value = option.value;
    item.setAttribute('role', 'option');
    entry.menu.appendChild(item);
  }
}

function closePickers(except) {
  for (const { picker, menu, trigger } of pickerMap.values()) {
    if (picker === except) continue;
    picker.classList.remove('is-open');
    menu.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
  }
}

/* ------------------------------------------------------------------ *
 * Event wiring
 * ------------------------------------------------------------------ */

moduleToggle.addEventListener('click', () => {
  switchModule().catch((err) => {
    switchAnimating = false;
    document.documentElement.classList.remove('is-module-switching');
    showToast(errorReason(err));
  });
});

searchInput.addEventListener('input', onSearchInput);
searchInput.addEventListener('keydown', (e) => {
  const items = visibleListItems();
  if (e.key === 'ArrowDown' && items.length) {
    e.preventDefault();
    selectedIndex += 1;
    applySelection();
  } else if (e.key === 'ArrowUp' && items.length) {
    e.preventDefault();
    selectedIndex -= 1;
    applySelection();
  } else if (e.key === 'Enter' && items.length) {
    e.preventDefault();
    applySelection();
    items[selectedIndex]?.click();
  }
});

sortSelect.addEventListener('change', () => {
  clearClosePreview();
  currentState().sort = sortSelect.value;
  currentState().scrollTop = 0;
  savePrefs();
  scheduleRender(true);
});

idleDays.addEventListener('change', () => {
  clearClosePreview();
  savePrefs();
  updateCloseIdleLabel();
  scheduleRender(true);
});

themeSelect.addEventListener('change', () => {
  applyTheme(themeSelect.value);
  savePrefs();
});

window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (themeSelect.value === 'system') applyTheme('system');
});

selectModeBtn.addEventListener('click', () => {
  setSelecting(!currentState().selecting);
});

selectionAllBtn.addEventListener('click', toggleVisibleSelection);
selectionCancel.addEventListener('click', () => setSelecting(false));

autoDedupe.addEventListener('change', () => {
  clearClosePreview();
  closeDuplicatesBtn.hidden = autoDedupe.checked;
  savePrefs();
  renderHome();
  if (autoDedupe.checked) {
    chrome.runtime.sendMessage({ type: 'dedupe-all-now' }).catch(() => {});
  }
});

closeDuplicatesBtn.addEventListener('click', () => {
  const ids = duplicateTargets();
  confirmAction(closeDuplicatesBtn, ids.length, () => chrome.tabs.remove(ids));
});

bookmarksDedupBtn.addEventListener('click', () => openDedup(MODULE_BOOKMARKS));

folderFilterBtn.addEventListener('click', () => {
  openFolderPicker({
    mode: 'browse',
    startId: state.bookmarks.folderId === 'all' ? bookmarkRootId : state.bookmarks.folderId,
  });
});

newFolderBtn.addEventListener('click', openNewFolderFromHome);

crumbBack.addEventListener('click', () => {
  const current = folderMap.get(state.bookmarks.folderId);
  if (current && !current.isRoot) navigateBookmarkFolder(current.parentId || 'all');
});

itemList.addEventListener(
  'scroll',
  () => {
    if (!isPageOpen()) currentState().scrollTop = itemList.scrollTop;
  },
  { passive: true }
);

itemList.addEventListener('change', (e) => {
  const target = e.target;
  if (target.classList.contains('group-check')) {
    const host = target.dataset.host;
    const ids = cachedGroupIds.get(host) || [];
    for (const id of ids) {
      if (target.checked) state.tabs.selected.add(id);
      else state.tabs.selected.delete(id);
    }
    syncRowCheckboxes();
    updateSelectionFooter();
    return;
  }
  if (target.classList.contains('row-check')) {
    const st = currentState();
    const id =
      state.module === MODULE_TABS
        ? Number(target.dataset.tabId)
        : target.dataset.bookmarkId;
    if (target.checked) st.selected.add(id);
    else st.selected.delete(id);
    target.closest('.tab-item')?.classList.toggle('is-selected', target.checked);
    syncGroupChecks();
    updateSelectionFooter();
  }
});

itemList.addEventListener('click', async (e) => {
  const folderRow = e.target.closest('.folder-row');
  if (folderRow) {
    navigateBookmarkFolder(folderRow.dataset.folderId);
    return;
  }

  const groupCheck = e.target.closest('.domain-header .check');
  if (groupCheck) return;

  const closeBtn = e.target.closest('.close-btn');
  if (closeBtn) {
    e.stopPropagation();
    const id = Number(closeBtn.dataset.tabId);
    if (!id) return;
    try {
      await chrome.tabs.remove(id);
      await loadTabsData();
      updateCloseIdleLabel();
      renderHome();
    } catch (err) {
      showToast(errorReason(err));
    }
    return;
  }

  const closeGroupBtn = e.target.closest('.close-group-btn');
  if (closeGroupBtn) {
    e.stopPropagation();
    confirmCloseGroup(closeGroupBtn.dataset.host);
    return;
  }

  const header = e.target.closest('.domain-header');
  if (header && !currentState().selecting && !searchInput.value.trim()) {
    const wrap = header.closest('.domain-group');
    const host = wrap?.dataset.host;
    if (!host || !wrap) return;
    if (collapsedHosts.has(host)) collapsedHosts.delete(host);
    else collapsedHosts.add(host);
    wrap.classList.toggle('collapsed');
    applySelection();
    return;
  }

  const bookmarkRow = e.target.closest('.bookmark-item');
  if (bookmarkRow) {
    if (currentState().selecting) {
      const input = bookmarkRow.querySelector('.row-check');
      if (input) {
        input.checked = !input.checked;
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }
      return;
    }
    const bookmark = bookmarkMap.get(bookmarkRow.dataset.bookmarkId);
    if (!bookmark) return;
    try {
      await chrome.tabs.create({ url: bookmark.url });
      window.close();
    } catch (err) {
      showToast(errorReason(err));
    }
    return;
  }

  const row = e.target.closest('.tab-item');
  if (row) {
    if (currentState().selecting) {
      const input = row.querySelector('.row-check');
      if (input) {
        input.checked = !input.checked;
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }
      return;
    }
    const tabId = Number(row.dataset.tabId);
    const windowId = Number(row.dataset.windowId);
    if (!tabId) return;
    try {
      await chrome.tabs.update(tabId, { active: true });
      await chrome.windows.update(windowId, { focused: true });
      window.close();
    } catch (err) {
      showToast(errorReason(err));
    }
  }
});

groupToggle.addEventListener('change', async () => {
  if (!supportsTabGroups) return;
  clearClosePreview();
  const turnOn = groupToggle.checked;
  autoGroupOn = turnOn;
  groupToggle.disabled = true;
  try {
    await savePrefs();
    if (turnOn) {
      await chrome.runtime.sendMessage({ type: 'group-all-now' });
    } else {
      const tabs = await chrome.tabs.query({});
      const noneId = chrome.tabGroups.TAB_GROUP_ID_NONE;
      const grouped = tabs.filter((tab) => tab.groupId !== noneId);
      if (grouped.length) await chrome.tabs.ungroup(grouped.map((tab) => tab.id));
    }
  } finally {
    await loadTabsData();
    groupToggle.disabled = false;
    updateCloseIdleLabel();
    renderHome();
  }
});

closeIdleBtn.addEventListener('click', () => {
  if (idleDays.value === 'all' || closeIdleBtn.disabled) return;
  const ids = Array.from(ensureIdleIds());
  if (!ids.length) return;
  const items = ids.map((id) => {
    const tab = allTabs.find((candidate) => candidate.id === id);
    return { id, label: tab ? tabTitle(tab) : String(id), sub: tab?.url || '' };
  });
  openConfirm({
    title: t('confirmCloseIdleTitle'),
    message: t('confirmCloseIdleBody', [ids.length, selectedIdleDays()]),
    items,
    confirmLabel: t('confirmRemoveMany', ids.length),
    onConfirm: async () => {
      const results = await runBatch(items, closeTabItem);
      showResultPage({
        title: t('resultClosedTabs'),
        results,
        worker: closeTabItem,
        afterDone: resetSelections,
      });
    },
  });
});

pageBack.addEventListener('click', () => {
  if (page?.onBack) page.onBack();
  else closePage();
});

document.addEventListener('click', (e) => {
  if (!e.target.closest('.picker')) closePickers();
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;

  if (document.querySelector('.picker.is-open')) {
    e.stopPropagation();
    closePickers();
    return;
  }
  if (isPageOpen()) {
    e.preventDefault();
    if (page?.onBack) page.onBack();
    else closePage();
    return;
  }
  if (searchInput.value) {
    searchInput.value = '';
    onSearchInput();
  } else if (closePreview) {
    clearClosePreview();
    renderHome();
  } else {
    window.close();
  }
});

// Live updates from the browser while the popup is open
chrome.tabs.onRemoved.addListener(() => scheduleHomeReload('tabs'));
chrome.tabs.onCreated.addListener(() => scheduleHomeReload('tabs'));
chrome.bookmarks.onCreated.addListener(() => scheduleHomeReload('bookmarks'));
chrome.bookmarks.onRemoved.addListener(() => scheduleHomeReload('bookmarks'));
chrome.bookmarks.onChanged.addListener(() => scheduleHomeReload('bookmarks'));
chrome.bookmarks.onMoved.addListener(() => scheduleHomeReload('bookmarks'));

function scheduleHomeReload(module) {
  if (module === MODULE_BOOKMARKS) bookmarksLoaded = false;
  if (state.module !== module || isPageOpen()) return;
  if (homeReloadTimer) return;
  homeReloadTimer = setTimeout(async () => {
    homeReloadTimer = 0;
    if (state.module !== module || isPageOpen()) return;
    try {
      if (module === MODULE_TABS) await loadTabsData();
      else await loadBookmarksData();
      renderHome();
      updateCloseIdleLabel();
    } catch (err) {
      showToast(errorReason(err));
    }
  }, 180);
}

/* ------------------------------------------------------------------ *
 * Init
 * ------------------------------------------------------------------ */

async function init() {
  await loadPrefs();
  applyTheme(themeSelect.value);
  pageBack.title = t('back');
  pageBack.setAttribute('aria-label', t('back'));
  crumbBack.title = t('back');
  crumbBack.setAttribute('aria-label', t('back'));
  setSortOptions();
  setupPickers();
  applyModuleChrome();

  try {
    await loadTabsData();
    if (state.module === MODULE_BOOKMARKS) await loadBookmarksData();
  } catch (err) {
    showToast(errorReason(err));
  }

  updateCloseIdleLabel();
  renderHome();
  searchInput.focus();
}

init().catch((err) => {
  console.error('Tab Box init failed:', err);
  showToast(errorReason(err));
});
