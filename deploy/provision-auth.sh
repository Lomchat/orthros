#!/usr/bin/env bash
set -euo pipefail

if [[ ${EUID} -ne 0 ]]; then
  echo "Run this provisioning script as root." >&2
  exit 1
fi

auth_dir=/etc/orthros
auth_env=${auth_dir}/auth.env
save_dir=/srv/bfme/data/cloud-saves
unit_path=/etc/systemd/system/orthros.service

install -d -m 700 "${auth_dir}" "${save_dir}"

if [[ ! -e ${auth_env} ]]; then
  db_password=$(openssl rand -hex 32)
  auth_secret=$(openssl rand -hex 48)
  umask 077
  {
    printf 'DATABASE_URL=postgresql://bfme_app:%s@127.0.0.1:5432/bfme\n' "${db_password}"
    printf 'BETTER_AUTH_URL=https://games.chalco.website\n'
    printf 'BETTER_AUTH_TRUSTED_ORIGINS=https://games.chalco.website,https://orthros.chalco.website\n'
    printf 'BETTER_AUTH_SECRET=%s\n' "${auth_secret}"
    printf 'BFME_SAVE_PATH=%s\n' "${save_dir}"
  } > "${auth_env}"
  chmod 600 "${auth_env}"
else
  db_password=$(sed -n 's#^DATABASE_URL=postgresql://bfme_app:\([^@]*\)@.*#\1#p' "${auth_env}")
  if [[ -z ${db_password} ]]; then
    echo "Existing ${auth_env} has no readable bfme_app DATABASE_URL." >&2
    exit 1
  fi
fi

if ! runuser -u postgres -- psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='bfme_app'" | grep -q 1; then
  runuser -u postgres -- psql -v ON_ERROR_STOP=1 -c \
    "CREATE ROLE bfme_app LOGIN PASSWORD '${db_password}' NOSUPERUSER NOCREATEDB NOCREATEROLE;"
else
  runuser -u postgres -- psql -v ON_ERROR_STOP=1 -c \
    "ALTER ROLE bfme_app PASSWORD '${db_password}' NOSUPERUSER NOCREATEDB NOCREATEROLE;"
fi
if ! runuser -u postgres -- psql -tAc "SELECT 1 FROM pg_database WHERE datname='bfme'" | grep -q 1; then
  runuser -u postgres -- createdb --owner=bfme_app bfme
fi

install -m 644 "${BASH_SOURCE[0]%/*}/orthros.service.example" "${unit_path}"
systemctl daemon-reload

echo "Orthros account storage and service are provisioned."
