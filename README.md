<p align="center">
    <img src="doc/demo/logo.png" width="80px" />
    <h1 align="center">Cloud Mail Plus</h1>
    <p align="center">Cloudflare Workers 邮箱服务增强版 — Cloudflare Email Service 原生发件 + 外部 API + D1 自动备份</p>
    <p align="center">
        简体中文 | <a href="/README-en.md">English</a>
    </p>
    <p align="center">
        <a href="https://github.com/AndrewYukon/cloud-mail-plus/blob/main/LICENSE">
            <img src="https://img.shields.io/badge/license-MIT-green" />
        </a>
    </p>
</p>

## Credits

本项目基于 [maillab/cloud-mail](https://github.com/maillab/cloud-mail) 开发，在其优秀的 Cloudflare Workers 邮箱服务基础上新增了以下功能。感谢原作者的开源贡献。

## 新增功能

### 1. Cloudflare Email Service 集成

使用 Cloudflare 原生 `send_email` Workers binding 发送邮件，替代 Resend 作为主要发送方式。

- **CF 优先模式**（默认）：先通过 Cloudflare Email Service 发送，失败自动回退 Resend
- **仅 Resend 模式**：与原版行为一致
- **仅 CF 模式**：只用 Cloudflare，无回退

优势：
- 无需第三方 API key（Cloudflare 自动管理 SPF/DKIM/DMARC）
- 更好的发件信誉度（Cloudflare IP 而非自建服务器 IP）
- 零额外成本（Workers 付费计划已包含）

在管理后台 **设置 → 邮件发送方式** 中切换。

### 2. External API（外部发件 API）

允许其他应用通过 HTTP API 发送邮件和查询状态，支持所有已配置的域名。

```bash
# 发送邮件
curl -X POST "https://your-domain.com/api/external/send" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: YOUR_API_KEY" \
  -d '{
    "from": "App <noreply@example.com>",
    "to": "user@gmail.com",
    "subject": "Hello",
    "html": "<p>Hello world</p>"
  }'

# 查询状态
curl "https://your-domain.com/api/external/status/9" \
  -H "X-API-Key: YOUR_API_KEY"
```

API Key 在管理后台 **设置 → 外部 API 密钥** 中生成。

详细文档：[External API Guide](docs/external-api-guide.md)

### 3. 邮件删除 + R2 附件清理（Web UI + API）

**Web UI**：选中邮件后工具栏有两个删除按钮：
- 🗑️ 软删除 — 标记删除，可恢复
- 🗑️ **永久删除** — 删除邮件 + R2/S3/KV 附件 + 收藏，不可恢复（有二次确认弹窗）

**External API** 同时提供删除端点：

```bash
# 软删除（标记删除，可恢复）
curl -X DELETE "https://your-domain.com/api/external/email/123" -H "X-API-Key: KEY"

# 永久删除（删除邮件 + R2 附件 + 收藏）
curl -X DELETE "https://your-domain.com/api/external/email/123/permanent" -H "X-API-Key: KEY"

# 批量删除
curl -X POST "https://your-domain.com/api/external/email/batch-delete" \
  -H "X-API-Key: KEY" -H "Content-Type: application/json" \
  -d '{"emailIds":[1,2,3],"permanent":true}'
```

### 4. 邮件导出为 .eml 文件（Web UI + API）

支持将邮件导出为标准 `.eml` 格式（RFC 5322），可在 Outlook/Thunderbird 等任意邮件客户端中打开。

**Web UI**：打开邮件详情 → 点击下载图标 📥 → 自动下载 `.eml` 文件。

**External API**：
```bash
curl "https://your-domain.com/api/external/email/9/export" \
  -H "X-API-Key: KEY" -o email-9.eml
```

导出内容包含：邮件头（From/To/Subject/Date）、HTML + 纯文本正文、内嵌图片（CID）、附件。

### 5. 新用户注册通知

新用户注册时自动发送通知到 Telegram Bot 和管理员邮箱（通过 CF Email Service）。无需额外配置 — 使用已有的 Telegram Bot 设置。

### 5. 管理员密码重置

忘记管理员密码时，通过 JWT Secret 重置：

```bash
curl -X POST "https://your-domain.com/api/reset-admin/<jwt_secret>" \
  -H "Content-Type: application/json" \
  -d '{"password":"newpassword"}'
```

### 7. D1 自动备份到 R2

Worker 内置 cron 定时任务，每天自动导出 D1 全量数据为 SQL 并 gzip 压缩上传到 R2。

- 每天 02:00 UTC 自动运行
- 保留最近 30 个备份，自动清理旧备份
- 零外部依赖 — 完全在 Cloudflare 内部完成
- 支持手动触发：`POST /api/backup/<jwt_secret>`
- 查看备份列表：`GET /api/backup/<jwt_secret>/list`

### 8. AI 邮件助手（Cloudflare Workers AI）

集成 [Cloudflare Workers AI](https://developers.cloudflare.com/workers-ai/) (`@cf/moonshotai/kimi-k2.5`) 的对话式邮件助手，登录后从 Header **✨ 邮件助手** 按钮打开侧边栏即可与 AI 对话。

**9 个邮件工具**（AI 自动选择调用）：

| 工具 | 用途 | 是否需确认 |
|------|------|----------|
| `listEmails` | 列出收件箱 / 已发送 / 草稿 / 垃圾箱 | 否 |
| `searchEmails` | 按主题/发件人/日期搜索邮件 | 否 |
| `getEmail` | 读取指定邮件全文 + 附件列表 | 否 |
| `getAttachmentText` | 读取文本类附件（text/* / json / xml / csv） | 否 |
| `summarizeEmail` | 3-5 行要点摘要 + 行动项 | 否 |
| `draftReply` | 起草回复（保存到草稿箱） | 否 |
| `draftNew` | 起草新邮件 | 否 |
| `sendDraft` | 发送草稿 | **是 ✓** |
| `deleteEmail` | 删除邮件（软删除/永久删除） | **是 ✓** |

**自动起草新邮件回复** — 收到新邮件时，AI 自动阅读并生成回复草稿保存到草稿箱（**永远不会自动发送**，必须用户在 UI 中确认）。

**安全特性**：
- 发送、删除操作必须由用户在侧边栏底部的确认卡片中点击「确认」才执行
- 所有工具调用按用户隔离 — 一个用户的 AI 助手永远看不到其他用户的邮件
- 工具调用计数封顶（每次对话最多 8 步），避免成本爆炸
- 自动起草仅 2 步上限（读取 + 起草）
- AI 模型决定该邮件无需回复时（noreply / spam / 自动通知）会自动跳过

**配置**：登录后进入 **设置** → 滑动到底部 **✨ AI 邮件助手** 部分 → 启用「AI 助手」开关 + 可选「自动起草」+ 自定义人设说明。

**模型与计费**：使用 Cloudflare Workers AI Kimi K2.5。免费层每天 10000 neurons，单次对话约消耗 50-200 neurons，足够正常使用。

**集成栈**：[AI SDK v6](https://sdk.vercel.ai/) + `@ai-sdk/vue` v3 (`Chat` 类) + `workers-ai-provider` + Cloudflare Workers AI。完整中英文 i18n。

---

## 部署

### 前置条件

- [Cloudflare](https://dash.cloudflare.com) 账号
- [Node.js](https://nodejs.org/) 16.17+
- [pnpm](https://pnpm.io/) 8+（推荐）或 npm
- `jq`、`python3`、`openssl`、`curl`（一键脚本依赖）
- 域名已添加到 Cloudflare DNS

### 一键部署（推荐）

```bash
git clone https://github.com/AndrewYukon/cloud-mail-plus.git
cd cloud-mail-plus
bash scripts/deploy.sh
```

脚本会自动完成：
- 检查 wrangler 登录状态（未登录会启动 `wrangler login`）
- 幂等创建 D1 / KV / R2（已存在则复用，不会重复创建）
- 生成 64 字符 JWT secret
- **可选启用 AI Email Agent**（Workers AI kimi-k2.5 + 自动起草） — 自动写入 `[ai]` binding、`EmailAgent` Durable Object、DO migration、agent schema
- 在 `wrangler.toml` 的标记块内写入 bindings + vars（重跑替换不重复）
- `wrangler deploy`（自动构建 Vue 前端）
- 调用 `/api/init/<jwt_secret>` 初始化 D1 schema（含 agent 表）
- 状态保存在 `.cloud-mail-deploy.env`（已 gitignore，含 JWT secret）

**子命令：**

```bash
bash scripts/deploy.sh                  # 交互式首次部署（会询问是否启用 AI Agent）
bash scripts/deploy.sh --with-ai        # 自动启用 AI Email Agent（非交互）
bash scripts/deploy.sh --no-ai          # 自动禁用 AI Email Agent（非交互）
bash scripts/deploy.sh --redeploy       # 仅重建+部署，跳过资源创建
bash scripts/deploy.sh --reset          # 清除本地状态文件，重新来
bash scripts/deploy.sh --destroy        # 拆除 Worker + D1 + KV + R2（不可逆）
bash scripts/deploy.sh --destroy --yes  # 跳过确认（CI/自动化）
```

> `--destroy` 会永久删除邮箱数据、附件、备份。请谨慎使用，建议先 `wrangler r2 object` 备份重要数据。

**AI Email Agent 一键启用：**

```bash
bash scripts/deploy.sh --with-ai
```

部署完成后：
1. 登录 Web UI（首次需注册管理员账号 — 邮箱必须与 `wrangler.toml` 的 `admin` 一致）
2. 顶部 Header 出现 **✨ 邮件助手 / Email Agent** 黄色胶囊按钮
3. **设置** 页面下方有 **✨ AI 邮件助手** 部分 — 打开「启用 AI 助手」+ 可选「自动起草」+ 自定义人设
4. 点击 Header 按钮 → 侧边栏滑出 → 与 AI 对话

启用后包含的功能：
- **9 个邮件工具**：listEmails / searchEmails / getEmail / getAttachmentText / summarizeEmail / draftReply / draftNew / sendDraft / deleteEmail
- **发送 + 删除需要二次确认**（在侧边栏底部弹出确认卡片，永远不会自动执行）
- **收到新邮件时自动起草回复**（保存到草稿箱，不会自动发送）
- **完整的中英文 i18n**（跟随系统语言切换）
- **模型**：`@cf/moonshotai/kimi-k2.5`（Cloudflare Workers AI，按 neuron 计费，免费层每天 10000 neurons）

> **集成架构**：AI SDK v6 (`ai` 包) + `@ai-sdk/vue` v3 (`Chat` 类) + `workers-ai-provider` + Cloudflare Workers AI。Worker 路由直接调用 `streamText()` 通过 SSE 流响应（不使用 Durable Object，避免 AIChatAgent 与 Vue Chat 的 WebSocket/HTTP 协议不匹配问题）。

### 已知部署注意事项

- **`pnpm install`** — 首次部署若 worker deps 未安装会报 `Could not resolve "workers-ai-provider"` 等错误。脚本会自动检测并安装，但首次会比较慢。
- **`compatibility_flags = ["nodejs_compat"]`** — 必须开启（agents 依赖包用了 `node:async_hooks` / `node:diagnostics_channel`）。一键脚本已自动写入。
- **`/api/init/<jwt_secret>`** 是 **GET** 请求，不是 POST。
- **Turnstile** — 默认如果没配 site_key 会报 "Verification module failed to load"。一键部署后若遇到，运行：
  ```bash
  npx wrangler d1 execute cloud-mail --remote --command "UPDATE setting SET site_key='', secret_key='';"
  ```
  然后硬刷新浏览器（Cmd+Shift+R）即可禁用验证码。
- **PWA 缓存** — 重新部署后 Service Worker 可能仍服务旧版本。DevTools → Application → Service Workers → Unregister，再硬刷新。

### 手动部署（步骤分解）

如果你需要更细的控制（例如自定义域名、共享已有 D1），可以按以下步骤手动操作。

1. **克隆仓库**

```bash
git clone https://github.com/AndrewYukon/cloud-mail-plus.git
cd cloud-mail-plus
```

2. **创建 Cloudflare 资源**

```bash
cd mail-worker
wrangler d1 create cloud-mail
wrangler kv namespace create cloud-mail-kv
wrangler r2 bucket create cloud-mail-r2
```

3. **配置 `wrangler.toml`**

将上一步生成的 ID 填入 `wrangler.toml`：

```toml
[[d1_databases]]
binding = "db"
database_name = "cloud-mail"
database_id = "<your-d1-id>"

[[kv_namespaces]]
binding = "kv"
id = "<your-kv-id>"

[[r2_buckets]]
binding = "r2"
bucket_name = "cloud-mail-r2"

[vars]
domain = '["example.com"]'
admin = "admin@example.com"
jwt_secret = "<random-string>"
```

4. **启用 Cloudflare Email Service（可选）**

在 Cloudflare Dashboard → Email → Email Sending 中 onboard 你的域名，然后在 `wrangler.toml` 中取消注释：

```toml
[[send_email]]
name = "EMAIL"
```

5. **部署**

```bash
wrangler deploy
```

6. **初始化数据库**

```
https://your-worker.workers.dev/api/init/<your-jwt-secret>
```

7. **注册管理员账号**

访问你的 Worker URL，用 `admin` 配置中的邮箱注册。

---

## CF Email Service API 注意事项

在集成 Cloudflare Email Service 时发现的 API 细节（文档未充分说明）：

| 项目 | 说明 |
|------|------|
| `from` 字段 | 必须是 `{ name, email }` 对象，不能用 `"Name <email>"` 字符串格式 |
| 附件 `type` 字段 | MIME 类型字段名是 `type`，不是 `mimeType` 或 `contentType` |
| 附件 `disposition` | **必填**，值为 `"attachment"` 或 `"inline"` |
| 发件状态 | 同步返回成功/失败，无 webhook 回调（与 Resend 不同） |
| 收件人上限 | to + cc + bcc 总计不超过 50 |

---

## 常见问题

### 子域名 catch-all 邮件路由（主域名已绑定其他邮件服务）

如果你的主域名（如 `example.com`）已绑定其他邮件服务（如 Google Workspace），无法在 Cloudflare 开启 Email Routing，可以使用子域名：

1. 在 Cloudflare Dashboard 为子域名 `mail.example.com` 开启 Email Routing
2. 设置 catch-all → cloud-mail Worker
3. 在 `wrangler.toml` 的 `domain` 中添加 `"mail.example.com"`
4. 用户邮箱格式变为 `user@mail.example.com`

注意：子域名和主域名的 Email Routing 是独立的，互不影响。

### IMAP/POP3/SMTP 客户端支持（Outlook/Thunderbird）

Cloudflare Workers 无法运行 IMAP/SMTP 等 TCP 协议服务。如需在 Outlook 等客户端中收发邮件，推荐搭配 [Stalwart Mail Server](https://github.com/stalwartlabs/stalwart) 使用：

- 部署指南：[stalwart-mail-deploy](https://github.com/AndrewYukon/stalwart-mail-deploy)
- Stalwart 提供 IMAP (993) + SMTP (465) 给 Outlook
- Cloud-Mail Plus 通过 External API 提供发件（走 CF Email Service，更高信誉度）
- 可通过 Mail Bridge 组件将两者打通（详见 stalwart-mail-deploy 的 [Cloudflare Workers 策略](https://github.com/AndrewYukon/stalwart-mail-deploy/tree/main/outbound-strategies/cloudflare-workers)）

---

## 原版功能

本项目保留了 [maillab/cloud-mail](https://github.com/maillab/cloud-mail) 的所有原版功能：

- 多域名支持
- 邮件收发（Cloudflare Email Routing 收件 + Resend 发件）
- 附件支持（R2/S3/KV 存储）
- 响应式 Web UI（Vue 3 + Element Plus）
- 多用户 + RBAC 权限控制
- Telegram 推送
- Turnstile 验证码
- 邮件转发
- 暗色模式
- 多语言（中/英）

---

## 技术栈

| 组件 | 技术 |
|------|------|
| 运行环境 | Cloudflare Workers |
| 后端框架 | Hono.js |
| 数据库 | Cloudflare D1 (SQLite) + Drizzle ORM |
| 缓存 | Cloudflare KV |
| 文件存储 | Cloudflare R2 |
| 发件 | **Cloudflare Email Service**（主） + Resend（备） |
| 收件 | Cloudflare Email Routing |
| 前端 | Vue 3 + Element Plus + Vite |

---

## 支持项目

如果这个项目对你有帮助，欢迎请我喝杯咖啡 ☕

<img src="doc/demo/Buy-me-a-coffee-WeChat.JPG" width="200" />

---

## License

MIT — 与原项目一致。详见 [LICENSE](LICENSE)。
