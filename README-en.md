<p align="center">
    <img src="doc/demo/logo.png" width="80px" />
    <h1 align="center">Cloud Mail Plus</h1>
    <p align="center">Enhanced Cloudflare Workers email service — native CF Email Service sending + External API + automatic D1 backup</p>
    <p align="center">
        <a href="/README.md">简体中文</a> | English
    </p>
    <p align="center">
        <a href="https://github.com/AndrewYukon/cloud-mail-plus/blob/main/LICENSE">
            <img src="https://img.shields.io/badge/license-MIT-green" />
        </a>
    </p>
</p>

## Credits

This project is based on [maillab/cloud-mail](https://github.com/maillab/cloud-mail), an excellent Cloudflare Workers email platform. We've added the following features on top of the original. Thanks to the original author for their open-source contribution.

## New Features

### 1. Cloudflare Email Service Integration

Uses the native `send_email` Workers binding to send outbound email, replacing Resend as the primary sender.

- **CF First** (default): try Cloudflare Email Service, fall back to Resend on failure
- **Resend Only**: original behavior
- **CF Only**: Cloudflare only, no fallback

Benefits:
- No third-party API key needed (Cloudflare handles SPF/DKIM/DMARC automatically)
- Better deliverability (Cloudflare IP reputation vs self-hosted)
- Zero additional cost (included in Workers paid plan)

Configure in admin Settings > Email Provider.

### 2. External API

Allows other applications to send email and query delivery status via HTTP API.

```bash
# Send
curl -X POST "https://your-domain.com/api/external/send" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: YOUR_API_KEY" \
  -d '{"from":"App <noreply@example.com>","to":"user@gmail.com","subject":"Hello","html":"<p>Hello</p>"}'

# Check status
curl "https://your-domain.com/api/external/status/9" -H "X-API-Key: YOUR_API_KEY"
```

Generate the API key in admin Settings > External API Key.

Full documentation: [External API Guide](docs/external-api-guide.md)

### 3. Email Delete + R2 Attachment Cleanup (Web UI + API)

**Web UI**: After selecting emails, the toolbar shows two delete buttons:
- 🗑️ Soft delete — marks as deleted, recoverable
- 🗑️ **Permanent delete** — removes email + R2/S3/KV attachments + stars, irreversible (with confirmation dialog)

**External API** also provides delete endpoints:

```bash
# Soft delete
curl -X DELETE "https://your-domain.com/api/external/email/123" -H "X-API-Key: KEY"

# Permanent delete (email + R2 attachments + stars)
curl -X DELETE "https://your-domain.com/api/external/email/123/permanent" -H "X-API-Key: KEY"

# Batch delete
curl -X POST "https://your-domain.com/api/external/email/batch-delete" \
  -H "X-API-Key: KEY" -H "Content-Type: application/json" \
  -d '{"emailIds":[1,2,3],"permanent":true}'
```

### 4. New User Registration Notification

Automatically sends Telegram + admin email notifications when a new user registers. Uses existing Telegram Bot settings — no extra configuration needed.

### 5. Admin Password Reset

Forgot admin password? Reset via JWT secret:

```bash
curl -X POST "https://your-domain.com/api/reset-admin/<jwt_secret>" \
  -H "Content-Type: application/json" \
  -d '{"password":"newpassword"}'
```

### 6. Automatic D1 Backup to R2

Built-in Worker cron job exports the entire D1 database as gzipped SQL to R2 daily.

- Runs at 02:00 UTC daily
- Retains last 30 backups, auto-cleans older ones
- Zero external dependencies
- Manual trigger: `POST /api/backup/<jwt_secret>`
- List backups: `GET /api/backup/<jwt_secret>/list`

---

## Deployment

### Prerequisites

- [Cloudflare](https://dash.cloudflare.com) account
- [Node.js](https://nodejs.org/) 16.17+
- Domain added to Cloudflare DNS

### Steps

1. **Clone**

```bash
git clone https://github.com/AndrewYukon/cloud-mail-plus.git
cd cloud-mail-plus
```

2. **Create Cloudflare resources**

```bash
cd mail-worker
wrangler d1 create cloud-mail
wrangler kv namespace create cloud-mail-kv
wrangler r2 bucket create cloud-mail-r2
```

3. **Configure `wrangler.toml`** — fill in the IDs from step 2

4. **Enable CF Email Service** (optional) — onboard your domain in Cloudflare Dashboard > Email > Email Sending, then uncomment `[[send_email]]` in `wrangler.toml`

5. **Deploy**: `wrangler deploy`

6. **Initialize**: visit `https://your-worker.workers.dev/api/init/<jwt_secret>`

7. **Register** admin account using the email in your `admin` config

---

## CF Email Service API Notes

Gotchas discovered during integration (not well documented by Cloudflare):

| Field | Note |
|-------|------|
| `from` | Must be `{ name, email }` object, not `"Name <email>"` string |
| Attachment `type` | MIME type field is `type`, not `mimeType` or `contentType` |
| Attachment `disposition` | **Required** — `"attachment"` or `"inline"` |
| Delivery status | Synchronous success/failure only, no webhook callbacks |
| Recipient limit | Max 50 across to + cc + bcc |

---

## Original Features

All features from [maillab/cloud-mail](https://github.com/maillab/cloud-mail) are preserved:

- Multi-domain support
- Email send/receive (Email Routing + Resend)
- Attachments (R2/S3/KV storage)
- Responsive Web UI (Vue 3 + Element Plus)
- Multi-user + RBAC
- Telegram push notifications
- Turnstile CAPTCHA
- Email forwarding
- Dark mode
- i18n (Chinese/English)

---

## License

MIT — same as the original project. See [LICENSE](LICENSE).
