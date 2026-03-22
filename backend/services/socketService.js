const { getJobStore } = require('./jobStore');
const { pauseBackup, resumeBackup, cancelBackup } = require('./backupEngine');
const { cancelRestore } = require('./restoreEngine');

function initSocketHandlers(io) {
  io.on('connection', (socket) => {
    console.log(`[Socket] Client connected: ${socket.id}`);

    // Send current jobs state on connect
    socket.emit('jobs:state', getJobStore());

    socket.on('job:pause', ({ jobId }) => {
      const ok = pauseBackup(jobId);
      socket.emit('job:paused', { jobId, ok });
    });

    socket.on('job:resume', ({ jobId }) => {
      const ok = resumeBackup(jobId, io);
      socket.emit('job:resumed', { jobId, ok });
    });

    socket.on('job:cancel', ({ jobId, isRestore }) => {
      const ok = isRestore ? cancelRestore(jobId) : cancelBackup(jobId);
      socket.emit('job:cancelled', { jobId, ok });
      io.emit('job:update', { id: jobId, status: 'cancelled' });
    });

    socket.on('disconnect', () => {
      console.log(`[Socket] Client disconnected: ${socket.id}`);
    });
  });
}

module.exports = { initSocketHandlers };
