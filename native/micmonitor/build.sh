#!/bin/zsh
# Build the micmonitor helper into resources/bin/
set -euo pipefail
cd "$(dirname "$0")"
swiftc -O -framework CoreAudio -framework Foundation main.swift -o ../../resources/bin/micmonitor
codesign -s - -f ../../resources/bin/micmonitor
echo "built resources/bin/micmonitor"
