#!/bin/bash
# Stops the private test Scan service and starts it again (its throwaway database stays on disk), to check a restart
# loses nothing. Test machine only.
set -uo pipefail
pkill -f "wrangler dev" ; pkill -f workerd ; sleep 3
(cd .test-service && WRANGLER_SEND_METRICS=false nohup wrangler dev --local --test-scheduled --port 8787 --ip 127.0.0.1 --persist-to ./state >> ../service.out 2>&1 &)
for i in $(seq 1 60); do curl -s -o /dev/null http://127.0.0.1:8787/ && break; sleep 2; done
curl -s -o /dev/null -w "test Scan service answering again (HTTP %{http_code})\n" http://127.0.0.1:8787/
