#!/usr/bin/env bash
# Deploys Private MRR to a VPS.
#
#   ./deploy.sh user@vps mrr.yourdomain.com
#
# Transfers the server, the Firebase key and the configuration, then starts the
# container. Idempotent: replay it to ship an update.
set -euo pipefail

TARGET="${1:?Usage: ./deploy.sh user@vps mrr.yourdomain.com}"
DOMAIN="${2:?Usage: ./deploy.sh user@vps mrr.yourdomain.com}"
REMOTE_DIR="${REMOTE_DIR:-/opt/private-mrr}"

say() { printf '\n\033[1m▸ %s\033[0m\n' "$1"; }

say "Local checks"
[ -f server/.env.real ] || { echo "server/.env.real not found"; exit 1; }
[ -f server/credentials/fcm-service-account.json ] || { echo "Firebase key not found"; exit 1; }
grep -q '^API_TOKEN=.\{32,\}' server/.env.real || { echo "API_TOKEN missing or too short"; exit 1; }
echo "  configuration and Firebase key present"

say "Archiving the server (without secrets)"
tar --exclude='node_modules' --exclude='dist' --exclude='data' \
    --exclude='credentials' --exclude='.env*' --exclude='*.log' \
    -czf /tmp/private-mrr-server.tar.gz server/
echo "  $(du -h /tmp/private-mrr-server.tar.gz | cut -f1)"

say "Transferring to $TARGET:$REMOTE_DIR"
ssh -n "$TARGET" "mkdir -p $REMOTE_DIR/credentials && chmod 700 $REMOTE_DIR/credentials"
scp -q /tmp/private-mrr-server.tar.gz "$TARGET:/tmp/"
ssh -n "$TARGET" "cd $REMOTE_DIR && tar xzf /tmp/private-mrr-server.tar.gz --strip-components=1 && rm /tmp/private-mrr-server.tar.gz"

say "Transferring secrets"
# The production configuration derives from .env.real, with the container paths.
sed -E 's#^DB_PATH=.*#DB_PATH=/data/mrr.db#; s#^NODE_ENV=.*#NODE_ENV=production#; s#^FCM_SERVICE_ACCOUNT_PATH=.*#FCM_SERVICE_ACCOUNT_PATH=/run/secrets/fcm-service-account.json#' \
  server/.env.real > /tmp/.env.prod
scp -q /tmp/.env.prod "$TARGET:$REMOTE_DIR/.env"
scp -q server/credentials/fcm-service-account.json "$TARGET:$REMOTE_DIR/credentials/"
ssh -n "$TARGET" "chmod 600 $REMOTE_DIR/.env $REMOTE_DIR/credentials/fcm-service-account.json"
rm -f /tmp/.env.prod /tmp/private-mrr-server.tar.gz
echo "  .env and Firebase key written with mode 600"

say "Building and starting the container"
ssh -n "$TARGET" "cd $REMOTE_DIR && docker compose up -d --build"

say "Waiting for startup"
for _ in $(seq 1 60); do
  if ssh -n "$TARGET" "curl -sf http://127.0.0.1:8791/health" >/dev/null 2>&1; then break; fi
  sleep 3
done
ssh -n "$TARGET" "curl -s http://127.0.0.1:8791/health" || { echo "the server is not responding"; exit 1; }

cat <<MSG

▸ Server deployed.

  Two manual steps remain:

  1. Expose it over HTTPS. Add this block to your Caddyfile, then reload Caddy:

$(sed "s/mrr.yourdomain.com/$DOMAIN/" server/Caddyfile.example | sed 's/^/     /')

  2. Declare the webhooks. For each of your Stripe accounts:
     URL: https://$DOMAIN/webhooks/stripe/<project-id>
     Then paste each whsec_... into $REMOTE_DIR/.env and reload:
     ssh $TARGET 'cd $REMOTE_DIR && docker compose up -d --force-recreate'

     Use --force-recreate, not 'docker compose restart': a plain restart reuses
     the existing container and does NOT re-read .env, so new webhook secrets
     would be silently ignored and every delivery would answer 500.

MSG
