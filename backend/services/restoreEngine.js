/**
 * RestoreEngine — restore logic
 * Supports: tar.gz (directory restore), dd image restore, rsync restore
 */

const { spawn, execSync } = require('child_process');
const fs = require('fs-extra');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { getJobStore, updateJob, saveJobStore } = require('./jobStore');
const { RESTORE_DIR } = require('../utils/fsHelpers');

const activeRestores = new Map();

function humanSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)} MB`;
  return `${(bytes / 1073741824).toFixed(2)} GB`;
}

// ── Tar Restore ──────────────────────────────────────────────────────────────

async function restoreTar(job, io) {
  const { id, source, destination } = job;

  await fs.ensureDir(destination);

  // Get archive size for progress
  let totalSize = 0;
  try {
    const stat = await fs.stat(source);
    totalSize = stat.size;
  } catch (_) {}

  updateJob(id, { status: 'running', totalSize, startedAt: Date.now() });
  io.emit('job:update', getJobStore()[id]);

  const args = ['-xzf', source, '-C', destination, '--checkpoint=100', '--checkpoint-action=echo=%u', '-v'];

  return new Promise((resolve, reject) => {
    const proc = spawn('tar', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    activeRestores.set(id, proc);

    const startTime = Date.now();
    let lastEmit = 0;
    let fileCount = 0;

    const emitProgress = (extra = {}) => {
      const now = Date.now();
      if (now - lastEmit < 500 && !extra.force) return;
      lastEmit = now;
      const elapsed = (now - startTime) / 1000;
      const progress = { jobId: id, elapsed: elapsed.toFixed(0), fileCount, ...extra };
      io.emit('job:progress', progress);
      updateJob(id, { progress });
    };

    proc.stdout.on('data', (d) => {
      const lines = d.toString().split('\n');
      lines.forEach(l => { if (l.trim()) { fileCount++; io.emit('job:log', { jobId: id, msg: l.trim() }); } });
      emitProgress();
    });

    proc.stderr.on('data', (d) => {
      const line = d.toString().trim();
      if (line.match(/^\d+$/)) {
        const ckpt = parseInt(line);
        const estimated = ckpt * 10240;
        const percent = totalSize > 0 ? Math.min(99, (estimated / totalSize) * 100) : 0;
        emitProgress({ percent: percent.toFixed(1) });
      }
    });

    proc.on('close', (code) => {
      activeRestores.delete(id);
      if (code === 0) {
        updateJob(id, { status: 'completed', completedAt: Date.now(), fileCount });
        io.emit('job:update', getJobStore()[id]);
        emitProgress({ percent: '100', force: true });
        resolve();
      } else {
        updateJob(id, { status: 'failed', error: `tar restore exited with code ${code}` });
        io.emit('job:update', getJobStore()[id]);
        reject(new Error(`code ${code}`));
      }
    });

    proc.on('error', (err) => {
      activeRestores.delete(id);
      updateJob(id, { status: 'failed', error: err.message });
      io.emit('job:update', getJobStore()[id]);
      reject(err);
    });
  });
}

// ── Image Restore (dd) ───────────────────────────────────────────────────────

async function restoreImage(job, io) {
  const { id, source, destination } = job;

  // If source is .gz, decompress on the fly
  const isGz = source.endsWith('.gz');

  let totalSize = 0;
  try {
    const stat = await fs.stat(source);
    totalSize = stat.size;
  } catch (_) {}

  updateJob(id, { status: 'running', totalSize, startedAt: Date.now() });
  io.emit('job:update', getJobStore()[id]);

  io.emit('job:log', { jobId: id, msg: `⚠ Writing image to ${destination} — DO NOT INTERRUPT!`, level: 'warn' });

  let proc;
  if (isGz) {
    // gunzip | dd
    const gunzip = spawn('gunzip', ['-c', source]);
    const dd = spawn('dd', [`of=${destination}`, 'bs=4M', 'conv=sync,noerror', 'status=progress']);
    gunzip.stdout.pipe(dd.stdin);
    proc = dd;
    activeRestores.set(id, gunzip); // kill gunzip to stop
  } else {
    proc = spawn('dd', [`if=${source}`, `of=${destination}`, 'bs=4M', 'conv=sync,noerror', 'status=progress']);
    activeRestores.set(id, proc);
  }

  const startTime = Date.now();
  let lastEmit = 0;

  return new Promise((resolve, reject) => {
    proc.stderr.on('data', (data) => {
      const lines = data.toString().split('\n');
      for (const line of lines) {
        const m = line.match(/^(\d+)\s+bytes.*copied,\s+([\d.]+)\s+s,\s+([\d.]+\s+\S+)/);
        if (m) {
          const bw = parseInt(m[1]);
          const elapsed = parseFloat(m[2]);
          const now = Date.now();
          if (now - lastEmit > 800) {
            lastEmit = now;
            const percent = totalSize > 0 ? Math.min(99, (bw / totalSize) * 100) : 0;
            const progress = { jobId: id, bytesWritten: bw, totalSize, percent: percent.toFixed(1), rate: m[3], elapsed: elapsed.toFixed(0) };
            io.emit('job:progress', progress);
            updateJob(id, { progress });
          }
        }
      }
    });

    proc.on('close', (code) => {
      activeRestores.delete(id);
      if (code === 0 || code === null) {
        updateJob(id, { status: 'completed', completedAt: Date.now() });
        io.emit('job:update', getJobStore()[id]);
        io.emit('job:progress', { jobId: id, percent: '100', force: true });
        resolve();
      } else {
        updateJob(id, { status: 'failed', error: `dd restore exited with code ${code}` });
        io.emit('job:update', getJobStore()[id]);
        reject(new Error(`dd code ${code}`));
      }
    });

    proc.on('error', (err) => {
      activeRestores.delete(id);
      updateJob(id, { status: 'failed', error: err.message });
      io.emit('job:update', getJobStore()[id]);
      reject(err);
    });
  });
}

// ── Rsync Restore ─────────────────────────────────────────────────────────────

async function restoreRsync(job, io) {
  const { id, source, destination } = job;
  await fs.ensureDir(destination);

  updateJob(id, { status: 'running', startedAt: Date.now() });
  io.emit('job:update', getJobStore()[id]);

  const args = ['-avz', '--progress', '--stats', '--human-readable', '--delete', '--partial', source + '/', destination + '/'];

  return new Promise((resolve, reject) => {
    const proc = spawn('rsync', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    activeRestores.set(id, proc);

    let fileCount = 0;
    const startTime = Date.now();
    let lastEmit = 0;

    proc.stdout.on('data', (data) => {
      const lines = data.toString().split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        const m = line.match(/^\s*([\d,]+)\s+(\d+)%\s+([\d.]+\S+)/);
        if (m) {
          const now = Date.now();
          if (now - lastEmit > 500) {
            lastEmit = now;
            const bw = parseInt(m[1].replace(/,/g, ''));
            const percent = m[2];
            const rate = m[3];
            const elapsed = ((now - startTime) / 1000).toFixed(0);
            const progress = { jobId: id, bytesWritten: bw, percent, rate, elapsed, fileCount };
            io.emit('job:progress', progress);
            updateJob(id, { progress });
          }
        } else {
          fileCount++;
          io.emit('job:log', { jobId: id, msg: line.trim() });
        }
      }
    });

    proc.on('close', (code) => {
      activeRestores.delete(id);
      if (code === 0 || code === 24) {
        updateJob(id, { status: 'completed', completedAt: Date.now(), fileCount });
        io.emit('job:update', getJobStore()[id]);
        io.emit('job:progress', { jobId: id, percent: '100', force: true });
        resolve();
      } else {
        updateJob(id, { status: 'failed', error: `rsync restore code ${code}` });
        io.emit('job:update', getJobStore()[id]);
        reject(new Error(`code ${code}`));
      }
    });

    proc.on('error', (err) => {
      activeRestores.delete(id);
      updateJob(id, { status: 'failed', error: err.message });
      io.emit('job:update', getJobStore()[id]);
      reject(err);
    });
  });
}

// ── Public API ────────────────────────────────────────────────────────────────

async function startRestore(options, io) {
  const id = uuidv4();
  const { type, source, destination, name } = options;

  const dest = destination || RESTORE_DIR;
  await fs.ensureDir(dest);

  const job = {
    id,
    type: 'restore-' + type,
    name: name || path.basename(source),
    source,
    destination: dest,
    status: 'queued',
    createdAt: Date.now(),
    progress: { percent: '0', rate: '0 B/s', bytesWritten: 0 }
  };

  const store = getJobStore();
  store[id] = job;
  saveJobStore(store);

  io.emit('job:created', job);

  setImmediate(async () => {
    try {
      if (type === 'directory') await restoreTar(job, io);
      else if (type === 'image') await restoreImage(job, io);
      else if (type === 'rsync') await restoreRsync(job, io);
    } catch (err) {
      console.error(`[RestoreEngine] Job ${id} error:`, err.message);
    }
  });

  return job;
}

function cancelRestore(jobId) {
  const proc = activeRestores.get(jobId);
  if (proc) {
    try { proc.kill('SIGTERM'); } catch (_) {}
    activeRestores.delete(jobId);
  }
  updateJob(jobId, { status: 'cancelled', completedAt: Date.now() });
  return true;
}

// Verify a backup archive integrity
async function verifyBackup(filePath, io, jobId) {
  return new Promise((resolve) => {
    const ext = path.extname(filePath);
    let proc;

    if (filePath.endsWith('.tar.gz') || filePath.endsWith('.tgz')) {
      proc = spawn('tar', ['-tzf', filePath], { stdio: ['ignore', 'pipe', 'pipe'] });
    } else {
      resolve({ valid: true, note: 'Verification not supported for this type' });
      return;
    }

    let fileCount = 0;
    let error = null;

    proc.stdout.on('data', (d) => {
      const lines = d.toString().split('\n').filter(Boolean);
      fileCount += lines.length;
      if (jobId) io.emit('job:log', { jobId, msg: `Verified ${fileCount} files...` });
    });

    proc.stderr.on('data', (d) => { error = d.toString(); });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve({ valid: true, fileCount });
      } else {
        resolve({ valid: false, error: error || `exit code ${code}` });
      }
    });
  });
}

module.exports = { startRestore, cancelRestore, verifyBackup };
