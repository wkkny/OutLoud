#!/usr/bin/env bash
# Fast checks run by the agent stop gate. The full suite is `bun run check`.
set -euo pipefail
cd "$(dirname "$0")/.."
bun run lint
bun run test
