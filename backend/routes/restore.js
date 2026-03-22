const express = require('express');
const router = express.Router();
const { startRestore, cancelRestore, verifyBackup } = require('../services/restoreEngine');
const fs = require('fs-extra');

// Start a restore
router.post('/start', async (req, res) => {
  try {
    const { type, source, destination, name } = req.body;

    if (!type || !source) {
      return res.status(400).json({ error: 'type and source are required' });
    }

    if (!['directory', 'image', 'rsync'].includes(type)) {
      return res.status(400).json({ error: 'type must be directory, image, or rsync' });
    }

    if (!await fs.pathExists(source)) {
      return res.status(400).json({ error: `Source backup not found: ${source}` });
    }

    const job = await startRestore({ type, source, destination, name }, req.io);
    res.json({ success: true, job });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Verify backup integrity
router.post('/verify', async (req, res) => {
  try {
    const { source } = req.body;
    if (!source) return res.status(400).json({ error: 'source is required' });

    req.io.emit('job:log', { jobId: 'verify', msg: `Verifying ${source}...` });
    const result = await verifyBackup(source, req.io, 'verify');
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Cancel a restore
router.post('/:id/cancel', (req, res) => {
  const ok = cancelRestore(req.params.id);
  req.io.emit('job:update', { id: req.params.id, status: 'cancelled' });
  res.json({ success: ok });
});

module.exports = router;
