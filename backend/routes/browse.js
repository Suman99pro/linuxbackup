const express = require('express');
const router = express.Router();
const fs = require('fs-extra');
const path = require('path');
const { execSync } = require('child_process');

// Browse any directory on the filesystem
router.get('/browse', async (req, res) => {
  const dirPath = req.query.path || '/';

  try {
    const resolved = path.resolve(dirPath);
    const entries = await fs.readdir(resolved, { withFileTypes: true });

    const items = [];
    for (const entry of entries) {
      // Skip broken symlinks / permission errors silently
      try {
        const fullPath = path.join(resolved, entry.name);
        const stat = await fs.stat(fullPath).catch(() => null);
        if (!stat) continue;

        items.push({
          name: entry.name,
          path: fullPath,
          isDirectory: entry.isDirectory() || (entry.isSymbolicLink() && stat.isDirectory()),
          isSymlink: entry.isSymbolicLink(),
          size: stat.size,
          mtime: stat.mtime,
        });
      } catch (_) {}
    }

    // Sort: directories first, then files, both alphabetical
    items.sort((a, b) => {
      if (a.isDirectory && !b.isDirectory) return -1;
      if (!a.isDirectory && b.isDirectory) return 1;
      return a.name.localeCompare(b.name);
    });

    // Build breadcrumb
    const parts = resolved.split('/').filter(Boolean);
    const breadcrumb = [{ name: '/', path: '/' }];
    let acc = '';
    for (const part of parts) {
      acc += '/' + part;
      breadcrumb.push({ name: part, path: acc });
    }

    res.json({ path: resolved, breadcrumb, items });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Get quick-access roots: /, /home/*, /mnt/*, /media/*, /data/*
router.get('/roots', (_req, res) => {
  const roots = ['/'];
  const candidates = ['/home', '/mnt', '/media', '/data', '/var', '/opt', '/etc', '/tmp'];

  for (const base of candidates) {
    try {
      if (fs.existsSync(base)) {
        const sub = fs.readdirSync(base, { withFileTypes: true });
        if (sub.length === 0) {
          roots.push(base);
        } else {
          sub.filter(e => e.isDirectory()).forEach(e => {
            roots.push(path.join(base, e.name));
          });
        }
      }
    } catch (_) {}
  }

  res.json({ roots });
});

module.exports = router;
