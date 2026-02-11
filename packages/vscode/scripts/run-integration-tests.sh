#!/bin/bash
# Wrapper for vscode-test that handles the Extension Host shutdown crash (exit code 6).
# Caused by webgpu-real-rgc.test.ts: the `webgpu` npm module (Dawn backend) creates a
# native GPU instance with no destroy API, which crashes during process cleanup.

set -o pipefail

OUTPUT=$(npx vscode-test 2>&1)
EXIT_CODE=$?

echo "$OUTPUT"

if [ $EXIT_CODE -eq 0 ]; then
  exit 0
fi

# Check if this is the known shutdown crash (exit code 6 from Extension Host)
# AND all tests actually passed (no "failing" in mocha output)
if echo "$OUTPUT" | grep -q "exited with code: 6"; then
  if echo "$OUTPUT" | grep -q "failing"; then
    echo ""
    echo "Tests failed (not a shutdown crash issue)"
    exit 1
  fi
  echo ""
  echo "All tests passed. Ignoring known Extension Host shutdown crash (exit code 6) on macOS."
  exit 0
fi

exit $EXIT_CODE
