#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# Cloudflare Email Routing Bootstrap — one-shot domain setup via CF API
#
# Performs everything the deploy script can't do via wrangler:
#   1. Look up zone_id + account_id for the domain
#   2. Enable Email Routing on the zone (auto-creates MX + SPF DNS records)
#   3. Set catch-all rule → cloud-mail Worker
#   4. Add _dmarc TXT (if missing) with safe p=none policy
#   5. Pre-verify destination address (sends verification email)
#
# Usage:
#   CF_API_TOKEN=cf_xxx bash scripts/cf-bootstrap-domain.sh <domain> [worker-name] [admin-email]
#
# Required token scopes (scope to the specific zone):
#   Account → Email Routing Addresses : Edit
#   Zone    → Email Routing Settings  : Edit
#   Zone    → Email Routing Rules     : Edit
#   Zone    → DNS                     : Edit
#   Zone    → Zone                    : Read
#
# Idempotent — safe to re-run. Existing rules / DNS records are detected.
# =============================================================================

DOMAIN="${1:-}"
WORKER="${2:-cloud-mail}"
ADMIN_EMAIL="${3:-}"

if [ -z "$DOMAIN" ]; then
  echo "Usage: CF_API_TOKEN=... bash $0 <domain> [worker-name] [admin-email]" >&2
  exit 1
fi
if [ -z "${CF_API_TOKEN:-}" ]; then
  echo "CF_API_TOKEN env var required. Create at https://dash.cloudflare.com/profile/api-tokens" >&2
  exit 1
fi
command -v jq >/dev/null || { echo "jq required" >&2; exit 1; }
command -v curl >/dev/null || { echo "curl required" >&2; exit 1; }

if [ -t 1 ]; then
  C_GREEN='\033[0;32m'; C_RED='\033[0;31m'; C_YEL='\033[1;33m'; C_BLU='\033[0;34m'; C_NC='\033[0m'
else C_GREEN=''; C_RED=''; C_YEL=''; C_BLU=''; C_NC=''; fi
step() { printf "${C_BLU}[%s]${C_NC} %s\n" "$1" "$2"; }
ok()   { printf "${C_GREEN}✓${C_NC} %s\n" "$1"; }
warn() { printf "${C_YEL}!${C_NC} %s\n" "$1"; }
err()  { printf "${C_RED}✗${C_NC} %s\n" "$1" >&2; }

api() {
  local method="$1" path="$2" body="${3:-}"
  local args=(-sS -X "$method" "https://api.cloudflare.com/client/v4$path"
              -H "Authorization: Bearer $CF_API_TOKEN")
  if [ -n "$body" ]; then
    args+=(-H "Content-Type: application/json" -d "$body")
  fi
  curl "${args[@]}"
}

# --- 1. Zone lookup ---
step "1/5" "Looking up zone for $DOMAIN..."
ZONE_JSON=$(api GET "/zones?name=$DOMAIN")
ZONE_ID=$(echo "$ZONE_JSON" | jq -r '.result[0].id // empty')
ACCOUNT_ID=$(echo "$ZONE_JSON" | jq -r '.result[0].account.id // empty')
if [ -z "$ZONE_ID" ]; then
  err "Zone '$DOMAIN' not found. Add it to Cloudflare first."
  echo "API response: $(echo "$ZONE_JSON" | jq -c '.errors // .messages // .')" >&2
  exit 1
fi
ok "Zone: $ZONE_ID"
ok "Account: $ACCOUNT_ID"

# --- 2. Enable Email Routing ---
step "2/5" "Enabling Email Routing on $DOMAIN..."
SETTINGS=$(api GET "/zones/$ZONE_ID/email/routing")
ROUTING_ENABLED=$(echo "$SETTINGS" | jq -r '.result.enabled // false')
if [ "$ROUTING_ENABLED" = "true" ]; then
  ok "Email Routing already enabled"
else
  ENABLE=$(api POST "/zones/$ZONE_ID/email/routing/enable" '{}')
  if echo "$ENABLE" | jq -e '.success == true' >/dev/null 2>&1; then
    ok "Email Routing enabled (MX + SPF DNS records auto-created)"
  else
    # Fallback path for accounts that need explicit DNS provisioning
    DISABLE_CODE=$(echo "$ENABLE" | jq -r '.errors[0].code // 0')
    if [ "$DISABLE_CODE" = "1006" ]; then
      DNS_PROVISION=$(api POST "/zones/$ZONE_ID/email/routing/dns" '{}')
      if echo "$DNS_PROVISION" | jq -e '.success == true' >/dev/null; then
        ok "DNS records provisioned; retrying enable..."
        ENABLE=$(api POST "/zones/$ZONE_ID/email/routing/enable" '{}')
      fi
    fi
    if echo "$ENABLE" | jq -e '.success == true' >/dev/null 2>&1; then
      ok "Email Routing enabled"
    else
      err "Failed to enable Email Routing"
      echo "$ENABLE" | jq -c '.errors // .messages // .' >&2
      exit 1
    fi
  fi
fi

# --- 3. Catch-all rule → Worker ---
step "3/5" "Setting catch-all rule → Worker '$WORKER'..."
RULE_BODY=$(jq -nc \
  --arg worker "$WORKER" \
  --arg name "cloud-mail catch-all (managed)" \
  '{matchers:[{type:"all"}], actions:[{type:"worker", value:[$worker]}], enabled:true, name:$name}')
RULE=$(api PUT "/zones/$ZONE_ID/email/routing/rules/catch_all" "$RULE_BODY")
if echo "$RULE" | jq -e '.success == true' >/dev/null; then
  ok "Catch-all rule routes all *@$DOMAIN → Worker '$WORKER'"
else
  err "Catch-all rule failed:"
  echo "$RULE" | jq -c '.errors // .messages // .' >&2
  exit 1
fi

# --- 4. _dmarc TXT (only if missing) ---
step "4/5" "Ensuring _dmarc TXT record..."
DMARC_LOOKUP=$(api GET "/zones/$ZONE_ID/dns_records?type=TXT&name=_dmarc.$DOMAIN")
DMARC_COUNT=$(echo "$DMARC_LOOKUP" | jq -r '.result | length')
if [ "$DMARC_COUNT" -gt 0 ]; then
  ok "_dmarc.$DOMAIN already exists — leaving as-is"
else
  DMARC_ADD=$(api POST "/zones/$ZONE_ID/dns_records" \
    '{"type":"TXT","name":"_dmarc","content":"v=DMARC1; p=none","ttl":300,"proxied":false}')
  if echo "$DMARC_ADD" | jq -e '.success == true' >/dev/null; then
    ok "_dmarc TXT added (p=none — tighten to quarantine/reject after monitoring)"
  else
    warn "Failed to add _dmarc: $(echo "$DMARC_ADD" | jq -c '.errors')"
  fi
fi

# --- 5. Optional destination-address verification ---
if [ -n "$ADMIN_EMAIL" ]; then
  step "5/5" "Pre-verifying destination address $ADMIN_EMAIL..."
  ADDRS=$(api GET "/accounts/$ACCOUNT_ID/email/routing/addresses?per_page=50")
  EXISTING=$(echo "$ADDRS" | jq -r --arg e "$ADMIN_EMAIL" '.result[]? | select(.email==$e) | .verified // ""')
  if [ -n "$EXISTING" ] && [ "$EXISTING" != "null" ]; then
    ok "$ADMIN_EMAIL already a verified destination ($EXISTING)"
  elif [ -n "$EXISTING" ]; then
    ok "$ADMIN_EMAIL already added (pending verification email)"
  else
    ADD=$(api POST "/accounts/$ACCOUNT_ID/email/routing/addresses" \
      "$(jq -nc --arg e "$ADMIN_EMAIL" '{email:$e}')")
    if echo "$ADD" | jq -e '.success == true' >/dev/null; then
      ok "Verification email sent to $ADMIN_EMAIL — click the link to confirm"
    else
      warn "Could not add destination: $(echo "$ADD" | jq -c '.errors')"
    fi
  fi
else
  step "5/5" "Skipping destination-address pre-verification (no admin-email arg)"
fi

cat <<EOF

============================================
  Cloudflare Bootstrap Complete: $DOMAIN
============================================

  Zone:     $ZONE_ID
  Account:  $ACCOUNT_ID
  Worker:   $WORKER (catch-all)

  Verify in Cloudflare Dashboard:
    Email → Email Routing → $DOMAIN
    DNS   → $DOMAIN  (look for auto-created MX + SPF)

  Test inbound:
    Send a test email to anything@$DOMAIN — should hit the Worker.

  For send_email outbound (CF Email Sending):
    The "from" address must be a verified destination on this account.
    If you ran with [admin-email], check that inbox + click the verification link.
    Then in cloud-mail, register the admin user → Settings → Email Sending.

EOF
