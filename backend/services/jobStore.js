const fs = require('fs-extra');
const path = require('path');

const JOB_STORE_PATH = path.join('/data', 'jobs.json');

function getJobStore() {
  try {
    if (fs.existsSync(JOB_STORE_PATH)) {
      return fs.readJsonSync(JOB_STORE_PATH);
    }
  } catch (_) {}
  return {};
}

function saveJobStore(store) {
  try {
    fs.ensureDirSync(path.dirname(JOB_STORE_PATH));
    fs.writeJsonSync(JOB_STORE_PATH, store, { spaces: 2 });
  } catch (err) {
    console.error('[JobStore] Save failed:', err.message);
  }
}

function updateJob(id, updates) {
  const store = getJobStore();
  if (store[id]) {
    Object.assign(store[id], updates);
    saveJobStore(store);
  }
}

function deleteJob(id) {
  const store = getJobStore();
  delete store[id];
  saveJobStore(store);
}

module.exports = { getJobStore, saveJobStore, updateJob, deleteJob };
