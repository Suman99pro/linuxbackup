/**
 * diskService — discovers available disks, partitions, and mount points
 * Uses lsblk, df, and /proc/mounts for comprehensive Linux disk info
 */

const { execSync } = require('child_process');
const fs = require('fs-extra');

function safeExec(cmd) {
  try {
    return execSync(cmd, { timeout: 8000 }).toString().trim();
  } catch (_) {
    return '';
  }
}

function getDisks() {
  const disks = [];

  // lsblk JSON output — most reliable
  const lsblkJson = safeExec('lsblk -J -b -o NAME,SIZE,TYPE,FSTYPE,MOUNTPOINT,LABEL,MODEL,SERIAL,VENDOR,TRAN,ROTA,RM,RO,STATE');
  if (lsblkJson) {
    try {
      const parsed = JSON.parse(lsblkJson);
      const flattenDevice = (dev, parent = null) => {
        const entry = {
          name: dev.name,
          path: `/dev/${dev.name}`,
          size: parseInt(dev.size) || 0,
          sizeHuman: humanSize(parseInt(dev.size) || 0),
          type: dev.type,
          fstype: dev.fstype || '',
          mountpoint: dev.mountpoint || '',
          label: dev.label || '',
          model: dev.model || '',
          serial: dev.serial || '',
          vendor: dev.vendor || '',
          transport: dev.tran || '',
          rotational: dev.rota === '1',
          removable: dev.rm === '1',
          readonly: dev.ro === '1',
          state: dev.state || '',
          parent,
          recommended: false,
          warnings: []
        };

        // Safety checks
        if (entry.readonly) entry.warnings.push('Read-only device');
        if (entry.removable) entry.warnings.push('Removable media');

        // Recommendation logic for image backup destination
        if (entry.type === 'disk' || entry.type === 'part') {
          if (!entry.readonly && !entry.removable) {
            if (entry.size > 10 * 1024 * 1024 * 1024) { // > 10GB
              entry.recommended = true;
            }
          }
          if (entry.transport === 'usb') entry.warnings.push('USB device — slower transfers');
          if (entry.transport === 'nvme') entry.warnings.push('');
        }

        disks.push(entry);

        if (dev.children) {
          dev.children.forEach(child => flattenDevice(child, dev.name));
        }
      };

      parsed.blockdevices.forEach(dev => flattenDevice(dev));
    } catch (err) {
      console.error('lsblk parse error:', err.message);
    }
  }

  return disks;
}

function getFilesystems() {
  const mounts = [];

  // df for usage stats
  const dfOut = safeExec("df -B1 --output=source,fstype,size,used,avail,pcent,target 2>/dev/null | tail -n +2");
  if (dfOut) {
    const lines = dfOut.split('\n');
    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 7) continue;
      const [source, fstype, size, used, avail, pcent, ...targetParts] = parts;
      const target = targetParts.join(' ');

      // Skip virtual filesystems
      if (['tmpfs', 'devtmpfs', 'devfs', 'sysfs', 'proc', 'cgroup', 'pstore', 'debugfs', 'tracefs', 'securityfs', 'hugetlbfs', 'mqueue', 'fusectl'].includes(fstype)) continue;
      if (target.startsWith('/sys') || target.startsWith('/proc') || target.startsWith('/dev/pts')) continue;

      const sizeB = parseInt(size) || 0;
      const usedB = parseInt(used) || 0;
      const availB = parseInt(avail) || 0;
      const usedPercent = parseInt(pcent) || 0;

      mounts.push({
        device: source,
        fstype,
        size: sizeB,
        sizeHuman: humanSize(sizeB),
        used: usedB,
        usedHuman: humanSize(usedB),
        avail: availB,
        availHuman: humanSize(availB),
        usedPercent,
        mountpoint: target,
        recommended: availB > 5 * 1024 * 1024 * 1024 && usedPercent < 85
      });
    }
  }

  return mounts;
}

function getSystemInfo() {
  return {
    hostname: safeExec('hostname'),
    kernel: safeExec('uname -r'),
    arch: safeExec('uname -m'),
    uptime: safeExec('uptime -p'),
    cpuInfo: safeExec("grep 'model name' /proc/cpuinfo | head -1 | cut -d: -f2").trim(),
    memTotal: parseInt(safeExec("grep MemTotal /proc/meminfo | awk '{print $2}'")) * 1024 || 0,
    memFree: parseInt(safeExec("grep MemAvailable /proc/meminfo | awk '{print $2}'")) * 1024 || 0,
  };
}

function humanSize(bytes) {
  if (!bytes || bytes < 1024) return `${bytes || 0} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)} MB`;
  if (bytes < 1099511627776) return `${(bytes / 1073741824).toFixed(2)} GB`;
  return `${(bytes / 1099511627776).toFixed(2)} TB`;
}

module.exports = { getDisks, getFilesystems, getSystemInfo };
