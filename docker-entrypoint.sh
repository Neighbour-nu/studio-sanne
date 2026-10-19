#!/bin/sh
# Zorg dat de datamap van de node-gebruiker is en start de server zonder root-rechten.
set -e
mkdir -p /data/fotos
chown -R node:node /data
exec setpriv --reuid=node --regid=node --init-groups node /app/server.js
