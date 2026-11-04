#!/bin/bash
# Starts everything the tests talk to, all on this test machine only:
#   fake eBay API (8788), fake eBay sold pages (8790), private test Scan service (8787), bad-network switch (8789, control 8791)
# Needs TEST_APP_KEY (a random throwaway key). Refuses to run if any real Cloudflare key is present.
set -euo pipefail
test -z "${CLOUDFLARE_API_TOKEN:-}${CLOUDFLARE_ACCOUNT_ID:-}${EBAY_ID:-}${EBAY_SECRET:-}" || { echo "REFUSED: real keys present"; exit 1; }
nohup node tests/e2e/fake-ebay.mjs > fake-ebay.out 2>&1 &
nohup node tests/e2e/chaos-proxy.mjs > chaos.out 2>&1 &
node tests/e2e/make-test-service.mjs
npm i -g wrangler@3 >/dev/null 2>&1
(cd .test-service && WRANGLER_SEND_METRICS=false nohup wrangler dev --local --test-scheduled --port 8787 --ip 127.0.0.1 --persist-to ./state > ../service.out 2>&1 &)
for i in $(seq 1 60); do curl -s -o /dev/null http://127.0.0.1:8787/ && break; sleep 2; done
curl -s -o /dev/null -w "test Scan service answering (HTTP %{http_code})\n" http://127.0.0.1:8787/
curl -sf http://127.0.0.1:8791/stats >/dev/null && echo "bad-network switch ready"
curl -sf "http://127.0.0.1:8790/sch/i.html" >/dev/null && echo "fake sold pages ready"
