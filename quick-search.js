'use strict';

/* ------------------------------------------------------------------ *
 * Tab Box — Quick Search
 *
 * In-page command palette opened by a browser shortcut (Alt+K by default)
 * or the Tab Box context menu. It searches the open tabs and the whole
 * bookmark tree, defaults to tabs, and lets the user flip between the
 * two sources without leaving the page.
 *
 * Runs as a content script: UI lives in a closed shadow root, data and
 * tab/window actions go through the service worker because content
 * scripts have no chrome.tabs / chrome.bookmarks access.
 * ------------------------------------------------------------------ */

(() => {
  if (globalThis.__tabboxQuickSearch) return;
  globalThis.__tabboxQuickSearch = true;

  const HOST_ID = 'tabbox-quick-search-host';
  const HOST_MARK = 'quick-search';
  const SOURCE_TABS = 'tabs';
  const SOURCE_BOOKMARKS = 'bookmarks';
  const RENDER_LIMIT = 100;
  const DATA_TIMEOUT_MS = 8000;
  const QUICK_SEARCH_PAGE = 'quick-search.html';
  // quick-search.html opens this script directly; it is not a content script
  // there, so it must open itself and close its own window/tab afterwards.
  const IS_STANDALONE =
    location.protocol === 'chrome-extension:' && location.pathname.endsWith(`/${QUICK_SEARCH_PAGE}`);
  const HOME_WINDOW_ID = readHomeWindowId();

  function readHomeWindowId() {
    if (!IS_STANDALONE) return null;
    const value = Number(new URLSearchParams(location.search).get('windowId'));
    return Number.isInteger(value) && value > 0 ? value : null;
  }

  const i18nCache = new Map();
  const t = (key, subs) => {
    const list = subs == null ? null : (Array.isArray(subs) ? subs : [subs]).map(String);
    const cacheKey = list ? `${key}\u0000${list.join('\u0001')}` : key;
    const cached = i18nCache.get(cacheKey);
    if (cached != null) return cached;
    const value = list ? chrome.i18n.getMessage(key, list) : chrome.i18n.getMessage(key);
    const text = value || key;
    i18nCache.set(cacheKey, text);
    return text;
  };

  const SOURCE_LABEL = {
    [SOURCE_TABS]: 'quickSearchTabs',
    [SOURCE_BOOKMARKS]: 'quickSearchBookmarks',
  };

  const ICON_SEARCH = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
      stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.6-3.6" />
    </svg>`;
  const ICON_EMPTY = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"
      stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.6-3.6" />
      <path d="M8.5 11h5" />
    </svg>`;
  const ICON_ERROR = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"
      stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7.5V13" />
      <path d="M12 16.5h.01" />
    </svg>`;

  /* ---- module state -------------------------------------------------- */

  let ui = null;
  let opening = null;
  let cssPromise = null;
  let shortcutPromise = null;
  let themeMode = 'system';
  let failedFavicons = new Set();
  let actionTimer = 0;
  let actionPending = false;
  let keyword = '';
  let selectedIndex = 0;
  let rows = [];

  const source = { current: SOURCE_TABS };
  const data = {
    [SOURCE_TABS]: { status: 'idle', items: [], run: 0 },
    [SOURCE_BOOKMARKS]: { status: 'idle', items: [], run: 0 },
  };

  /* ---- small helpers -------------------------------------------------- */

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function hostOf(url) {
    try {
      return new URL(url).hostname.replace(/^www\./, '');
    } catch {
      return '';
    }
  }

  function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function tokenize(text) {
    const trimmed = (text || '').trim().toLowerCase();
    if (!trimmed) return [];
    return Array.from(new Set(trimmed.split(/\s+/).filter(Boolean)));
  }

  function appendHighlighted(parent, text, tokens) {
    const raw = text == null ? '' : String(text);
    if (!tokens.length || !raw) {
      parent.textContent = raw;
      return;
    }
    const re = new RegExp(tokens.map(escapeRegExp).join('|'), 'gi');
    let last = 0;
    let count = 0;
    let match;
    while (count < 8 && (match = re.exec(raw))) {
      if (match.index > last) parent.append(raw.slice(last, match.index));
      const mark = document.createElement('mark');
      mark.textContent = match[0];
      parent.append(mark);
      last = match.index + match[0].length;
      count += 1;
      if (match[0].length === 0) re.lastIndex += 1;
    }
    if (last < raw.length) parent.append(raw.slice(last));
  }

  function formatAgo(ago) {
    if (!Number.isFinite(ago) || ago < 0) return '';
    if (ago < 60000) return t('timeJustNow');
    if (ago < 3600000) return t('timeMinutes', Math.floor(ago / 60000));
    if (ago < 86400000) return t('timeHours', Math.floor(ago / 3600000));
    return t('timeDays', Math.floor(ago / 86400000));
  }

  function resolveTheme(mode) {
    if (mode === 'light' || mode === 'dark') return mode;
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  function request(message) {
    return new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve(null);
      }, DATA_TIMEOUT_MS);
      try {
        chrome.runtime.sendMessage(message, (response) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          // Touch lastError so Chrome does not log "Unchecked runtime.lastError".
          void chrome.runtime.lastError;
          resolve(response == null ? null : response);
        });
      } catch {
        settled = true;
        clearTimeout(timer);
        resolve(null);
      }
    });
  }

  function loadCss() {
    if (!cssPromise) {
      cssPromise = fetch(chrome.runtime.getURL('quick-search.css'))
        .then((response) => (response.ok ? response.text() : ''))
        .catch(() => '');
    }
    return cssPromise;
  }

  function getShortcutText() {
    if (!shortcutPromise) {
      shortcutPromise = request({ type: 'tabbox-quick-search-shortcut' }).then((res) =>
        res && typeof res.shortcut === 'string' ? res.shortcut : 'Alt+K'
      );
    }
    return shortcutPromise;
  }

  async function readThemeMode() {
    try {
      const stored = await chrome.storage.local.get('prefs');
      const theme = stored?.prefs?.theme;
      return theme === 'light' || theme === 'dark' ? theme : 'system';
    } catch {
      return 'system';
    }
  }

  /* ---- data ----------------------------------------------------------- */

  function makeEntry(kind, raw) {
    const url = raw.url || '';
    const host = hostOf(url);
    const title = (raw.title || '').trim() || url || t('untitled');
    return {
      kind,
      id: raw.id,
      windowId: raw.windowId,
      title,
      url,
      host,
      folder: kind === 'bookmark' ? raw.folder || '' : '',
      favIconUrl: raw.favIconUrl || '',
      recency: raw.lastAccessed || raw.dateAdded || 0,
      active: Boolean(raw.active),
      titleLower: title.toLowerCase(),
      urlLower: url.toLowerCase(),
      hostLower: host.toLowerCase(),
      folderLower: (kind === 'bookmark' ? raw.folder || '' : '').toLowerCase(),
    };
  }

  function sortByRecency(items) {
    // Both sources open with their most recent item first; search ranking
    // only reorders matches while a keyword is present.
    items.sort((a, b) => b.recency - a.recency);
  }

  function scoreEntry(entry, tokens) {
    let total = 0;
    for (const token of tokens) {
      if (entry.titleLower.startsWith(token)) total += 120;
      else if (entry.titleLower.includes(token)) total += 80;
      else if (entry.hostLower.startsWith(token)) total += 60;
      else if (entry.hostLower.includes(token)) total += 45;
      else if (entry.folderLower && entry.folderLower.includes(token)) total += 30;
      else if (entry.urlLower.includes(token)) total += 20;
      else return -1;
    }
    return total;
  }

  async function loadSource(name) {
    const bucket = data[name];
    const run = ++bucket.run;
    bucket.status = 'loading';
    bucket.items = [];
    if (ui && source.current === name) render();
    updateChipCounts();

    const response = await request({ type: 'tabbox-quick-search-data', source: name });
    if (run !== bucket.run) return;

    if (!response || !response.ok || !Array.isArray(response.items)) {
      console.warn('[Tab Box] quick search data failed:', name, response?.error || 'no response');
      bucket.status = 'error';
      bucket.items = [];
    } else {
      const kind = name === SOURCE_TABS ? 'tab' : 'bookmark';
      const items = response.items.map((raw) => makeEntry(kind, raw));
      sortByRecency(items);
      bucket.status = 'ready';
      bucket.items = items;
    }

    if (!ui) return;
    updateChipCounts();
    if (source.current === name) render({ resetSelection: true });
  }

  /* ---- UI construction ------------------------------------------------ */

  function buildOverlay(css) {
    const host = document.createElement('div');
    host.id = HOST_ID;
    host.dataset.tabbox = HOST_MARK;
    // Inline + !important so the host page cannot reposition or hide it.
    host.style.cssText = [
      'all: initial !important',
      'position: fixed !important',
      'inset: 0 !important',
      'width: 100% !important',
      'height: 100% !important',
      'display: block !important',
      'z-index: 2147483647 !important',
      'pointer-events: auto !important',
    ].join('; ');
    host.setAttribute('data-theme', resolveTheme(themeMode));

    const previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const shadow = host.attachShadow({ mode: 'closed' });

    if (css) {
      try {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(css);
        shadow.adoptedStyleSheets = [sheet];
      } catch {
        const style = document.createElement('style');
        style.textContent = css;
        shadow.appendChild(style);
      }
    } else {
      // Fetch failed (very unusual): let the browser load the sheet directly.
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = chrome.runtime.getURL('quick-search.css');
      shadow.appendChild(link);
    }

    const shell = el('div', 'qs-shell');
    const mask = el('div', 'qs-mask');
    const panel = el('div', 'qs-panel');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-label', t('quickSearchTitle'));

    const head = el('div', 'qs-head');
    const tabsWrap = el('div', 'qs-tabs');
    tabsWrap.setAttribute('role', 'tablist');
    const tabButtons = {};
    const tabCounts = {};
    for (const key of [SOURCE_TABS, SOURCE_BOOKMARKS]) {
      const btn = el('button', 'qs-tab');
      btn.type = 'button';
      btn.tabIndex = -1;
      btn.dataset.source = key;
      btn.setAttribute('role', 'tab');
      btn.setAttribute('aria-selected', key === SOURCE_TABS ? 'true' : 'false');
      const label = el('span', 'qs-tab-label', t(SOURCE_LABEL[key]));
      const count = el('span', 'qs-tab-count', '');
      btn.append(label, count);
      tabsWrap.appendChild(btn);
      tabButtons[key] = btn;
      tabCounts[key] = count;
    }
    const shortcutEl = el('span', 'qs-shortcut');
    shortcutEl.hidden = true;
    head.append(tabsWrap, shortcutEl);

    const inputRow = el('div', 'qs-input-row');
    const searchIcon = el('span', 'qs-search-icon');
    searchIcon.innerHTML = ICON_SEARCH;
    const input = el('input', 'qs-input');
    input.type = 'text';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-expanded', 'true');
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-controls', 'tabbox-quick-search-list');
    input.setAttribute('aria-label', t('quickSearchTitle'));
    const clearBtn = el('button', 'qs-clear', '×');
    clearBtn.type = 'button';
    clearBtn.tabIndex = -1;
    clearBtn.hidden = true;
    clearBtn.setAttribute('aria-label', t('quickSearchClear'));
    inputRow.append(searchIcon, input, clearBtn);

    const summary = el('div', 'qs-summary');
    const summaryLabel = el('span', 'qs-summary-label');
    const summaryCount = el('span', 'qs-summary-count');
    summary.append(summaryLabel, summaryCount);

    const body = el('div', 'qs-body');
    const list = el('ul', 'qs-list');
    list.id = 'tabbox-quick-search-list';
    list.setAttribute('role', 'listbox');
    list.setAttribute('aria-label', t('quickSearchTitle'));

    const loadingState = el('div', 'qs-state');
    const spinner = el('div', 'qs-spinner');
    loadingState.append(spinner, el('div', 'qs-state-text', t('quickSearchLoading')));

    const emptyState = el('div', 'qs-state');
    emptyState.hidden = true;
    const emptyIcon = el('div', 'qs-state-icon');
    emptyIcon.innerHTML = ICON_EMPTY;
    const emptyText = el('div', 'qs-state-text');
    const emptyHint = el('div', 'qs-state-hint');
    emptyState.append(emptyIcon, emptyText, emptyHint);

    const errorState = el('div', 'qs-state is-clickable');
    errorState.hidden = true;
    errorState.setAttribute('role', 'button');
    errorState.tabIndex = -1;
    const errorIcon = el('div', 'qs-state-icon');
    errorIcon.innerHTML = ICON_ERROR;
    const errorText = el('div', 'qs-state-text', t('quickSearchLoadFailed'));
    errorState.append(errorIcon, errorText);

    body.append(list, loadingState, emptyState, errorState);

    const foot = el('div', 'qs-foot');
    foot.append(
      keyHint(['↑', '↓'], t('quickSearchHintSelect')),
      keyHint(['Enter'], t('quickSearchHintOpen')),
      keyHint(['Tab'], t('quickSearchHintSwitch')),
      keyHint(['Esc'], t('quickSearchHintClose'), true)
    );

    panel.append(head, inputRow, summary, body, foot);
    shell.append(mask, panel);
    shadow.appendChild(shell);

    const cleanup = [];

    ui = {
      host,
      shadow,
      mask,
      panel,
      list,
      body,
      input,
      clearBtn,
      tabs: tabButtons,
      counts: tabCounts,
      shortcutEl,
      summaryLabel,
      summaryCount,
      loadingState,
      emptyState,
      emptyText,
      emptyHint,
      errorState,
      previousFocus,
      cleanup,
      rowEls: [],
    };

    // Keep every keystroke inside the overlay instead of the host page.
    host.addEventListener('keydown', onKeydown);
    host.addEventListener('keyup', (event) => event.stopPropagation());
    host.addEventListener('keypress', (event) => event.stopPropagation());

    for (const type of [
      'pointerdown',
      'mousedown',
      'mouseup',
      'click',
      'dblclick',
      'auxclick',
      'contextmenu',
    ]) {
      host.addEventListener(type, (event) => event.stopPropagation());
    }

    host.addEventListener(
      'wheel',
      (event) => {
        const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
        if (!path.includes(ui?.body)) event.preventDefault();
        event.stopPropagation();
      },
      { passive: false }
    );

    host.addEventListener(
      'touchmove',
      (event) => {
        const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
        if (!path.includes(ui?.body)) event.preventDefault();
        event.stopPropagation();
      },
      { passive: false }
    );

    mask.addEventListener('click', closeOverlay);

    input.addEventListener('input', () => {
      keyword = input.value.trim();
      render({ resetSelection: true });
    });

    clearBtn.addEventListener('click', () => {
      input.value = '';
      keyword = '';
      input.focus({ preventScroll: true });
      render({ resetSelection: true });
    });

    // Prevent buttons from stealing focus, then handle clicks.
    shadow.addEventListener('mousedown', (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target.closest('.qs-tab, .qs-clear, .qs-state.is-clickable')) {
        event.preventDefault();
      }
    });

    shadow.addEventListener('focusin', (event) => {
      if (ui && event.target !== ui.input) ui.input.focus({ preventScroll: true });
    });

    shadow.addEventListener('mouseover', (event) => {
      if (!ui) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      const row = target.closest('.qs-row');
      if (!row) return;
      const index = Number(row.dataset.index);
      if (!Number.isInteger(index) || index === selectedIndex) return;
      selectedIndex = index;
      paintSelection(false);
    });

    shadow.addEventListener('click', onShadowClick);

    // Theme follows the popup preference and the OS, even while open.
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onMediaChange = () => applyThemeToUi();
    media.addEventListener('change', onMediaChange);
    cleanup.push(() => media.removeEventListener('change', onMediaChange));

    const onStorageChange = (changes, area) => {
      if (area !== 'local' || !changes.prefs) return;
      const next = changes.prefs.newValue?.theme;
      themeMode = next === 'light' || next === 'dark' ? next : 'system';
      applyThemeToUi();
    };
    chrome.storage.onChanged.addListener(onStorageChange);
    cleanup.push(() => chrome.storage.onChanged.removeListener(onStorageChange));

    const focusInput = () => {
      if (!ui) return;
      try {
        ui.input.focus({ preventScroll: true });
      } catch {
        // ignore
      }
    };
    // A standalone popup window is not always active when the script starts;
    // focus the search box as soon as the window really gets focus.
    const onWindowFocus = () => focusInput();
    window.addEventListener('focus', onWindowFocus);
    cleanup.push(() => window.removeEventListener('focus', onWindowFocus));

    document.documentElement.appendChild(host);
    requestAnimationFrame(() => {
      if (!ui) return;
      host.classList.add('is-open');
      if (IS_STANDALONE) {
        try {
          window.focus();
        } catch {
          // ignore
        }
      }
      focusInput();
      setTimeout(focusInput, 150);
    });
  }

  function keyHint(keys, label, alignEnd = false) {
    const wrap = el('span', 'qs-key' + (alignEnd ? ' qs-key-end' : ''));
    for (const key of keys) wrap.appendChild(el('kbd', '', key));
    wrap.appendChild(el('span', '', label));
    return wrap;
  }

  function applyThemeToUi() {
    if (!ui) return;
    ui.host.setAttribute('data-theme', resolveTheme(themeMode));
  }

  function onShadowClick(event) {
    if (!ui) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    const tabBtn = target.closest('.qs-tab');
    if (tabBtn) {
      setSource(tabBtn.dataset.source);
      return;
    }
    if (target.closest('.qs-state.is-clickable')) {
      loadSource(source.current);
      return;
    }
    const row = target.closest('.qs-row');
    if (row) {
      const index = Number(row.dataset.index);
      openEntry(rows[index]);
    }
  }

  /* ---- rendering ------------------------------------------------------ */

  function updateChipCounts() {
    if (!ui) return;
    for (const name of [SOURCE_TABS, SOURCE_BOOKMARKS]) {
      const countEl = ui.counts[name];
      const bucket = data[name];
      if (!countEl) continue;
      if (bucket.status === 'ready') {
        countEl.textContent = String(bucket.items.length);
      } else if (bucket.status === 'loading') {
        countEl.textContent = '…';
      } else {
        countEl.textContent = '';
      }
    }
  }

  function render({ resetSelection = false } = {}) {
    if (!ui) return;
    const name = source.current;
    const bucket = data[name];
    const isTabs = name === SOURCE_TABS;

    for (const key of [SOURCE_TABS, SOURCE_BOOKMARKS]) {
      const active = key === name;
      ui.tabs[key].classList.toggle('is-active', active);
      ui.tabs[key].setAttribute('aria-selected', active ? 'true' : 'false');
    }

    ui.input.placeholder = t(
      isTabs ? 'quickSearchTabsPlaceholder' : 'quickSearchBookmarksPlaceholder'
    );
    ui.clearBtn.hidden = !ui.input.value;

    ui.list.hidden = true;
    ui.loadingState.hidden = true;
    ui.emptyState.hidden = true;
    ui.errorState.hidden = true;
    ui.list.replaceChildren();
    ui.rowEls = [];
    rows = [];
    ui.input.removeAttribute('aria-activedescendant');

    if (bucket.status !== 'ready') {
      selectedIndex = 0;
      if (bucket.status === 'error') {
        ui.errorState.hidden = false;
        ui.summaryLabel.textContent = t('quickSearchLoadFailed');
        ui.summaryCount.textContent = '';
      } else {
        ui.loadingState.hidden = false;
        ui.summaryLabel.textContent = t(
          isTabs ? 'quickSearchRecentTabs' : 'quickSearchRecentBookmarks'
        );
        ui.summaryCount.textContent = '';
      }
      return;
    }

    const tokens = tokenize(keyword);
    let matches;
    if (!tokens.length) {
      matches = bucket.items.map((entry) => ({ entry, score: 0 }));
    } else {
      matches = [];
      for (const entry of bucket.items) {
        const score = scoreEntry(entry, tokens);
        if (score >= 0) matches.push({ entry, score });
      }
      matches.sort(
        (a, b) =>
          b.score - a.score ||
          b.entry.recency - a.entry.recency ||
          a.entry.title.localeCompare(b.entry.title)
      );
    }

    const limited = matches.slice(0, RENDER_LIMIT);
    rows = limited.map((item) => item.entry);

    ui.summaryLabel.textContent = tokens.length
      ? t('quickSearchResults')
      : t(isTabs ? 'quickSearchRecentTabs' : 'quickSearchRecentBookmarks');
    ui.summaryCount.textContent =
      matches.length > limited.length
        ? `${limited.length} / ${matches.length}`
        : String(matches.length);

    if (!matches.length) {
      selectedIndex = 0;
      ui.emptyText.textContent = tokens.length
        ? t(isTabs ? 'quickSearchNoMatchTabs' : 'quickSearchNoMatchBookmarks')
        : t(isTabs ? 'quickSearchNoTabs' : 'quickSearchNoBookmarks');
      ui.emptyHint.textContent = tokens.length ? t('quickSearchEmptyHint') : '';
      ui.emptyHint.hidden = !tokens.length;
      ui.emptyState.hidden = false;
      return;
    }

    const frag = document.createDocumentFragment();
    for (let index = 0; index < rows.length; index += 1) {
      frag.appendChild(renderRow(rows[index], index, tokens));
    }
    ui.list.replaceChildren(frag);
    ui.rowEls = Array.from(ui.list.children);
    ui.list.hidden = false;

    if (resetSelection) selectedIndex = 0;
    selectedIndex = Math.max(0, Math.min(selectedIndex, rows.length - 1));
    paintSelection(false);
  }

  function renderRow(entry, index, tokens) {
    const row = el('li', 'qs-row');
    row.id = `tabbox-qs-option-${index}`;
    row.dataset.index = String(index);
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', 'false');
    row.title = entry.url;

    row.appendChild(makeFavicon(entry));

    const info = el('div', 'qs-row-info');
    const title = el('div', 'qs-row-title');
    appendHighlighted(title, entry.title, tokens);
    const meta = el('div', 'qs-row-meta');

    if (entry.kind === 'tab') {
      const host = el('span', 'qs-host');
      appendHighlighted(host, entry.host || entry.url, tokens);
      meta.appendChild(host);
      const ago = entry.recency ? formatAgo(Date.now() - entry.recency) : '';
      if (ago) {
        meta.appendChild(el('span', 'qs-sep', '·'));
        meta.appendChild(el('span', 'qs-ago', ago));
      }
    } else {
      const url = el('span', 'qs-url');
      appendHighlighted(url, entry.url, tokens);
      meta.appendChild(url);
      if (entry.folder) {
        meta.appendChild(el('span', 'qs-sep', '·'));
        const folder = el('span', 'qs-folder');
        appendHighlighted(folder, entry.folder, tokens);
        meta.appendChild(folder);
      }
    }

    info.append(title, meta);
    row.appendChild(info);

    if (entry.active) row.appendChild(el('span', 'qs-badge', t('quickSearchCurrent')));
    return row;
  }

  function makeFavicon(entry) {
    const src = entry.favIconUrl || faviconUrlFor(entry.url);
    const fallback = () => {
      const letter = (entry.host || entry.title || '?').trim().charAt(0).toUpperCase() || '?';
      return el('span', 'qs-favicon-fallback', letter);
    };
    if (!src || failedFavicons.has(src)) return fallback();

    const img = document.createElement('img');
    img.className = 'qs-favicon';
    img.src = src;
    img.alt = '';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.addEventListener(
      'error',
      () => {
        failedFavicons.add(src);
        img.replaceWith(fallback());
      },
      { once: true }
    );
    return img;
  }

  function faviconUrlFor(url) {
    if (!url) return '';
    try {
      const favicon = new URL(chrome.runtime.getURL('/_favicon/'));
      favicon.searchParams.set('pageUrl', url);
      favicon.searchParams.set('size', '32');
      return favicon.toString();
    } catch {
      return '';
    }
  }

  function paintSelection(scroll) {
    if (!ui) return;
    if (!rows.length) {
      ui.input.removeAttribute('aria-activedescendant');
      return;
    }
    selectedIndex = Math.max(0, Math.min(selectedIndex, rows.length - 1));
    for (let index = 0; index < ui.rowEls.length; index += 1) {
      const active = index === selectedIndex;
      ui.rowEls[index].classList.toggle('is-active', active);
      ui.rowEls[index].setAttribute('aria-selected', active ? 'true' : 'false');
    }
    const current = ui.rowEls[selectedIndex];
    if (!current) return;
    ui.input.setAttribute('aria-activedescendant', current.id);
    if (scroll) current.scrollIntoView({ block: 'nearest' });
  }

  function setSource(next) {
    if (!ui || !next || next === source.current) return;
    source.current = next;
    if (data[next].status === 'idle') loadSource(next);
    render({ resetSelection: true });
    ui.input.focus({ preventScroll: true });
  }

  /* ---- commands ------------------------------------------------------- */

  function onKeydown(event) {
    // Always keep page-level shortcuts from firing while the overlay is up.
    event.stopPropagation();
    if (!ui) return;
    if (event.isComposing || event.keyCode === 229) return;

    switch (event.key) {
      case 'Escape':
        event.preventDefault();
        closeOverlay();
        break;
      case 'Tab':
        event.preventDefault();
        setSource(source.current === SOURCE_TABS ? SOURCE_BOOKMARKS : SOURCE_TABS);
        break;
      case 'ArrowDown':
        event.preventDefault();
        moveSelection(1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        moveSelection(-1);
        break;
      case 'PageDown':
        event.preventDefault();
        moveSelection(5);
        break;
      case 'PageUp':
        event.preventDefault();
        moveSelection(-5);
        break;
      case 'Enter':
        event.preventDefault();
        openEntry(rows[selectedIndex]);
        break;
      default:
        break;
    }
  }

  function moveSelection(delta) {
    if (!rows.length) return;
    selectedIndex = (selectedIndex + delta + rows.length) % rows.length;
    paintSelection(true);
  }

  async function openEntry(entry) {
    if (!entry || actionPending) return;
    actionPending = true;
    const message =
      entry.kind === 'tab'
        ? {
            type: 'tabbox-quick-search-open',
            target: { kind: 'tab', tabId: entry.id, windowId: entry.windowId },
          }
        : {
            type: 'tabbox-quick-search-open',
            target: {
              kind: 'bookmark',
              url: entry.url,
              // In standalone mode the palette lives in its own popup window;
              // open the page in the window the user came from.
              windowId: HOME_WINDOW_ID || undefined,
            },
          };

    try {
      const response = await request(message);
      if (response?.ok) {
        closeOverlay();
        return;
      }
      console.warn('[Tab Box] quick search could not open entry:', response?.error || entry.url);
      showActionError();
    } finally {
      actionPending = false;
    }
  }

  function showActionError() {
    if (!ui) return;
    clearTimeout(actionTimer);
    ui.summaryLabel.textContent = t('quickSearchActionFailed');
    ui.summaryLabel.classList.add('is-error');
    actionTimer = setTimeout(() => {
      if (!ui) return;
      ui.summaryLabel.classList.remove('is-error');
      render();
    }, 2600);
  }

  /* ---- open / close --------------------------------------------------- */

  async function openOverlay() {
    if (ui) {
      ui.input.focus({ preventScroll: true });
      return;
    }
    if (opening) return opening;

    opening = (async () => {
      themeMode = await readThemeMode();
      const css = await loadCss();
      if (ui) return;

      const stale = document.getElementById(HOST_ID);
      if (stale?.dataset?.tabbox === HOST_MARK) stale.remove();

      // Every open starts on tabs with a fresh snapshot of both sources.
      keyword = '';
      selectedIndex = 0;
      source.current = SOURCE_TABS;
      for (const name of [SOURCE_TABS, SOURCE_BOOKMARKS]) {
        data[name].status = 'idle';
        data[name].items = [];
        data[name].run += 1;
      }

      buildOverlay(css);
      render();
      loadShortcut();
      loadSource(SOURCE_TABS);
      loadSource(SOURCE_BOOKMARKS);
    })().finally(() => {
      opening = null;
    });

    return opening;
  }

  async function loadShortcut() {
    const text = await getShortcutText();
    if (!ui) return;
    if (text) {
      ui.shortcutEl.textContent = text;
      ui.shortcutEl.hidden = false;
    } else {
      ui.shortcutEl.hidden = true;
    }
  }

  function closeOverlay() {
    if (!ui) return;
    const current = ui;
    ui = null;
    rows = [];
    selectedIndex = 0;
    keyword = '';
    clearTimeout(actionTimer);

    for (const dispose of current.cleanup) {
      try {
        dispose();
      } catch {
        // ignore
      }
    }

    current.host.classList.remove('is-open');
    current.host.classList.add('is-closing');
    current.host.style.pointerEvents = 'none';
    setTimeout(() => current.host.remove(), 180);

    if (IS_STANDALONE) {
      closeStandaloneWindow();
      return;
    }

    const previous = current.previousFocus;
    if (previous && previous.isConnected) {
      try {
        previous.focus({ preventScroll: true });
      } catch {
        // ignore
      }
    }
  }

  function closeStandaloneWindow() {
    setTimeout(async () => {
      try {
        if (chrome.tabs?.getCurrent) {
          const tab = await chrome.tabs.getCurrent();
          if (tab?.id != null) {
            await chrome.tabs.remove(tab.id);
            return;
          }
        }
      } catch {
        // fall through to window.close()
      }
      window.close();
    }, 220);
  }

  async function toggleOverlay() {
    if (ui) {
      closeOverlay();
      return;
    }
    await openOverlay();
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== 'tabbox-quick-search-toggle') return false;
    toggleOverlay()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => {
        console.warn('[Tab Box] quick search failed to open:', error);
        closeOverlay();
        sendResponse({ ok: false, error: String(error) });
      });
    return true;
  });

  if (IS_STANDALONE) {
    // The standalone page is already focused: show the palette immediately.
    document.title = `${t('quickSearchTitle')} — ${t('extName')}`;
    openOverlay().catch((error) => {
      console.warn('[Tab Box] quick search failed to open standalone:', error);
      closeStandaloneWindow();
    });
  }
})();
