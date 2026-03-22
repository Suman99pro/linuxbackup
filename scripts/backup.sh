#!/usr/bin/env bash
# LinuxBackup helper scripts
# Usage: ./scripts/backup.sh [command] [args]

set -euo pipefail

BASE_URL="${LINUXBACKUP_URL:-http://localhost:3000}"
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
NC='\033[0m'

usage() {
  echo -e "${CYAN}LinuxBackup CLI Helper${NC}"
  echo ""
  echo "Usage: $0 <command> [options]"
  echo ""
  echo "Commands:"
  echo "  backup-dir <source> [name] [dest]   Backup a directory (tar+gzip)"
  echo "  backup-rsync <source> [name] [dest] Backup with rsync (incremental)"
  echo "  backup-image <device> [name]        Backup a disk image (dd)"
  echo "  restore-dir <source> [dest]         Restore a tar.gz archive"
  echo "  restore-image <source> <device>     Restore disk image"
  echo "  list-jobs                           List all jobs"
  echo "  list-files                          List backup files"
  echo "  list-disks                          List available disks"
  echo "  pause <job-id>                      Pause a running job"
  echo "  resume <job-id>                     Resume a paused job"
  echo "  cancel <job-id>                     Cancel a job"
  echo "  verify <backup-path>               Verify backup integrity"
  echo ""
  echo "Environment:"
  echo "  LINUXBACKUP_URL  Base URL (default: http://localhost:3000)"
  echo ""
}

check_jq() {
  if ! command -v jq &>/dev/null; then
    echo -e "${YELLOW}Warning: jq not found, output will be raw JSON${NC}"
    JQ_CMD="cat"
  else
    JQ_CMD="jq ."
  fi
}

post() {
  local endpoint="$1"
  local body="$2"
  curl -s -X POST "${BASE_URL}${endpoint}" \
    -H "Content-Type: application/json" \
    -d "${body}"
}

get() {
  local endpoint="$1"
  curl -s "${BASE_URL}${endpoint}"
}

cmd="${1:-help}"
shift || true

case "$cmd" in
  backup-dir)
    SOURCE="${1:?Source path required}"
    NAME="${2:-backup}"
    DEST="${3:-}"
    echo -e "${GREEN}Starting directory backup: ${SOURCE}${NC}"
    BODY=$(printf '{"type":"directory","source":"%s","name":"%s","destination":"%s","excludes":["/proc","/sys","/dev","/run","/tmp"]}' \
      "$SOURCE" "$NAME" "$DEST")
    post "/api/backup/start" "$BODY" | ${JQ_CMD:-cat}
    ;;

  backup-rsync)
    SOURCE="${1:?Source path required}"
    NAME="${2:-backup}"
    DEST="${3:-}"
    echo -e "${GREEN}Starting rsync backup: ${SOURCE}${NC}"
    BODY=$(printf '{"type":"rsync","source":"%s","name":"%s","destination":"%s"}' "$SOURCE" "$NAME" "$DEST")
    post "/api/backup/start" "$BODY" | ${JQ_CMD:-cat}
    ;;

  backup-image)
    DEVICE="${1:?Device path required (e.g. /dev/sda)}"
    NAME="${2:-disk_image}"
    echo -e "${YELLOW}Starting disk image backup: ${DEVICE}${NC}"
    echo -e "${RED}WARNING: This will read the ENTIRE device. Ensure sufficient space.${NC}"
    BODY=$(printf '{"type":"image","source":"%s","name":"%s"}' "$DEVICE" "$NAME")
    post "/api/backup/start" "$BODY" | ${JQ_CMD:-cat}
    ;;

  restore-dir)
    SOURCE="${1:?Backup source path required}"
    DEST="${2:-/data/restores/restored}"
    echo -e "${GREEN}Starting directory restore: ${SOURCE} → ${DEST}${NC}"
    BODY=$(printf '{"type":"directory","source":"%s","destination":"%s"}' "$SOURCE" "$DEST")
    post "/api/restore/start" "$BODY" | ${JQ_CMD:-cat}
    ;;

  restore-image)
    SOURCE="${1:?Backup source path required}"
    DEST="${2:?Target device required (e.g. /dev/sdb)}"
    echo -e "${RED}WARNING: This will OVERWRITE ${DEST}. Press Ctrl+C to abort.${NC}"
    sleep 5
    BODY=$(printf '{"type":"image","source":"%s","destination":"%s"}' "$SOURCE" "$DEST")
    post "/api/restore/start" "$BODY" | ${JQ_CMD:-cat}
    ;;

  list-jobs)
    get "/api/jobs" | ${JQ_CMD:-cat}
    ;;

  list-files)
    get "/api/backup/files" | ${JQ_CMD:-cat}
    ;;

  list-disks)
    echo -e "${CYAN}=== Block Devices ===${NC}"
    get "/api/disks" | ${JQ_CMD:-cat}
    echo -e "${CYAN}=== Filesystems ===${NC}"
    get "/api/disks/filesystems" | ${JQ_CMD:-cat}
    ;;

  pause)
    JOB_ID="${1:?Job ID required}"
    post "/api/backup/${JOB_ID}/pause" '{}' | ${JQ_CMD:-cat}
    echo -e "${YELLOW}Job paused: ${JOB_ID}${NC}"
    ;;

  resume)
    JOB_ID="${1:?Job ID required}"
    post "/api/backup/${JOB_ID}/resume" '{}' | ${JQ_CMD:-cat}
    echo -e "${GREEN}Job resumed: ${JOB_ID}${NC}"
    ;;

  cancel)
    JOB_ID="${1:?Job ID required}"
    post "/api/backup/${JOB_ID}/cancel" '{}' | ${JQ_CMD:-cat}
    echo -e "${RED}Job cancelled: ${JOB_ID}${NC}"
    ;;

  verify)
    SOURCE="${1:?Backup path required}"
    echo -e "${CYAN}Verifying: ${SOURCE}${NC}"
    BODY=$(printf '{"source":"%s"}' "$SOURCE")
    post "/api/restore/verify" "$BODY" | ${JQ_CMD:-cat}
    ;;

  help|--help|-h|*)
    usage
    ;;
esac
