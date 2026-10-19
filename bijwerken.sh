#!/usr/bin/env bash
# Na het uploaden van een nieuwe versie: back-up maken en opnieuw bouwen. Foto's blijven bewaard.
set -euo pipefail
cd "$(dirname "$0")"
./backup.sh
D="docker"; docker info >/dev/null 2>&1 || D="sudo docker"
$D compose up -d --build
echo "Bijgewerkt."
