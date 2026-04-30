const backendUrlInput = document.getElementById('backendUrl');
const apiKeyInput = document.getElementById('apiKey');
const connectBtn = document.getElementById('connectBtn');
const disconnectBtn = document.getElementById('disconnectBtn');
const saveBtn = document.getElementById('saveBtn');
const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');

// Load saved settings
chrome.storage.local.get(['apiKey', 'backendUrl'], (data) => {
  apiKeyInput.value = data.apiKey || '';
  backendUrlInput.value = data.backendUrl || 'ws://localhost:3005/ws/browser-bridge';
});

// Get current status
chrome.runtime.sendMessage({ type: 'get_status' }, (response) => {
  if (chrome.runtime.lastError) {
    updateUI(false, 'Service worker not ready');
    return;
  }
  if (response) updateUI(response.connected);
});

// Listen for status changes
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'status') {
    updateUI(msg.connected, msg.error);
  }
});

connectBtn.addEventListener('click', async () => {
  statusText.textContent = 'Saving settings...';

  // Save settings first
  await chrome.storage.local.set({
    apiKey: apiKeyInput.value,
    backendUrl: backendUrlInput.value || 'ws://localhost:3005/ws/browser-bridge',
  });

  statusText.textContent = 'Connecting...';

  // Then connect
  chrome.runtime.sendMessage({ type: 'connect' }, (response) => {
    if (chrome.runtime.lastError) {
      updateUI(false, 'Failed: ' + chrome.runtime.lastError.message);
      return;
    }
    if (response && response.error) {
      updateUI(false, response.error);
    }
    // Status will be updated via broadcast
  });
});

disconnectBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'disconnect' });
});

saveBtn.addEventListener('click', async () => {
  await chrome.storage.local.set({
    apiKey: apiKeyInput.value,
    backendUrl: backendUrlInput.value || 'ws://localhost:3005/ws/browser-bridge',
  });
  statusText.textContent = 'Settings saved';
  setTimeout(() => {
    chrome.runtime.sendMessage({ type: 'get_status' }, (r) => {
      if (r) updateUI(r.connected);
    });
  }, 1000);
});

function updateUI(isConnected, error) {
  statusDot.className = 'status-dot ' + (error ? 'error' : isConnected ? 'connected' : 'disconnected');
  connectBtn.style.display = isConnected ? 'none' : '';
  disconnectBtn.style.display = isConnected ? '' : 'none';

  if (error) {
    statusText.textContent = error;
    statusText.className = 'status-text error';
  } else if (isConnected) {
    statusText.textContent = 'Connected to Octi backend';
    statusText.className = 'status-text connected';
  } else {
    statusText.textContent = 'Not connected';
    statusText.className = 'status-text';
  }
}
