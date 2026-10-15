#!/usr/bin/env bash
# One command to set up (or re-link) the Google Sheet that Assistant Coach syncs to.
#  - creates apps-script/Secret.gs with a random key (first run only)
#  - creates a new Google Sheet + bound script via clasp (first run only)
#  - pushes the script and deploys/updates the web app
#  - prints a one-tap connect link to open on your phone
# Requires: clasp (npm i -g @google/clasp) logged in with `clasp login`.
set -euo pipefail
cd "$(dirname "$0")/.."
APP_URL="${APP_URL:-https://ethandf.github.io/soccer-coach/}"
TITLE="${TITLE:-Assistant Coach Season Log}"

command -v clasp >/dev/null || { echo "Install clasp first: npm i -g @google/clasp && clasp login"; exit 1; }

# clasp can exit 0 even when Google rejects the call, so check what it printed.
run_clasp() {
  local out code=0
  out=$(clasp "$@" 2>&1) || code=$?
  if [ $code -ne 0 ] || grep -qiE 'invalid_grant|"error"|^error' <<<"$out"; then
    echo "$out" >&2
    if grep -q invalid_grant <<<"$out"; then echo "✗ clasp's Google login expired. Run  clasp login  and then re-run this script." >&2
    else echo "✗ clasp $1 failed." >&2; fi
    exit 1
  fi
  printf '%s\n' "$out"
}

if [ ! -f apps-script/Secret.gs ]; then
  printf "// Shared secret the app sends as ?key=… — keep out of git.\nconst SYNC_KEY = '%s';\n" "$(openssl rand -hex 12)" > apps-script/Secret.gs
  echo "✓ Made a new sync key"
fi
KEY=$(sed -n "s/.*SYNC_KEY = '\(.*\)'.*/\1/p" apps-script/Secret.gs)

if [ ! -f .clasp.json ]; then
  cp apps-script/appsscript.json /tmp/ac-manifest.json   # clasp create overwrites the manifest
  run_clasp create-script --type sheets --title "$TITLE" --rootDir apps-script
  cp /tmp/ac-manifest.json apps-script/appsscript.json
  echo "✓ Created the sheet \"$TITLE\" in your Google Drive"
fi

run_clasp push --force >/dev/null && echo "✓ Pushed the script"

DEPLOY_FILE=apps-script/.deployment-id
if [ -f "$DEPLOY_FILE" ]; then
  DEP=$(cat "$DEPLOY_FILE")
  run_clasp create-deployment --deploymentId "$DEP" --description "update $(date +%F)" >/dev/null
else
  DEP=$(run_clasp create-deployment --description "v1" | sed -n 's/^Deployed \([^ ]*\).*/\1/p')
  echo "$DEP" > "$DEPLOY_FILE"
fi
echo "✓ Web app deployed"

EXEC="https://script.google.com/macros/s/$DEP/exec?key=$KEY"
ENC=$(python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1],safe=""))' "$EXEC")
LINK="${APP_URL}#sync=${ENC}"

if curl -fsL "$EXEC" | grep -q '"ok":true'; then
  echo "✓ Sheet is answering"
else
  echo
  echo "⚠ One-time step: authorize the script. Run  clasp open-script , choose \"setup\", click Run, approve."
  echo "  (Then re-run this script to confirm.)"
fi

echo
echo "Open this on your phone (text/AirDrop it to yourself) to connect the app:"
echo "  $LINK"
if command -v qrencode >/dev/null; then echo; qrencode -t ansiutf8 "$LINK"; fi
