function fmtTime(ts) {
  const d = new Date(ts);
  return d.getHours().toString().padStart(2, "0") + ":" +
         d.getMinutes().toString().padStart(2, "0");
}

function collapseLog(entries) {
  const result = [];
  let i = 0;
  while (i < entries.length) {
    const msg = entries[i].msg;
    if (msg.includes("0")) {
      let j = i;
      while (j < entries.length && entries[j].msg === msg) j++;
      const run = entries.slice(i, j);
      if (run.length <= 2) {
        result.push(...run);
      } else {
        result.push(run[0], { ts: null, msg: `… ${run.length - 2} more …` }, run[run.length - 1]);
      }
      i = j;
    } else {
      result.push(entries[i]);
      i++;
    }
  }
  return result;
}

function renderLog(entries) {
  const el = document.getElementById("log");
  el.replaceChildren();
  if (!entries.length) {
    const div = document.createElement("div");
    div.className = "empty";
    div.textContent = "no activity since last start";
    el.appendChild(div);
    return;
  }
  const collapsed = collapseLog(entries);
  for (const e of [...collapsed].reverse()) {
    const row = document.createElement("div");
    row.className = "entry";
    const ts = document.createElement("span");
    ts.className = "ts";
    ts.textContent = e.ts ? fmtTime(e.ts) : "";
    const msg = document.createElement("span");
    msg.className = e.ts === null ? "msg ellipsis" : "msg";
    msg.textContent = e.msg;
    row.append(ts, msg);
    el.appendChild(row);
  }
}

const DEFAULTS = { minLoadedTabs: 3, idleTimeoutMinutes: 20, checkIntervalMinutes: 5, protectPinned: false, protectAudible: true, excludeTitlePatterns: [], excludeUrlPatterns: [] };
const SETTING_KEYS = ["minLoadedTabs", "idleTimeoutMinutes", "checkIntervalMinutes"];

function renderPatternList(listId, storageKey, patterns) {
  const list = document.getElementById(listId);
  list.replaceChildren();
  for (const [i, pattern] of patterns.entries()) {
    const li = document.createElement("li");
    const span = document.createElement("span");
    span.textContent = pattern;
    const btn = document.createElement("button");
    btn.className = "btn-remove";
    btn.textContent = "−";
    btn.addEventListener("click", async () => {
      const { settings: s = {} } = await browser.storage.local.get("settings");
      s[storageKey] = (s[storageKey] ?? []).filter((_, j) => j !== i);
      await browser.storage.local.set({ settings: s });
      renderPatternList(listId, storageKey, s[storageKey]);
    });
    li.append(span, btn);
    list.appendChild(li);
  }
}

async function renderSettings() {
  const { settings = {} } = await browser.storage.local.get("settings");

  for (const key of SETTING_KEYS) {
    const input = document.getElementById(key);
    input.value = settings[key] ?? DEFAULTS[key];
    input.addEventListener("change", async () => {
      const val = parseInt(input.value, 10);
      if (isNaN(val) || val < parseInt(input.min, 10)) return;
      const { settings: s = {} } = await browser.storage.local.get("settings");
      s[key] = val;
      await browser.storage.local.set({ settings: s });
      if (key === "checkIntervalMinutes") {
        await browser.runtime.sendMessage({ type: "updateAlarm", checkIntervalMinutes: val });
      }
    });
  }

  for (const key of ["protectPinned", "protectAudible"]) {
    const checkbox = document.getElementById(key);
    checkbox.checked = settings[key] ?? DEFAULTS[key];
    checkbox.addEventListener("change", async () => {
      const { settings: s = {} } = await browser.storage.local.get("settings");
      s[key] = checkbox.checked;
      await browser.storage.local.set({ settings: s });
    });
  }

  renderPatternList("titlePatternList", "excludeTitlePatterns", settings.excludeTitlePatterns ?? []);
  renderPatternList("urlPatternList", "excludeUrlPatterns", settings.excludeUrlPatterns ?? []);

  for (const [inputId, btnId, listId, storageKey] of [
    ["newTitlePattern", "addTitlePattern", "titlePatternList", "excludeTitlePatterns"],
    ["newUrlPattern",   "addUrlPattern",   "urlPatternList",   "excludeUrlPatterns"],
  ]) {
    const input = document.getElementById(inputId);
    const addBtn = document.getElementById(btnId);
    const addPattern = async () => {
      const val = input.value.trim();
      if (!val) return;
      let re;
      try { re = new RegExp(val, "i"); } catch {
        input.style.borderColor = "#933";
        setTimeout(() => { input.style.borderColor = ""; }, 800);
        return;
      }
      const { settings: s = {} } = await browser.storage.local.get("settings");
      s[storageKey] = [...(s[storageKey] ?? []), val];
      await browser.storage.local.set({ settings: s });
      input.value = "";
      renderPatternList(listId, storageKey, s[storageKey]);

      const field = storageKey === "excludeTitlePatterns" ? "title" : "url";
      const tabs = await browser.tabs.query({});
      const matches = tabs.filter(tab => re.test(tab[field] ?? ""));
      const { log: entries = [] } = await browser.storage.local.get("log");
      if (matches.length) {
        for (const tab of matches) {
          const label = (tab[field] || `tab ${tab.id}`).slice(0, 50);
          entries.push({ ts: Date.now(), msg: `${field} match: "${label}"` });
        }
      } else {
        entries.push({ ts: Date.now(), msg: `no ${field} matches: /${val}/` });
      }
      if (entries.length > 50) entries.splice(0, entries.length - 50);
      await browser.storage.local.set({ log: entries });
      renderLog(entries);
    };
    addBtn.addEventListener("click", addPattern);
    input.addEventListener("keydown", e => { if (e.key === "Enter") addPattern(); });
  }
}

async function main() {
  const { log: logs = [] } = await browser.storage.local.get("log");

  renderLog(logs);
  await renderSettings();

  document.getElementById("clearLog").addEventListener("click", async () => {
    await browser.storage.local.set({ log: [] });
    renderLog([]);
  });

  document.getElementById("resetAll").addEventListener("click", async () => {
    await browser.storage.local.remove("settings");
    window.location.reload();
  });
}

main();
