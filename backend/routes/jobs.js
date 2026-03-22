const express = require('express');
const router = express.Router();
const { getJobStore, deleteJob } = require('../services/jobStore');

router.get('/', (_req, res) => {
  const store = getJobStore();
  const jobs = Object.values(store).sort((a, b) => b.createdAt - a.createdAt);
  res.json({ jobs });
});

router.get('/:id', (req, res) => {
  const store = getJobStore();
  const job = store[req.params.id];
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

router.delete('/:id', (req, res) => {
  deleteJob(req.params.id);
  res.json({ success: true });
});

router.delete('/', (_req, res) => {
  const store = getJobStore();
  const ids = Object.keys(store);
  const completed = ids.filter(id => ['completed', 'failed', 'cancelled'].includes(store[id].status));
  completed.forEach(id => deleteJob(id));
  res.json({ deleted: completed.length });
});

module.exports = router;
