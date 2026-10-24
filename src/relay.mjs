#!/usr/bin/env node
/**
 * dsh-mobile-relay —— 让手机上的 DSH Mobile 连上电脑上的 DeepSeek Harness。
 *
 * 一条命令做三件事：
 *   1. 起一个只监听 127.0.0.1 的“鉴权桥”，替 harness 补上它要的登录 Cookie；
 *   2. 起 dsh-relay 中继（默认 0.0.0.0:3443，自签证书 + 配对码 + 设备令牌）；
 *   3. 打印当前配对码和二维码，写好 pairing.json 方便脚本读取。
 *
 * 环境变量（都可选）：
 *   DSH_HOME              默认 ~/.dsh
 *   DSH_CREDENTIALS_PATH  默认 $DSH_HOME/.credentials.yaml
 *   DSH_HARNESS_PORT      harness 端口，默认自动探测
 *   DSH_RELAY_PORT        中继端口，默认 3443
 *   DSH_RELAY_PLAIN_PORT  兼容明文端口，默认 0（关闭），老客户端可设 3444
 *   DSH_RELAY_BIND        中继绑定地址，默认 0.0.0.0
 */
import fs from "node:fs";
import https from "node:https";
import path from "node:path";
import { apply } from "dsh-relay";
import QRCode from "qrcode";
import { startAuthShim } from "./auth-shim.mjs";
import {
  collectLanAddresses,
  detectHarnessPort,
  readBrowserSessionSecret,
  resolveDshHome,
} from "./config.mjs";

const RELAY_PORT = Number(process.env.DSH_RELAY_PORT ?? 3443);
const PLAIN_PORT = Number(process.env.DSH_RELAY_PLAIN_PORT ?? 0);
const BIND = process.env.DSH_RELAY_BIND ?? "0.0.0.0";
const STATE_DIR = path.join(resolveDshHome(), "relay");
const OUT_DIR = process.cwd();

const log = (...args) => console.log("[dsh-mobile-relay]", ...args);

function buildRelayContext(harnessPort) {
  let dispose = null;
  const ctx = {
    webServer: {
      host: "127.0.0.1",
      port: harnessPort,
      register: () => () => {},
      tapIndex: () => () => {},
    },
    get: (name) => (name === "dshHomePath" ? (sub) => path.join(resolveDshHome(), sub) : undefined),
    effect: (fn) => {
      dispose = fn();
      return () => {};
    },
    inject: () => {},
  };
  return { ctx, getDispose: () => dispose };
}

function buildConfig({ ip, ips }) {
  const hosts = [...new Set(["127.0.0.1", "localhost", ...ips])];
  return {
    bind: BIND,
    port: RELAY_PORT,
    stateDir: STATE_DIR,
    tls: "self-signed",
    publicHostnames: hosts,
    trustedHosts: ips.flatMap((a) => [`${a}:${RELAY_PORT}`, `${a}:${PLAIN_PORT}`]),
    auth: "both",
    sessionTtlMs: 24 * 3600 * 1000,
    deviceTokenTtlMs: 30 * 24 * 3600 * 1000,
    pairingWindowMs: 24 * 3600 * 1000,
    pairingCodeLength: 8,
    maxFailedAttempts: 20,
    lockoutMs: 60_000,
    rateLimitPerMinute: 1200,
    privilegedMethods: "allow-authenticated",
    extraProxyPaths: [],
    // 关键：不写这个字段会导致每个请求在 setSoTimeout 处抛错（TypeError: msecs must be a number）
    proxyTimeoutMs: 120_000,
    compat: {
      addressGrants: true,
      addressGrantTtlMs: 24 * 3600 * 1000,
      plainPort: PLAIN_PORT,
    },
    uiLink: false,
    mdns: false,
  };
}

function fetchPairingPage(ip) {
  return new Promise((resolve) => {
    const agent = new https.Agent({ rejectUnauthorized: false });
    const req = https.get(
      {
        host: "127.0.0.1",
        port: RELAY_PORT,
        path: "/relay/pair",
        agent,
        headers: { host: `${ip}:${RELAY_PORT}` },
        timeout: 8000,
      },
      (res) => {
        let html = "";
        res.on("data", (c) => (html += c));
        res.on("end", () => resolve(html));
      },
    );
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(""));
  });
}

async function publishPairing(ip) {
  const html = await fetchPairingPage(ip);
  const code = /class="code">([^<]+)<\/div>/.exec(html)?.[1]?.trim() ?? "";
  const pin = /Certificate pin \(SHA-256\/SPKI\)<br><span class="mono">([^<]+)<\/span>/.exec(html)?.[1]?.trim() ?? "";
  const expiresIn = Number(/Expires in (\d+) seconds/.exec(html)?.[1] ?? 0);
  const url = `https://${ip}:${RELAY_PORT}`;

  const payload = {
    v: 1,
    kind: "dsh-relay-pair",
    url,
    ...(PLAIN_PORT > 0 ? { plainUrl: `http://${ip}:${PLAIN_PORT}` } : {}),
    ...(pin ? { fingerprint: pin } : {}),
    code,
    expiresAt: Date.now() + expiresIn * 1000,
  };

  const info = {
    url,
    code,
    pin,
    expiresAt: new Date(payload.expiresAt).toISOString(),
    payload,
    generatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(OUT_DIR, "pairing.json"), JSON.stringify(info, null, 2), "utf-8");
  await QRCode.toFile(path.join(OUT_DIR, "pairing-qr.png"), JSON.stringify(payload), {
    width: 420,
    margin: 2,
  });

  console.log("");
  console.log("================ 手机配对信息 ================");
  console.log(`  中继地址 : ${url}`);
  console.log(`  配对码   : ${code}`);
  if (PLAIN_PORT > 0) console.log(`  兼容端口 : http://${ip}:${PLAIN_PORT}`);
  if (pin) console.log(`  证书指纹 : ${pin}`);
  console.log(`  二维码   : ${path.join(OUT_DIR, "pairing-qr.png")}`);
  console.log(`  详细参数 : ${path.join(OUT_DIR, "pairing.json")}`);
  console.log("==============================================");
  console.log("");
  console.log(await QRCode.toString(JSON.stringify(payload), { type: "terminal", small: true }));
}

async function main() {
  const secret = readBrowserSessionSecret();
  const harnessPort = detectHarnessPort();
  const { all, ordered } = collectLanAddresses();
  let ip = ordered[0] ?? "127.0.0.1";

  log(`harness 端口 ${harnessPort}，本机局域网 IP ${ip}`);
  const shim = await startAuthShim({ harnessPort, secret, port: 0 });
  log(`鉴权桥已就绪：127.0.0.1:${shim.port} -> 127.0.0.1:${harnessPort}`);

  const { ctx, getDispose } = buildRelayContext(shim.port);
  apply(ctx, buildConfig({ ip, ips: all }));
  log(`中继已启动：${BIND}:${RELAY_PORT}`);

  await new Promise((r) => setTimeout(r, 600));
  await publishPairing(ip);

  // 热点/DHCP 下 IP 会变：变了就带着新地址重启监听，并重新打印配对信息
  let knownIps = all.slice().sort().join(",");
  setInterval(async () => {
    const now = collectLanAddresses();
    const nextIp = now.ordered[0] ?? "127.0.0.1";
    const nextKey = now.all.slice().sort().join(",");
    if (nextIp === ip && nextKey === knownIps) return;
    log(`网络地址变化：${ip} -> ${nextIp}，正在重启中继……`);
    ip = nextIp;
    knownIps = nextKey;
    try {
      const dispose = getDispose();
      if (dispose) await dispose();
      apply(ctx, buildConfig({ ip, ips: now.all }));
      await new Promise((r) => setTimeout(r, 600));
      await publishPairing(ip);
    } catch (err) {
      console.error("[dsh-mobile-relay] 重启失败：", err);
    }
  }, 15_000);

  const shutdown = async () => {
    log("正在退出……");
    try {
      const dispose = getDispose();
      if (dispose) await dispose();
      await shim.close();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("\n启动失败：", err.message);
  console.error("\n排查建议：");
  console.error("  1) 先启动 DeepSeek Harness（桌面版或 dsh web），并保持运行；");
  console.error("  2) 确认 DSH_HOME 指向的是这份 harness 的家目录（默认 ~/.dsh）；");
  console.error("  3) 端口被占用时用 DSH_RELAY_PORT 换一个；");
  console.error("  4) 更多见 docs/TROUBLESHOOTING.md\n");
  process.exit(1);
});
