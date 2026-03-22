const express = require('express');
const router = express.Router();
const { getDisks, getFilesystems, getSystemInfo } = require('../services/diskService');

router.get('/', (_req, res) => {
  try {
    const disks = getDisks();
    res.json({ disks });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/filesystems', (_req, res) => {
  try {
    const filesystems = getFilesystems();
    res.json({ filesystems });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/system', (_req, res) => {
  try {
    const info = getSystemInfo();
    res.json(info);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
