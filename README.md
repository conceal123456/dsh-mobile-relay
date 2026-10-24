# dsh-mobile-relay

把电脑上的 **DeepSeek Harness**（DSH）接到手机上的 **[DSH Mobile](https://github.com/sorsama/deepseek-harness-mobile)**，一条命令跑通，手机扫码即用。

> 解决的核心问题：DSH 桌面版 / `dsh web` 自带登录鉴权（整个 `/api` 面都要签名 Cookie），而 `dsh-relay` 只会转发、不会登录，所以手机上永远看到 **401 / “harness 拒绝了中继”**。本项目用一个只监听本机的「鉴权桥」把这层补上，同时保留中继的配对码、设备令牌、TLS 和证书固定。

---

## 它做了什么

```
手机 (DSH Mobile)
   │  https://<电脑局域网IP>:3443   （自签证书 + 配对码 + 设备令牌）
   ▼
dsh-relay 中继  ────────────────►  鉴权桥 127.0.0.1:随机端口
   （配对、设备管理、TLS）              （读出 harness 的签名密钥，
                                        现签 Cookie，改写 Host/Origin）
                                        │
                                        ▼
                              DeepSeek Harness 127.0.0.1:52761
```

启动后你会得到：

- `https://<IP>:3443` 的中继地址
- 8 位配对码 + 二维码（`pairing-qr.png`）
- `pairing.json`（给脚本/自动化读取）

---

## 前置条件

| 项目 | 要求 |
|---|---|
| 电脑 | 已安装并运行 **DeepSeek Harness**（桌面版，或 `dsh web`） |
| Node.js | ≥ 18.17（推荐 20/22） |
| 手机 | Android 8.0+，安装 [DSH Mobile](https://github.com/sorsama/deepseek-harness-mobile/releases/latest) |
| 网络 | 手机与电脑在**同一个局域网**（同一路由器，或电脑连手机热点） |

---

## 快速开始

### 1. 拉取 & 安装

```bash
git clone https://github.com/conceal123456/dsh-mobile-relay.git
cd dsh-mobile-relay
npm install
```

### 2. 启动（保持这个窗口别关）

```bash
npm start
```

看到这样的输出就成功了：

```
[dsh-mobile-relay] harness 端口 52761，本机局域网 IP 192.168.1.20
[dsh-mobile-relay] 鉴权桥已就绪：127.0.0.1:49812 -> 127.0.0.1:52761
[dsh-mobile-relay] 中继已启动：0.0.0.0:3443

================ 手机配对信息 ================
  中继地址 : https://192.168.1.20:3443
  配对码   : 04296087
  二维码   : ./pairing-qr.png
==============================================
```

### 3. 手机配对

1. 打开 **DSH Mobile** → 连接方式选 **中继**；
2. 点 **扫描二维码**，扫电脑上的 `pairing-qr.png`；
   （或手动填：地址 `https://192.168.1.20:3443` + 上面的 8 位配对码）
3. 配对成功后回到列表点那台机器，就会同步电脑上的会话。

> 每台设备只需配对一次，之后自动重连。

---

## 常用配置

全部通过环境变量，Windows PowerShell 示例：

```powershell
$env:DSH_HARNESS_PORT = "52761"   # 不填会自动探测
$env:DSH_RELAY_PORT   = "3443"
$env:DSH_HOME         = "D:\dsh-home"   # 多份 DSH 家目录时指定
npm start
```

| 变量 | 默认 | 说明 |
|---|---|---|
| `DSH_HOME` | `~/.dsh` | DSH 家目录 |
| `DSH_CREDENTIALS_PATH` | `$DSH_HOME/.credentials.yaml` | 凭据文件路径 |
| `DSH_HARNESS_PORT` | 自动探测 | harness 端口 |
| `DSH_RELAY_PORT` | `3443` | 中继端口（TLS） |
| `DSH_RELAY_PLAIN_PORT` | `0` | 明文兼容端口，老客户端才需要，建议保持关闭 |
| `DSH_RELAY_BIND` | `0.0.0.0` | 中继绑定地址 |

---

## 常见问题

**手机提示「无法连接 …」**
1. 先用手机浏览器打开 `https://<IP>:3443/relay/health`，能返回 `ok` 说明网络和 TLS 正常（证书警告点继续）；
2. 打不开就是网络问题：确认同一 Wi-Fi、电脑防火墙放行 3443，路由器未开启「AP 隔离」；
3. 能打开但 App 连不上，多半是地址栏里还留着旧 IP —— 手动清空重填。

**IP 老是变？**
本项目每 15 秒检测一次网络，IP 变化会自动重启监听并重新打印配对信息，看控制台最新那一段即可。

**「中继拒绝了该配对码」**
配对码一次性、24 小时有效。重启中继会换新码，用**最新**输出的那个。

**手机能看到会话但操作报 401？**
说明鉴权桥的 secret 与当前运行的 harness 不匹配（常见于同时装了多个 DSH 家目录）。用 `DSH_HOME` 指向正确的家目录再启动。

更多见 [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)。

---

## 安全说明

- 鉴权桥**只监听 127.0.0.1**，局域网和公网都连不到它。
- 中继的 TLS 用自签证书，手机端按**证书指纹固定（pinning）**校验，扫码配对时自带指纹。
- 配对后的设备持有长期令牌；可在 `https://127.0.0.1:3443/relay/devices` 查看和吊销。
- 能连上中继的人＝能在你电脑上执行命令（Agent 有 shell 权限）。**不要**把 3443 直接映射到公网；确有需要请套 VPN（Tailscale 等）。
- 本项目不修改 harness 任何文件，也不关闭它的鉴权。

---

## 目录结构

```
src/
  relay.mjs        启动器：起鉴权桥 + 中继 + 打印配对信息 + IP 变化看门狗
  auth-shim.mjs    鉴权桥：读 secret、签 Cookie、转发 HTTP/WebSocket
  config.mjs       环境探测：家目录、凭据、harness 端口、局域网 IP
scripts/
  start.ps1        Windows 一键脚本
docs/
  ARCHITECTURE.md  原理与失败模式
  TROUBLESHOOTING.md 踩坑合集
```

---

## 致谢

- [sorsama/deepseek-harness-relay](https://github.com/sorsama/deepseek-harness-relay) —— 中继本体
- [sorsama/deepseek-harness-mobile](https://github.com/sorsama/deepseek-harness-mobile) —— 手机客户端
- DeepSeek Harness 及其品牌归其所有者，本项目为非官方社区方案。

## License

MIT
