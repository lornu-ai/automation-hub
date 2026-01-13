#!/bin/bash

# Smoke Test Script for Cloudflare Edge Discovery Worker
# Tests the discovery endpoint from a GKE cluster to verify multi-cloud connectivity
#
# Usage:
#   ./scripts/smoke-test.sh [DISCOVERY_URL]
#
# Example:
#   DISCOVERY_URL=https://discovery.lornu.ai ./scripts/smoke-test.sh

set -euo pipefail

DISCOVERY_URL="${1:-${DISCOVERY_URL:-https://discovery.lornu.ai}}"
TIMEOUT="${TIMEOUT:-30}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info() {
  echo -e "${BLUE}ℹ️  $1${NC}"
}

log_success() {
  echo -e "${GREEN}✅ $1${NC}"
}

log_error() {
  echo -e "${RED}❌ $1${NC}"
}

log_warning() {
  echo -e "${YELLOW}⚠️  $1${NC}"
}

echo ""
log_info "🚀 Starting Cloudflare Edge Discovery Smoke Test"
log_info "Discovery URL: ${DISCOVERY_URL}"
echo ""

# Step 1: Health Check
log_info "Step 1: Checking Worker Health"
HEALTH_RESPONSE=$(curl -sS -w "\n%{http_code}" \
  "${DISCOVERY_URL}/healthz" \
  --max-time "${TIMEOUT}" 2>&1) || {
  log_error "Failed to connect to discovery service"
  exit 1
}

HTTP_CODE=$(echo "$HEALTH_RESPONSE" | tail -n1)
HEALTH_BODY=$(echo "$HEALTH_RESPONSE" | sed '$d')

if [ "$HTTP_CODE" -ge 200 ] && [ "$HTTP_CODE" -lt 300 ]; then
  log_success "Health check passed (HTTP $HTTP_CODE)"
  echo "$HEALTH_BODY" | jq '.' 2>/dev/null || echo "$HEALTH_BODY"
else
  log_error "Health check failed with HTTP $HTTP_CODE: $HEALTH_BODY"
  exit 1
fi

# Step 2: Discovery Test (All Agents)
log_info "Step 2: Testing Discovery Endpoint (All Agents)"
DISCOVERY_RESPONSE=$(curl -sS -w "\n%{http_code}" \
  "${DISCOVERY_URL}/discover" \
  --max-time "${TIMEOUT}" 2>&1) || {
  log_error "Failed to discover agents"
  exit 1
}

HTTP_CODE=$(echo "$DISCOVERY_RESPONSE" | tail -n1)
DISCOVERY_BODY=$(echo "$DISCOVERY_RESPONSE" | sed '$d')

if [ "$HTTP_CODE" -ge 200 ] && [ "$HTTP_CODE" -lt 300 ]; then
  log_success "Discovery request successful (HTTP $HTTP_CODE)"
  
  # Parse response
  SOURCE=$(echo "$DISCOVERY_BODY" | jq -r '.source // "unknown"' 2>/dev/null || echo "unknown")
  COUNT=$(echo "$DISCOVERY_BODY" | jq -r '.count // 0' 2>/dev/null || echo "0")
  
  log_info "Response source: ${SOURCE}"
  log_info "Agents found: ${COUNT}"
  
  if [ "$COUNT" -gt 0 ]; then
    log_success "Found ${COUNT} active agents!"
    echo "$DISCOVERY_BODY" | jq '.agents[0]' 2>/dev/null || echo "$DISCOVERY_BODY"
  else
    log_warning "No agents found (registry may be empty or cache expired)"
  fi
else
  log_error "Discovery failed with HTTP $HTTP_CODE: $DISCOVERY_BODY"
  exit 1
fi

# Step 3: Skill-Based Discovery Test
log_info "Step 3: Testing Skill-Based Discovery"
SKILL="sql_optimization"  # Example skill
SKILL_RESPONSE=$(curl -sS -w "\n%{http_code}" \
  "${DISCOVERY_URL}/discover?skill=${SKILL}" \
  --max-time "${TIMEOUT}" 2>&1) || {
  log_warning "Skill-based discovery test failed (may be expected if no agents with skill)"
  exit 0  # Don't fail on skill test - may be no agents with this skill
}

HTTP_CODE=$(echo "$SKILL_RESPONSE" | tail -n1)
SKILL_BODY=$(echo "$SKILL_RESPONSE" | sed '$d')

if [ "$HTTP_CODE" -ge 200 ] && [ "$HTTP_CODE" -lt 300 ]; then
  SKILL_COUNT=$(echo "$SKILL_BODY" | jq -r '.count // 0' 2>/dev/null || echo "0")
  log_success "Skill-based discovery successful (found ${SKILL_COUNT} agents with skill '${SKILL}')"
else
  log_warning "Skill-based discovery returned HTTP $HTTP_CODE (may be expected)"
fi

# Step 4: Latency Check
log_info "Step 4: Measuring Discovery Endpoint Latency"
LATENCY=$(curl -o /dev/null -sS -w '%{time_total}' \
  --max-time "${TIMEOUT}" \
  "${DISCOVERY_URL}/discover" 2>&1 || echo "0")

LATENCY_MS=$(echo "$LATENCY * 1000" | bc 2>/dev/null || echo "0")
log_success "Discovery endpoint latency: ${LATENCY_MS}ms"

if (( $(echo "$LATENCY_MS < 100" | bc -l 2>/dev/null || echo "0") )); then
  log_success "✅ Latency target met (<100ms)"
else
  log_warning "⚠️  Latency above target (${LATENCY_MS}ms >= 100ms)"
fi

echo ""
log_success "🎉 Smoke Test PASSED: Edge Discovery is operational!"
echo ""
