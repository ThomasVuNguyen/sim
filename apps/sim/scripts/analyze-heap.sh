#!/bin/bash
# Analyze a heap snapshot file
# Usage: ./scripts/analyze-heap.sh <path-to-heapsnapshot>

if [ -z "$1" ]; then
  echo "Usage: ./scripts/analyze-heap.sh <path-to-heapsnapshot>"
  echo "Example: ./scripts/analyze-heap.sh apps/sim/heap-1234567890.heapsnapshot"
  exit 1
fi

if [ ! -f "$1" ]; then
  echo "Error: File not found: $1"
  exit 1
fi

cd "$(dirname "$0")/.." || exit 1
bun run scripts/analyze-heap.ts "$1"

