#!/usr/bin/env bash
# Change the device page's username and password on the server. The password is typed privately
# (not shown, not saved in shell history) and only its hash is stored on the server.
#
#   deploy/set-login.sh
#
# SB_HOST and SB_KEY override the server and SSH key.
set -euo pipefail
HOST="${SB_HOST:-ubuntu@44.205.75.144}"
KEY="${SB_KEY:-$HOME/.ssh/study_buddy_lightsail}"
SSH=(ssh -i "$KEY" -o StrictHostKeyChecking=accept-new "$HOST")

read -r -p "Username [judge]: " USER_NAME
USER_NAME="${USER_NAME:-judge}"
[[ "$USER_NAME" =~ ^[A-Za-z0-9._-]+$ ]] || { echo "Use letters, numbers, dot, dash or underscore."; exit 1; }
read -r -s -p "New password (at least 10 characters): " PASS; echo
read -r -s -p "Same password again: " PASS2; echo
[ "$PASS" = "$PASS2" ] || { echo "The passwords don't match. Nothing changed."; exit 1; }
[ "${#PASS}" -ge 10 ] || { echo "Too short. Nothing changed."; exit 1; }

# Hash on the server (Caddy's bcrypt); the password goes over SSH on stdin, never on a command line.
HASH=$(printf '%s\n' "$PASS" | "${SSH[@]}" 'docker run --rm -i caddy:2.8 caddy hash-password')
[[ "$HASH" == \$2* ]] || { echo "Couldn't hash the password. Nothing changed."; exit 1; }

printf '%s\n%s\n' "$USER_NAME" "$HASH" | "${SSH[@]}" '
  set -e
  read -r U; read -r H
  cd ~/study-buddy
  H=${H//\$/\$\$}   # Docker Compose reads "$" as a variable: store each as "$$"
  sed -i "s|^DEVICE_USER=.*|DEVICE_USER=$U|; s|^DEVICE_PASSWORD_HASH=.*|DEVICE_PASSWORD_HASH=$H|" deploy/.env
  docker compose -p study-buddy -f deploy/docker-compose.yml --env-file deploy/.env up -d --force-recreate caddy >/dev/null 2>&1
  echo "Updated on the server."'

# Keep the local note in step (the password itself isn't written anywhere).
NOTE="$(git rev-parse --show-toplevel)/deploy/hosting.local.txt"
if [ -f "$NOTE" ]; then
  sed -i '' "s|^  Username: .*|  Username: $USER_NAME|; s|^  Password: .*|  Password: (changed $(date +%F); you chose it)|" "$NOTE"
fi
echo "Done. Sign in at https://device.44-205-75-144.sslip.io as \"$USER_NAME\" with the new password."
