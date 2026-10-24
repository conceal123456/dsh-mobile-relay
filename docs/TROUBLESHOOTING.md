# 排错手册

按「手机看到什么」往下找。

---

## 1. 手机提示「无法连接 <地址>。请检查地址，并确认中继正在运行且本手机可以访问它。」

先分清是**网络不通**还是**中继没认这个地址**。

**第一步：用手机浏览器打开**

```
https://<电脑IP>:3443/relay/health
```

- 出现证书警告 → 点「继续访问」；
- 返回 `ok`／`{"service":"dsh-relay"}` → 网络与 TLS 都正常，问题在 App 侧（多半是地址栏里残留旧 IP，清空重填）；
- 打不开 → 继续下一步。

**检查清单**

1. 手机和电脑是否同一个 Wi-Fi？电脑如果连的是**手机热点**，注意部分机型（vivo/OPPO 等）会开「客户端隔离」，导致手机访问不到热点下的电脑；换个路由器或改用 USB 方案。
2. 电脑防火墙是否放行 3443？Windows 首次监听会弹窗，选「允许」；否则手动加规则：
   ```powershell
   New-NetFirewallRule -DisplayName "DSH Relay" -Direction Inbound -Action Allow `
       -Protocol TCP -LocalPort 3443 -Profile Private,Public
   ```
3. 电脑 IP 是否变了？看控制台最新打印的「中继地址」。

---

## 2. 「中继拒绝了该配对码」

- 配对码**一次性**，默认 24 小时；
- 重启中继会换新码；
- 用控制台**最新**输出的那一个，或扫最新的 `pairing-qr.png`。

---

## 3. 「harness 拒绝了中继 … 中继无法登录到 harness」

harness 返回了 401。检查：

1. 电脑上 harness 是否还在运行？
2. `DSH_HOME` 是否指向**当前这份** harness 的家目录？
   ```powershell
   Get-Content "$env:USERPROFILE\.dsh\.credentials.yaml" | Select-String browser-session -Context 0,5
   ```
   没有 `client-connection/browser-session` 这一节，说明目录不对。多份 harness 时显式指定：
   ```powershell
   $env:DSH_HOME = "D:\dsh-home"
   npm start
   ```

---

## 4. 会话列表空白 / 一直重连

中继通了，但 WebSocket 没带上 Cookie。确认中继的目标端口是**鉴权桥**的端口（启动日志第二行），而不是 harness 本身。

本项目的 `npm start` 会自动做这件事；如果是你自己拼的脚本，务必让 `webServer.port` 指向鉴权桥。

---

## 5. 每个请求都失败，日志报 `TypeError [ERR_INVALID_ARG_TYPE]: "msecs" ... received undefined`

`dsh-relay` 的配置少了 `proxyTimeoutMs`。本项目已内置（`120000`）。自定义配置时记得补：

```js
proxyTimeoutMs: 120_000,
```

---

## 6. `403 untrusted-host`

relay 的 Host 白名单里没有你访问用的地址。本项目启动时会把本机所有 IPv4 自动加进 `publicHostnames` / `trustedHosts`；如果你手动改过，请确保包含手机实际访问的那个 IP。

---

## 7. `EADDRINUSE`

3443 被占了。换端口：

```powershell
$env:DSH_RELAY_PORT = "3453"
npm start
```

---

## 8. 电脑切换网络后手机连不上

DHCP 换了 IP。本项目每 15 秒检测一次，会自动重启并打印新的配对信息；看控制台最新一段即可。若等了很久没更新，重启 `npm start`。

---

## 9. 想彻底重置配对关系

删掉 `~/.dsh/relay/state.json`（设备令牌、证书、签名密钥都在里面），重启中继，重新扫码。

> 这会同时更换证书，已配对设备需要重新配对。
