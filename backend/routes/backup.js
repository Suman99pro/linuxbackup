const express = require('express');
const router = express.Router();
const { startBackup, pauseBackup, resumeBackup, cancelBackup } = require('../services/backupEngine');
const { listBackups } = require('../utils/fsHelpers');
const { getJobStore, deleteJob } = require('../services/jobStore');
const fs = require('fs-extra');
const path = require('path');

// Start a new backup
router.post('/start', async (req, res) => {
  try {
    const { type, source, destination, name, excludes, compression } = req.body;

    if (!type || !source) {
      return res.status(400).json({ error: 'type and source are required' });
    }

    if (!['directory', 'image', 'rsync'].includes(type)) {
      return res.status(400).json({ error: 'type must be directory, image, or rsync' });
    }

    // Validate source exists
    if (!await fs.pathExists(source) && type !== 'image') {
      return res.status(400).json({ error: `Source path does not exist: ${source}` });
    }

    const job = await startBackup({ type, source, destination, name, excludes, compression }, req.io);
    res.json({ success: true, job });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Pause a backup
router.post('/:id/pause', (req, res) => {
  const ok = pauseBackup(req.params.id);
  if (ok) {
    req.io.emit('job:update', { id: req.params.id, status: 'paused' });
    res.json({ success: true });
  } else {
    res.status(404).json({ error: 'Job not found or not pausable' });
  }
});

// Resume a backup
router.post('/:id/resume', (req, res) => {
  const ok = resumeBackup(req.params.id, req.io);
  if (ok) {
    res.json({ success: true });
  } else {
    res.status(404).json({ error: 'Job not found or not resumable' });
  }
});

// Cancel a backup
router.post('/:id/cancel', (req, res) => {
  const ok = cancelBackup(req.params.id);
  req.io.emit('job:update', { id: req.params.id, status: 'cancelled' });
  res.json({ success: ok });
});

// List backup files on disk
router.get('/files', (_req, res) => {
  try {
    const files = listBackups();
    res.json({ files });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete a backup file
router.delete('/files/:filename', async (req, res) => {
  try {
    const { listBackups } = require('../utils/fsHelpers');
    const files = listBackups();
    const file = files.find(f => f.name === req.params.filename);
    if (!file) return res.status(404).json({ error: 'File not found' });
    await fs.remove(file.path);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
