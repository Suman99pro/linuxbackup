/**
 * BackupEngine — core backup logic
 * Supports: tar+gzip (directory), dd (disk image), rsync (incremental)
 * Features: pause/resume via SIGSTOP/SIGCONT, real-time progress via Socket.IO
 */

const { spawn, execSync } = require('child_process');
const fs = require('fs-extra');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { getJobStore, updateJob, saveJobStore } = require('./jobStore');
const { BACKUP_DIR, RESTORE_DIR } = require('../utils/fsHelpers');

const activeProcesses = new Map(); // jobId -> child process

// ── Helpers ─────────────────────────────────────────────────────────────────

function humanSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)} MB`;
  return `${(bytes / 1073741824).toFixed(2)} GB`;
}

function parseDdProgress(line) {
  // dd outputs: "X bytes (Y GB, Z GiB) copied, T s, R MB/s"
  const m = line.match(/^(\d+)\s+bytes.*copied,\s+([\d.]+)\s+s,\s+([\d.]+)\s+(\S+)/);
  if (m) {
    return {
      bytesWritten: parseInt(m[1]),
      elapsed: parseFloat(m[2]),
      rate: `${m[3]} ${m[4]}`
    };
  }
  return null;
}

function parseTarProgress(line, totalSize) {
  // tar with --checkpoint outputs checkpoint numbers
  const m = line.match(/checkpoint (\d+)/i) || line.match(/^(\d+)\s/);
  if (m && totalSize > 0) {
    const ckpt = parseInt(m[1]);
    // each checkpoint ≈ 512 bytes * blocksize(20) = 10240 bytes by default
    const estimated = ckpt * 10240;
    return { bytesWritten: estimated };
  }
  return null;
}

// ── Directory Backup (tar+gzip) ──────────────────────────────────────────────

async function backupDirectory(job, io) {
  const { id, source, destFile, compression, excludes } = job;

  // Get total size first
  let totalSize = 0;
  try {
    const out = execSync(`du -sb "${source}" 2>/dev/null | awk '{print $1}'`).toString().trim();
    totalSize = parseInt(out) || 0;
  } catch (_) {}

  updateJob(id, { status: 'running', totalSize, startedAt: Date.now() });
  io.emit('job:update', getJobStore()[id]);

  const args = [
    '--create',
    '--gzip',
    '--checkpoint=100',
    '--checkpoint-action=echo=%{%s}T checkpoint %u',
    '--verbose',
  ];

  if (excludes && excludes.length) {
    excludes.forEach(ex => args.push(`--exclude=${ex}`));
  }

  args.push('-f', destFile, source);

  return new Promise((resolve, reject) => {
    const proc = spawn('tar', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    activeProcesses.set(id, proc);

    let bytesWritten = 0;
    let lastEmit = 0;
    let fileCount = 0;
    const startTime = Date.now();

    const emitProgress = (extra = {}) => {
      const now = Date.now();
      if (now - lastEmit < 500 && !extra.force) return; // throttle
      lastEmit = now;

      const elapsed = (now - startTime) / 1000;
      const percent = totalSize > 0 ? Math.min(99, (bytesWritten / totalSize) * 100) : 0;
      const rate = elapsed > 0 ? bytesWritten / elapsed : 0;
      const eta = rate > 0 && totalSize > bytesWritten ? (totalSize - bytesWritten) / rate : 0;

      const progress = {
        jobId: id,
        bytesWritten,
        totalSize,
        percent: percent.toFixed(1),
        rate: humanSize(rate) + '/s',
        elapsed: elapsed.toFixed(0),
        eta: eta > 0 ? eta.toFixed(0) : '...',
        fileCount,
        ...extra
      };
      io.emit('job:progress', progress);
      updateJob(id, { progress });
    };

    proc.stderr.on('data', (data) => {
      const lines = data.toString().split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        // count files
        if (!line.includes('checkpoint')) fileCount++;
        const p = parseTarProgress(line, totalSize);
        if (p) bytesWritten = p.bytesWritten;
        emitProgress();
      }
    });

    proc.stdout.on('data', (data) => {
      const lines = data.toString().split('\n');
      lines.forEach(l => { if (l.trim()) fileCount++; });
      emitProgress();
    });

    proc.on('close', async (code) => {
      activeProcesses.delete(id);
      if (code === 0) {
        const stat = await fs.stat(destFile).catch(() => ({ size: 0 }));
        const finalState = {
          status: 'completed',
          completedAt: Date.now(),
          finalSize: stat.size,
          fileCount
        };
        updateJob(id, finalState);
        io.emit('job:update', getJobStore()[id]);
        emitProgress({ percent: '100', force: true });
        resolve();
      } else if (code === null || code === 143) {
        updateJob(id, { status: 'paused' });
        io.emit('job:update', getJobStore()[id]);
        resolve();
      } else {
        updateJob(id, { status: 'failed', error: `tar exited with code ${code}` });
        io.emit('job:update', getJobStore()[id]);
        reject(new Error(`tar exited with code ${code}`));
      }
    });

    proc.on('error', (err) => {
      activeProcesses.delete(id);
      updateJob(id, { status: 'failed', error: err.message });
      io.emit('job:update', getJobStore()[id]);
      reject(err);
    });
  });
}

// ── Disk Image Backup (dd) ───────────────────────────────────────────────────

async function backupDiskImage(job, io) {
  const { id, source, destFile } = job;

  // Get disk size
  let totalSize = 0;
  try {
    const out = execSync(`blockdev --getsize64 "${source}" 2>/dev/null`).toString().trim();
    totalSize = parseInt(out) || 0;
  } catch (_) {
    try {
      const out = execSync(`lsblk -b -d -n -o SIZE "${source}" 2>/dev/null`).toString().trim();
      totalSize = parseInt(out) || 0;
    } catch (_2) {}
  }

  updateJob(id, { status: 'running', totalSize, startedAt: Date.now() });
  io.emit('job:update', getJobStore()[id]);

  // dd with gzip compression and progress via status=progress
  const ddArgs = [
    `if=${source}`,
    `of=${destFile}.img`,
    'bs=4M',
    'conv=sync,noerror',
    'status=progress'
  ];

  return new Promise((resolve, reject) => {
    const proc = spawn('dd', ddArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
    activeProcesses.set(id, proc);

    const startTime = Date.now();
    let lastEmit = 0;
    let bytesWritten = 0;
    let rate = '0 B/s';

    const emitProgress = (extra = {}) => {
      const now = Date.now();
      if (now - lastEmit < 800 && !extra.force) return;
      lastEmit = now;
      const elapsed = (now - startTime) / 1000;
      const percent = totalSize > 0 ? Math.min(99, (bytesWritten / totalSize) * 100) : 0;
      const rateBytes = elapsed > 0 ? bytesWritten / elapsed : 0;
      const eta = rateBytes > 0 && totalSize > bytesWritten ? (totalSize - bytesWritten) / rateBytes : 0;
      const progress = {
        jobId: id,
        bytesWritten,
        totalSize,
        percent: percent.toFixed(1),
        rate,
        elapsed: elapsed.toFixed(0),
        eta: eta > 0 ? eta.toFixed(0) : '...',
        ...extra
      };
      io.emit('job:progress', progress);
      updateJob(id, { progress });
    };

    // dd writes progress to stderr
    proc.stderr.on('data', (data) => {
      const lines = data.toString().split('\n');
      for (const line of lines) {
        const p = parseDdProgress(line);
        if (p) {
          bytesWritten = p.bytesWritten;
          rate = p.rate;
          emitProgress();
        }
      }
    });

    proc.on('close', async (code) => {
      activeProcesses.delete(id);
      const finalFile = `${destFile}.img`;
      if (code === 0) {
        // Optionally compress with gzip
        try {
          io.emit('job:log', { jobId: id, msg: 'Compressing image with gzip...' });
          execSync(`gzip -1 "${finalFile}"`);
        } catch (_) {}
        const stat = await fs.stat(finalFile + '.gz').catch(() => fs.stat(finalFile).catch(() => ({ size: 0 })));
        updateJob(id, { status: 'completed', completedAt: Date.now(), finalSize: stat.size });
        io.emit('job:update', getJobStore()[id]);
        emitProgress({ percent: '100', force: true });
        resolve();
      } else if (code === null) {
        updateJob(id, { status: 'paused' });
        io.emit('job:update', getJobStore()[id]);
        resolve();
      } else {
        updateJob(id, { status: 'failed', error: `dd exited with code ${code}` });
        io.emit('job:update', getJobStore()[id]);
        reject(new Error(`dd exited with code ${code}`));
      }
    });

    proc.on('error', (err) => {
      activeProcesses.delete(id);
      updateJob(id, { status: 'failed', error: err.message });
      io.emit('job:update', getJobStore()[id]);
      reject(err);
    });
  });
}

// ── Rsync Incremental Backup ─────────────────────────────────────────────────

async function backupRsync(job, io) {
  const { id, source, destFile, excludes } = job;

  // destFile is actually destDir for rsync
  const destDir = destFile;
  await fs.ensureDir(destDir);

  let totalSize = 0;
  try {
    const out = execSync(`du -sb "${source}" 2>/dev/null | awk '{print $1}'`).toString().trim();
    totalSize = parseInt(out) || 0;
  } catch (_) {}

  updateJob(id, { status: 'running', totalSize, startedAt: Date.now() });
  io.emit('job:update', getJobStore()[id]);

  const args = [
    '-avz',
    '--progress',
    '--stats',
    '--human-readable',
    '--delete',
    '--partial',           // allow resume
    '--inplace',
  ];

  if (excludes && excludes.length) {
    excludes.forEach(ex => args.push(`--exclude=${ex}`));
  }

  args.push(source + '/', destDir + '/');

  return new Promise((resolve, reject) => {
    const proc = spawn('rsync', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    activeProcesses.set(id, proc);

    const startTime = Date.now();
    let lastEmit = 0;
    let bytesWritten = 0;
    let fileCount = 0;
    let currentFile = '';
    let rate = '0 B/s';

    const emitProgress = (extra = {}) => {
      const now = Date.now();
      if (now - lastEmit < 400 && !extra.force) return;
      lastEmit = now;
      const elapsed = (now - startTime) / 1000;
      const percent = totalSize > 0 ? Math.min(99, (bytesWritten / totalSize) * 100) : 0;
      const rateBytes = elapsed > 0 ? bytesWritten / elapsed : 0;
      const eta = rateBytes > 0 && totalSize > bytesWritten ? (totalSize - bytesWritten) / rateBytes : 0;
      const progress = {
        jobId: id,
        bytesWritten,
        totalSize,
        percent: percent.toFixed(1),
        rate,
        elapsed: elapsed.toFixed(0),
        eta: eta > 0 ? eta.toFixed(0) : '...',
        fileCount,
        currentFile,
        ...extra
      };
      io.emit('job:progress', progress);
      updateJob(id, { progress });
    };

    proc.stdout.on('data', (data) => {
      const lines = data.toString().split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;

        // Rsync progress line: "     1,234,567  99%  12.34MB/s    0:00:01 (xfr#1, to-chk=0/1)"
        const progressMatch = line.match(/^\s*([\d,]+)\s+(\d+)%\s+([\d.]+\S+)/);
        if (progressMatch) {
          bytesWritten = parseInt(progressMatch[1].replace(/,/g, ''));
          rate = progressMatch[3];
          emitProgress();
          continue;
        }

        // File being transferred
        if (!line.startsWith(' ') && !line.startsWith('sent') && !line.startsWith('total')) {
          currentFile = line.trim();
          fileCount++;
          io.emit('job:log', { jobId: id, msg: currentFile });
        }

        // Stats block
        const totalMatch = line.match(/Total transferred file size:\s+([\d,]+)/);
        if (totalMatch) {
          bytesWritten = parseInt(totalMatch[1].replace(/,/g, ''));
        }
      }
      emitProgress();
    });

    proc.stderr.on('data', (data) => {
      io.emit('job:log', { jobId: id, msg: data.toString().trim(), level: 'warn' });
    });

    proc.on('close', async (code) => {
      activeProcesses.delete(id);
      if (code === 0 || code === 24) { // 24 = partial transfer (files vanished)
        const stat = await fs.stat(destDir).catch(() => ({ size: 0 }));
        updateJob(id, { status: 'completed', completedAt: Date.now(), fileCount });
        io.emit('job:update', getJobStore()[id]);
        emitProgress({ percent: '100', force: true });
        resolve();
      } else if (code === null) {
        updateJob(id, { status: 'paused' });
        io.emit('job:update', getJobStore()[id]);
        resolve();
      } else {
        updateJob(id, { status: 'failed', error: `rsync exited with code ${code}` });
        io.emit('job:update', getJobStore()[id]);
        reject(new Error(`rsync exited with code ${code}`));
      }
    });

    proc.on('error', (err) => {
      activeProcesses.delete(id);
      updateJob(id, { status: 'failed', error: err.message });
      io.emit('job:update', getJobStore()[id]);
      reject(err);
    });
  });
}

// ── Public API ───────────────────────────────────────────────────────────────

async function startBackup(options, io) {
  const id = uuidv4();
  const { type, source, destination, name, excludes, compression } = options;

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const safeName = (name || 'backup').replace(/[^a-zA-Z0-9_-]/g, '_');

  let destFile;
  if (type === 'rsync') {
    destFile = path.join(destination || BACKUP_DIR, `${safeName}_${timestamp}`);
  } else if (type === 'image') {
    destFile = path.join(destination || BACKUP_DIR, `${safeName}_${timestamp}`);
  } else {
    destFile = path.join(destination || BACKUP_DIR, `${safeName}_${timestamp}.tar.gz`);
  }

  const job = {
    id,
    type,
    name: safeName,
    source,
    destFile,
    excludes: excludes || [],
    compression: compression || 'gzip',
    status: 'queued',
    createdAt: Date.now(),
    progress: { percent: '0', rate: '0 B/s', bytesWritten: 0 }
  };

  const store = getJobStore();
  store[id] = job;
  saveJobStore(store);

  io.emit('job:created', job);

  // Run async
  setImmediate(async () => {
    try {
      if (type === 'directory') await backupDirectory(job, io);
      else if (type === 'image') await backupDiskImage(job, io);
      else if (type === 'rsync') await backupRsync(job, io);
    } catch (err) {
      console.error(`[BackupEngine] Job ${id} error:`, err.message);
    }
  });

  return job;
}

function pauseBackup(jobId) {
  const proc = activeProcesses.get(jobId);
  if (proc && proc.pid) {
    try {
      process.kill(proc.pid, 'SIGSTOP');
      updateJob(jobId, { status: 'paused' });
      return true;
    } catch (err) {
      console.error('Pause failed:', err.message);
    }
  }
  return false;
}

function resumeBackup(jobId, io) {
  const proc = activeProcesses.get(jobId);
  if (proc && proc.pid) {
    try {
      process.kill(proc.pid, 'SIGCONT');
      updateJob(jobId, { status: 'running' });
      const store = getJobStore();
      io.emit('job:update', store[jobId]);
      return true;
    } catch (err) {
      console.error('Resume failed:', err.message);
    }
  }
  // If process died (e.g. for rsync --partial), restart
  const store = getJobStore();
  const job = store[jobId];
  if (job && job.type === 'rsync') {
    setImmediate(() => backupRsync(job, io));
    return true;
  }
  return false;
}

function cancelBackup(jobId) {
  const proc = activeProcesses.get(jobId);
  if (proc && proc.pid) {
    try {
      proc.kill('SIGTERM');
    } catch (_) {}
    activeProcesses.delete(jobId);
  }
  updateJob(jobId, { status: 'cancelled', completedAt: Date.now() });
  return true;
}

module.exports = { startBackup, pauseBackup, resumeBackup, cancelBackup };
