#!/usr/bin/env bash
# scripts/qa-multiuser.sh
# Walks docs/QA.md §7.1, §7.2, §7.5, §7.6 against a running backend.
# Pre-req: ALICE, BOB, ADMIN env vars hold octi_… tokens for three users.
# Pure bash + curl — no jq dependency.

set -u
API="${API_URL:-http://localhost:3005/api}"

: "${ALICE:?Set ALICE to alice's octi_… token}"
: "${BOB:?Set BOB to bob's octi_… token}"
: "${ADMIN:?Set ADMIN to your admin token}"

GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
pass=0; fail=0
ok()   { echo -e "  ${GREEN}✓${NC} $1"; pass=$((pass+1)); }
bad()  { echo -e "  ${RED}✗${NC} $1"; fail=$((fail+1)); }
step() { echo -e "${CYAN}▶ $1${NC}"; }
heading() { echo; echo -e "${YELLOW}━━ $1 ━━${NC}"; }

ah() { echo "Authorization: Bearer $1"; }

# Tiny jq replacement: pull a top-level "key": "value" string out of JSON.
# Limitation: scalar string fields only. Good enough for ids and slugs.
jget() {
  local key="$1" json="$2"
  # Match `"key": "value"` allowing whitespace + escaped quotes inside.
  local re="\"$key\"[[:space:]]*:[[:space:]]*\"([^\"\\\\]*(\\\\.[^\"\\\\]*)*)\""
  if [[ "$json" =~ $re ]]; then
    echo "${BASH_REMATCH[1]}"
  fi
}

assert_status() {
  local label="$1" want="$2" got="$3"
  if [[ "$got" == "$want" ]]; then ok "$label → $got"; else bad "$label → got $got (want $want)"; fi
}

# ── 7.1 Cross-tenant session isolation ─────────────────────────────
heading "7.1 Cross-tenant session isolation"
step "alice creates a session"
resp=$(curl -s -H "$(ah "$ALICE")" -X POST "$API/sessions" \
  -H 'content-type: application/json' \
  -d '{"channelType":"webchat","channelId":"qa-1"}')
AS=$(jget id "$resp")
echo "    alice session: $AS"
[[ "$AS" =~ ^[0-9a-f-]{36}$ ]] && ok "session id is uuid" || { bad "session id not a uuid: '$AS' (raw: $resp)"; AS=""; }

if [[ -n "$AS" ]]; then
  step "alice can read her own session"
  code=$(curl -s -o /dev/null -w "%{http_code}" -H "$(ah "$ALICE")" "$API/sessions/$AS")
  assert_status "GET /sessions/\$AS as alice" 200 "$code"

  step "bob tries to read alice's session"
  code=$(curl -s -o /dev/null -w "%{http_code}" -H "$(ah "$BOB")" "$API/sessions/$AS")
  assert_status "GET /sessions/\$AS as bob (expect collapse to 404)" 404 "$code"

  step "anonymous cannot read alice's session"
  code=$(curl -s -o /dev/null -w "%{http_code}" "$API/sessions/$AS")
  assert_status "GET /sessions/\$AS no auth" 401 "$code"
fi

# ── 7.2 API token isolation ────────────────────────────────────────
heading "7.2 API token isolation"
step "alice lists her tokens (no tokenHash leaks)"
body=$(curl -s -H "$(ah "$ALICE")" "$API/auth/api-tokens")
echo "$body" | grep -q tokenHash \
  && bad "tokenHash leaked!" \
  || ok "no tokenHash field"
echo "$body" | grep -q '"prefix"' \
  && ok "prefix field present" \
  || bad "no prefix field — response: $body"

ALICE_TOKEN_ID=$(jget id "$body")
if [[ -n "$ALICE_TOKEN_ID" ]]; then
  step "bob tries to revoke alice's token by id"
  code=$(curl -s -o /dev/null -w "%{http_code}" -X DELETE \
    -H "$(ah "$BOB")" "$API/auth/api-tokens/$ALICE_TOKEN_ID")
  assert_status "DELETE /auth/api-tokens/<alice-id> as bob" 404 "$code"

  step "alice's token still valid after attempted cross-tenant revoke"
  code=$(curl -s -o /dev/null -w "%{http_code}" -H "$(ah "$ALICE")" "$API/auth/api-tokens")
  assert_status "GET /auth/api-tokens as alice (post-attack)" 200 "$code"
else
  bad "could not capture alice token id (skip cross-tenant revoke)"
fi

# ── 7.5 Quotas ─────────────────────────────────────────────────────
heading "7.5 Quotas"
step "admin lists quotas (admin-only)"
code=$(curl -s -o /dev/null -w "%{http_code}" -H "$(ah "$ADMIN")" "$API/admin/quotas")
assert_status "GET /admin/quotas as admin" 200 "$code"

step "alice cannot list quotas"
code=$(curl -s -o /dev/null -w "%{http_code}" -H "$(ah "$ALICE")" "$API/admin/quotas")
assert_status "GET /admin/quotas as alice" 403 "$code"

# ── 7.6 Workspace isolation ────────────────────────────────────────
heading "7.6 Workspace isolation"
step "alice creates a workspace"
ts=$(date +%s)
slug="qa-alice-ws-$ts"
resp=$(curl -s -H "$(ah "$ALICE")" -X POST "$API/me/workspaces" \
  -H 'content-type: application/json' \
  -d "{\"slug\":\"$slug\",\"name\":\"QA alice ws\"}")
WS=$(jget id "$resp")
if [[ -n "$WS" ]]; then
  ok "workspace created: $WS ($slug)"
else
  bad "could not create workspace — response: $resp"
fi

if [[ -n "$WS" ]]; then
  step "alice lists workspaces (sees the new one)"
  list_a=$(curl -s -H "$(ah "$ALICE")" "$API/me/workspaces")
  echo "$list_a" | grep -q "\"$slug\"" && ok "alice sees $slug" || bad "alice missing $slug — response: $list_a"

  step "bob lists workspaces (does NOT see alice's)"
  list_b=$(curl -s -H "$(ah "$BOB")" "$API/me/workspaces")
  echo "$list_b" | grep -q "\"$slug\"" && bad "bob can see alice's ws — leak!" || ok "bob does not see alice's ws"
fi

# ── Summary ────────────────────────────────────────────────────────
echo
if [[ "$fail" -eq 0 ]]; then
  echo -e "${GREEN}all $pass checks passed${NC}"
  exit 0
else
  echo -e "${RED}$fail failed, $pass passed${NC}"
  exit 1
fi
