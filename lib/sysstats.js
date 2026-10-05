// Live CPU / RAM / NVIDIA GPU sampling for the UI's system monitor.
// GPU numbers come from a long-running `nvidia-smi -lms` process (one spawn, not one per sample).
const os = require("os");
const { spawn } = require("child_process");

const GPU_QUERY = "index,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw";
const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };

function cpuTimes() {
  let idle = 0, total = 0;
  for (const c of os.cpus()) { for (const t of Object.values(c.times)) total += t; idle += c.times.idle; }
  return { idle, total };
}

/** Start sampling every intervalMs; onSample(sample) is called each tick. Returns a stop() function. */
function startSampling(onSample, intervalMs = 1000) {
  let gpu = null, gpuError = null, smi = null, stopped = false, restartTimer = null;

  const launchSmi = () => {
    if (stopped) return;
    smi = spawn("nvidia-smi", [`--query-gpu=${GPU_QUERY}`, "--format=csv,noheader,nounits", "-lms", String(intervalMs)], { windowsHide: true });
    let buf = "";
    smi.stdout.on("data", (d) => {
      buf += d.toString();
      const lines = buf.split(/\r?\n/); buf = lines.pop();
      for (const line of lines) {
        const f = line.split(",").map((s) => s.trim());
        if (f.length < 7 || f[0] !== "0") continue; // first GPU only
        gpu = { name: f[1], util: num(f[2]), memUsed: num(f[3]) * 1048576, memTotal: num(f[4]) * 1048576, temp: num(f[5]), power: num(f[6]) };
        gpuError = null;
      }
    });
    smi.on("error", (e) => { gpuError = e.code === "ENOENT" ? "nvidia-smi not found" : e.message; gpu = null; smi = null; });
    smi.on("exit", () => {
      smi = null;
      if (!stopped && gpuError !== "nvidia-smi not found") restartTimer = setTimeout(launchSmi, 5000);
    });
  };
  launchSmi();

  let prev = cpuTimes();
  const tick = setInterval(() => {
    const cur = cpuTimes();
    const dTotal = cur.total - prev.total;
    const cpu = dTotal > 0 ? Math.round((1 - (cur.idle - prev.idle) / dTotal) * 1000) / 10 : 0;
    prev = cur;
    onSample({ t: Date.now(), cpu, cores: os.cpus().length, ramUsed: os.totalmem() - os.freemem(), ramTotal: os.totalmem(), gpu, gpuError });
  }, intervalMs);

  return function stop() {
    stopped = true; clearInterval(tick); clearTimeout(restartTimer);
    if (smi) smi.kill();
  };
}

module.exports = { startSampling };
