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

### 3. 邮件删除 API + R2 附件清理

外部 API 新增邮件删除端点，永久删除时同步清理 R2/S3/KV 中的附件文件。

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

### 4. 新用户注册通知

新用户注册时自动发送通知到 Telegram Bot 和管理员邮箱（通过 CF Email Service）。无需额外配置 — 使用已有的 Telegram Bot 设置。

### 5. 管理员密码重置

忘记管理员密码时，通过 JWT Secret 重置：

```bash
curl -X POST "https://your-domain.com/api/reset-admin/<jwt_secret>" \
  -H "Content-Type: application/json" \
  -d '{"password":"newpassword"}'
```

### 6. D1 自动备份到 R2

Worker 内置 cron 定时任务，每天自动导出 D1 全量数据为 SQL 并 gzip 压缩上传到 R2。

- 每天 02:00 UTC 自动运行
- 保留最近 30 个备份，自动清理旧备份
- 零外部依赖 — 完全在 Cloudflare 内部完成
- 支持手动触发：`POST /api/backup/<jwt_secret>`
- 查看备份列表：`GET /api/backup/<jwt_secret>/list`

---

## 部署

### 前置条件

- [Cloudflare](https://dash.cloudflare.com) 账号
- [Node.js](https://nodejs.org/) 16.17+
- 域名已添加到 Cloudflare DNS

### 步骤

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

## License

MIT — 与原项目一致。详见 [LICENSE](LICENSE)。
