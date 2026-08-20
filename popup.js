const searchInput = document.getElementById('search');
const sortSelect = document.getElementById('sort');
const idleOnly = document.getElementById('idle-only');
const idleDays = document.getElementById('idle-days');
const autoGroup = document.getElementById('auto-group');
const autoDedupe = document.getElementById('auto-dedupe');
const tabList = document.getElementById('tab-list');
const summaryEl = document.getElementById('summary');
const groupBtn = document.getElementById('group-btn');
const ungroupBtn = document.getElementById('ungroup-btn');
const closeDuplicatesBtn = document.getElementById('close-duplicates');
const closeIdleBtn = document.getElementById('close-idle');

const supportsTabGroups = Boolean(
  chrome.tabGroups && chrome.tabs.group && chrome.tabs.ungroup
);

let allTabs = [];
let statsByDay = {};
let lastActive = {};
let collapsedHosts = new Set();
let selectedIndex = 0;
let confirmTimer = null;
let confirmTarget = null;
let renderTimer = 0;
let cachedItems = [];

if (!supportsTabGroups) {
  groupBtn.disabled = true;
  ungroupBtn.disabled = true;
  groupBtn.title = '当前浏览器不支持标签组 API，请升级 Edge / Chrome';
  ungroupBtn.title = groupBtn.title;
}

function selectedIdleDays() {
  return Math.min(7, Math.max(1, Number(idleDays.value) || 2));
}

function updateCloseIdleLabel() {
  const days = selectedIdleDays();
  closeIdleBtn.textContent = `关闭近${days}天未访问`;
  closeIdleBtn.dataset.label = closeIdleBtn.textContent;
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
  const [tabs, stored] = await Promise.all([
    chrome.tabs.query({}),
    chrome.storage.local.get(['stats', 'lastActive', 'prefs']),
  ]);
  allTabs = tabs;
  statsByDay = stored.stats || {};
  lastActive = stored.lastActive || {};

  const prefs = stored.prefs || {};
  if (!sortSelect.dataset.ready) {
    if (prefs.sort) sortSelect.value = prefs.sort;
    idleOnly.checked = Boolean(prefs.idleOnly ?? prefs.unvisitedOnly);
    if (prefs.idleDays) idleDays.value = String(prefs.idleDays);
    autoGroup.checked = prefs.autoGroup !== false;
    autoDedupe.checked = prefs.autoDedupe !== false;
    sortSelect.dataset.ready = '1';
  }
  updateCloseIdleLabel();
  scheduleRender(true);
}

function savePrefs() {
  chrome.storage.local.set({
    prefs: {
      sort: sortSelect.value,
      idleOnly: idleOnly.checked,
      idleDays: selectedIdleDays(),
      autoGroup: autoGroup.checked,
      autoDedupe: autoDedupe.checked,
    },
  });
}

function buildViewModel() {
  const keyword = searchInput.value.trim().toLowerCase();
  const days = selectedIdleDays();
  const onlyIdle = idleOnly.checked;
  const today = new Date().toLocaleDateString('sv');
  const todayStats = statsByDay[today] || {};
  const urlCounts = new Map();
  let idleTotal = 0;
  let dupeTotal = 0;

  for (const tab of allTabs) {
    const url = tabUrlKey(tab.url);
    urlCounts.set(url, (urlCounts.get(url) || 0) + 1);
    if (isIdleTab(tab, days)) idleTotal += 1;
  }
  for (const [url, count] of urlCounts) {
    if (count > 1 && /^https?:/.test(url)) dupeTotal += count - 1;
  }

  const items = [];
  for (const tab of allTabs) {
    const url = tabUrlKey(tab.url);
    const host = hostOf(tab.url);
    const count = todayStats[url] || 0;
    if (onlyIdle && !isIdleTab(tab, days)) continue;

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

  if (sortSelect.value === 'least') {
    items.sort((a, b) => a.count - b.count || a.last - b.last);
  } else if (sortSelect.value === 'stale') {
    items.sort((a, b) => a.last - b.last);
  }

  const groups = [];
  const index = new Map();
  for (const item of items) {
    const key = item.host || '(其他)';
    let g = index.get(key);
    if (g == null) {
      g = groups.length;
      index.set(key, g);
      groups.push({ host: key, items: [], minCount: item.count, minLast: item.last || 0 });
    }
    const group = groups[g];
    group.items.push(item);
    if (item.count < group.minCount) group.minCount = item.count;
    if ((item.last || 0) < group.minLast) group.minLast = item.last || 0;
  }

  if (sortSelect.value === 'least') {
    groups.sort((a, b) => a.minCount - b.minCount || b.items.length - a.items.length);
  } else if (sortSelect.value === 'stale') {
    groups.sort((a, b) => a.minLast - b.minLast);
  } else {
    groups.sort((a, b) => b.items.length - a.items.length);
  }

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
    view.keyword || idleOnly.checked ? ` · 显示 ${view.items.length} 个` : ''
  }`;

  const frag = document.createDocumentFragment();

  if (view.items.length === 0) {
    const tip = document.createElement('li');
    tip.className = 'empty-tip';
    tip.textContent = view.keyword ? '没有匹配的标签页' : '没有符合条件的标签页';
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
    summaryEl.textContent = `没有可${label}的标签页`;
    return;
  }
  if (confirmTarget !== btn) {
    if (confirmTimer) clearTimeout(confirmTimer);
    if (confirmTarget) confirmTarget.textContent = confirmTarget.dataset.label;
    confirmTarget = btn;
    btn.dataset.label = btn.dataset.label || btn.textContent;
    btn.textContent = `再点一次，${label} ${count} 个`;
    confirmTimer = setTimeout(() => {
      btn.textContent = btn.dataset.label;
      confirmTarget = null;
    }, 3000);
    return;
  }
  clearTimeout(confirmTimer);
  btn.textContent = btn.dataset.label;
  confirmTarget = null;
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
  scheduleRender(false);
});
sortSelect.addEventListener('change', () => {
  savePrefs();
  scheduleRender(true);
});
idleOnly.addEventListener('change', () => {
  savePrefs();
  scheduleRender(true);
});
idleDays.addEventListener('change', () => {
  updateCloseIdleLabel();
  savePrefs();
  scheduleRender(true);
});
autoGroup.addEventListener('change', () => {
  savePrefs();
  if (autoGroup.checked) chrome.runtime.sendMessage({ type: 'group-all-now' });
});
autoDedupe.addEventListener('change', () => {
  savePrefs();
  if (autoDedupe.checked) chrome.runtime.sendMessage({ type: 'dedupe-all-now' });
});

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
      scheduleRender(true);
    } else {
      window.close();
    }
  }
});

groupBtn.addEventListener('click', async () => {
  if (!supportsTabGroups) return;
  await chrome.runtime.sendMessage({ type: 'group-all-now' });
  reload();
});

ungroupBtn.addEventListener('click', async () => {
  if (!supportsTabGroups) return;
  const tabs = await chrome.tabs.query({});
  const noneId = chrome.tabGroups.TAB_GROUP_ID_NONE;
  const grouped = tabs.filter((t) => t.groupId !== noneId);
  if (grouped.length) await chrome.tabs.ungroup(grouped.map((t) => t.id));
  autoGroup.checked = false;
  savePrefs();
  reload();
});

closeDuplicatesBtn.addEventListener('click', () => {
  const ids = duplicateTargets();
  confirmAction(closeDuplicatesBtn, ids.length, '关闭重复', () => chrome.tabs.remove(ids));
});

closeIdleBtn.addEventListener('click', () => {
  const days = selectedIdleDays();
  const targets = allTabs.filter(
    (t) => !t.pinned && !t.active && /^https?:/.test(t.url || '') && isIdleTab(t, days)
  );
  confirmAction(closeIdleBtn, targets.length, `关闭近${days}天未访问`, () =>
    chrome.tabs.remove(targets.map((t) => t.id))
  );
});

reload();
