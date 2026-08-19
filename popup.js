const searchInput = document.getElementById('search');
const sortSelect = document.getElementById('sort');
const unvisitedOnly = document.getElementById('unvisited-only');
const autoGroup = document.getElementById('auto-group');
const autoDedupe = document.getElementById('auto-dedupe');
const tabList = document.getElementById('tab-list');
const summaryEl = document.getElementById('summary');
const groupBtn = document.getElementById('group-btn');
const ungroupBtn = document.getElementById('ungroup-btn');
const closeDuplicatesBtn = document.getElementById('close-duplicates');
const closeUnvisitedBtn = document.getElementById('close-unvisited');

const supportsTabGroups = Boolean(
  chrome.tabGroups && chrome.tabs.group && chrome.tabs.ungroup
);

const GROUP_COLORS = ['blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];

let allTabs = [];
let todayStats = {};
let lastActive = {};
let collapsedHosts = new Set();
let selectedIndex = 0;
let confirmTimer = null;
let confirmTarget = null;

if (!supportsTabGroups) {
  groupBtn.disabled = true;
  ungroupBtn.disabled = true;
  groupBtn.title = '当前浏览器不支持标签组 API，请升级 Edge / Chrome';
  ungroupBtn.title = groupBtn.title;
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
  while (start < text.length) {
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
  }
}

function visibleTabItems() {
  return [...tabList.querySelectorAll('.domain-group:not(.collapsed) .tab-item')];
}

function applySelection() {
  const items = visibleTabItems();
  if (items.length === 0) return;
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
  const today = new Date().toLocaleDateString('sv');
  todayStats = (stored.stats || {})[today] || {};
  lastActive = stored.lastActive || {};

  const prefs = stored.prefs || {};
  if (!sortSelect.dataset.ready) {
    if (prefs.sort) sortSelect.value = prefs.sort;
    unvisitedOnly.checked = Boolean(prefs.unvisitedOnly);
    autoGroup.checked = prefs.autoGroup !== false;
    autoDedupe.checked = prefs.autoDedupe !== false;
    sortSelect.dataset.ready = '1';
    unvisitedOnly.dataset.ready = '1';
    autoGroup.dataset.ready = '1';
    autoDedupe.dataset.ready = '1';
  }

  render();
}

function savePrefs() {
  chrome.storage.local.set({
    prefs: {
      sort: sortSelect.value,
      unvisitedOnly: unvisitedOnly.checked,
      autoGroup: autoGroup.checked,
      autoDedupe: autoDedupe.checked,
    },
  });
}

function filteredItems() {
  const keyword = searchInput.value.trim().toLowerCase();

  const urlCounts = new Map();
  for (const tab of allTabs) {
    const key = tabUrlKey(tab.url);
    urlCounts.set(key, (urlCounts.get(key) || 0) + 1);
  }

  return allTabs
    .map((tab) => {
      const url = tabUrlKey(tab.url);
      const host = hostOf(tab.url);
      return {
        tab,
        host,
        url,
        count: todayStats[url] || 0,
        last: lastActive[url] || tab.lastAccessed || 0,
        dupes: urlCounts.get(url) || 1,
      };
    })
    .filter(({ tab, host, url, count }) => {
      if (unvisitedOnly.checked && count > 0) return false;
      if (!keyword) return true;
      return (
        (tab.title || '').toLowerCase().includes(keyword) ||
        (tab.url || '').toLowerCase().includes(keyword) ||
        host.toLowerCase().includes(keyword) ||
        url.toLowerCase().includes(keyword)
      );
    });
}

function sortItems(items) {
  if (sortSelect.value === 'least') {
    items.sort((a, b) => a.count - b.count || a.last - b.last);
  } else if (sortSelect.value === 'stale') {
    items.sort((a, b) => a.last - b.last);
  }
  return items;
}

function groupedByHost(items) {
  const groups = [];
  const index = new Map();
  for (const item of items) {
    const key = item.host || '(其他)';
    if (!index.has(key)) {
      index.set(key, groups.length);
      groups.push({ host: key, items: [] });
    }
    groups[index.get(key)].items.push(item);
  }

  if (sortSelect.value === 'least') {
    groups.sort((a, b) => {
      const minA = Math.min(...a.items.map((i) => i.count));
      const minB = Math.min(...b.items.map((i) => i.count));
      return minA - minB || b.items.length - a.items.length;
    });
  } else if (sortSelect.value === 'stale') {
    groups.sort((a, b) => {
      const minA = Math.min(...a.items.map((i) => i.last || 0));
      const minB = Math.min(...b.items.map((i) => i.last || 0));
      return minA - minB;
    });
  } else {
    groups.sort((a, b) => b.items.length - a.items.length);
  }
  return groups;
}

function renderTabRow(item, keyword, now) {
  const { tab, host, count, last, dupes } = item;
  const li = document.createElement('li');
  li.className = 'tab-item' + (tab.active ? ' active-tab' : '');
  li.title = tab.url || '';

  if (tab.favIconUrl && /^https?:/.test(tab.favIconUrl)) {
    const img = document.createElement('img');
    img.className = 'favicon';
    img.src = tab.favIconUrl;
    img.addEventListener('error', () => {
      const fb = document.createElement('div');
      fb.className = 'favicon-fallback';
      fb.textContent = (host[0] || '?').toUpperCase();
      img.replaceWith(fb);
    });
    li.appendChild(img);
  } else {
    const fb = document.createElement('div');
    fb.className = 'favicon-fallback';
    fb.textContent = (host[0] || '?').toUpperCase();
    li.appendChild(fb);
  }

  const info = document.createElement('div');
  info.className = 'tab-info';

  const title = document.createElement('div');
  title.className = 'tab-title';
  appendHighlighted(title, tab.title || tab.url || '(无标题)', keyword);
  info.appendChild(title);

  const meta = document.createElement('div');
  meta.className = 'tab-meta';
  const hostSpan = document.createElement('span');
  hostSpan.className = 'host';
  appendHighlighted(hostSpan, host || tab.url || '', keyword);
  meta.appendChild(hostSpan);

  if (last) {
    const ago = now - last;
    const timeSpan = document.createElement('span');
    timeSpan.textContent =
      ago < 60000
        ? '刚刚'
        : ago < 3600000
          ? `${Math.floor(ago / 60000)} 分钟前`
          : ago < 86400000
            ? `${Math.floor(ago / 3600000)} 小时前`
            : `${Math.floor(ago / 86400000)} 天前`;
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
  closeBtn.textContent = '×';
  closeBtn.title = '关闭该标签页';
  closeBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    await chrome.tabs.remove(tab.id);
    reload();
  });
  li.appendChild(closeBtn);

  li.addEventListener('click', async () => {
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
    window.close();
  });

  return li;
}

function render() {
  const keyword = searchInput.value.trim().toLowerCase();
  const now = Date.now();
  const items = sortItems(filteredItems());
  const groups = groupedByHost(items);

  const unvisitedTotal = allTabs.filter((t) => !todayStats[tabUrlKey(t.url)]).length;
  const dupeTotal = duplicateTargets().length;
  summaryEl.textContent = `共 ${allTabs.length} 个 · 今日未访问 ${unvisitedTotal} 个 · 重复 ${dupeTotal} 个${
    keyword || unvisitedOnly.checked ? ` · 显示 ${items.length} 个` : ''
  }`;

  tabList.textContent = '';

  if (items.length === 0) {
    const tip = document.createElement('li');
    tip.className = 'empty-tip';
    tip.textContent = keyword ? '没有匹配的标签页' : '没有符合条件的标签页';
    tabList.appendChild(tip);
    return;
  }

  for (const group of groups) {
    const wrap = document.createElement('li');
    wrap.className = 'domain-group';

    const header = document.createElement('div');
    header.className = 'domain-header';

    const name = document.createElement('span');
    name.className = 'domain-name';
    appendHighlighted(name, group.host, keyword);

    const count = document.createElement('span');
    count.className = 'domain-count';
    count.textContent = `${group.items.length}`;

    const closeGroupBtn = document.createElement('button');
    closeGroupBtn.className = 'close-group-btn';
    closeGroupBtn.textContent = '关闭本组';
    closeGroupBtn.title = `关闭 ${group.host} 下未固定的标签页`;
    closeGroupBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const ids = group.items.filter((i) => !i.tab.pinned).map((i) => i.tab.id);
      if (!ids.length) return;
      await chrome.tabs.remove(ids);
      collapsedHosts.delete(group.host);
      reload();
    });

    header.append(name, count, closeGroupBtn);

    const searching = Boolean(keyword);
    const collapsed = !searching && collapsedHosts.has(group.host);
    wrap.classList.toggle('collapsed', collapsed);

    header.addEventListener('click', () => {
      if (searching) return;
      if (collapsedHosts.has(group.host)) collapsedHosts.delete(group.host);
      else collapsedHosts.add(group.host);
      render();
    });

    const inner = document.createElement('ul');
    inner.className = 'domain-tabs';
    for (const item of group.items) inner.appendChild(renderTabRow(item, keyword, now));

    wrap.append(header, inner);
    tabList.appendChild(wrap);
  }

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
    // 优先关掉更早打开的，保留最新的
    tabs.sort((a, b) => a.id - b.id);
    toClose.push(...tabs.slice(0, -1).map((t) => t.id));
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

searchInput.addEventListener('input', () => {
  selectedIndex = 0;
  render();
});
sortSelect.addEventListener('change', () => {
  savePrefs();
  render();
});
unvisitedOnly.addEventListener('change', () => {
  savePrefs();
  render();
});
autoGroup.addEventListener('change', () => {
  savePrefs();
  if (autoGroup.checked) chrome.runtime.sendMessage({ type: 'group-all-now' });
});
autoDedupe.addEventListener('change', () => {
  savePrefs();
  if (autoDedupe.checked) chrome.runtime.sendMessage({ type: 'dedupe-all-now' });
});

searchInput.addEventListener('keydown', async (e) => {
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
      render();
    } else {
      window.close();
    }
  }
});

groupBtn.addEventListener('click', async () => {
  if (!supportsTabGroups) return;

  const tabs = await chrome.tabs.query({});
  const pending = new Map();

  for (const tab of tabs) {
    if (tab.pinned || !tab.url || !/^https?:/.test(tab.url)) continue;
    const host = hostOf(tab.url);
    if (!host) continue;
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
    if (tabIds.length < 2) continue;
    try {
      const existing = existingByWindow.get(windowId) || [];
      const found = existing.find((g) => g.title === host);
      if (found) {
        await chrome.tabs.group({ tabIds, groupId: found.id });
      } else {
        const groupId = await chrome.tabs.group({ tabIds, createProperties: { windowId } });
        let hash = 0;
        for (const ch of host) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
        await chrome.tabGroups.update(groupId, {
          title: host,
          color: GROUP_COLORS[hash % GROUP_COLORS.length],
        });
      }
    } catch (err) {
      console.warn('分组失败:', host, err);
    }
  }
  reload();
});

ungroupBtn.addEventListener('click', async () => {
  if (!supportsTabGroups) return;
  const tabs = await chrome.tabs.query({});
  const noneId = chrome.tabGroups.TAB_GROUP_ID_NONE;
  const grouped = tabs.filter((t) => t.groupId !== noneId);
  if (grouped.length) await chrome.tabs.ungroup(grouped.map((t) => t.id));
  // 取消分组后关闭自动分组，避免立刻又被自动收回去
  autoGroup.checked = false;
  savePrefs();
  reload();
});

closeDuplicatesBtn.addEventListener('click', () => {
  const ids = duplicateTargets();
  confirmAction(closeDuplicatesBtn, ids.length, '关闭重复', () => chrome.tabs.remove(ids));
});

closeUnvisitedBtn.addEventListener('click', () => {
  const targets = allTabs.filter(
    (t) => !t.pinned && !t.active && !todayStats[tabUrlKey(t.url)]
  );
  confirmAction(closeUnvisitedBtn, targets.length, '关闭未访问', () =>
    chrome.tabs.remove(targets.map((t) => t.id))
  );
});

reload();
