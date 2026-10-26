#!/usr/bin/env bash
# Orthros backups (docs/backups.md): restic snapshots of everything here that is not disposable — data/ (games,
# engines, installers, Wine prefix, corpus, proofs), backups/manual/, the Git repository with its unpushed commits and
# branches, the local notes (CLAUDE.md, DECISIONS.md, STATUS.md), the working tree's uncommitted changes — and of the
# live services' state in /var/lib, into backups/restic/. Content-addressed and deduplicated: a file is stored once,
# whatever the number of snapshots holding it; a snapshot costs what changed since the last one.
#
# Usage (as root): tools/backup.sh <command> [...]
#   setup                      once: the password, the repository, the nightly timer (run again: nothing redone)
#   snapshot [-m <note>]       a snapshot now (tag manual: never forgotten); the note is a tag too
#   daily                      the timer's run: a snapshot (tag daily), then the retention policy
#   list                       the snapshots
#   diff <a> <b>               what changed between two snapshots (ids, or latest)
#   find <pattern>             the snapshots holding files whose name matches (a deleted file's history)
#   ls <snapshot> <path>       the files under <path> in a snapshot
#   restore <snapshot> <path> [--to <dir>] [--yes]
#                              <path> (file or folder, absolute or relative) as it was in the snapshot: in place — the
#                              current state snapshotted first (tag pre-restore), files added since removed, asked first
#                              unless --yes —, or copied to <dir>/<absolute path> with --to (nothing in place touched)
#   mount [<dir>]              every snapshot browsable as plain files (FUSE; default backups/mnt; Ctrl-C unmounts)
#   check [--full]             the repository's integrity (its structure and 1 % of the data, or all of the data)
#   forget                     the retention policy alone
#   restic <args...>           any other restic command on this repository
set -euo pipefail

ROOT=$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)
export RESTIC_REPOSITORY=${ORTHROS_RESTIC_REPOSITORY:-$ROOT/backups/restic}
export RESTIC_PASSWORD_FILE=${ORTHROS_RESTIC_PASSWORD_FILE:-$ROOT/backups/restic-password}
export RESTIC_CACHE_DIR=${RESTIC_CACHE_DIR:-$ROOT/backups/cache}
export GOMAXPROCS=${GOMAXPROCS:-4} # (a shared server: restic's hashing and compression on 4 cores at most)
HOST=orthros                       # (one name whatever the machine's: the retention and the parent snapshot by it)

# What a snapshot holds. The repository's folder is whole but for the disposable (build/, node_modules/, generated
# tests, agent worktrees) and the backups themselves; the services' state but for caches remade on demand and the
# linked game trees their runners rebuild at each start.
SOURCES=("$ROOT" /var/lib/private/orthros2 /var/lib/private/orthros-goldsrc /var/lib/orthros-openmw /etc/orthros-openmw.env
  /etc/systemd/system/orthros.service /etc/systemd/system/orthros-snapshot-jobs.service
  /etc/systemd/system/orthros-goldsrc@.service /etc/systemd/system/orthros-openmw@.service
  /etc/systemd/system/orthros-backup.service /etc/systemd/system/orthros-backup.timer)
EXCLUDES=("$ROOT/build" "$ROOT/node_modules" "$ROOT/tests/generated" "$ROOT/.claude/worktrees"
  "$ROOT/backups/restic" "$ROOT/backups/cache" "$ROOT/backups/mnt" "$ROOT/backups/restore-*" "$ROOT/backups/restic-password"
  /var/lib/private/orthros2/brcache /var/lib/private/orthros2/covers
  '/var/lib/private/orthros-goldsrc/*/game' '/var/lib/orthros-openmw/*/gamedata')
# Retention: every snapshot of the last 14 days, then one a week for 8 weeks, one a month for 2 years; the manual ones
# and those taken before a restore, always.
KEEP=(--keep-daily 14 --keep-weekly 8 --keep-monthly 24 --keep-tag manual --keep-tag pre-restore)

die() { echo "backup: $*" >&2; exit 1; }
need_root() { [ "$(id -u)" = 0 ] || die "run as root (the services' state is readable by root only)"; }
need_repo() { [ -f "$RESTIC_REPOSITORY/config" ] || die "no repository in $RESTIC_REPOSITORY: tools/backup.sh setup"; }

snapshot() { # <tag> [note]
  local tag=$1 note=${2:-} src args=()
  for src in "${SOURCES[@]}"; do [ -e "$src" ] && args+=("$src"); done
  for src in "${EXCLUDES[@]}"; do args+=(--exclude "$src"); done
  args+=(--host "$HOST" --tag "$tag")
  [ -n "$note" ] && args+=(--tag "note:${note//,/;}")
  # (exit 3: some files unreadable — gone while read, say — and the snapshot saved without them)
  nice -n 10 ionice -c 3 restic backup "${args[@]}" || { local rc=$?; [ $rc = 3 ] || return $rc; echo "backup: snapshot saved, some files unreadable (above)" >&2; }
}

# (restic 0.16's diff takes ids only: latest made the newest snapshot's)
snap_id() {
  if [ "$1" = latest ]; then
    restic snapshots --host "$HOST" --json | python3 -c 'import json, sys; s = json.load(sys.stdin); print(max(s, key=lambda x: x["time"])["id"] if s else "")'
  else echo "$1"; fi
}

forget() { restic forget --host "$HOST" --group-by host "${KEEP[@]}" --prune; }

restore() { # <snapshot> <path> [--to <dir>] [--yes]
  [ $# -ge 2 ] || die "usage: restore <snapshot> <path> [--to <dir>] [--yes]"
  local snap=$1 target to='' yes=0 src
  target=$(realpath -m "$2"); shift 2
  while [ $# -gt 0 ]; do
    case $1 in --to) to=$(realpath -m "$2"); shift 2 ;; --yes) yes=1; shift ;; *) die "restore: unknown option $1" ;; esac
  done
  if [ -n "$to" ]; then
    mkdir -p "$to"
    restic restore "$snap" --target "$to" --include "$target"
    [ -e "$to$target" ] || [ -L "$to$target" ] || die "$target: not in snapshot $snap"
    echo "restored to $to$target"; return
  fi
  # (staged beside the data, the same disk: a whole game restored without crossing disks, then synchronized)
  STAGE="$ROOT/backups/restore-$(date +%Y%m%d-%H%M%S)"
  trap 'rm -rf "$STAGE"' EXIT
  restic restore "$snap" --target "$STAGE" --include "$target"
  src="$STAGE$target"
  [ -e "$src" ] || [ -L "$src" ] || die "$target: not in snapshot $snap"
  local from=$src into=$target
  if [ -d "$src" ] && [ ! -L "$src" ]; then from="$src/"; into="$target/"; fi
  local changes
  changes=$(rsync -aHAX --delete --dry-run --itemize-changes "$from" "$into" 2>/dev/null || true)
  if [ -e "$target" ] && [ -z "$changes" ]; then echo "$target: already as in snapshot $snap"; return; fi
  echo "$target will be as in snapshot $snap — $(printf '%s\n' "$changes" | grep -c . || true) change(s):"
  printf '%s\n' "$changes" | head -20
  if [ "$yes" != 1 ]; then
    [ -t 0 ] || die "in place without --yes needs a terminal (or --to <dir> for a copy)"
    read -r -p "Replace? [y/N] " answer; [ "$answer" = y ] || [ "$answer" = o ] || die "nothing changed"
  fi
  snapshot pre-restore "before restoring $target from $snap"
  mkdir -p "$(dirname "$target")"
  rsync -aHAX --delete "$from" "$into"
  echo "$target restored from snapshot $snap (the state before: the newest snapshot tagged pre-restore)"
}

setup() {
  mkdir -p "$ROOT/backups/manual"; chmod 700 "$ROOT/backups"
  if [ ! -s "$RESTIC_PASSWORD_FILE" ]; then
    (umask 077; openssl rand -base64 33 > "$RESTIC_PASSWORD_FILE")
    echo "password written to $RESTIC_PASSWORD_FILE (keep a copy elsewhere: without it the snapshots are unreadable)"
  fi
  [ -f "$RESTIC_REPOSITORY/config" ] || restic init
  cat > /etc/systemd/system/orthros-backup.service <<EOF
# Written by $ROOT/tools/backup.sh setup (docs/backups.md)
[Unit]
Description=Orthros nightly restic snapshot (docs/backups.md)
After=local-fs.target

[Service]
Type=oneshot
ExecStart=$ROOT/tools/backup.sh daily
Nice=19
IOSchedulingClass=idle
CPUSchedulingPolicy=batch
Environment=GOMAXPROCS=4
EOF
  cat > /etc/systemd/system/orthros-backup.timer <<EOF
# Written by $ROOT/tools/backup.sh setup (docs/backups.md)
[Unit]
Description=Orthros nightly restic snapshot (docs/backups.md)

[Timer]
OnCalendar=*-*-* 04:40:00
RandomizedDelaySec=15min
Persistent=true

[Install]
WantedBy=timers.target
EOF
  systemctl daemon-reload
  systemctl enable --now orthros-backup.timer
  systemctl list-timers orthros-backup.timer --no-pager
}

cmd=${1:-}; [ $# -gt 0 ] && shift
case $cmd in
  setup) need_root; setup ;;
  snapshot)
    need_root; need_repo; note=''
    while [ $# -gt 0 ]; do case $1 in -m) note=$2; shift 2 ;; *) die "snapshot: unknown option $1" ;; esac; done
    snapshot manual "$note" ;;
  daily) need_root; need_repo; snapshot daily; forget ;;
  list) need_repo; restic snapshots --host "$HOST" ;;
  diff) need_repo; [ $# -eq 2 ] || die "usage: diff <a> <b>"; restic diff "$(snap_id "$1")" "$(snap_id "$2")" ;;
  find) need_repo; [ $# -ge 1 ] || die "usage: find <pattern>"; restic find --host "$HOST" "$@" ;;
  ls) need_repo; [ $# -eq 2 ] || die "usage: ls <snapshot> <path>"; restic ls --recursive "$1" "$(realpath -m "$2")" ;;
  restore) need_root; need_repo; restore "$@" ;;
  mount) need_repo; dir=${1:-$ROOT/backups/mnt}; mkdir -p "$dir"; echo "snapshots under $dir/snapshots/ (Ctrl-C to unmount)"; restic mount "$dir" ;;
  check) need_repo; if [ "${1:-}" = --full ]; then restic check --read-data; else restic check --read-data-subset=1%; fi ;;
  forget) need_root; need_repo; forget ;;
  restic) need_repo; restic "$@" ;;
  *) sed -n '2,/^set -euo/p' "$0" | sed '$d; s/^# \{0,1\}//'; [ -z "$cmd" ] || exit 2 ;;
esac
