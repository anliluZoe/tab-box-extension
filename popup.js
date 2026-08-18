const searchInput = document.getElementById('search');
const sortSelect = document.getElementById('sort');
const unvisitedOnly = document.getElementById('unvisited-only');
const tabList = document.getElementById('tab-list');
const summaryEl = document.getElementById('summary');

let allTabs = [];
let todayStats = {};
let lastActive = {};

// 读取所有标签页和统计数据，然后刷新列表
async function reload() {
  const [tabs, stored] = await Promise.all([
    chrome.tabs.query({}),
    chrome.storage.local.get(['stats', 'lastActive']),
  ]);
  allTabs = tabs;
  const today = new Date().toLocaleDateString('sv');
  todayStats = (stored.stats || {})[today] || {};
  lastActive = stored.lastActive || {};
  render();
}

// 根据搜索词、排序方式、筛选条件渲染标签页列表
function render() {
  const keyword = searchInput.value.trim().toLowerCase();
  const now = Date.now();

  const items = allTabs
    .map((tab) => {
      const url = (tab.url || '').split('#')[0];
      let host = '';
      try {
        host = new URL(tab.url).hostname;
      } catch {}
      return {
        tab,
        host,
        count: todayStats[url] || 0,
        last: lastActive[url] || 0,
      };
    })
    .filter(({ tab, host, count }) => {
      if (unvisitedOnly.checked && count > 0) return false;
      if (!keyword) return true;
      return (
        (tab.title || '').toLowerCase().includes(keyword) ||
        (tab.url || '').toLowerCase().includes(keyword) ||
        host.toLowerCase().includes(keyword)
      );
    });

  if (sortSelect.value === 'least') {
    items.sort((a, b) => a.count - b.count || a.last - b.last);
  } else if (sortSelect.value === 'stale') {
    items.sort((a, b) => a.last - b.last);
  }

  const unvisitedTotal = allTabs.filter((t) => !todayStats[(t.url || '').split('#')[0]]).length;
  summaryEl.textContent = `共 ${allTabs.length} 个标签页 · 今日未访问 ${unvisitedTotal} 个${
    keyword || unvisitedOnly.checked ? ` · 当前显示 ${items.length} 个` : ''
  }`;

  tabList.textContent = '';

  if (items.length === 0) {
    const tip = document.createElement('li');
    tip.className = 'empty-tip';
    tip.textContent = keyword ? '没有匹配的标签页' : '没有符合条件的标签页';
    tabList.appendChild(tip);
    return;
  }

  for (const { tab, host, count, last } of items) {
    const li = document.createElement('li');
    li.className = 'tab-item' + (tab.active ? ' active-tab' : '');

    // 图标：优先用页面 favicon，加载失败则显示域名首字母
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
    title.textContent = tab.title || tab.url || '(无标题)';
    info.appendChild(title);

    const meta = document.createElement('div');
    meta.className = 'tab-meta';
    const hostSpan = document.createElement('span');
    hostSpan.className = 'host';
    hostSpan.textContent = host || tab.url || '';
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

    const badge = document.createElement('span');
    badge.className = 'count-badge' + (count === 0 ? ' zero' : '');
    badge.textContent = `今日 ${count} 次`;
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

    // 点击整行：跳转到该标签页
    li.addEventListener('click', async () => {
      await chrome.tabs.update(tab.id, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
      window.close();
    });

    tabList.appendChild(li);
  }
}

searchInput.addEventListener('input', render);
sortSelect.addEventListener('change', render);
unvisitedOnly.addEventListener('change', render);

// 按域名分组：在每个窗口内，把相同域名且数量 >= 2 的标签页合并成一个标签组
document.getElementById('group-btn').addEventListener('click', async () => {
  const tabs = await chrome.tabs.query({});
  const groups = new Map(); // key: windowId|host -> { windowId, host, tabIds }

  for (const tab of tabs) {
    if (tab.pinned || !tab.url || !/^https?:/.test(tab.url)) continue;
    let host;
    try {
      host = new URL(tab.url).hostname;
    } catch {
      continue;
    }
    const key = `${tab.windowId}|${host}`;
    if (!groups.has(key)) groups.set(key, { windowId: tab.windowId, host, tabIds: [] });
    groups.get(key).tabIds.push(tab.id);
  }

  const colors = ['blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];
  for (const { windowId, host, tabIds } of groups.values()) {
    if (tabIds.length < 2) continue;
    try {
      const groupId = await chrome.tabs.group({ tabIds, createProperties: { windowId } });
      // 域名做个简单哈希，让同一域名的分组颜色保持稳定
      let hash = 0;
      for (const ch of host) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
      await chrome.tabGroups.update(groupId, {
        title: host.replace(/^www\./, ''),
        color: colors[hash % colors.length],
      });
    } catch (e) {
      console.warn('分组失败:', host, e);
    }
  }
  reload();
});

// 取消分组：解散所有窗口里的全部标签组
document.getElementById('ungroup-btn').addEventListener('click', async () => {
  const tabs = await chrome.tabs.query({});
  const grouped = tabs.filter((t) => t.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE);
  if (grouped.length) await chrome.tabs.ungroup(grouped.map((t) => t.id));
  reload();
});

// 一键关闭今天没有访问过的标签页（跳过固定的标签页和当前标签页）。
// 第一次点击进入确认状态，3 秒内再点一次才真正关闭，防止误触。
const closeUnvisitedBtn = document.getElementById('close-unvisited');
let confirmTimer = null;

closeUnvisitedBtn.addEventListener('click', async () => {
  const targets = allTabs.filter(
    (t) => !t.pinned && !t.active && !todayStats[(t.url || '').split('#')[0]]
  );
  if (targets.length === 0) {
    summaryEl.textContent = '没有可关闭的标签页（已跳过固定和当前标签页）';
    return;
  }

  if (!closeUnvisitedBtn.dataset.confirming) {
    closeUnvisitedBtn.dataset.confirming = '1';
    closeUnvisitedBtn.textContent = `再点一次，关闭 ${targets.length} 个标签页`;
    confirmTimer = setTimeout(() => {
      delete closeUnvisitedBtn.dataset.confirming;
      closeUnvisitedBtn.textContent = '关闭今日未访问的标签页';
    }, 3000);
    return;
  }

  clearTimeout(confirmTimer);
  delete closeUnvisitedBtn.dataset.confirming;
  closeUnvisitedBtn.textContent = '关闭今日未访问的标签页';
  await chrome.tabs.remove(targets.map((t) => t.id));
  reload();
});

reload();
