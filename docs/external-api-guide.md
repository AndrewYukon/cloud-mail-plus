# Cloud-Mail External API Guide

Cloud-Mail provides an External API for other applications to send email and query delivery status through any domain configured in Cloud-Mail.

## Base URL & Authentication

```
Base URL: https://mail.blizzarddelights.com/api
Auth:     X-API-Key header
```

### Environment Variables

```bash
CLOUD_MAIL_API_URL=https://mail.blizzarddelights.com/api
CLOUD_MAIL_API_KEY=<your-api-key>
```

The API key is managed in the Cloud-Mail admin panel: **Settings → External API Key → Generate**.

---

## Endpoints

### Health Check

```
GET /api/external/health
```

No authentication required. Returns `{ "status": "ok" }`.

---

### Send Email

```
POST /api/external/send
```

**Headers:**

| Header | Value |
|--------|-------|
| Content-Type | application/json |
| X-API-Key | `<your-api-key>` |

**Body (JSON):**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| from | string | Yes | Sender address. Format: `"Name <email>"` or `"email"`. Domain must be configured in Cloud-Mail. |
| to | string \| string[] | Yes | Recipient(s). Single address or array (max 50). |
| subject | string | Yes | Email subject line. |
| html | string | Yes* | HTML body. *At least one of `html` or `text` is required. |
| text | string | Yes* | Plain text body. *At least one of `html` or `text` is required. |
| cc | string \| string[] | No | CC recipient(s). |
| bcc | string \| string[] | No | BCC recipient(s). |
| replyTo | string | No | Reply-to address. |
| headers | object | No | Custom email headers (e.g., `{ "X-Custom": "value" }`). |
| attachments | object[] | No | File attachments. See [Attachments](#attachments) below. |

**Response:**

```json
{
  "code": 200,
  "message": "success",
  "data": {
    "emailId": 9,
    "status": "delivered",
    "provider": "cloudflare",
    "resendEmailId": null
  }
}
```

| Field | Description |
|-------|-------------|
| emailId | Unique ID for status tracking. |
| status | `"delivered"` (CF Email) or `"sent"` (Resend, pending delivery confirmation). |
| provider | `"cloudflare"` or `"resend"`. |
| resendEmailId | Resend's email ID (only when sent via Resend). |

---

### Query Status

```
GET /api/external/status/:emailId
```

**Headers:**

| Header | Value |
|--------|-------|
| X-API-Key | `<your-api-key>` |

**Response:**

```json
{
  "code": 200,
  "message": "success",
  "data": {
    "emailId": 9,
    "status": "delivered",
    "statusCode": 2,
    "from": "info@owaa.ai",
    "subject": "Your verification code",
    "recipient": [{ "address": "user@gmail.com", "name": "" }],
    "resendEmailId": null,
    "message": null,
    "createTime": "2026-04-26 20:20:37"
  }
}
```

**Status values:**

| status | statusCode | Description |
|--------|-----------|-------------|
| delivered | 2 | Email accepted for delivery (CF Email) or confirmed delivered (Resend webhook). |
| sent | 1 | Sent via Resend, awaiting delivery confirmation. |
| bounced | 3 | Recipient server rejected the email. |
| complained | 4 | Recipient marked as spam. |
| delayed | 5 | Delivery delayed, will retry. |
| failed | 8 | Send failed. |

---

## Attachments

Each attachment object:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| filename | string | Yes | File name (e.g., `"invoice.pdf"`). |
| content | string | Yes | Base64-encoded file content. |
| type | string | Yes | MIME type (e.g., `"application/pdf"`, `"image/png"`). |
| disposition | string | Yes | `"attachment"` for regular files, `"inline"` for embedded images. |
| contentId | string | No | CID for inline images (reference in HTML as `cid:<contentId>`). |

**Example with attachment:**

```json
{
  "from": "Owaa <noreply@owaa.ai>",
  "to": "user@gmail.com",
  "subject": "Your invoice",
  "html": "<p>Please find your invoice attached.</p>",
  "attachments": [
    {
      "filename": "invoice.pdf",
      "content": "JVBERi0xLjQK...",
      "type": "application/pdf",
      "disposition": "attachment"
    }
  ]
}
```

---

## Available Sender Domains

The `from` address must use a domain configured in Cloud-Mail. Currently configured:

- `owaa.ai` — e.g., `info@owaa.ai`, `noreply@owaa.ai`, `support@owaa.ai`
- `blizzarddelights.com` — e.g., `info@blizzarddelights.com`

To add a new domain: update `domain` in `wrangler.toml` → deploy → onboard in Cloudflare dashboard (Email Routing + Email Sending).

---

## Code Examples

### Node.js / JavaScript

```javascript
const CLOUD_MAIL_API_URL = process.env.CLOUD_MAIL_API_URL;
const CLOUD_MAIL_API_KEY = process.env.CLOUD_MAIL_API_KEY;

// Send email
async function sendEmail({ from, to, subject, html, text, attachments }) {
  const res = await fetch(`${CLOUD_MAIL_API_URL}/external/send`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': CLOUD_MAIL_API_KEY,
    },
    body: JSON.stringify({ from, to, subject, html, text, attachments }),
  });
  const body = await res.json();
  if (body.code !== 200) {
    throw new Error(`Send failed: ${body.message}`);
  }
  return body.data; // { emailId, status, provider }
}

// Check status
async function checkStatus(emailId) {
  const res = await fetch(`${CLOUD_MAIL_API_URL}/external/status/${emailId}`, {
    headers: { 'X-API-Key': CLOUD_MAIL_API_KEY },
  });
  const body = await res.json();
  if (body.code !== 200) {
    throw new Error(`Status check failed: ${body.message}`);
  }
  return body.data; // { emailId, status, from, subject, recipient, createTime }
}

// Usage
const { emailId } = await sendEmail({
  from: 'Owaa <noreply@owaa.ai>',
  to: 'user@gmail.com',
  subject: 'Your verification code',
  html: '<p>Your code is <b>123456</b></p>',
  text: 'Your code is 123456',
});

const { status } = await checkStatus(emailId);
console.log(`Email ${emailId}: ${status}`); // "delivered"
```

### Python

```python
import os
import requests

CLOUD_MAIL_API_URL = os.environ["CLOUD_MAIL_API_URL"]
CLOUD_MAIL_API_KEY = os.environ["CLOUD_MAIL_API_KEY"]
HEADERS = {"X-API-Key": CLOUD_MAIL_API_KEY}


def send_email(from_addr, to, subject, html=None, text=None, attachments=None):
    resp = requests.post(
        f"{CLOUD_MAIL_API_URL}/external/send",
        headers=HEADERS,
        json={
            "from": from_addr,
            "to": to,
            "subject": subject,
            "html": html,
            "text": text,
            "attachments": attachments,
        },
    )
    data = resp.json()
    if data["code"] != 200:
        raise Exception(f"Send failed: {data['message']}")
    return data["data"]


def check_status(email_id):
    resp = requests.get(
        f"{CLOUD_MAIL_API_URL}/external/status/{email_id}",
        headers=HEADERS,
    )
    return resp.json()["data"]


# Usage
result = send_email(
    from_addr="Owaa <noreply@owaa.ai>",
    to="user@gmail.com",
    subject="Your verification code",
    html="<p>Your code is <b>123456</b></p>",
)
email_id = result["emailId"]
status = check_status(email_id)["status"]
print(f"Email {email_id}: {status}")  # "delivered"
```

### cURL

```bash
# Send
curl -X POST "https://mail.blizzarddelights.com/api/external/send" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $CLOUD_MAIL_API_KEY" \
  -d '{
    "from": "Owaa <noreply@owaa.ai>",
    "to": "user@gmail.com",
    "subject": "Test email",
    "html": "<p>Hello world</p>",
    "text": "Hello world"
  }'

# Check status
curl "https://mail.blizzarddelights.com/api/external/status/9" \
  -H "X-API-Key: $CLOUD_MAIL_API_KEY"
```

---

## Error Handling

| HTTP Code | Error | Cause |
|-----------|-------|-------|
| 401 | Missing X-API-Key header | No `X-API-Key` header in request. |
| 401 | Invalid API key | Wrong API key. |
| 400 | from is required | Missing `from` field. |
| 400 | to is required | Missing `to` field. |
| 400 | subject is required | Missing `subject` field. |
| 400 | html or text is required | Neither `html` nor `text` provided. |
| 400 | Domain 'xxx' is not configured | The `from` address uses a domain not in Cloud-Mail. |
| 400 | CF Email failed: ... | Cloudflare Email Service error (auto-falls back to Resend if available). |
| 400 | No Resend token configured for xxx | CF Email failed and no Resend fallback token for this domain. |
| 404 | Email not found | Invalid `emailId` in status query. |

---

## Send Priority

Cloud-Mail routes outbound email through two providers:

```
1. Cloudflare Email Service (primary) — native Workers binding, no API key needed
2. Resend API (fallback) — used when CF Email fails or is unavailable
```

The admin can change the priority in Settings → Email Provider:
- **CF First** (default): try Cloudflare, fall back to Resend on failure.
- **Resend Only**: use Resend exclusively.
- **CF Only**: use Cloudflare only, no fallback.
