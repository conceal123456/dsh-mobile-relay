/**
 * 运行环境探测：DSH 家目录、harness 端口、凭据文件、局域网 IP。
 *
 * 目标：开箱即用。所有值都可以用环境变量覆盖，读不到时给出人能看懂的提示。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { execFileSync } from "node:child_process";

/** DSH 家目录：优先 DSH_HOME，其次 ~/.dsh */
export function resolveDshHome() {
  const fromEnv = process.env.DSH_HOME?.trim();
  if (fromEnv) return fromEnv;
  return path.join(os.homedir(), ".dsh");
}

/** harness 的凭据文件（里面存着 browser-session 的签名密钥） */
export function resolveCredentialsPath() {
  const explicit = process.env.DSH_CREDENTIALS_PATH?.trim();
  if (explicit) return explicit;
  return path.join(resolveDshHome(), ".credentials.yaml");
}

/**
 * 从 .credentials.yaml 里取出 client-connection/browser-session 的 secret。
 *
 * 该文件结构固定，这里只做最小解析，不引入 YAML 依赖：
 *
 *   client-connection/browser-session:
 *     kind: grant
 *     payload:
 *       version: 1
 *       secret: <base64url>
 */
export function readBrowserSessionSecret(file = resolveCredentialsPath()) {
  if (!fs.existsSync(file)) {
    throw new Error(
      `找不到 DSH 凭据文件：${file}\n` +
        `请先在电脑上启动一次 DeepSeek Harness（桌面版或 "dsh web"），它会生成该文件；\n` +
        `或者用 DSH_CREDENTIALS_PATH 指定其它路径。`,
    );
  }
  const lines = fs.readFileSync(file, "utf-8").split(/\r?\n/);
  let inSection = false;
  let sectionIndent = -1;
  for (const line of lines) {
    if (/^\s*client-connection\/browser-session\s*:/.test(line)) {
      inSection = true;
      sectionIndent = line.search(/\S/);
      continue;
    }
    if (!inSection) continue;
    const indent = line.search(/\S/);
    if (line.trim() !== "" && indent <= sectionIndent && !/^client-connection\/browser-session\s*:/.test(line)) {
      break;
    }
    const m = /^\s*secret\s*:\s*(\S+)\s*$/.exec(line);
    if (m) return m[1];
  }
  throw new Error(
    `凭据文件里没有找到 client-connection/browser-session 的 secret：${file}\n` +
      `请确认这个文件属于当前正在运行的 harness（多份 DSH 家目录容易搞混）。`,
  );
}

/** 本机所有可用于局域网访问的 IPv4，按“最像真实网卡”的顺序排前面 */
export function collectLanAddresses() {
  const virtualHints = ["vmware", "vethernet", "meta", "loopback", "virtualbox", "tap", "tun", "docker", "utun"];
  const all = [];
  const preferred = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const info of list ?? []) {
      if (info.family !== "IPv4" || info.internal) continue;
      if (info.address.startsWith("169.254.")) continue;
      all.push(info.address);
      const lower = name.toLowerCase();
      if (!virtualHints.some((h) => lower.includes(h))) preferred.push(info.address);
    }
  }
  const ordered = [...new Set([...preferred, ...all])];
  return { all: [...new Set(all)], preferred: ordered[0] ?? "127.0.0.1", ordered };
}

/**
 * 找出 harness 正在监听的本地端口。
 *
 * 顺序：DSH_HARNESS_PORT → 进程名里带 deepseek/dsh 的监听端口 → 52761。
 * 探测失败不致命，返回 fallback 并打印提示。
 */
export function detectHarnessPort(fallback = 52761) {
  const fromEnv = Number(process.env.DSH_HARNESS_PORT);
  if (Number.isInteger(fromEnv) && fromEnv > 0) return fromEnv;

  try {
    if (process.platform === "win32") {
      const out = execFileSync("netstat", ["-ano", "-p", "TCP"], { encoding: "utf-8", timeout: 5000 });
      const listen = out
        .split(/\r?\n/)
        .map((l) => l.trim().split(/\s+/))
        .filter((p) => p.length >= 5 && p[3] === "LISTENING" && (p[1].startsWith("127.0.0.1:") || p[1].startsWith("0.0.0.0:")))
        .map((p) => ({ port: Number(p[1].split(":").pop()), pid: p[4] }));

      const ps = execFileSync(
        "powershell",
        ["-NoProfile", "-Command", "Get-Process | Where-Object { $_.ProcessName -match 'DeepSeek|deepseek|dsh' } | Select-Object -ExpandProperty Id"],
        { encoding: "utf-8", timeout: 5000 },
      );
      const pids = new Set(ps.split(/\r?\n/).map((s) => s.trim()).filter(Boolean));
      const hit = listen.find((l) => pids.has(l.pid) && l.port < 65000);
      if (hit) return hit.port;
    } else {
      const out = execFileSync("sh", ["-c", "lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null || ss -ltnp 2>/dev/null"], {
        encoding: "utf-8",
        timeout: 5000,
      });
      const m = out.match(/(?:127\.0\.0\.1|0\.0\.0\.0|\*):(\d{2,5})\s+.*?(?:deepseek|dsh)/i);
      if (m) return Number(m[1]);
    }
  } catch {
    /* 探测失败就用默认值，下面会提示 */
  }
  return fallback;
}

/** 端口是否已被占用 */
export function isPortFree(port, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    srv.listen(port, host);
  });
}
