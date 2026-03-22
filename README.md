# LinuxBackup 🛡️

**A powerful, Docker-based Linux Backup & Restore Engine with real-time transfer monitoring, pause/resume support, and disk image cloning.**

Built for sysadmins who need a serious, no-nonsense backup solution they can self-host anywhere.

---

## Features

- **Three backup modes**
  - `directory` — tar+gzip compressed archive of any directory
  - `rsync` — incremental, bandwidth-efficient sync with `--partial` resume support
  - `image` — full disk/partition clone via `dd` with optional gzip compression

- **Real-time progress** — WebSocket-powered live transfer stats (rate, ETA, bytes transferred, file count)

- **Pause & Resume** — SIGSTOP/SIGCONT for tar/dd jobs; `--partial` flag for rsync jobs means interrupted transfers always resume from where they left off

- **Restore engine** — restore tar.gz archives, rsync directories, or dd images back to disk

- **Disk discovery** — automatically detects all block devices from the Linux host, shows size, filesystem, mount point, transport type (NVMe/SATA/USB), and recommends suitable targets

- **Backup verification** — integrity check via `tar -tzf` before restore

- **Persistent job history** — survives container restarts via JSON store at `/data/jobs.json`

- **Files browser** — lists all backup files with size, type detection, and one-click restore

- **Terminal-style UI** — live log stream, progress bars, stat boxes — all in browser

---

## Quick Start

```bash
git clone https://github.com/suman99pro/linuxbackup.git
cd linuxbackup
cp .env.example .env
docker compose up -d
```

Open **http://localhost:3000**

---

## Directory Structure

```
linuxbackup/
├── backend/
│   ├── server.js               # Express + Socket.IO entry point
│   ├── package.json
│   ├── routes/
│   │   ├── backup.js           # Backup REST endpoints
│   │   ├── restore.js          # Restore REST endpoints
│   │   ├── disks.js            # Disk/filesystem discovery endpoints
│   │   └── jobs.js             # Job management endpoints
│   ├── services/
│   │   ├── backupEngine.js     # Core: tar, rsync, dd backup logic
│   │   ├── restoreEngine.js    # Core: tar, rsync, dd restore logic
│   │   ├── diskService.js      # lsblk + df disk discovery
│   │   ├── jobStore.js         # Persistent JSON job store
│   │   └── socketService.js    # Socket.IO event handlers
│   └── utils/
│       └── fsHelpers.js        # Directory management, file listing
├── frontend/
│   └── public/
│       └── index.html          # Single-file frontend (vanilla JS + Socket.IO)
├── Dockerfile
├── docker-compose.yml
├── .env.example
├── .dockerignore
├── .gitignore
└── README.md
```

---

## Backup Modes Explained

### Directory Backup (`tar+gzip`)

Creates a compressed `.tar.gz` archive. Best for config files, home directories, application data.

- Uses `tar --checkpoint` for progress tracking
- Supports exclude patterns (e.g. `*.log`, `tmp/`, `/proc`)
- Output: `/data/backups/<name>_<timestamp>.tar.gz`

```bash
# Equivalent shell command:
tar -czf /data/backups/myhome_2025.tar.gz --exclude=*.log /home/user
```

### Rsync Incremental (`rsync`)

Syncs only changed files. Best for large directories, scheduled backups, network shares.

- `--partial` flag means transfers survive interruption and resume automatically
- `--delete` keeps destination in sync
- Pause/Resume: rsync jobs are restarted from the last checkpoint using `--partial --inplace`
- Output: `/data/backups/<name>_<timestamp>/` (directory mirror)

```bash
# Equivalent shell command:
rsync -avz --progress --partial --inplace --delete /source/ /data/backups/dest/
```

### Disk Image (`dd`)

Full block-level clone of a disk or partition. Best for system drives, bare-metal recovery.

- Uses `dd bs=4M conv=sync,noerror status=progress`
- Auto-compresses result with `gzip -1` after completion
- Output: `/data/backups/<name>_<timestamp>.img.gz`
- **Requires privileged container + /dev passthrough** (see below)

```bash
# Equivalent shell command:
dd if=/dev/sda bs=4M conv=sync,noerror status=progress | gzip -1 > backup.img.gz
```

---

## Configuration

### Mount host directories for backup

Edit `docker-compose.yml` and uncomment the volume mounts:

```yaml
volumes:
  - linuxbackup_data:/data
  - /home:/mnt/host/home:ro      # backup source (read-only)
  - /etc:/mnt/host/etc:ro
  - /mnt/external:/mnt/external  # external drive as backup destination
```

Then in the UI, set source to `/mnt/host/home` and destination to `/mnt/external`.

### Enable disk image backup (dd mode)

Disk image backup requires access to host block devices. Two options:

**Option A — Full privileged (simplest):**
```yaml
services:
  linuxbackup:
    privileged: true
    volumes:
      - /dev:/dev
```

**Option B — Targeted device passthrough (more secure):**
```yaml
services:
  linuxbackup:
    cap_add:
      - SYS_RAWIO
    devices:
      - /dev/sda:/dev/sda
      - /dev/sdb:/dev/sdb
```

---

## API Reference

All endpoints return JSON. Socket.IO events are emitted for real-time updates.

### Backup

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/backup/start` | Start a backup job |
| `POST` | `/api/backup/:id/pause` | Pause a running job |
| `POST` | `/api/backup/:id/resume` | Resume a paused job |
| `POST` | `/api/backup/:id/cancel` | Cancel a job |
| `GET` | `/api/backup/files` | List backup files |
| `DELETE` | `/api/backup/files/:name` | Delete a backup file |

**Start backup request body:**
```json
{
  "type": "directory",
  "name": "my_backup",
  "source": "/mnt/host/home/user",
  "destination": "/data/backups",
  "excludes": ["*.log", "tmp/", ".cache/"]
}
```

### Restore

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/restore/start` | Start a restore job |
| `POST` | `/api/restore/verify` | Verify archive integrity |
| `POST` | `/api/restore/:id/cancel` | Cancel a restore |

**Start restore request body:**
```json
{
  "type": "directory",
  "source": "/data/backups/my_backup_2025-01-01.tar.gz",
  "destination": "/data/restores/my_backup_restored"
}
```

### Disks

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/disks` | List all block devices (lsblk) |
| `GET` | `/api/disks/filesystems` | List mounted filesystems (df) |
| `GET` | `/api/disks/system` | System info (hostname, kernel, memory) |

### Jobs

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/jobs` | List all jobs |
| `GET` | `/api/jobs/:id` | Get a specific job |
| `DELETE` | `/api/jobs/:id` | Delete a job record |
| `DELETE` | `/api/jobs` | Delete all completed/failed/cancelled jobs |

### Socket.IO Events

**Server → Client:**
| Event | Payload | Description |
|-------|---------|-------------|
| `jobs:state` | `{ [id]: job }` | Full job state on connect |
| `job:created` | `job` | New job started |
| `job:update` | `job` | Job status changed |
| `job:progress` | `{ jobId, percent, rate, bytesWritten, eta, ... }` | Transfer progress |
| `job:log` | `{ jobId, msg, level }` | Log line from backup process |

**Client → Server:**
| Event | Payload | Description |
|-------|---------|-------------|
| `job:pause` | `{ jobId }` | Pause a job (SIGSTOP) |
| `job:resume` | `{ jobId }` | Resume a job (SIGCONT) |
| `job:cancel` | `{ jobId }` | Cancel a job (SIGTERM) |

---

## Security Considerations

- This tool is designed for **internal/trusted network use only**
- There is **no authentication** built in — add a reverse proxy (nginx + basic auth, or Authelia) for public exposure
- Disk image mode with `/dev` passthrough gives the container raw disk access — treat the container as root-equivalent
- Mount source directories **read-only** (`:ro`) whenever possible

### Example nginx reverse proxy with basic auth:

```nginx
location / {
    auth_basic "LinuxBackup";
    auth_basic_user_file /etc/nginx/.htpasswd;
    proxy_pass http://localhost:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
}
```

---

## Scheduled Backups

Use the host's cron to trigger backups via the API:

```cron
# Daily rsync backup of /home at 2am
0 2 * * * curl -s -X POST http://localhost:3000/api/backup/start \
  -H "Content-Type: application/json" \
  -d '{"type":"rsync","name":"daily_home","source":"/mnt/host/home","excludes":["*.cache"]}'
```

---

## Building from Source

```bash
cd backend
npm install
node server.js
```

---

## Requirements

- Docker Engine 20.10+
- Docker Compose v2+
- Linux host (for disk discovery and image backup)

---

## License

MIT — use freely, modify freely, deploy anywhere.

---

*Built with Node.js, Express, Socket.IO, and standard Linux tools (tar, rsync, dd, lsblk).*
