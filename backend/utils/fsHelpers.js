const fs = require('fs-extra');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || '/data';
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const RESTORE_DIR = path.join(DATA_DIR, 'restores');
const LOGS_DIR = path.join(DATA_DIR, 'logs');

function ensureDirectories() {
  [DATA_DIR, BACKUP_DIR, RESTORE_DIR, LOGS_DIR].forEach(dir => {
    fs.ensureDirSync(dir);
    console.log(`[FS] Ensured: ${dir}`);
  });
}

function listBackups() {
  const files = [];
  try {
    const entries = fs.readdirSync(BACKUP_DIR, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(BACKUP_DIR, entry.name);
      const stat = fs.statSync(fullPath);
      files.push({
        name: entry.name,
        path: fullPath,
        size: stat.size,
        sizeHuman: humanSize(stat.size),
        isDirectory: entry.isDirectory(),
        mtime: stat.mtime,
        type: detectBackupType(entry.name, entry.isDirectory())
      });
    }
  } catch (_) {}
  return files.sort((a, b) => b.mtime - a.mtime);
}

function detectBackupType(name, isDir) {
  if (isDir) return 'rsync';
  if (name.endsWith('.tar.gz') || name.endsWith('.tgz')) return 'directory';
  if (name.endsWith('.img') || name.endsWith('.img.gz')) return 'image';
  return 'unknown';
}

function humanSize(bytes) {
  if (!bytes || bytes < 1024) return `${bytes || 0} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)} MB`;
  if (bytes < 1099511627776) return `${(bytes / 1073741824).toFixed(2)} GB`;
  return `${(bytes / 1099511627776).toFixed(2)} TB`;
}

module.exports = { BACKUP_DIR, RESTORE_DIR, LOGS_DIR, DATA_DIR, ensureDirectories, listBackups };
