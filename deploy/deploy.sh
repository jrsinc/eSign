#!/bin/sh
# Deploys one commit of Method 365 on the production server (Docker setup, see PRODUCTION.md).
# Run it from the app folder:   sh deploy/deploy.sh <commit>
# The CI/CD pipeline runs it over SSH after the tests pass. Steps:
#   1. back up the data folder, 2. switch to the commit, 3. rebuild and restart,
#   4. wait until the app reports healthy, 5. if it doesn't, go back to the previous version.
set -eu

SHA="${1:?usage: sh deploy/deploy.sh <commit>}"
[ -f docker-compose.yml ] && [ -f .env ] || { echo "Run this from the Method 365 folder (with docker-compose.yml and .env)"; exit 1; }

log() { printf '[deploy %s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }
PREV=$(git rev-parse HEAD)
PREV_SHORT=$(git rev-parse --short HEAD)
NEW_SHORT=$(git rev-parse --short "$SHA")
STAMP=$(date -u +%Y%m%d-%H%M%S)

healthy() {
  id=$(docker compose ps -q esign 2>/dev/null)
  [ -n "$id" ] && [ "$(docker inspect -f '{{.State.Health.Status}}' "$id" 2>/dev/null)" = healthy ]
}
wait_healthy() {
  i=0
  while [ "$i" -lt 40 ]; do
    healthy && return 0
    i=$((i + 1))
    sleep 3
  done
  return 1
}

# 1. Backup of the live data, kept on the server (newest 10).
mkdir -p predeploy-backups
if [ -n "$(docker compose ps -q esign 2>/dev/null)" ]; then
  log "Backing up data before updating"
  docker compose exec -T esign tar czf - -C /app/data . < /dev/null > "predeploy-backups/data-$STAMP-$PREV_SHORT.tgz"
fi

# 2-4. Switch, rebuild, restart, wait.
log "Updating $PREV_SHORT -> $NEW_SHORT"
git checkout --quiet --detach "$SHA"
docker compose up -d --build --remove-orphans < /dev/null
if wait_healthy; then
  log "Healthy on $NEW_SHORT"
else
  # 5. Roll back.
  log "Not healthy on $NEW_SHORT: rolling back to $PREV_SHORT"
  docker compose logs --tail 60 esign < /dev/null || true
  git checkout --quiet --detach "$PREV"
  docker compose up -d --build --remove-orphans < /dev/null
  if wait_healthy; then log "Rolled back: $PREV_SHORT is running"; else log "Rollback is not healthy either: check the server now"; fi
  exit 1
fi

ls -1t predeploy-backups/data-*.tgz 2>/dev/null | tail -n +11 | xargs -r rm -f
docker image prune -f > /dev/null 2>&1 || true
log "Done"
