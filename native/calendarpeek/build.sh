#!/bin/zsh
# Build the calendarpeek helper into resources/bin/
# The Info.plist is embedded as a __TEXT,__info_plist section — a bare CLI
# binary needs the NSCalendars usage strings in its own image for the TCC
# permission prompt to work.
set -euo pipefail
cd "$(dirname "$0")"
swiftc -O -framework EventKit -framework Foundation main.swift -o ../../resources/bin/calendarpeek \
  -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker Info.plist
codesign -s - -f ../../resources/bin/calendarpeek
echo "built resources/bin/calendarpeek"
