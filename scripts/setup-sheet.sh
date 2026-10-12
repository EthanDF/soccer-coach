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

if [ ! -f apps-script/Secret.gs ]; then
  printf "// Shared secret the app sends as ?key=… — keep out of git.\nconst SYNC_KEY = '%s';\n" "$(openssl rand -hex 12)" > apps-script/Secret.gs
  echo "✓ Made a new sync key"
fi
KEY=$(sed -n "s/.*SYNC_KEY = '\(.*\)'.*/\1/p" apps-script/Secret.gs)

if [ ! -f .clasp.json ]; then
  cp apps-script/appsscript.json /tmp/ac-manifest.json   # clasp create overwrites the manifest
  clasp create-script --type sheets --title "$TITLE" --rootDir apps-script
  cp /tmp/ac-manifest.json apps-script/appsscript.json
  echo "✓ Created the sheet \"$TITLE\" in your Google Drive"
fi

clasp push --force >/dev/null && echo "✓ Pushed the script"

DEPLOY_FILE=apps-script/.deployment-id
if [ -f "$DEPLOY_FILE" ]; then
  DEP=$(cat "$DEPLOY_FILE")
  clasp create-deployment --deploymentId "$DEP" --description "update $(date +%F)" >/dev/null
else
  DEP=$(clasp create-deployment --description "v1" | sed -n 's/^Deployed \([^ ]*\).*/\1/p')
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
