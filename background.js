// 后台统计：记录每个网页每天被“点开”（切换到该标签页或页面加载完成）的次数，
// 以及每个网页最后一次活跃的时间。数据只保留最近 7 天。

const KEEP_DAYS = 7;

// 写入需要串行，避免两个事件同时读改写 storage 互相覆盖
let writeQueue = Promise.resolve();

function recordVisit(tab) {
  if (!tab || !tab.url || !/^https?:/.test(tab.url)) return;
  const url = tab.url.split('#')[0];

  writeQueue = writeQueue.then(async () => {
    const { stats = {}, lastActive = {} } = await chrome.storage.local.get(['stats', 'lastActive']);

    // 'sv' 地区的日期格式恰好是 YYYY-MM-DD，且按本地时区计算
    const today = new Date().toLocaleDateString('sv');
    const dayStats = stats[today] || (stats[today] = {});
    dayStats[url] = (dayStats[url] || 0) + 1;

    const now = Date.now();
    lastActive[url] = now;

    // 清理过期数据
    const cutoff = new Date(now - KEEP_DAYS * 86400000).toLocaleDateString('sv');
    for (const day of Object.keys(stats)) {
      if (day < cutoff) delete stats[day];
    }
    for (const [u, t] of Object.entries(lastActive)) {
      if (now - t > KEEP_DAYS * 86400000) delete lastActive[u];
    }

    await chrome.storage.local.set({ stats, lastActive });
  }).catch(() => {});
}

// 用户切换到某个标签页
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    recordVisit(await chrome.tabs.get(tabId));
  } catch {
    // 标签页可能已被关闭
  }
});

// 当前活跃的标签页完成了一次导航（比如在同一个标签页里打开新网址）
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.active) recordVisit(tab);
});

// 切换浏览器窗口时，也算“点开”了该窗口当前的标签页
chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  try {
    const [tab] = await chrome.tabs.query({ active: true, windowId });
    recordVisit(tab);
  } catch {}
});
