#!/usr/bin/env bash
# Bootstrap Paperclip and import this company package into it.
# Run this on the machine that will host Paperclip long-term (this repo's
# CI/dev container is not a persistent host).
set -euo pipefail

cd "$(dirname "$0")/.."

if ! command -v claude >/dev/null 2>&1; then
  echo "error: 'claude' CLI not found. Install Claude Code, then run 'claude login' with your Max plan account." >&2
  exit 1
fi

if ! claude auth status >/dev/null 2>&1; then
  echo "error: Claude Code isn't logged in. Run 'claude login' with your Max plan account, then re-run this script." >&2
  exit 1
fi

echo "==> Onboarding Paperclip (creates local config + embedded database if this is the first run)"
npx paperclipai onboard --yes

echo "==> Importing this company package into Paperclip"
npx paperclipai company import . --target new --yes

cat <<'EOF'

Done. Open the Paperclip dashboard (default http://localhost:3100).

Imported agents land with heartbeats disabled by default — review the org
chart and task queue, then enable heartbeats from the dashboard once
you're ready for agents to start working.

To pick up config changes after editing files in this repo, re-run:
  npx paperclipai company import . --target existing --company-id <id>
(see README.md for --collision options)
EOF
