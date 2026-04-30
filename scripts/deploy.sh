#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# Cloud Mail Plus — One-Click Deploy Script
#
# What it does:
#   1. Pre-flight: checks node/pnpm/jq/python3, wrangler login
#   2. Prompts for domains, admin email, CF Email Service preference
#   3. Idempotently creates D1 / KV / R2 resources on Cloudflare
#   4. Generates JWT secret (or reuses existing)
#   5. Patches mail-worker/wrangler.toml with bindings + vars
#      (writes inside markers — re-runs replace, never duplicate)
#   6. Runs `wrangler deploy` (auto-builds the Vue frontend)
#   7. Calls /api/init/<jwt_secret> to initialize the D1 schema
#   8. Saves state to .cloud-mail-deploy.env so re-runs skip prompts
#
# Usage:
#   bash scripts/deploy.sh                # interactive
#   bash scripts/deploy.sh --redeploy     # skip resource creation, just rebuild + ship
#   bash scripts/deploy.sh --reset        # forget saved state, start fresh
#   bash scripts/deploy.sh --destroy      # tear down D1/KV/R2 + delete Worker (DANGEROUS)
#   bash scripts/deploy.sh --destroy --yes  # skip confirmation prompts (CI / scripting)
#
# Re-runs are safe: existing D1/KV/R2 resources are detected and reused.
# --destroy is irreversible: D1 data, KV pairs, R2 objects are permanently deleted.
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
WORKER_DIR="$REPO_ROOT/mail-worker"
WRANGLER_TOML="$WORKER_DIR/wrangler.toml"
STATE_FILE="$REPO_ROOT/.cloud-mail-deploy.env"

REDEPLOY=false
DESTROY=false
ASSUME_YES=false
for arg in "$@"; do
  case "$arg" in
    --redeploy)      REDEPLOY=true ;;
    --destroy)       DESTROY=true ;;
    --yes|-y)        ASSUME_YES=true ;;
    --reset)         rm -f "$STATE_FILE"; echo "State file removed."; exit 0 ;;
    -h|--help)       sed -n '4,25p' "$0"; exit 0 ;;
    *) echo "Unknown arg: $arg" >&2; exit 1 ;;
  esac
done

# --- Output helpers ---
if [ -t 1 ]; then
  C_GREEN='\033[0;32m'; C_RED='\033[0;31m'; C_YEL='\033[1;33m'; C_BLU='\033[0;34m'; C_NC='\033[0m'
else
  C_GREEN=''; C_RED=''; C_YEL=''; C_BLU=''; C_NC=''
fi
step() { printf "${C_BLU}[%s]${C_NC} %s\n" "$1" "$2"; }
ok()   { printf "${C_GREEN}✓${C_NC} %s\n" "$1"; }
warn() { printf "${C_YEL}!${C_NC} %s\n" "$1"; }
err()  { printf "${C_RED}✗${C_NC} %s\n" "$1" >&2; }

# --- Pre-flight ---
preflight() {
  step "0/7" "Pre-flight checks..."
  for bin in node jq python3 openssl curl; do
    command -v "$bin" >/dev/null 2>&1 || { err "$bin not found in PATH"; exit 1; }
  done
  if command -v pnpm >/dev/null 2>&1; then
    PKG_MGR="pnpm"
  elif command -v npm >/dev/null 2>&1; then
    PKG_MGR="npm"
    warn "pnpm not found, falling back to npm (cloud-mail uses pnpm-lock.yaml — install times will be slower)"
  else
    err "neither pnpm nor npm found"; exit 1
  fi
  [ -d "$WORKER_DIR" ] || { err "mail-worker dir not found at $WORKER_DIR"; exit 1; }
  [ -f "$WRANGLER_TOML" ] || { err "wrangler.toml not found at $WRANGLER_TOML"; exit 1; }

  cd "$WORKER_DIR"
  if [ ! -d node_modules ]; then
    step "0/7" "Installing mail-worker dependencies (first run)..."
    $PKG_MGR install --silent 2>&1 | tail -5 || true
  fi

  if ! npx --no-install wrangler whoami >/dev/null 2>&1; then
    warn "Not logged in to Cloudflare. Launching 'wrangler login'..."
    npx wrangler login
  fi
  ACCOUNT=$(npx wrangler whoami 2>&1 | grep -oE '[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}' | head -1 || echo "<unknown>")
  ok "Cloudflare account: $ACCOUNT"
}

# --- State ---
load_state() { [ -f "$STATE_FILE" ] && source "$STATE_FILE" || true; }
save_state() {
  umask 077
  cat >"$STATE_FILE" <<EOF
# Cloud Mail Plus deploy state — do not commit (in .gitignore)
DOMAINS="${DOMAINS:-}"
ADMIN="${ADMIN:-}"
USE_CF_EMAIL="${USE_CF_EMAIL:-}"
JWT_SECRET="${JWT_SECRET:-}"
D1_NAME="${D1_NAME:-}"
D1_ID="${D1_ID:-}"
KV_NAME="${KV_NAME:-}"
KV_ID="${KV_ID:-}"
R2_BUCKET="${R2_BUCKET:-}"
WORKER_URL="${WORKER_URL:-}"
EOF
}

# --- Inputs ---
prompt_inputs() {
  step "1/7" "Reading configuration..."
  if [ -z "${DOMAINS:-}" ]; then
    echo "  Email domains for receiving (must be in your Cloudflare account)."
    echo "  Comma-separated, e.g. mail.example.com,foo.com"
    read -rp "  Domains: " DOMAINS
  fi
  [ -z "$DOMAINS" ] && { err "DOMAINS is required"; exit 1; }

  if [ -z "${ADMIN:-}" ]; then
    read -rp "  Admin email (used to register the first admin account): " ADMIN
  fi
  [[ "$ADMIN" =~ ^[^@]+@[^@]+\.[a-zA-Z]+$ ]] || { err "ADMIN must be a valid email"; exit 1; }

  if [ -z "${USE_CF_EMAIL:-}" ]; then
    read -rp "  Enable Cloudflare Email Service for outbound (recommended) [Y/n]: " ans
    if [[ "${ans:-y}" =~ ^[Yy]$ ]]; then USE_CF_EMAIL="true"; else USE_CF_EMAIL="false"; fi
  fi

  D1_NAME="${D1_NAME:-cloud-mail}"
  KV_NAME="${KV_NAME:-cloud-mail-kv}"
  R2_BUCKET="${R2_BUCKET:-cloud-mail-r2}"

  if [ -z "${JWT_SECRET:-}" ]; then
    JWT_SECRET=$(openssl rand -hex 32)
    ok "Generated JWT secret (saved to $STATE_FILE)"
  fi

  ok "Domains: $DOMAINS"
  ok "Admin:   $ADMIN"
  ok "CF Email Service: $USE_CF_EMAIL"
}

# --- Resource ensure ---
ensure_d1() {
  step "2/7" "Ensuring D1 database '$D1_NAME'..."
  if [ -n "${D1_ID:-}" ]; then
    if npx wrangler d1 list --json 2>/dev/null | jq -e --arg id "$D1_ID" '.[] | select(.uuid==$id)' >/dev/null; then
      ok "Reusing D1: $D1_ID"; return
    fi
    warn "Saved D1_ID '$D1_ID' not found in account — will look up or create"
    D1_ID=""
  fi
  D1_ID=$(npx wrangler d1 list --json 2>/dev/null | jq -r --arg n "$D1_NAME" '.[] | select(.name==$n) | .uuid' | head -1)
  if [ -n "$D1_ID" ] && [ "$D1_ID" != "null" ]; then
    ok "Found existing D1 '$D1_NAME': $D1_ID"
  else
    local out
    out=$(npx wrangler d1 create "$D1_NAME" 2>&1) || { err "$out"; exit 1; }
    D1_ID=$(echo "$out" | grep -oE 'database_id\s*=\s*"[^"]+"' | sed 's/.*"\(.*\)".*/\1/' | head -1)
    [ -z "$D1_ID" ] && D1_ID=$(echo "$out" | grep -oE '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}' | head -1)
    [ -z "$D1_ID" ] && { err "Failed to extract D1 ID from output:\n$out"; exit 1; }
    ok "Created D1: $D1_ID"
  fi
}

ensure_kv() {
  step "3/7" "Ensuring KV namespace '$KV_NAME'..."
  if [ -n "${KV_ID:-}" ]; then
    if npx wrangler kv namespace list 2>/dev/null | jq -e --arg id "$KV_ID" '.[] | select(.id==$id)' >/dev/null 2>&1; then
      ok "Reusing KV: $KV_ID"; return
    fi
    KV_ID=""
  fi
  KV_ID=$(npx wrangler kv namespace list 2>/dev/null | jq -r --arg n "$KV_NAME" '.[] | select(.title==$n) | .id' | head -1)
  if [ -n "$KV_ID" ] && [ "$KV_ID" != "null" ]; then
    ok "Found existing KV '$KV_NAME': $KV_ID"
  else
    local out
    out=$(npx wrangler kv namespace create "$KV_NAME" 2>&1) || { err "$out"; exit 1; }
    KV_ID=$(echo "$out" | grep -oE 'id\s*=\s*"[^"]+"' | sed 's/.*"\(.*\)".*/\1/' | head -1)
    [ -z "$KV_ID" ] && KV_ID=$(echo "$out" | grep -oE '"id":\s*"[^"]+"' | sed 's/.*"\(.*\)"/\1/' | head -1)
    [ -z "$KV_ID" ] && { err "Failed to extract KV ID:\n$out"; exit 1; }
    ok "Created KV: $KV_ID"
  fi
}

ensure_r2() {
  step "4/7" "Ensuring R2 bucket '$R2_BUCKET'..."
  if npx wrangler r2 bucket list 2>/dev/null | grep -qE "^\s*name:\s*$R2_BUCKET\b|\"$R2_BUCKET\""; then
    ok "Reusing R2 bucket: $R2_BUCKET"
  else
    local out
    out=$(npx wrangler r2 bucket create "$R2_BUCKET" 2>&1) || {
      if echo "$out" | grep -qiE "already exists|Conflict"; then
        ok "R2 bucket already exists: $R2_BUCKET"
      else
        err "$out"; exit 1
      fi
    }
    ok "Created R2 bucket: $R2_BUCKET"
  fi
}

# --- TOML patch (managed block — re-runs replace, never duplicate) ---
patch_toml() {
  step "5/7" "Patching wrangler.toml with bindings + vars..."
  python3 - "$WRANGLER_TOML" "$D1_NAME" "$D1_ID" "$KV_ID" "$R2_BUCKET" "$DOMAINS" "$ADMIN" "$JWT_SECRET" "$USE_CF_EMAIL" <<'PYEOF'
import re, sys, json
toml_path, d1_name, d1_id, kv_id, r2_bucket, domains_csv, admin, jwt, use_cf = sys.argv[1:10]
text = open(toml_path).read()

start = "# >>> cloud-mail-deploy >>>"
end   = "# <<< cloud-mail-deploy <<<"
text = re.sub(re.escape(start) + r".*?" + re.escape(end) + r"\n?", "", text, flags=re.S)

domains = [d.strip() for d in domains_csv.split(",") if d.strip()]
domains_toml = json.dumps(json.dumps(domains))[1:-1]  # 'json.dumps' twice → escaped string

block = [
  start,
  '[[d1_databases]]',
  'binding = "db"',
  f'database_name = "{d1_name}"',
  f'database_id = "{d1_id}"',
  '',
  '[[kv_namespaces]]',
  'binding = "kv"',
  f'id = "{kv_id}"',
  '',
  '[[r2_buckets]]',
  'binding = "r2"',
  f'bucket_name = "{r2_bucket}"',
  '',
]
if use_cf == "true":
  block += ['[[send_email]]', 'name = "EMAIL"', '']

block += [
  '[vars]',
  f"domain = '{json.dumps(domains)}'",
  f'admin = "{admin}"',
  f'jwt_secret = "{jwt}"',
  end,
  '',
]

open(toml_path, "w").write(text.rstrip() + "\n\n" + "\n".join(block))
print("patched")
PYEOF
  ok "wrangler.toml updated (managed block written)"
}

# --- Deploy ---
deploy_worker() {
  step "6/7" "Deploying Worker (auto-builds frontend via [build] hook)..."
  cd "$WORKER_DIR"
  local log
  log=$(mktemp)
  if ! npx wrangler deploy 2>&1 | tee "$log"; then
    err "wrangler deploy failed — see output above"
    rm -f "$log"; exit 1
  fi
  WORKER_URL=$(grep -oE 'https://[a-zA-Z0-9.-]+\.workers\.dev' "$log" | head -1)
  if [ -z "$WORKER_URL" ]; then
    WORKER_URL=$(grep -oE 'https://[a-zA-Z0-9.-]+\.[a-z]+/?[^[:space:]]*' "$log" | grep -v cloudflare | head -1 || true)
  fi
  rm -f "$log"
  if [ -z "$WORKER_URL" ]; then
    warn "Could not auto-detect Worker URL from deploy output"
    read -rp "  Enter Worker URL (e.g. https://cloud-mail.<your>.workers.dev): " WORKER_URL
  fi
  ok "Deployed: $WORKER_URL"
}

# --- DB init ---
init_db() {
  step "7/7" "Initializing D1 schema via /api/init..."
  local code
  code=$(curl -s -o /tmp/cm-init.out -w "%{http_code}" -X POST "$WORKER_URL/api/init/$JWT_SECRET" || echo "000")
  if [[ "$code" =~ ^2 ]]; then
    ok "Database initialized"
  elif [ "$code" = "409" ] || grep -qiE "already|exists" /tmp/cm-init.out 2>/dev/null; then
    ok "Database already initialized — skipped"
  else
    warn "Init returned HTTP $code:"
    cat /tmp/cm-init.out 2>/dev/null || true
    echo
    warn "You may need to run manually: curl -X POST \"$WORKER_URL/api/init/<jwt_secret>\""
  fi
  rm -f /tmp/cm-init.out
}

# --- Summary ---
print_summary() {
  cat <<EOF

============================================
  Cloud Mail Plus — Deployment Complete!
============================================

  Worker URL:     $WORKER_URL
  Admin email:    $ADMIN
  Domains:        $DOMAINS
  CF Email Send:  $USE_CF_EMAIL

  Resources:
    D1:    $D1_NAME ($D1_ID)
    KV:    $KV_NAME ($KV_ID)
    R2:    $R2_BUCKET

  State saved to: $STATE_FILE  (gitignored — contains JWT secret)

  Next steps:
    1. Open $WORKER_URL and register with $ADMIN
    2. Cloudflare Dashboard → Email → Email Routing
       Add catch-all rule for each domain → cloud-mail Worker
$([ "$USE_CF_EMAIL" = "true" ] && echo "    3. Cloudflare Dashboard → Email → Email Sending — onboard each domain")

  Re-deploy after code changes:
    bash scripts/deploy.sh --redeploy

  Manual D1 backup:
    curl -X POST "$WORKER_URL/api/backup/<jwt_secret>"

EOF
}

# --- Destroy ---
confirm() {
  local msg="$1"
  if [ "$ASSUME_YES" = "true" ]; then return 0; fi
  read -rp "  $msg [y/N]: " ans
  [[ "${ans:-n}" =~ ^[Yy]$ ]]
}

destroy_all() {
  echo "============================================"
  echo "  Cloud Mail Plus — Teardown (--destroy)"
  echo "============================================"
  echo
  preflight
  load_state

  echo "  Resources to be deleted:"
  echo "    Worker:  cloud-mail (in account $ACCOUNT)"
  [ -n "${D1_NAME:-}" ] && echo "    D1:      $D1_NAME ($D1_ID)" || echo "    D1:      cloud-mail (will look up)"
  [ -n "${KV_NAME:-}" ] && echo "    KV:      $KV_NAME ($KV_ID)" || echo "    KV:      cloud-mail-kv (will look up)"
  [ -n "${R2_BUCKET:-}" ] && echo "    R2:      $R2_BUCKET" || echo "    R2:      cloud-mail-r2 (will look up)"
  echo "    State:   $STATE_FILE"
  echo
  warn "This is IRREVERSIBLE. Mailbox data, attachments, and backups will be permanently deleted."
  confirm "Proceed with teardown?" || { echo "Aborted."; exit 0; }

  # 1. Delete Worker
  step "1/5" "Deleting Worker 'cloud-mail'..."
  if npx wrangler delete --name cloud-mail --force >/dev/null 2>&1; then
    ok "Worker deleted"
  else
    warn "Worker delete failed or worker did not exist"
  fi

  # 2. Empty + delete R2 bucket
  local r2="${R2_BUCKET:-cloud-mail-r2}"
  step "2/5" "Emptying + deleting R2 bucket '$r2'..."
  if npx wrangler r2 bucket list 2>/dev/null | grep -qE "$r2"; then
    confirm "  R2 bucket '$r2' may contain attachments + D1 backups — delete all objects?" || { warn "Skipping R2"; }
    # Empty via list + delete (Wrangler has no recursive empty)
    local cursor="" deleted=0
    while :; do
      local list_out
      list_out=$(npx wrangler r2 object list "$r2" ${cursor:+--cursor "$cursor"} --json 2>/dev/null || echo '{"objects":[]}')
      local keys
      keys=$(echo "$list_out" | jq -r '.objects[]?.key // empty')
      [ -z "$keys" ] && break
      while IFS= read -r key; do
        [ -z "$key" ] && continue
        npx wrangler r2 object delete "$r2/$key" >/dev/null 2>&1 && deleted=$((deleted+1)) || true
      done <<<"$keys"
      cursor=$(echo "$list_out" | jq -r '.truncated // false | if . then "next" else "" end')
      [ -z "$cursor" ] && break
      [ "$cursor" = "next" ] && cursor=$(echo "$list_out" | jq -r '.cursor // empty')
      [ -z "$cursor" ] && break
    done
    [ "$deleted" -gt 0 ] && ok "Removed $deleted objects from R2"
    if npx wrangler r2 bucket delete "$r2" >/dev/null 2>&1; then
      ok "R2 bucket deleted"
    else
      warn "R2 delete failed (bucket may not be empty — run again or delete via Dashboard)"
    fi
  else
    warn "R2 bucket '$r2' not found"
  fi

  # 3. Delete KV namespace
  step "3/5" "Deleting KV namespace..."
  local kv_id="${KV_ID:-}"
  if [ -z "$kv_id" ]; then
    kv_id=$(npx wrangler kv namespace list 2>/dev/null | jq -r --arg n "${KV_NAME:-cloud-mail-kv}" '.[] | select(.title==$n) | .id' | head -1)
  fi
  if [ -n "$kv_id" ] && [ "$kv_id" != "null" ]; then
    if npx wrangler kv namespace delete --namespace-id "$kv_id" --force >/dev/null 2>&1 \
       || echo "y" | npx wrangler kv namespace delete --namespace-id "$kv_id" >/dev/null 2>&1; then
      ok "KV namespace deleted ($kv_id)"
    else
      warn "KV delete failed — try Dashboard"
    fi
  else
    warn "KV namespace not found"
  fi

  # 4. Delete D1 database
  step "4/5" "Deleting D1 database..."
  local d1_name="${D1_NAME:-cloud-mail}"
  if npx wrangler d1 list --json 2>/dev/null | jq -e --arg n "$d1_name" '.[] | select(.name==$n)' >/dev/null; then
    if echo "y" | npx wrangler d1 delete "$d1_name" >/dev/null 2>&1; then
      ok "D1 database '$d1_name' deleted"
    else
      warn "D1 delete failed — try Dashboard or 'wrangler d1 delete $d1_name'"
    fi
  else
    warn "D1 database '$d1_name' not found"
  fi

  # 5. Clean local state + restore wrangler.toml
  step "5/5" "Cleaning local state..."
  if [ -f "$WRANGLER_TOML" ]; then
    python3 - "$WRANGLER_TOML" <<'PYEOF'
import re, sys
p = sys.argv[1]
text = open(p).read()
new = re.sub(r"# >>> cloud-mail-deploy >>>.*?# <<< cloud-mail-deploy <<<\n?", "", text, flags=re.S)
open(p, "w").write(new.rstrip() + "\n")
PYEOF
    ok "Removed managed block from wrangler.toml"
  fi
  rm -f "$STATE_FILE" && ok "Removed $STATE_FILE"

  cat <<EOF

============================================
  Teardown Complete
============================================

  Verify in Cloudflare Dashboard:
    Workers:        https://dash.cloudflare.com/?to=/:account/workers
    D1:             https://dash.cloudflare.com/?to=/:account/workers/d1
    KV:             https://dash.cloudflare.com/?to=/:account/workers/kv/namespaces
    R2:             https://dash.cloudflare.com/?to=/:account/r2

  If any resource is stuck, delete it manually from the Dashboard.

EOF
}

if [ "$DESTROY" = "true" ]; then
  destroy_all
  exit 0
fi

# --- Main ---
echo "============================================"
echo "  Cloud Mail Plus — One-Click Deploy"
echo "============================================"
echo

load_state
preflight
prompt_inputs

if [ "$REDEPLOY" = "false" ]; then
  ensure_d1
  ensure_kv
  ensure_r2
  patch_toml
  save_state
else
  step "—" "Redeploy mode: skipping resource creation, reusing existing config"
  [ -z "${D1_ID:-}" ] && { err "No saved state — run without --redeploy first"; exit 1; }
fi

deploy_worker
save_state
init_db
save_state
print_summary
