const DEFAULTS = {
  minLoadedTabs: 3,
  idleTimeoutMinutes: 20,
  checkIntervalMinutes: 5,
  protectPinned: false,
  protectAudible: true,
  excludeTitlePatterns: [],
  excludeUrlPatterns: []
};

async function loadSettings() {
  const { settings = {} } = await browser.storage.local.get("settings");
  return {
    minLoadedTabs: settings.minLoadedTabs ?? DEFAULTS.minLoadedTabs,
    idleTimeoutMinutes: settings.idleTimeoutMinutes ?? DEFAULTS.idleTimeoutMinutes,
    checkIntervalMinutes: settings.checkIntervalMinutes ?? DEFAULTS.checkIntervalMinutes,
    protectPinned: settings.protectPinned ?? DEFAULTS.protectPinned,
    protectAudible: settings.protectAudible ?? DEFAULTS.protectAudible,
    excludeTitlePatterns: settings.excludeTitlePatterns ?? DEFAULTS.excludeTitlePatterns,
    excludeUrlPatterns: settings.excludeUrlPatterns ?? DEFAULTS.excludeUrlPatterns,
  };
}

// --- Persistent log ring buffer ---

async function log(msg) {
  console.log("[Idle Tab Manager]", msg);
  const { log: entries = [] } = await browser.storage.local.get("log");
  entries.push({ ts: Date.now(), msg });
  if (entries.length > 50) entries.splice(0, entries.length - 50);
  await browser.storage.local.set({ log: entries });
}

// --- State ---

async function loadState() {
  const { lastActive = {} } = await browser.storage.local.get("lastActive");
  return lastActive;
}

async function saveState(state) {
  await browser.storage.local.set({ lastActive: state });
}

async function markActive(tabId) {
  const state = await loadState();
  state[tabId] = Date.now();
  await saveState(state);
}

// --- Core: unload idle tabs ---

async function unloadIdleTabs() {
  const { minLoadedTabs, idleTimeoutMinutes, protectPinned, protectAudible, excludeTitlePatterns, excludeUrlPatterns } = await loadSettings();
  const idleTimeoutMs = idleTimeoutMinutes * 60 * 1000;
  const tabs = await browser.tabs.query({});
  const state = await loadState();
  const currentTime = Date.now();

  const toRegexes = patterns => patterns
    .map(p => { try { return new RegExp(p, "i"); } catch { return null; } })
    .filter(Boolean);
  const titleRegexes = toRegexes(excludeTitlePatterns);
  const urlRegexes = toRegexes(excludeUrlPatterns);

  const pool = tabs.filter(tab =>
    !tab.active && !tab.discarded
  );

  const candidates = [];
  const shielded = [];
  for (const tab of pool) {
    const byPin = protectPinned && tab.pinned;
    const byAudible = protectAudible && tab.audible;
    const byPattern = titleRegexes.some(re => re.test(tab.title ?? "")) ||
                      urlRegexes.some(re => re.test(tab.url ?? ""));
    if (byPin || byAudible || byPattern) {
      const reason = byPin ? "pinned" : byAudible ? "audible" : "pattern";
      shielded.push({ tab, reason });
    } else {
      candidates.push(tab);
    }
  }

  const sorted = candidates
    .map(tab => ({ tab, last: state[tab.id] ?? currentTime }))
    .sort((a, b) => b.last - a.last);

  const recentIds = new Set(
    sorted.slice(0, minLoadedTabs).map(t => t.tab.id)
  );

  let discarded = 0;
  for (const { tab, last } of sorted) {
    if (recentIds.has(tab.id)) continue;
    if ((currentTime - last) > idleTimeoutMs) {
      const label = (tab.title || `tab ${tab.id}`).slice(0, 40);
      try {
        await browser.tabs.discard(tab.id);
        await log(`discarded "${label}"`);
        discarded++;
      } catch (_) {}
    }
  }

  for (const { tab, reason } of shielded) {
    const last = state[tab.id] ?? currentTime;
    if ((currentTime - last) > idleTimeoutMs) {
      const label = (tab.title || `tab ${tab.id}`).slice(0, 40);
      await log(`kept (${reason}): "${label}"`);
    }
  }

  await log(`idle check — ${discarded} discarded`);
}

// --- Message handler ---

browser.runtime.onMessage.addListener(msg => {
  if (msg.type === "updateAlarm") {
    return (async () => {
      await browser.alarms.clear("idle-check");
      await browser.alarms.create("idle-check", { periodInMinutes: msg.checkIntervalMinutes });
    })();
  }
});

// --- Event listeners ---

browser.tabs.onActivated.addListener(({ tabId }) => markActive(tabId));

browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading" || changeInfo.status === "complete") {
    markActive(tabId);
  }
});

browser.tabs.onRemoved.addListener(async tabId => {
  const state = await loadState();
  delete state[tabId];
  await saveState(state);
});

// Recreate alarm on every SW startup so it picks up any saved check interval.
(async () => {
  const { checkIntervalMinutes } = await loadSettings();
  await browser.alarms.clear("idle-check");
  browser.alarms.create("idle-check", { periodInMinutes: checkIntervalMinutes });
})();

browser.alarms.onAlarm.addListener(({ name }) => {
  if (name === "idle-check") unloadIdleTabs();
});

// --- Initialize on install ---

browser.runtime.onInstalled.addListener(async () => {
  log("started");
  const tabs = await browser.tabs.query({});
  const t = Date.now();
  const state = Object.fromEntries(tabs.map(tab => [tab.id, t]));
  await saveState(state);
});
