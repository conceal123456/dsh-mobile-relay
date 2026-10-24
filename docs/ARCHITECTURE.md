# 原理与失败模式

## 为什么官方 dsh-relay 不够用

`dsh-relay` 的设计前提是：**它作为 DSH 插件运行在 harness 内部**，通过 `ctx` 拿到 harness 的服务，并假定背后的 harness 允许本机直连。

而 DeepSeek Harness 从 0.1.2 起给整个 `/api` 面加了登录：

- 启动时打印一次 `dsh web: http://127.0.0.1:<port>/?token=…`；
- 浏览器用这个 token 换一个**签名 Cookie**（`dsh-auth-<hash>`）；
- 之后所有 `/api` 请求都要带这个 Cookie，否则一律 `401`。

`dsh-relay` 的转发是「透明」的：它不改 Cookie、也不会替你去登录。于是中继把请求转给 harness 时，harness 看到的是「没有 Cookie 的陌生请求」→ 401 → 手机端显示：

> harness 拒绝了中继 … 中继无法登录到 harness。

把它当独立进程跑（不从 harness 内部加载）时，这个问题必然出现。

## 鉴权桥怎么补

harness 的会话 Cookie 是**对称签名**的，密钥持久化在 DSH 家目录的凭据文件里：

```yaml
# ~/.dsh/.credentials.yaml
client-connection/browser-session:
  kind: grant
  payload:
    version: 1
    secret: <32 字节 base64url>
```

Cookie 结构（见 harness 源码 `packages/client-connection`）：

```
名字 = "dsh-auth-" + base64url(sha256(authority))
值   = "v1." + base64url(JSON{version,authority,issuedAt,expiresAt})
          + "." + base64url(HMAC-SHA256(secret, body))
authority = "127.0.0.1:<harness端口>"
```

鉴权桥因此可以：

1. 只监听 `127.0.0.1`；
2. 每 12 小时现签一个 24 小时有效的 Cookie；
3. 把中继转来的请求补上 `Cookie`，并把 `Host` / `Origin` / `Referer` 改写成 harness 自己的 authority；
4. WebSocket（`/api/remote.mux`）同样处理 —— 否则会话事件流会 401 断开。

> ⚠️ 有效期必须 ≤ harness 的 `cookieMaxAgeDays`（默认 7 天）。签一个 200 天的 Cookie 会被 `authenticate()` 判为非法，表现同样是 401。

## 数据流

```
App ──TLS(自签, 指纹固定)──► relay:3443
                              │ 校验设备令牌 / 配对码
                              ▼
                         shim:127.0.0.1:<随机>
                              │ 注入 Cookie，改写 Host
                              ▼
                         harness:127.0.0.1:<port>
```

## 典型失败模式对照表

| 现象 | 根因 | 处理 |
|---|---|---|
| `无法连接 <IP>:3443` | 地址不存在 / 旧 IP / 防火墙 / 热点隔离 | 先手机浏览器开 `/relay/health` 验证 |
| `中继拒绝了该配对码` | 码一次性且随重启更换 | 用控制台最新输出的码 |
| `中继无法登录到 harness`（401） | 缺少鉴权桥 | 本项目已内置；若仍出现，检查 `DSH_HOME` |
| 会话列表空白、WebSocket 反复重连 | 升级连接没带 Cookie | 确认走的是鉴权桥端口，而不是直连 harness |
| 每个请求 500 / `msecs must be a number` | relay 配置缺 `proxyTimeoutMs` | 本项目已内置该字段 |
| 403 `untrusted-host` | 请求的 Host 不在白名单 | 本项目会把所有本机地址自动加进白名单 |
