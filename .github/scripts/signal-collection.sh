#!/usr/bin/env bash
set -euo pipefail

if [[ "${HEALTHCHECKS_COLLECT_URL:-}" != https://* ]]; then
  echo 'HEALTHCHECKS_COLLECT_URL must be configured with an HTTPS check URL.' >&2
  exit 1
fi

# No verbose errors: curl diagnostics can disclose the secret check URL.
# Retry transient failures only; bound both connection and total retry time.
if ! curl --silent --fail --output /dev/null \
  --proto '=https' --tlsv1.2 \
  --connect-timeout 10 --max-time 30 \
  --retry 3 --retry-delay 5 --retry-max-time 90 \
  "$HEALTHCHECKS_COLLECT_URL" 2>/dev/null; then
  echo 'Collection succeeded, but the Healthchecks signal failed.' >&2
  exit 1
fi
