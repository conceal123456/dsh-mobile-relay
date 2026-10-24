/**
 * harness 鉴权桥
 *
 * 背景：DeepSeek Harness 0.1.2+ 给整个 /api 面加了登录（启动链接里的 token → 签名 Cookie）。
 * dsh-relay 只做“中继转发”，它不知道 harness 的会话密钥，于是转发过去的请求会被 harness 判 401。
 *
 * 这个桥用一个只监听 127.0.0.1 的本地反代解决：
 *   1. 从 ~/.dsh/.credentials.yaml 读出 client-connection/browser-session 的签名密钥；
 *   2. 按 harness 的 Cookie 格式（v1.<base64url(payload)>.<base64url(HMAC)>）现签一个会话 Cookie；
 *   3. 把中继转来的请求补上这个 Cookie，并把 Host/Origin 改写成 harness 自己的地址，再转发给 harness。
 *
 * 安全边界：
 *   - 只绑定 127.0.0.1，外网 / 局域网都连不进来；
 *   - 不修改 harness 任何文件，不关掉它的鉴权；
 *   - Cookie 由本机密钥现签，有效期 24 小时，进程重启即换新。
 */
import http from "node:http";
import net from "node:net";
import crypto from "node:crypto";

const b64url = (buf) =>
  Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** harness 的 Cookie 名：dsh-auth-<base64url(sha256(authority))> */
function cookieName(authority) {
  return "dsh-auth-" + b64url(crypto.createHash("sha256").update(authority).digest());
}

/** 现签一个 v1 浏览器会话 Cookie（harness 的 isAuthenticated 认这个版本） */
function mintSessionCookie(authority, secretKey) {
  const now = Date.now();
  // 注意：有效期必须 ≤ harness 的 cookieMaxAgeDays（默认 7 天），否则会被判为非法。
  const ttlMs = 24 * 3600 * 1000;
  const payload = { version: 1, authority, issuedAt: now, expiresAt: now + ttlMs };
  const body = b64url(JSON.stringify(payload));
  const sig = crypto.createHmac("sha256", secretKey).update(body).digest();
  return `${cookieName(authority)}=v1.${body}.${b64url(sig)}`;
}

/**
 * 启动鉴权桥。
 *
 * @param {object} options
 * @param {number} options.harnessPort harness 实际监听端口
 * @param {string} options.secret        browser-session 的签名密钥（base64url 字符串）
 * @param {number} [options.port]        监听端口，0 = 让系统分配
 * @param {string} [options.host]        harness 所在主机，默认 127.0.0.1
 * @returns {Promise<{port:number, close:()=>Promise<void>}>}
 */
export async function startAuthShim({ harnessPort, secret, port = 0, host = "127.0.0.1" }) {
  // harness 存的是 base64url 文本，签名时要用它解码后的 32 字节原始密钥
  const secretKey = Buffer.from(String(secret).trim(), "base64url");
  if (secretKey.length !== 32) {
    throw new Error(`browser-session 的 secret 长度异常（${secretKey.length} 字节，应为 32），请检查凭据文件`);
  }
  const authority = `${host}:${harnessPort}`;
  let cached = null;
  let cachedAt = 0;

  const currentCookie = () => {
    if (!cached || Date.now() - cachedAt > 12 * 3600 * 1000) {
      cached = mintSessionCookie(authority, secretKey);
      cachedAt = Date.now();
    }
    return cached;
  };

  const rewrite = (headers) => {
    const out = { ...headers };
    out.host = authority;
    if (out.origin) out.origin = `http://${authority}`;
    if (out.referer) out.referer = `http://${authority}/`;
    out.cookie = (out.cookie ? `${out.cookie}; ` : "") + currentCookie();
    return out;
  };

  const server = http.createServer((req, res) => {
    const upstream = http.request(
      { host, port: harnessPort, method: req.method, path: req.url, headers: rewrite(req.headers) },
      (up) => {
        if (up.statusCode === 401) {
          console.warn(
            "[auth-shim] harness 仍然返回 401：多半是凭据文件不属于当前运行的 harness（secret 不匹配）。",
          );
        }
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      },
    );
    upstream.on("error", (err) => {
      if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
      res.end("auth-shim upstream error: " + err.message);
    });
    req.pipe(upstream);
  });

  // WebSocket（/api/remote.mux 等）走 upgrade，需要手工接管 socket
  server.on("upgrade", (req, socket, head) => {
    const headers = rewrite(req.headers);
    const target = net.connect(harnessPort, host, () => {
      let raw = `${req.method} ${req.url} HTTP/1.1\r\n`;
      for (const [k, v] of Object.entries(headers)) {
        if (Array.isArray(v)) for (const item of v) raw += `${k}: ${item}\r\n`;
        else if (v !== undefined) raw += `${k}: ${v}\r\n`;
      }
      raw += "\r\n";
      target.write(raw);
      if (head?.length) target.write(head);
      target.pipe(socket);
      socket.pipe(target);
    });
    target.on("error", () => socket.destroy());
    socket.on("error", () => target.destroy());
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });

  const actualPort = server.address().port;
  return {
    port: actualPort,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
