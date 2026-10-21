#!/usr/bin/env bash
# Ship the last commit to the Lightsail server and restart it. Learner data (a Docker volume) and the
# server's settings (deploy/.env, never in git) stay as they are.
#
#   deploy/update.sh
#
# SB_HOST and SB_KEY override the server and SSH key.
set -euo pipefail
HOST="${SB_HOST:-ubuntu@44.205.75.144}"
KEY="${SB_KEY:-$HOME/.ssh/study_buddy_lightsail}"
SSH=(ssh -i "$KEY" -o StrictHostKeyChecking=accept-new "$HOST")

cd "$(git rev-parse --show-toplevel)"
if [ -n "$(git status --porcelain)" ]; then
  echo "Note: only committed changes are deployed. Uncommitted changes stay on this computer."
fi
echo "Deploying $(git log -1 --format='%h %s') to $HOST"

# The committed code, swapped in next to the old copy (kept as ~/study-buddy.old for a quick rollback).
git archive --format=tar HEAD | "${SSH[@]}" '
  set -e
  rm -rf ~/study-buddy.new && mkdir -p ~/study-buddy.new && tar -x -C ~/study-buddy.new
  if [ -f ~/study-buddy/deploy/.env ]; then cp ~/study-buddy/deploy/.env ~/study-buddy.new/deploy/.env; fi
  rm -rf ~/study-buddy.old
  if [ -d ~/study-buddy ]; then mv ~/study-buddy ~/study-buddy.old; fi
  mv ~/study-buddy.new ~/study-buddy'

"${SSH[@]}" '
  set -e
  cd ~/study-buddy
  if [ ! -f deploy/.env ]; then echo "deploy/.env is missing on the server (see deploy/env.example)."; exit 1; fi
  docker compose -p study-buddy -f deploy/docker-compose.yml --env-file deploy/.env up -d --build
  docker image prune -f >/dev/null
  docker compose -p study-buddy -f deploy/docker-compose.yml ps --format "table {{.Service}}\t{{.Status}}"'
