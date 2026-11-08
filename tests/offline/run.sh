#!/bin/sh
# Offline checks for the Apps Script backend: every .gs file runs in Node against fakes of Sheets,
# Drive, Composio/Xero, Gemini and MailApp (nothing real is called). Prints PASS/FAIL per check.
#   tests/offline/run.sh            # all checks, summary and failures
#   tests/offline/run.sh --all      # every PASS line too
set -e
DIR=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$DIR/build"
python3 "$DIR/gen.py" "$DIR" >/dev/null
OUT="$DIR/build/last-run.txt"
node "$DIR/build/harness.js" "$DIR/../../apps-script" > "$OUT" 2>&1 || true
if [ "$1" = "--all" ]; then grep -E "^(=== |PASS|FAIL)" "$OUT"; else grep -E "^(=== PO Desk|FAIL)|Error" "$OUT"; fi
ok=0
grep -q "offline (Stages 5-10): 0 failure" "$OUT" || ok=1
node "$DIR/coding.js" "$DIR/../../apps-script" || ok=1
node "$DIR/categories.js" "$DIR/../../apps-script" || ok=1
exit $ok
