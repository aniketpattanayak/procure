#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Creates the "Jeevaka" tenant in procure via the platform API.
# Run this while `pnpm dev` is running (API on port 4000).
# Usage:  bash create-jeevaka.sh
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

API="http://localhost:4000/api/v1"
TODAY=$(date +%F)
RENEWAL=$(date -v +1y +%F 2>/dev/null || date -d '+1 year' +%F)

echo ""
echo "╔══════════════════════════════════════════════════════╗"
echo "║   Jeevaka Tenant Setup — procure                    ║"
echo "╚══════════════════════════════════════════════════════╝"
echo ""

echo "➤  Step 1 / 3 : Logging in as platform owner …"
LOGIN=$(curl -s -X POST "$API/platform/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"email":"owner@procure.local","password":"Owner@12345"}')
TOKEN=$(echo "$LOGIN" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['token'])" 2>/dev/null || true)
if [ -z "$TOKEN" ]; then
  echo "❌  Login failed. Make sure 'pnpm dev' is running."
  echo "    Response: $LOGIN"
  exit 1
fi
echo "   ✓  Got platform token."

echo "➤  Step 2 / 3 : Finding a plan …"
PLANS=$(curl -s "$API/platform/catalog" -H "Authorization: Bearer $TOKEN")
PLAN_ID=$(echo "$PLANS" | python3 -c "
import sys,json
data=json.load(sys.stdin)
items=data if isinstance(data,list) else data.get('plans',data.get('data',{}).get('rows',[]))
starter=[p for p in items if p.get('code')=='starter']
print((starter or items)[0]['id'])
" 2>/dev/null || true)
if [ -z "$PLAN_ID" ]; then
  echo "❌  No plans found — run 'pnpm db:seed' first."; exit 1
fi
echo "   ✓  Plan: $PLAN_ID"

echo "➤  Step 3 / 3 : Creating Jeevaka tenant …"
BODY=$(python3 - <<PY
import json
print(json.dumps({
  "code":"jeevaka","name":"Jeevaka","legalName":"Jeevaka ERP Pvt Ltd",
  "timezone":"Asia/Kolkata","currency":"INR","fyStartMonth":4,
  "taxIds":{},"address":{"country":"IN"},
  "planId":"$PLAN_ID",
  "subscription":{"status":"active","startDate":"$TODAY","renewalDate":"$RENEWAL"},
  "admin":{"name":"Jeevaka Admin","email":"admin@jeevaka.local"}
}))
PY
)

RESULT=$(curl -s -X POST "$API/platform/tenants" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "$BODY")

TEMP_PW=$(echo "$RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('temporaryPassword',''))" 2>/dev/null || true)

if [ -z "$TEMP_PW" ]; then
  MSG=$(echo "$RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('message',str(d)))" 2>/dev/null || echo "$RESULT")
  if echo "$MSG" | grep -qi "already\|duplicate\|exist"; then
    echo "   ℹ  Tenant 'jeevaka' already exists."
    TEMP_PW="(already set — use the password you set before)"
  else
    echo "❌  Failed: $MSG"; exit 1
  fi
fi

echo ""
echo "═══════════════════════════════════════════════════════"
echo "  ✅  Jeevaka is ready!"
echo "═══════════════════════════════════════════════════════"
echo ""
echo "  URL      :  http://localhost:3000"
echo "  Company  :  jeevaka"
echo "  Email    :  admin@jeevaka.local"
echo "  Password :  $TEMP_PW"
echo ""
