// Windows app list with per-app RAM, plus closing apps to free RAM for ComfyUI.
const { execFile } = require("child_process");
const path = require("path");

const PS = (args, timeout = 15000) => new Promise((resolve, reject) => {
  execFile("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", ...args], { windowsHide: true, timeout, maxBuffer: 8 << 20 },
    (err, stdout, stderr) => (err ? reject(new Error(stderr.trim() || err.message)) : resolve(stdout)));
});

// Windows shell / system processes that must never be closed from here.
const SYSTEM = new Set(["dwm", "explorer", "ctfmon", "sihost", "taskhostw", "runtimebroker", "searchhost", "startmenuexperiencehost",
  "shellexperiencehost", "textinputhost", "conhost", "svchost", "fontdrvhost", "csrss", "winlogon", "lsass", "services",
  "smss", "wininit", "securityhealthsystray", "memory compression", "registry", "system", "idle", "applicationframehost",
  "systemsettingsbroker", "dllhost", "widgets", "widgetservice", "phoneexperiencehost", "lockapp", "useroobebroker",
  "crossdeviceresume", "smartscreen", "sgrmbroker", "audiodg", "wudfhost", "nvcontainer", "nvidia share", "nvsphelper64"]);
// Closing these would stop the tools SpriteForge is being used from.
const CAUTION = { code: "This is Visual Studio Code. If Claude Code runs inside it, that session closes too." };
// Never offered: ending these would cut off the assistant working on this project.
const KEEP = { claude: "Claude Code" };

let cache = { at: 0, list: null }, inflight = null;

/**
 * @param {{comfyPid?: number}} opts
 * @returns {Promise<Array<{name,title,count,bytes,hasWindow,protected,reason?,caution?}>>}
 */
async function listApps({ comfyPid } = {}) {
  if (cache.list && Date.now() - cache.at < 2500) return cache.list;
  if (!inflight) inflight = PS(["-File", path.join(__dirname, "apps.ps1")]).finally(() => (inflight = null));
  const raw = JSON.parse((await inflight).trim() || "[]");
  const list = (Array.isArray(raw) ? raw : [raw]).map((a) => {
    const key = a.name.toLowerCase(), pids = [].concat(a.pids || []);
    let reason = null;
    if (SYSTEM.has(key)) reason = "Windows";
    else if (KEEP[key]) reason = KEEP[key];
    else if (comfyPid && pids.includes(comfyPid)) reason = "ComfyUI (the AI)";
    else if (pids.includes(process.pid)) reason = "SpriteForge";
    else if (key === "python" && /ComfyUI_windows_portable/i.test(a.path || "")) reason = "ComfyUI (the AI)";
    return { name: a.name, title: a.title || a.name, count: a.count, bytes: a.bytes || 0, hasWindow: a.hasWindow,
      protected: !!reason, reason, caution: CAUTION[key] || null };
  });
  cache = { at: Date.now(), list };
  return list;
}

/** Ask every window of the app to close (like clicking its ✕); `force` ends the processes instead. */
async function closeApp(name, { force = false, comfyPid } = {}) {
  const app = (await listApps({ comfyPid })).find((a) => a.name.toLowerCase() === String(name).toLowerCase());
  if (!app) throw new Error(`${name} is not running`);
  if (app.protected) throw new Error(`${app.title} can't be closed from here (${app.reason})`);
  const q = app.name.replace(/'/g, "''");
  const script = force
    ? `Stop-Process -Name '${q}' -Force -ErrorAction SilentlyContinue`
    : `Get-Process -Name '${q}' -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | ForEach-Object { [void]$_.CloseMainWindow() }`;
  await PS(["-Command", script]);
  cache.at = 0; // next list reflects the change
  return { ok: true, name: app.name, forced: force, hadWindow: app.hasWindow };
}

module.exports = { listApps, closeApp };
