#!/usr/bin/env bash
# Déploiement de Private MRR sur un VPS.
#
#   ./deploy.sh user@vps mrr.tondomaine.com
#
# Transfère le serveur, la clé Firebase et la configuration, puis démarre le
# conteneur. Idempotent : rejouable pour livrer une mise à jour.
set -euo pipefail

TARGET="${1:?Usage: ./deploy.sh user@vps mrr.tondomaine.com}"
DOMAIN="${2:?Usage: ./deploy.sh user@vps mrr.tondomaine.com}"
REMOTE_DIR="${REMOTE_DIR:-/opt/private-mrr}"

say() { printf '\n\033[1m▸ %s\033[0m\n' "$1"; }

say "Vérifications locales"
[ -f server/.env.real ] || { echo "server/.env.real introuvable"; exit 1; }
[ -f server/credentials/fcm-service-account.json ] || { echo "clé Firebase introuvable"; exit 1; }
grep -q '^API_TOKEN=.\{32,\}' server/.env.real || { echo "API_TOKEN absent ou trop court"; exit 1; }
echo "  configuration et clé Firebase présentes"

say "Archive du serveur (sans secrets)"
tar --exclude='node_modules' --exclude='dist' --exclude='data' \
    --exclude='credentials' --exclude='.env*' --exclude='*.log' \
    -czf /tmp/private-mrr-server.tar.gz server/
echo "  $(du -h /tmp/private-mrr-server.tar.gz | cut -f1)"

say "Transfert vers $TARGET:$REMOTE_DIR"
ssh "$TARGET" "mkdir -p $REMOTE_DIR/credentials && chmod 700 $REMOTE_DIR/credentials"
scp -q /tmp/private-mrr-server.tar.gz "$TARGET:/tmp/"
ssh "$TARGET" "cd $REMOTE_DIR && tar xzf /tmp/private-mrr-server.tar.gz --strip-components=1 && rm /tmp/private-mrr-server.tar.gz"

say "Transfert des secrets"
# La configuration de production dérive de .env.real, avec les chemins du conteneur.
sed -E 's#^DB_PATH=.*#DB_PATH=/data/mrr.db#; s#^NODE_ENV=.*#NODE_ENV=production#; s#^FCM_SERVICE_ACCOUNT_PATH=.*#FCM_SERVICE_ACCOUNT_PATH=/run/secrets/fcm-service-account.json#' \
  server/.env.real > /tmp/.env.prod
scp -q /tmp/.env.prod "$TARGET:$REMOTE_DIR/.env"
scp -q server/credentials/fcm-service-account.json "$TARGET:$REMOTE_DIR/credentials/"
ssh "$TARGET" "chmod 600 $REMOTE_DIR/.env $REMOTE_DIR/credentials/fcm-service-account.json"
rm -f /tmp/.env.prod /tmp/private-mrr-server.tar.gz
echo "  .env et clé Firebase déposés en 600"

say "Construction et démarrage du conteneur"
ssh "$TARGET" "cd $REMOTE_DIR && docker compose up -d --build"

say "Attente du démarrage"
for i in $(seq 1 60); do
  if ssh "$TARGET" "curl -sf http://127.0.0.1:8791/health" >/dev/null 2>&1; then break; fi
  sleep 3
done
ssh "$TARGET" "curl -s http://127.0.0.1:8791/health" || { echo "le serveur ne répond pas"; exit 1; }

cat <<MSG

▸ Serveur déployé.

  Il reste deux étapes manuelles :

  1. Exposer en HTTPS — ajoute ce bloc à ton Caddyfile puis recharge Caddy :

$(sed "s/mrr.tondomaine.com/$DOMAIN/" server/Caddyfile.example | sed 's/^/     /')

  2. Déclarer les webhooks — pour chacun de tes comptes Stripe :
     URL : https://$DOMAIN/webhooks/stripe/<identifiant-du-projet>
     Puis colle chaque whsec_… dans $REMOTE_DIR/.env et relance :
     ssh $TARGET 'cd $REMOTE_DIR && docker compose restart'

MSG
