const express = require('express');
const router = express.Router();
const { startBackup, pauseBackup, resumeBackup, cancelBackup } = require('../services/backupEngine');
const { listBackups } = require('../utils/fsHelpers');
const fs = require('fs-extra');

// ── Debug route — confirms which code version is loaded ──────────────────────
router.get('/version', (_req, res) => {
  res.json({ version: 'v3-fixed', time: new Date().toISOString() });
});

// ── List backup files ─────────────────────────────────────────────────────────
router.get('/files', (_req, res) => {
  try {
    res.json({ files: listBackups() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Delete a backup file via POST body (avoids all HTTP method/routing issues) 
// POST /api/backup/delete  { "name": "filename.tar.gz" }
router.post('/delete', async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required in request body' });

    const files = listBackups();
    const file = files.find(f => f.name === name);
    if (!file) return res.status(404).json({ error: `File not found: ${name}` });

    await fs.remove(file.path);
    res.json({ success: true, deleted: name });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Start backup ──────────────────────────────────────────────────────────────
router.post('/start', async (req, res) => {
  try {
    const { type, source, destination, name, excludes, compression } = req.body;
    if (!type || !source) return res.status(400).json({ error: 'type and source are required' });
    if (!['directory', 'image', 'rsync'].includes(type)) return res.status(400).json({ error: 'invalid type' });
    if (type !== 'image' && !await fs.pathExists(source)) return res.status(400).json({ error: `Source does not exist: ${source}` });
    const job = await startBackup({ type, source, destination, name, excludes, compression }, req.io);
    res.json({ success: true, job });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Job controls ──────────────────────────────────────────────────────────────
router.post('/:id/pause', (req, res) => {
  const ok = pauseBackup(req.params.id);
  if (ok) { req.io.emit('job:update', { id: req.params.id, status: 'paused' }); res.json({ success: true }); }
  else res.status(404).json({ error: 'Job not found or not pausable' });
});

router.post('/:id/resume', (req, res) => {
  const ok = resumeBackup(req.params.id, req.io);
  if (ok) res.json({ success: true });
  else res.status(404).json({ error: 'Job not found or not resumable' });
});

router.post('/:id/cancel', (req, res) => {
  cancelBackup(req.params.id);
  req.io.emit('job:update', { id: req.params.id, status: 'cancelled' });
  res.json({ success: true });
});

module.exports = router;
