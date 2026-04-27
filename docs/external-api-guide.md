# Cloud-Mail Plus — External API Guide

Cloud-Mail Plus provides an External API for other applications to send email and query delivery status through any domain configured in Cloud-Mail.

## Base URL & Authentication

```
Base URL: https://your-worker-domain.com/api
Auth:     X-API-Key header
```

### Environment Variables

```bash
CLOUD_MAIL_API_URL=https://your-worker-domain.com/api
CLOUD_MAIL_API_KEY=<your-api-key>
```

The API key is managed in the Cloud-Mail admin panel: **Settings > External API Key > Generate**.

---

## Endpoints

### Health Check

```
GET /api/external/health
```

No authentication required.

### Send Email

```
POST /api/external/send
```

| Header | Value |
|--------|-------|
| Content-Type | application/json |
| X-API-Key | `<your-api-key>` |

**Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| from | string | Yes | `"Name <email>"` or `"email"`. Domain must be configured. |
| to | string \| string[] | Yes | Recipient(s), max 50. |
| subject | string | Yes | Subject line. |
| html | string | Yes* | HTML body (*at least one of html/text required). |
| text | string | Yes* | Plain text body. |
| cc | string \| string[] | No | CC recipients. |
| bcc | string \| string[] | No | BCC recipients. |
| replyTo | string | No | Reply-to address. |
| attachments | object[] | No | See [Attachments](#attachments). |

**Response:** `{ emailId, status, provider, resendEmailId }`

### Query Status

```
GET /api/external/status/:emailId
```

**Status values:** `delivered`, `sent`, `bounced`, `complained`, `delayed`, `failed`

---

## Attachments

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| filename | string | Yes | e.g., `"invoice.pdf"` |
| content | string | Yes | Base64-encoded content |
| type | string | Yes | MIME type, e.g., `"application/pdf"` |
| disposition | string | Yes | `"attachment"` or `"inline"` |
| contentId | string | No | CID for inline images |

---

## Code Examples

### Node.js

```javascript
const res = await fetch(`${CLOUD_MAIL_API_URL}/external/send`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-API-Key': CLOUD_MAIL_API_KEY,
  },
  body: JSON.stringify({
    from: 'App <noreply@example.com>',
    to: 'user@gmail.com',
    subject: 'Your verification code',
    html: '<p>Your code is <b>123456</b></p>',
  }),
});
const { data } = await res.json();
```

### Python

```python
resp = requests.post(
    f"{CLOUD_MAIL_API_URL}/external/send",
    headers={"X-API-Key": CLOUD_MAIL_API_KEY},
    json={
        "from": "App <noreply@example.com>",
        "to": "user@gmail.com",
        "subject": "Your verification code",
        "html": "<p>Your code is <b>123456</b></p>",
    },
)
email_id = resp.json()["data"]["emailId"]
```

### cURL

```bash
curl -X POST "https://your-worker-domain.com/api/external/send" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: YOUR_API_KEY" \
  -d '{"from":"App <noreply@example.com>","to":"user@gmail.com","subject":"Test","html":"<p>Hello</p>"}'
```

---

## Delete Email

### Soft Delete

```
DELETE /api/external/email/:emailId
```

Marks the email as deleted (recoverable). Returns `{ emailId, deleted: true }`.

### Permanent Delete (+ R2 Attachment Cleanup)

```
DELETE /api/external/email/:emailId/permanent
```

Permanently deletes the email, its R2/S3/KV attachments, and stars. Irreversible.

### Batch Delete

```
POST /api/external/email/batch-delete
```

```json
{
  "emailIds": [1, 2, 3],
  "permanent": true
}
```

Max 100 emails per batch. Set `permanent: false` for soft delete.

---

## Admin Password Reset

If you forget the admin password:

```
POST /api/reset-admin/:jwt_secret
```

```json
{ "password": "newpassword" }
```

Protected by JWT secret (same as init endpoint). No auth header needed.

---

## Send Priority

Configurable in admin Settings > Email Provider:

1. **CF First** (default): try Cloudflare Email Service, fall back to Resend on failure.
2. **Resend Only**: use Resend exclusively.
3. **CF Only**: Cloudflare only, no fallback.
