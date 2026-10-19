const statusEl = document.getElementById('status');
const toggleBtn = document.getElementById('toggle');
const connEl = document.getElementById('connection');
const deviceEl = document.getElementById('device');

async function refresh() {
  const res = await chrome.runtime.sendMessage({ type: 'getStatus' });
  statusEl.textContent = res.trackingEnabled ? 'Tracking: ON' : 'Tracking: PAUSED';
  toggleBtn.textContent = res.trackingEnabled ? 'Pause tracking' : 'Resume tracking';
  if (deviceEl) {
    if (res.enrolled && res.deviceId) {
      deviceEl.textContent = `Device: ${res.deviceId.slice(0, 8)}…`;
      deviceEl.className = 'status ok';
    } else {
      deviceEl.textContent = 'Device: not enrolled — run enroll-local-device.sh then Sync';
      deviceEl.className = 'status bad';
    }
  }
  if (!connEl) return;
  if (!res.serverOk) {
    connEl.textContent = 'Server: offline (start local server on :8787)';
    connEl.className = 'status bad';
  } else if (res.health?.extension_connected) {
    connEl.textContent = 'Server: connected · events arriving';
    connEl.className = 'status ok';
  } else {
    connEl.textContent = 'Server: reachable · waiting for heartbeat';
    connEl.className = 'status';
  }
}

toggleBtn.addEventListener('click', async () => {
  const res = await chrome.runtime.sendMessage({ type: 'getStatus' });
  await chrome.runtime.sendMessage({ type: 'setTracking', enabled: !res.trackingEnabled });
  await refresh();
});

document.getElementById('syncCreds').addEventListener('click', async () => {
  const res = await chrome.runtime.sendMessage({ type: 'syncDeviceCredentials' });
  deviceEl.textContent = res.ok
    ? `Device synced: ${String(res.deviceId).slice(0, 8)}…`
    : 'Sync failed — enroll local device first';
  deviceEl.className = res.ok ? 'status ok' : 'status bad';
  await refresh();
});

document.getElementById('openDash').addEventListener('click', () => {
  chrome.tabs.create({ url: 'http://127.0.0.1:8787/' });
});

refresh();
