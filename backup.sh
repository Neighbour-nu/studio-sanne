#!/usr/bin/env bash
# Maakt een back-up van alle foto's en teksten van Studio Sanne in de map backups/.
# Bewaart de laatste 10 back-ups.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p backups
BESTAND="backups/studio-sanne-$(date +%Y-%m-%d_%H%M).tar.gz"
tar czf "$BESTAND" data .env
chmod 600 "$BESTAND"
ls -1t backups/studio-sanne-*.tar.gz | tail -n +11 | xargs -r rm --
echo "Back-up gemaakt: $BESTAND ($(du -h "$BESTAND" | cut -f1))"
