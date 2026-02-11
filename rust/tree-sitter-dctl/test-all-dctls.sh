#!/bin/bash
# Test tree-sitter-dctl parser against ALL DCTL files recursively
#
# Usage:
#   ./test-all-dctls.sh           # Normal mode: show OK/PARTIAL for each file
#   ./test-all-dctls.sh -v        # Verbose mode: show all errors for PARTIAL files
#   ./test-all-dctls.sh -q        # Quiet mode: only show PARTIAL files and summary

cd "$(dirname "$0")"

VERBOSE=0
QUIET=0

while getopts "vq" opt; do
  case $opt in
    v) VERBOSE=1 ;;
    q) QUIET=1 ;;
  esac
done

ok=0
partial=0
declare -a partial_files=()

echo "Testing tree-sitter-dctl parser (all files)..."
echo ""

# Find all .dctl files recursively
while IFS= read -r -d '' f; do
  result=$(npx tree-sitter parse "$f" 2>&1)
  last_line=$(echo "$result" | tail -1)
  basename_f=$(basename "$f")

  if echo "$last_line" | grep -q "ERROR"; then
    echo "PARTIAL: $basename_f"
    partial=$((partial + 1))
    partial_files+=("$f")

    if [ $VERBOSE -eq 1 ]; then
      # Show all ERROR lines with context
      echo "$result" | grep -E "ERROR \[" | head -10 | sed 's/^/  /'
      echo ""
    fi
  else
    if [ $QUIET -eq 0 ]; then
      echo "OK: $basename_f"
    fi
    ok=$((ok + 1))
  fi
done < <(find ../test-dctl -name "*.dctl" -type f -print0 2>/dev/null)

total=$((ok + partial))
echo ""
echo "=== Results ==="
echo "OK (no errors): $ok"
echo "PARTIAL (has errors): $partial"
echo "Total: $total"
if [ $total -gt 0 ]; then
  echo "Clean parse rate: $((ok * 100 / total))%"
fi

# In verbose mode, show summary of all partial files
if [ $VERBOSE -eq 1 ] && [ $partial -gt 0 ]; then
  echo ""
  echo "=== PARTIAL Files ==="
  for f in "${partial_files[@]}"; do
    echo "  $f"
  done
fi
