const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const morgan = require('morgan');

const backupRoutes = require('./routes/backup');
const restoreRoutes = require('./routes/restore');
const diskRoutes = require('./routes/disks');
const jobRoutes = require('./routes/jobs');
const browseRoutes = require('./routes/browse');
const { initSocketHandlers } = require('./services/socketService');
const { ensureDirectories } = require('./utils/fsHelpers');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST', 'DELETE'] },
  maxHttpBufferSize: 1e8
});

app.use(cors());
app.use(express.json());
app.use(morgan('dev'));
app.use(express.static(path.join(__dirname, '../frontend/public')));
app.use((req, _res, next) => { req.io = io; next(); });

app.use('/api/backup', backupRoutes);
app.use('/api/restore', restoreRoutes);
app.use('/api/disks', diskRoutes);
app.use('/api/jobs', jobRoutes);
app.use('/api/fs', browseRoutes);

app.get('/api/health', (_req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));
app.get('*', (_req, res) =>
  res.sendFile(path.join(__dirname, '../frontend/public/index.html'))
);

ensureDirectories();
initSocketHandlers(io);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`[LinuxBackup] Server running on port ${PORT}`);
});

module.exports = { io };
