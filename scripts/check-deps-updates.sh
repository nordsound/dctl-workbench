#!/bin/bash
# Check for updates to external dependencies
# Compares current versions against latest releases

set -e

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
NC='\033[0m'

# Dependencies with their repositories and current pinned versions
# Format: "name|owner/repo|current_tag"
DEPS=(
    "openexr|AcademySoftwareFoundation/openexr|v3.4.4"
    "Imath|AcademySoftwareFoundation/Imath|v3.2.2"
    "libdeflate|ebiggers/libdeflate|"
    "OpenColorIO|AcademySoftwareFoundation/OpenColorIO|v2.5.1"
    "zlib|madler/zlib|v1.3.1"
    "expat|libexpat/libexpat|R_2_7_4"
    "yaml-cpp|jbeder/yaml-cpp|yaml-cpp-0.9.0"
    "pystring|imageworks/pystring|v1.1.4"
    "minizip-ng|zlib-ng/minizip-ng|4.1.0"
)

check_update() {
    local name=$1
    local repo=$2
    local current_tag=$3

    # Get latest release tag using gh CLI
    local latest_tag
    latest_tag=$(gh release view --repo "$repo" --json tagName -q '.tagName' 2>/dev/null || echo "")

    # If no release found, try latest tag
    if [ -z "$latest_tag" ]; then
        latest_tag=$(gh api "repos/$repo/tags" --jq '.[0].name' 2>/dev/null || echo "")
    fi

    if [ -z "$latest_tag" ]; then
        echo -e "$name: ${YELLOW}Could not fetch latest version${NC}"
        return
    fi

    if [ -z "$current_tag" ]; then
        echo -e "$name: ${YELLOW}No pinned version${NC} (latest: $latest_tag)"
    elif [ "$current_tag" = "$latest_tag" ]; then
        echo -e "$name: ${GREEN}Up to date${NC} ($current_tag)"
    else
        echo -e "$name: ${RED}Update available${NC} ($current_tag -> $latest_tag)"
    fi
}

# Check if gh is available
if ! command -v gh &> /dev/null; then
    echo "Error: gh CLI is required. Install it with: brew install gh"
    exit 1
fi

echo "=== Checking for dependency updates ==="
echo ""

for dep in "${DEPS[@]}"; do
    IFS='|' read -r name repo current_tag <<< "$dep"
    check_update "$name" "$repo" "$current_tag"
done

echo ""
echo "=== Check complete ==="
