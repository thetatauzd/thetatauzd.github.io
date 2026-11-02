#!/usr/bin/env bash
# Publish firebase-database.rules.json to the live Realtime Database, safely.
#
#   scripts/publish-rules.sh                 # publish when nothing at the top level changes
#   scripts/publish-rules.sh "site,familyTree"   # also allow changes to these top-level nodes
#
# It refuses to publish when the file would remove a live node, change or add a node you did
# not name, or drop the users/$uid guard that keeps new sign-ups from making themselves admin.
# It shows every changed rule, asks before publishing, and checks the live rules afterwards.
# Brand-new database with nothing to lose: run `firebase use <project-id>` and
# `firebase deploy --only database` directly instead.
set -euo pipefail
cd "$(dirname "$0")/.."

ALLOW="${1:-}"
FILE=firebase-database.rules.json

command -v firebase >/dev/null || { echo "Firebase CLI not found (https://firebase.google.com/docs/cli)."; exit 1; }
[ -f firebase.json ] || { echo "firebase.json is missing: publish from a branch that has it."; exit 1; }

live=$(mktemp "${TMPDIR:-/tmp}/rules-live.XXXXXX")
after=$(mktemp "${TMPDIR:-/tmp}/rules-after.XXXXXX")
trap 'rm -f "$live" "$after"' EXIT

firebase database:get "/.settings/rules" > "$live"

python3 -I - "$live" "$FILE" "$ALLOW" <<'EOF'
import json, sys
L = json.load(open(sys.argv[1]))['rules']
R = json.load(open(sys.argv[2]))['rules']
allow = {a.strip() for a in sys.argv[3].split(',') if a.strip()}

def paths(d, p=''):
    out = {}
    for k, v in d.items():
        if isinstance(v, dict):
            out.update(paths(v, p + '/' + k))
        else:
            out[p + '/' + k] = v
    return out

missing = [k for k in L if k not in R and not k.startswith('.')]
changed = [k for k in L if k in R and R[k] != L[k]]
added = sorted(k for k in R if k not in L)
bad = [k for k in changed + added if k not in allow]
guard = "newData.child('role').val() === 'pending'" in str(R.get('users', {}).get('$uid', {}).get('.validate', ''))

print('nodes:', len(R), '| missing:', missing, '| changed:', changed, '| added:', added, '| users guard:', guard)
for k in changed:
    a, b = paths(L[k], k), paths(R[k], k)
    for path in sorted(set(a) | set(b)):
        if a.get(path) != b.get(path):
            print('  ' + path)
            print('     live: ' + str(a.get(path)))
            print('     file: ' + str(b.get(path)))
if missing:
    print('STOP: the file would remove live nodes:', missing)
if bad:
    print('STOP: changes to nodes not named on the command line:', bad, '(name them as the first argument if intended)')
if not guard:
    print("STOP: users/$uid/.validate no longer forces role 'pending' on self-writes")
sys.exit(1 if (missing or bad or not guard) else 0)
EOF

read -r -p "Publish $FILE to the live database? [y/N] " ok
case "$ok" in y|Y) ;; *) echo "Not published."; exit 1 ;; esac

firebase deploy --only database

firebase database:get "/.settings/rules" > "$after"
python3 -I -c 'import json, sys
a = json.load(open(sys.argv[1])); b = json.load(open(sys.argv[2]))
print("Live rules match the file:", a == b)
sys.exit(0 if a == b else 1)' "$after" "$FILE"
