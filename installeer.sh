#!/usr/bin/env bash
# =====================================================================
#  Studio Sanne: installeren of bijwerken op de server
#  Gebruik:  cd ~/studio-sanne && ./installeer.sh
#  Je kunt dit script veilig vaker draaien (bijvoorbeeld na een update).
# =====================================================================
set -euo pipefail
cd "$(dirname "$0")"

DOMEIN="studiosanne.online"
roze=$'\e[35m'; groen=$'\e[32m'; geel=$'\e[33m'; rood=$'\e[31m'; vet=$'\e[1m'; uit=$'\e[0m'
stap()   { echo; echo "${roze}${vet}==> $*${uit}"; }
ok()     { echo "${groen}✔ $*${uit}"; }
let_op() { echo "${geel}! $*${uit}"; }
fout()   { echo "${rood}✘ $*${uit}"; exit 1; }

SUDO=""; [ "$(id -u)" -ne 0 ] && SUDO="sudo"
command -v docker >/dev/null || fout "Docker is niet gevonden op deze server."
DOCKER="docker"; docker info >/dev/null 2>&1 || DOCKER="$SUDO docker"
poort_bezet() { $SUDO ss -ltnH 2>/dev/null | awk '{print $4}' | grep -Eq "[:.]$1\$"; }

# ---------------------------------------------------------------------
stap "1. Controle"
$DOCKER compose version >/dev/null 2>&1 || fout "'docker compose' werkt niet. Installeer de Docker Compose-plugin."
ok "Docker en Docker Compose zijn aanwezig."

# ---------------------------------------------------------------------
stap "2. Instellingen (.env)"
touch .env; chmod 600 .env
zet_env() { # zet_env NAAM WAARDE
  grep -v "^$1=" .env > .env.tmp || true
  printf "%s='%s'\n" "$1" "$2" >> .env.tmp
  mv .env.tmp .env; chmod 600 .env
}
if grep -q '^ADMIN_PASSWORD=' .env; then
  ok "Er is al een wachtwoord ingesteld. Dat blijft zo."
  echo "   (Veranderen? Haal de regel ADMIN_PASSWORD uit .env weg en draai dit script opnieuw.)"
else
  while true; do
    read -r -s -p "   Kies een wachtwoord voor Sanne (minimaal 8 tekens): " PW1; echo
    read -r -s -p "   Typ het nog een keer: " PW2; echo
    [ "$PW1" != "$PW2" ] && { let_op "De twee wachtwoorden zijn niet gelijk."; continue; }
    [ ${#PW1} -lt 8 ]     && { let_op "Te kort, minimaal 8 tekens."; continue; }
    case "$PW1" in *\'*) let_op "Gebruik geen apostrof (') in het wachtwoord."; continue;; esac
    break
  done
  zet_env ADMIN_PASSWORD "$PW1"
  ok "Wachtwoord opgeslagen in .env (alleen leesbaar voor jou)."
fi

# Vrije lokale poort kiezen (alleen bereikbaar vanaf de server zelf).
POORT=$(grep '^STUDIO_POORT=' .env | cut -d"'" -f2 || true)
if [ -z "$POORT" ]; then
  for p in $(seq 8090 8120); do poort_bezet "$p" || { POORT=$p; break; }; done
  [ -n "$POORT" ] || fout "Geen vrije poort gevonden tussen 8090 en 8120."
  zet_env STUDIO_POORT "$POORT"
fi
ok "Studio Sanne gebruikt intern poort ${POORT}."
mkdir -p data backups

# ---------------------------------------------------------------------
stap "3. Welke webserver regelt HTTPS op deze server?"
PROXY_NAAM=""; PROXY_IMAGE=""; PROXY_NET=""; PROXY_HOSTNET=0; SOORT=""
while read -r naam image poorten; do
  if echo "$poorten" | grep -q ':443->'; then PROXY_NAAM="$naam"; PROXY_IMAGE="$image"; break; fi
done < <($DOCKER ps --format '{{.Names}} {{.Image}} {{.Ports}}')
if [ -z "$PROXY_NAAM" ]; then  # proxy-container met network_mode: host?
  while read -r naam image mode; do
    if [ "$mode" = "host" ] && echo "$image" | grep -Eqi 'caddy|traefik|nginx'; then
      PROXY_NAAM="$naam"; PROXY_IMAGE="$image"; PROXY_HOSTNET=1; break
    fi
  done < <($DOCKER ps --format '{{.Names}} {{.Image}}' | while read -r n i; do echo "$n $i $($DOCKER inspect -f '{{.HostConfig.NetworkMode}}' "$n")"; done)
fi

if [ -n "$PROXY_NAAM" ]; then
  case "$PROXY_IMAGE" in
    *nginx-proxy-manager*) SOORT="npm" ;;
    *caddy*)               SOORT="caddy" ;;
    *traefik*)             SOORT="traefik" ;;
    *)                     SOORT="anders" ;;
  esac
  if [ "$PROXY_HOSTNET" = 0 ]; then
    for n in $($DOCKER inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$PROXY_NAAM"); do
      if [ "$n" != "bridge" ] && [ "$n" != "host" ]; then PROXY_NET="$n"; break; fi
    done
  fi
  ok "Gevonden: container '${PROXY_NAAM}' (${PROXY_IMAGE})."
else
  if   systemctl is-active --quiet nginx 2>/dev/null;   then SOORT="nginx-host"
  elif systemctl is-active --quiet caddy 2>/dev/null;   then SOORT="caddy-host"
  elif poort_bezet 443;                                  then SOORT="anders"
  else SOORT="geen"; fi
  ok "Soort webserver: ${SOORT}"
fi

# Adres waarop de proxy Studio Sanne bereikt
if [ -n "$PROXY_NET" ]; then
  UPSTREAM="studio-sanne:3000"
  ok "Studio Sanne komt in hetzelfde Docker-netwerk als de proxy: ${PROXY_NET}"
else
  UPSTREAM="127.0.0.1:${POORT}"
fi

# docker-compose.override.yml opbouwen
schrijf_override() { # $1 = extra labels (mag leeg)
  {
    echo "# Automatisch gemaakt door installeer.sh. Niet met de hand aanpassen, draai liever het script opnieuw."
    echo "services:"
    echo "  studio-sanne:"
    if [ -n "$PROXY_NET" ]; then echo "    networks: [default, proxy]"; fi
    if [ -n "${1:-}" ]; then printf '%s\n' "$1"; fi
    if [ -n "$PROXY_NET" ]; then
      echo "networks:"
      echo "  proxy:"
      echo "    name: ${PROXY_NET}"
      echo "    external: true"
    fi
  } > docker-compose.override.yml
}
LABELS=""
if [ "$SOORT" = "traefik" ]; then
  ARGS=$($DOCKER inspect -f '{{join .Args " "}} {{join .Config.Cmd " "}}' "$PROXY_NAAM" 2>/dev/null || true)
  EP=$(echo "$ARGS" | grep -oE 'entrypoints\.[A-Za-z0-9_-]+\.address=:443' | head -1 | cut -d. -f2 || true)
  CR=$(echo "$ARGS" | grep -oE 'certificatesresolvers\.[A-Za-z0-9_-]+\.' | head -1 | cut -d. -f2 || true)
  EP=${EP:-websecure}; CR=${CR:-letsencrypt}
  LABELS="    labels:
      - traefik.enable=true
      - traefik.docker.network=${PROXY_NET}
      - traefik.http.routers.studiosanne.rule=Host(\`${DOMEIN}\`) || Host(\`www.${DOMEIN}\`)
      - traefik.http.routers.studiosanne.entrypoints=${EP}
      - traefik.http.routers.studiosanne.tls.certresolver=${CR}
      - traefik.http.services.studiosanne.loadbalancer.server.port=3000"
fi
schrijf_override "$LABELS"

# ---------------------------------------------------------------------
stap "4. Studio Sanne bouwen en starten (de eerste keer duurt dit een paar minuten)"
$DOCKER compose up -d --build
echo -n "   Wachten tot de site reageert"
GESTART=0
for i in $(seq 1 40); do
  if curl -fsS "http://127.0.0.1:${POORT}/healthz" >/dev/null 2>&1; then GESTART=1; break; fi
  echo -n "."; sleep 2
done
echo
[ "$GESTART" = 1 ] || { $DOCKER compose logs --tail=40; fout "De site start niet. Zie de meldingen hierboven."; }
ok "De site draait."

# ---------------------------------------------------------------------
stap "5. Het domein ${DOMEIN} koppelen"
case "$SOORT" in
  caddy)
    BLOK=$(printf '%s, www.%s {\n\tencode zstd gzip\n\treverse_proxy %s\n}' "$DOMEIN" "$DOMEIN" "$UPSTREAM")
    CF_BIN="/etc/caddy/Caddyfile"
    CF=$($DOCKER inspect -f '{{range .Mounts}}{{if eq .Destination "/etc/caddy/Caddyfile"}}{{.Source}}{{end}}{{end}}' "$PROXY_NAAM")
    if [ -z "$CF" ]; then
      D=$($DOCKER inspect -f '{{range .Mounts}}{{if eq .Destination "/etc/caddy"}}{{.Source}}{{end}}{{end}}' "$PROXY_NAAM")
      [ -n "$D" ] && CF="$D/Caddyfile"
    fi
    if [ -z "$PROXY_NET" ] && [ "$PROXY_HOSTNET" = 0 ]; then
      let_op "Caddy zit niet in een eigen Docker-netwerk; automatisch koppelen gaat niet. Vraag hulp (zie handleiding)."
    elif [ -n "$CF" ] && $SUDO test -f "$CF"; then
      if $SUDO grep -q "$DOMEIN" "$CF"; then
        ok "${DOMEIN} staat al in ${CF}."
      else
        echo "   Caddyfile gevonden: ${CF}"
        echo "   Dit blok komt onderaan te staan:"; echo; echo "$BLOK" | sed 's/^/      /'; echo
        read -r -p "   Toevoegen en Caddy herladen? (j/n) " JA
        if [ "$JA" = "j" ] || [ "$JA" = "J" ]; then
          KOPIE="${CF}.voor-studio-sanne.$(date +%Y%m%d%H%M%S)"
          $SUDO cp "$CF" "$KOPIE"
          printf '\n# Studio Sanne\n%s\n' "$BLOK" | $SUDO tee -a "$CF" >/dev/null
          if $DOCKER exec "$PROXY_NAAM" caddy validate --config "$CF_BIN" --adapter caddyfile >/dev/null 2>&1 \
             && $DOCKER exec "$PROXY_NAAM" caddy reload --config "$CF_BIN" --adapter caddyfile; then
            ok "Caddy is herladen. HTTPS wordt automatisch geregeld."
            echo "   (Reservekopie van de oude Caddyfile: ${KOPIE})"
          else
            $SUDO cp "$KOPIE" "$CF"
            $DOCKER exec "$PROXY_NAAM" caddy reload --config "$CF_BIN" --adapter caddyfile >/dev/null 2>&1 || true
            fout "Caddy accepteerde de nieuwe instelling niet. De oude Caddyfile is teruggezet; de cockpit werkt gewoon door."
          fi
        else
          let_op "Niet toegevoegd. Plak het blok zelf in ${CF} en herlaad Caddy."
        fi
      fi
    else
      let_op "Ik kon de Caddyfile niet vinden. Voeg dit blok zelf toe en herlaad Caddy:"; echo; echo "$BLOK"
    fi
    ;;
  npm)
    let_op "Je gebruikt Nginx Proxy Manager. Doe dit in de webinterface (meestal http://<server-ip>:81):"
    cat <<EOF
     1. Hosts > Proxy Hosts > Add Proxy Host
     2. Domain Names: ${DOMEIN} en www.${DOMEIN}
     3. Scheme: http   Forward Hostname/IP: ${UPSTREAM%%:*}   Forward Port: ${UPSTREAM##*:}
     4. Zet 'Block Common Exploits' aan.
     5. Tab SSL: 'Request a new SSL Certificate', 'Force SSL' en 'HTTP/2 Support' aan.
     6. Tab Advanced, plak deze regel (anders lukt het uploaden van grote foto's niet):
            client_max_body_size 40m;
     7. Save.
EOF
    ;;
  traefik)
    ok "Traefik-labels gezet (entrypoint '${EP}', certresolver '${CR}'). Traefik pakt dit vanzelf op."
    let_op "Kloppen die twee namen niet met jouw Traefik? Pas ze aan in docker-compose.override.yml en draai: docker compose up -d"
    ;;
  nginx-host)
    CONF="/etc/nginx/sites-available/${DOMEIN}"
    if [ ! -f "$CONF" ]; then
      $SUDO tee "$CONF" >/dev/null <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name ${DOMEIN} www.${DOMEIN};
    client_max_body_size 40m;
    location / {
        proxy_pass http://127.0.0.1:${POORT};
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
EOF
      $SUDO ln -sf "$CONF" "/etc/nginx/sites-enabled/${DOMEIN}"
      $SUDO nginx -t && $SUDO systemctl reload nginx
      ok "Nginx-configuratie gemaakt: ${CONF}"
    fi
    if command -v certbot >/dev/null; then
      $SUDO certbot --nginx -d "$DOMEIN" -d "www.${DOMEIN}" --redirect \
        || let_op "Certbot lukte niet. Staat de DNS al goed? Probeer later: sudo certbot --nginx -d ${DOMEIN} -d www.${DOMEIN}"
    else
      let_op "Voor HTTPS: sudo apt install certbot python3-certbot-nginx  en daarna  sudo certbot --nginx -d ${DOMEIN} -d www.${DOMEIN}"
    fi
    ;;
  caddy-host)
    let_op "Caddy draait direct op de server. Voeg dit toe aan /etc/caddy/Caddyfile en draai: sudo systemctl reload caddy"
    printf '\n%s, www.%s {\n\tencode zstd gzip\n\treverse_proxy 127.0.0.1:%s\n}\n' "$DOMEIN" "$DOMEIN" "$POORT"
    ;;
  geen)
    let_op "Er draait nog niets op poort 443. Ik kan Caddy laten meestarten; dat regelt HTTPS automatisch."
    read -r -p "   Caddy voor Studio Sanne starten? (j/n) " JA
    if [ "$JA" = "j" ] || [ "$JA" = "J" ]; then
      printf '%s, www.%s {\n\tencode zstd gzip\n\treverse_proxy studio-sanne:3000\n}\n' "$DOMEIN" "$DOMEIN" > Caddyfile
      cat > docker-compose.override.yml <<'EOF'
# Automatisch gemaakt door installeer.sh: eigen Caddy voor HTTPS.
services:
  caddy:
    image: caddy:2
    container_name: studio-sanne-caddy
    restart: unless-stopped
    ports: ["80:80", "443:443"]
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - ./caddy-data:/data
    depends_on: [studio-sanne]
EOF
      $DOCKER compose up -d
      ok "Caddy gestart."
    fi
    ;;
  *)
    let_op "Ik herken de webserver niet automatisch (${PROXY_IMAGE:-$SOORT})."
    echo "   Laat die webserver ${DOMEIN} en www.${DOMEIN} doorsturen naar http://${UPSTREAM}"
    echo "   en sta uploads tot 40 MB toe."
    ;;
esac

# ---------------------------------------------------------------------
stap "Klaar"
IP=$(curl -fsS -4 --max-time 5 https://ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')
echo "   IP-adres van deze server: ${vet}${IP}${uit}"
DNS=$(getent ahostsv4 "$DOMEIN" 2>/dev/null | awk 'NR==1{print $1}' || true)
if [ "$DNS" = "$IP" ]; then ok "${DOMEIN} wijst al naar deze server."
else let_op "${DOMEIN} wijst nog naar '${DNS:-niets}'. Zet bij TransIP een A-record voor @ en voor www op ${IP}."; fi
echo
echo "   Site:     https://${DOMEIN}"
echo "   Beheer:   https://${DOMEIN}/beheer"
echo "   Back-up:  ./backup.sh"
