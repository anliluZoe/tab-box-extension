const searchInput = document.getElementById('search');
const sortSelect = document.getElementById('sort');
const idleDays = document.getElementById('idle-days');
const autoDedupe = document.getElementById('auto-dedupe');
const tabList = document.getElementById('tab-list');
const summaryEl = document.getElementById('summary');
const groupToggle = document.getElementById('group-toggle');
const closeDuplicatesBtn = document.getElementById('close-duplicates');
const closeIdleBtn = document.getElementById('close-idle');
const versionText = document.getElementById('version-text');
const checkUpdateBtn = document.getElementById('check-update');
const themeSelect = document.getElementById('theme');

const UPDATE_REPOS = ['anliluZoe/tab-box-extension', 'anliluZoe/brower-extension'];
const manifestVersion = chrome.runtime.getManifest().version;
versionText.textContent = `当前版本 v${manifestVersion}`;

const supportsTabGroups = Boolean(
  chrome.tabGroups && chrome.tabs.group && chrome.tabs.ungroup
);

let allTabs = [];
let statsByDay = {};
let lastActive = {};
let collapsedHosts = new Set();
let selectedIndex = 0;
let confirmTarget = null;
let closePreview = null;
let renderTimer = 0;
let cachedItems = [];
let themeMode = 'system';
let autoGroupOn = true;

if (!supportsTabGroups) {
  groupToggle.disabled = true;
  groupToggle.closest('.group-switch').title = '当前浏览器不支持标签组 API，请升级 Edge / Chrome';
}

function resolveTheme(mode) {
  if (mode === 'light' || mode === 'dark') return mode;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyTheme(mode = themeMode) {
  themeMode = mode || 'system';
  document.documentElement.dataset.theme = resolveTheme(themeMode);
}

function selectedIdleDays() {
  // 还没选天数时，摘要里的闲置数量仍按近 2 天统计
  const n = Number(idleDays.value);
  if (!n) return 2;
  return Math.min(7, Math.max(1, n));
}

function updateCloseIdleLabel() {
  const pending = idleDays.value !== 'all';
  const days = selectedIdleDays();
  const count = pending ? allTabs.filter((t) => isIdleCloseTarget(t, days)).length : 0;
  closeIdleBtn.disabled = !pending || count === 0;
  closeIdleBtn.textContent = count ? `确认移除 ${count} 个` : '确认移除';
  closeIdleBtn.title = !pending
    ? '先选择未访问天数，列表会显示将要关闭的标签页'
    : count
      ? `关闭近${days}天未访问的 ${count} 个标签页`
      : `没有近${days}天未访问的标签页`;
}

function recentDayKeys(days) {
  const keys = [];
  const now = Date.now();
  for (let i = 0; i < days; i += 1) {
    keys.push(new Date(now - i * 86400000).toLocaleDateString('sv'));
  }
  return keys;
}

function tabLastSeen(tab, url) {
  return lastActive[url] || tab.lastAccessed || 0;
}

function isIdleTab(tab, days) {
  const url = tabUrlKey(tab.url);
  const last = tabLastSeen(tab, url);
  const cutoff = Date.now() - days * 86400000;
  if (last && last >= cutoff) return false;
  for (const day of recentDayKeys(days)) {
    if (statsByDay[day]?.[url]) return false;
  }
  // 没有可靠活跃记录时不判定为闲置，避免误关
  return Boolean(last) && last < cutoff;
}

function isIdleCloseTarget(tab, days) {
  return !tab.pinned && !tab.active && /^https?:/.test(tab.url || '') && isIdleTab(tab, days);
}

function clearClosePreview() {
  if (!closePreview && !confirmTarget) return;
  if (confirmTarget) confirmTarget.textContent = confirmTarget.dataset.label;
  confirmTarget = null;
  closePreview = null;
}

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

function formatAgo(ago) {
  if (ago < 60000) return '刚刚';
  if (ago < 3600000) return `${Math.floor(ago / 60000)} 分钟前`;
  if (ago < 86400000) return `${Math.floor(ago / 3600000)} 小时前`;
  return `${Math.floor(ago / 86400000)} 天前`;
}

function scheduleRender(immediate) {
  if (immediate) {
    if (renderTimer) {
      clearTimeout(renderTimer);
      renderTimer = 0;
    }
    render();
    return;
  }
  if (renderTimer) return;
  renderTimer = setTimeout(() => {
    renderTimer = 0;
    render();
  }, 80);
}

function visibleTabItems() {
  return tabList.querySelectorAll('.domain-group:not(.collapsed) .tab-item');
}

function applySelection() {
  const items = visibleTabItems();
  if (!items.length) return;
  selectedIndex = Math.max(0, Math.min(selectedIndex, items.length - 1));
  items.forEach((el, i) => el.classList.toggle('selected', i === selectedIndex));
  items[selectedIndex].scrollIntoView({ block: 'nearest' });
}

async function reload() {
  clearClosePreview();
  const [tabs, stored] = await Promise.all([
    chrome.tabs.query({}),
    chrome.storage.local.get(['stats', 'lastActive', 'prefs']),
  ]);
  allTabs = tabs;
  statsByDay = stored.stats || {};
  lastActive = stored.lastActive || {};

  const prefs = stored.prefs || {};
  if (!sortSelect.dataset.ready) {
    // 旧「访问最少优先」并入「最久未用优先」；旧「标签多的在前」改为「最新访问优先」
    const sortWasStale = prefs.sort === 'least' || prefs.sort === 'stale';
    sortSelect.value = sortWasStale ? 'stale' : 'recent';
    const legacyFilter = 'idleOnly' in prefs || 'unvisitedOnly' in prefs;
    if (prefs.idleDays === 'all' || (prefs.idleDays && !legacyFilter)) {
      idleDays.value = String(prefs.idleDays);
    } else if (legacyFilter && (prefs.idleOnly || prefs.unvisitedOnly) && prefs.idleDays) {
      idleDays.value = String(prefs.idleDays);
    } else {
      idleDays.value = 'all';
    }
    autoGroupOn = prefs.autoGroup !== false;
    autoDedupe.checked = prefs.autoDedupe !== false;
    closeDuplicatesBtn.hidden = autoDedupe.checked;
    themeSelect.value = prefs.theme || 'system';
    applyTheme(themeSelect.value);
    sortSelect.dataset.ready = '1';
    if (prefs.sort !== sortSelect.value) savePrefs();
    syncPicker(sortSelect);
    syncPicker(idleDays);
    syncPicker(themeSelect);
  }
  if (supportsTabGroups) groupToggle.checked = autoGroupOn;
  updateCloseIdleLabel();
  scheduleRender(true);
}

function savePrefs() {
  return chrome.storage.local.set({
    prefs: {
      sort: sortSelect.value,
      idleDays: idleDays.value,
      autoGroup: autoGroupOn,
      autoDedupe: autoDedupe.checked,
      theme: themeSelect.value,
    },
  });
}

function buildViewModel() {
  const keyword = closePreview ? '' : searchInput.value.trim().toLowerCase();
  const days = selectedIdleDays();
  const limitToIdle = closePreview === 'idle' || (!closePreview && idleDays.value !== 'all');
  const today = new Date().toLocaleDateString('sv');
  const todayStats = statsByDay[today] || {};
  const urlCounts = new Map();
  let idleTotal = 0;
  let dupeTotal = 0;

  for (const tab of allTabs) {
    const url = tabUrlKey(tab.url);
    urlCounts.set(url, (urlCounts.get(url) || 0) + 1);
    if (isIdleCloseTarget(tab, days)) idleTotal += 1;
  }
  for (const [url, count] of urlCounts) {
    if (count > 1 && /^https?:/.test(url)) dupeTotal += count - 1;
  }

  const dupeCloseIds = closePreview === 'duplicates' ? new Set(duplicateTargets()) : null;
  const items = [];
  for (const tab of allTabs) {
    const url = tabUrlKey(tab.url);
    const host = hostOf(tab.url);
    const count = todayStats[url] || 0;
    if (dupeCloseIds) {
      if (!dupeCloseIds.has(tab.id)) continue;
    } else if (limitToIdle && !isIdleCloseTarget(tab, days)) {
      continue;
    }

    const title = tab.title || tab.url || '(无标题)';
    if (keyword) {
      const hay = `${title}\n${tab.url || ''}\n${host}\n${url}`.toLowerCase();
      if (!hay.includes(keyword)) continue;
    }

    items.push({
      tab,
      host,
      url,
      title,
      count,
      last: tabLastSeen(tab, url),
      dupes: urlCounts.get(url) || 1,
    });
  }

  const sortByStale = sortSelect.value === 'stale';
  if (sortByStale) items.sort((a, b) => a.last - b.last);
  else items.sort((a, b) => b.last - a.last);

  const groups = [];
  const index = new Map();
  for (const item of items) {
    const key = item.host || '(其他)';
    let g = index.get(key);
    if (g == null) {
      g = groups.length;
      index.set(key, g);
      groups.push({ host: key, items: [], minLast: item.last || 0, maxLast: item.last || 0 });
    }
    const group = groups[g];
    group.items.push(item);
    const seen = item.last || 0;
    if (seen < group.minLast) group.minLast = seen;
    if (seen > group.maxLast) group.maxLast = seen;
  }

  if (sortByStale) groups.sort((a, b) => a.minLast - b.minLast);
  else groups.sort((a, b) => b.maxLast - a.maxLast);

  return { keyword, items, groups, idleTotal, dupeTotal, days };
}

function renderTabRow(item, keyword, now) {
  const { tab, host, title, count, last, dupes } = item;
  const li = document.createElement('li');
  li.className = 'tab-item' + (tab.active ? ' active-tab' : '');
  li.dataset.tabId = String(tab.id);
  li.dataset.windowId = String(tab.windowId);
  li.title = tab.url || '';

  if (tab.favIconUrl && /^https?:/.test(tab.favIconUrl)) {
    const img = document.createElement('img');
    img.className = 'favicon';
    img.src = tab.favIconUrl;
    img.loading = 'lazy';
    img.addEventListener(
      'error',
      () => {
        const fb = document.createElement('div');
        fb.className = 'favicon-fallback';
        fb.textContent = (host[0] || '?').toUpperCase();
        img.replaceWith(fb);
      },
      { once: true }
    );
    li.appendChild(img);
  } else {
    const fb = document.createElement('div');
    fb.className = 'favicon-fallback';
    fb.textContent = (host[0] || '?').toUpperCase();
    li.appendChild(fb);
  }

  const info = document.createElement('div');
  info.className = 'tab-info';

  const titleEl = document.createElement('div');
  titleEl.className = 'tab-title';
  appendHighlighted(titleEl, title, keyword);
  info.appendChild(titleEl);

  const meta = document.createElement('div');
  meta.className = 'tab-meta';
  const hostSpan = document.createElement('span');
  hostSpan.className = 'host';
  appendHighlighted(hostSpan, host || tab.url || '', keyword);
  meta.appendChild(hostSpan);
  if (last) {
    const timeSpan = document.createElement('span');
    timeSpan.textContent = formatAgo(now - last);
    meta.appendChild(timeSpan);
  }
  info.appendChild(meta);
  li.appendChild(info);

  if (dupes > 1) {
    const dupe = document.createElement('span');
    dupe.className = 'dupe-badge';
    dupe.textContent = `重复 ${dupes}`;
    dupe.title = '还有相同网址的标签页';
    li.appendChild(dupe);
  }

  const badge = document.createElement('span');
  badge.className = 'count-badge' + (count === 0 ? ' zero' : '');
  badge.textContent = `今日 ${count}`;
  badge.title = '今天切换到该页面的次数';
  li.appendChild(badge);

  const closeBtn = document.createElement('button');
  closeBtn.className = 'close-btn';
  closeBtn.type = 'button';
  closeBtn.textContent = '×';
  closeBtn.title = '关闭该标签页';
  li.appendChild(closeBtn);

  return li;
}

function render() {
  const now = Date.now();
  const view = buildViewModel();
  cachedItems = view.items;

  summaryEl.textContent = `共 ${allTabs.length} 个 · 近${view.days}天闲置 ${view.idleTotal} 个 · 重复 ${view.dupeTotal} 个${
    view.keyword || idleDays.value !== 'all' || closePreview ? ` · 显示 ${view.items.length} 个` : ''
  }`;

  const frag = document.createDocumentFragment();

  if (view.items.length === 0) {
    const tip = document.createElement('li');
    tip.className = 'empty-tip';
    tip.textContent = view.keyword
      ? '没有匹配的标签页'
      : idleDays.value !== 'all'
        ? `没有近${view.days}天未访问的标签页`
        : '没有符合条件的标签页';
    frag.appendChild(tip);
    tabList.replaceChildren(frag);
    return;
  }

  const searching = Boolean(view.keyword);
  for (const group of view.groups) {
    const wrap = document.createElement('li');
    wrap.className = 'domain-group';
    wrap.dataset.host = group.host;
    if (!searching && collapsedHosts.has(group.host)) wrap.classList.add('collapsed');

    const header = document.createElement('div');
    header.className = 'domain-header';

    const name = document.createElement('span');
    name.className = 'domain-name';
    appendHighlighted(name, group.host, view.keyword);

    const count = document.createElement('span');
    count.className = 'domain-count';
    count.textContent = `${group.items.length}`;

    const closeGroupBtn = document.createElement('button');
    closeGroupBtn.className = 'close-group-btn';
    closeGroupBtn.type = 'button';
    closeGroupBtn.textContent = '关闭本组';
    closeGroupBtn.title = `关闭 ${group.host} 下未固定的标签页`;

    header.append(name, count, closeGroupBtn);

    const inner = document.createElement('ul');
    inner.className = 'domain-tabs';
    for (const item of group.items) inner.appendChild(renderTabRow(item, view.keyword, now));

    wrap.append(header, inner);
    frag.appendChild(wrap);
  }

  tabList.replaceChildren(frag);
  applySelection();
}

function duplicateTargets() {
  const byUrl = new Map();
  for (const tab of allTabs) {
    if (tab.pinned || !/^https?:/.test(tab.url || '')) continue;
    const key = tabUrlKey(tab.url);
    if (!byUrl.has(key)) byUrl.set(key, []);
    byUrl.get(key).push(tab);
  }

  const toClose = [];
  for (const tabs of byUrl.values()) {
    if (tabs.length < 2) continue;
    tabs.sort((a, b) => a.id - b.id);
    for (let i = 0; i < tabs.length - 1; i += 1) toClose.push(tabs[i].id);
  }
  return toClose;
}

async function confirmAction(btn, count, label, run) {
  if (count === 0) {
    const hadPreview = Boolean(closePreview || confirmTarget);
    clearClosePreview();
    if (hadPreview) render();
    summaryEl.textContent = `没有可${label}的标签页`;
    return;
  }
  if (confirmTarget !== btn) {
    if (confirmTarget) confirmTarget.textContent = confirmTarget.dataset.label;
    confirmTarget = btn;
    closePreview = btn === closeDuplicatesBtn ? 'duplicates' : 'idle';
    btn.dataset.label = btn.dataset.label || btn.textContent;
    btn.textContent = btn === closeDuplicatesBtn ? '确认关闭重复标签页' : `确认${label}`;
    selectedIndex = 0;
    scheduleRender(true);
    return;
  }
  clearClosePreview();
  await run();
  reload();
}

// 事件委托：避免给每个标签页单独绑监听器
tabList.addEventListener('click', async (e) => {
  const closeBtn = e.target.closest('.close-btn');
  if (closeBtn) {
    e.stopPropagation();
    const row = closeBtn.closest('.tab-item');
    const tabId = Number(row?.dataset.tabId);
    if (tabId) {
      await chrome.tabs.remove(tabId);
      reload();
    }
    return;
  }

  const closeGroupBtn = e.target.closest('.close-group-btn');
  if (closeGroupBtn) {
    e.stopPropagation();
    const wrap = closeGroupBtn.closest('.domain-group');
    const host = wrap?.dataset.host;
    const ids = cachedItems
      .filter((i) => (i.host || '(其他)') === host && !i.tab.pinned)
      .map((i) => i.tab.id);
    if (ids.length) {
      await chrome.tabs.remove(ids);
      if (host) collapsedHosts.delete(host);
      reload();
    }
    return;
  }

  const header = e.target.closest('.domain-header');
  if (header && !searchInput.value.trim()) {
    const wrap = header.closest('.domain-group');
    const host = wrap?.dataset.host;
    if (!host || !wrap) return;
    if (collapsedHosts.has(host)) {
      collapsedHosts.delete(host);
      wrap.classList.remove('collapsed');
    } else {
      collapsedHosts.add(host);
      wrap.classList.add('collapsed');
    }
    applySelection();
    return;
  }

  const row = e.target.closest('.tab-item');
  if (row) {
    const tabId = Number(row.dataset.tabId);
    const windowId = Number(row.dataset.windowId);
    await chrome.tabs.update(tabId, { active: true });
    await chrome.windows.update(windowId, { focused: true });
    window.close();
  }
});

searchInput.addEventListener('input', () => {
  selectedIndex = 0;
  clearClosePreview();
  scheduleRender(false);
});
sortSelect.addEventListener('change', () => {
  clearClosePreview();
  savePrefs();
  scheduleRender(true);
});
idleDays.addEventListener('change', () => {
  clearClosePreview();
  updateCloseIdleLabel();
  savePrefs();
  scheduleRender(true);
});
themeSelect.addEventListener('change', () => {
  applyTheme(themeSelect.value);
  savePrefs();
});
autoDedupe.addEventListener('change', () => {
  clearClosePreview();
  closeDuplicatesBtn.hidden = autoDedupe.checked;
  savePrefs();
  scheduleRender(true);
  if (autoDedupe.checked) chrome.runtime.sendMessage({ type: 'dedupe-all-now' });
});

window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (themeSelect.value === 'system') applyTheme('system');
});

applyTheme('system');

searchInput.addEventListener('keydown', (e) => {
  const items = visibleTabItems();
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
    items[selectedIndex].click();
  } else if (e.key === 'Escape') {
    if (searchInput.value) {
      searchInput.value = '';
      selectedIndex = 0;
      clearClosePreview();
      scheduleRender(true);
    } else {
      window.close();
    }
  }
});

groupToggle.addEventListener('change', async () => {
  if (!supportsTabGroups) return;
  const turnOn = groupToggle.checked;
  autoGroupOn = turnOn;
  groupToggle.disabled = true;
  clearClosePreview();
  try {
    await savePrefs();
    if (turnOn) {
      await chrome.runtime.sendMessage({ type: 'group-all-now' });
    } else {
      const tabs = await chrome.tabs.query({});
      const noneId = chrome.tabGroups.TAB_GROUP_ID_NONE;
      const grouped = tabs.filter((t) => t.groupId !== noneId);
      if (grouped.length) await chrome.tabs.ungroup(grouped.map((t) => t.id));
    }
  } finally {
    await reload();
    if (supportsTabGroups) groupToggle.disabled = false;
  }
});

closeDuplicatesBtn.addEventListener('click', () => {
  const ids = duplicateTargets();
  confirmAction(closeDuplicatesBtn, ids.length, '关闭重复', () => chrome.tabs.remove(ids));
});

closeIdleBtn.addEventListener('click', async () => {
  if (idleDays.value === 'all' || closeIdleBtn.disabled) return;
  const days = selectedIdleDays();
  const ids = allTabs.filter((t) => isIdleCloseTarget(t, days)).map((t) => t.id);
  if (!ids.length) return;
  clearClosePreview();
  await chrome.tabs.remove(ids);
  reload();
});

function parseVersion(raw) {
  return String(raw || '')
    .trim()
    .replace(/^v/i, '')
    .split(/[.+-]/)
    .filter(Boolean)
    .map((part) => {
      const n = Number.parseInt(part, 10);
      return Number.isFinite(n) ? n : 0;
    });
}

function compareVersion(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  const len = Math.max(left.length, right.length);
  for (let i = 0; i < len; i += 1) {
    const x = left[i] || 0;
    const y = right[i] || 0;
    if (x !== y) return x - y;
  }
  return 0;
}

async function fetchLatestRelease() {
  let lastError;
  for (const repo of UPDATE_REPOS) {
    try {
      const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
        headers: { Accept: 'application/vnd.github+json' },
      });
      if (res.status === 404) continue;
      if (!res.ok) throw new Error(`GitHub API ${res.status}`);
      const data = await res.json();
      if (data?.tag_name) return data;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error('未找到可用的 Release');
}

checkUpdateBtn.addEventListener('click', async () => {
  checkUpdateBtn.classList.add('busy');
  checkUpdateBtn.textContent = '检查中…';
  try {
    const release = await fetchLatestRelease();
    const latest = release.tag_name;
    const pageUrl = release.html_url;
    const zip = (release.assets || []).find(
      (a) => /\.zip$/i.test(a.name) && /tab-box/i.test(a.name)
    ) || (release.assets || []).find((a) => /\.zip$/i.test(a.name));

    if (compareVersion(latest, manifestVersion) > 0) {
      summaryEl.textContent = `发现新版本 ${latest}（当前 v${manifestVersion}），正在打开下载页…`;
      await chrome.tabs.create({ url: zip?.browser_download_url || pageUrl });
    } else {
      summaryEl.textContent = `已是最新版本 v${manifestVersion}`;
    }
  } catch (err) {
    console.warn('检查更新失败:', err);
    summaryEl.textContent = '检查更新失败，请稍后重试或手动打开 GitHub Release 页';
  } finally {
    checkUpdateBtn.classList.remove('busy');
    checkUpdateBtn.textContent = '检查更新';
  }
});

function syncPicker(select) {
  const picker = select.closest('.picker');
  if (!picker) return;
  picker.querySelector('.picker-label').textContent = select.selectedOptions[0]?.textContent || '';
  picker.querySelectorAll('.picker-option').forEach((btn) => {
    const on = btn.dataset.value === select.value;
    btn.classList.toggle('is-selected', on);
    btn.setAttribute('aria-selected', on ? 'true' : 'false');
  });
}

function closePickers(except) {
  document.querySelectorAll('.picker.is-open').forEach((picker) => {
    if (picker === except) return;
    picker.classList.remove('is-open');
    picker.querySelector('.picker-menu').hidden = true;
    picker.querySelector('.picker-trigger').setAttribute('aria-expanded', 'false');
  });
}

for (const select of document.querySelectorAll('select')) {
  const picker = document.createElement('div');
  picker.className = 'picker' + (select.id === 'theme' ? ' picker-compact' : '');
  select.parentNode.insertBefore(picker, select);
  picker.appendChild(select);
  select.classList.add('picker-native');
  select.tabIndex = -1;

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'picker-trigger';
  trigger.title = select.title;
  trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.setAttribute('aria-expanded', 'false');
  const label = document.createElement('span');
  label.className = 'picker-label';
  const chevron = document.createElement('span');
  chevron.className = 'picker-chevron';
  chevron.setAttribute('aria-hidden', 'true');
  trigger.append(label, chevron);

  const menu = document.createElement('div');
  menu.className = 'picker-menu';
  menu.hidden = true;
  menu.setAttribute('role', 'listbox');
  for (const option of select.options) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'picker-option';
    item.dataset.value = option.value;
    item.textContent = option.textContent;
    item.setAttribute('role', 'option');
    menu.appendChild(item);
  }

  picker.append(trigger, menu);
  syncPicker(select);

  trigger.addEventListener('click', () => {
    const willOpen = menu.hidden;
    closePickers(picker);
    if (!willOpen) return;
    menu.hidden = false;
    picker.classList.add('is-open');
    trigger.setAttribute('aria-expanded', 'true');
    const triggerRect = trigger.getBoundingClientRect();
    picker.classList.toggle('is-up', window.innerHeight - triggerRect.bottom < menu.offsetHeight + 12);
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
    syncPicker(select);
    closePickers();
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

document.addEventListener('click', (e) => {
  if (!e.target.closest('.picker')) closePickers();
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || !document.querySelector('.picker.is-open')) return;
  e.stopPropagation();
  closePickers();
});

reload();
