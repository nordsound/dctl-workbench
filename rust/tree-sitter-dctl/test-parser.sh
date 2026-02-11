#!/bin/bash
# Test tree-sitter-dctl parser against multiple DCTL files

cd "$(dirname "$0")"

ok=0
partial=0
failed=0

echo "Testing tree-sitter-dctl parser..."
echo ""

for dir in ../test-dctl/photographic-dctls ../test-dctl/utility-dctls/* ../test-dctl/github-dctls/*; do
  if [ -d "$dir" ]; then
    for f in "$dir"/*.dctl; do
      if [ -f "$f" ]; then
        result=$(npx tree-sitter parse "$f" 2>&1 | tail -1)
        basename_f=$(basename "$f")
        if echo "$result" | grep -q "ERROR"; then
          echo "PARTIAL: $basename_f"
          partial=$((partial + 1))
        else
          echo "OK: $basename_f"
          ok=$((ok + 1))
        fi
      fi
    done
  fi
done

total=$((ok + partial))
echo ""
echo "=== Results ==="
echo "OK (no errors): $ok"
echo "PARTIAL (has errors): $partial"
echo "Total: $total"
if [ $total -gt 0 ]; then
  echo "Clean parse rate: $((ok * 100 / total))%"
fi
