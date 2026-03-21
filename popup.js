document.addEventListener('DOMContentLoaded', () => {
  loadResults();
  loadApiKey();

  document.getElementById('btnScan').addEventListener('click', triggerScan);
  document.getElementById('btnSave').addEventListener('click', saveApiKey);
  document.getElementById('btnClear').addEventListener('click', clearCache);
});

// ---- Load and display scan results for the active tab ----

function loadResults() {
  chrome.runtime.sendMessage({ type: 'getTabResults' }, results => {
    if (chrome.runtime.lastError) return;

    const list = document.getElementById('userList');
    const entries = Object.entries(results || {});

    if (entries.length === 0) {
      list.innerHTML = '<p class="empty">Open a Reddit thread to start scanning.</p>';
      setSummary(0, 0, 0, 0);
      return;
    }

    entries.sort((a, b) => (b[1].score ?? -1) - (a[1].score ?? -1));

    let bots = 0, sus = 0, humans = 0;
    list.innerHTML = '';

    for (const [username, r] of entries) {
      if (r.score < 0) continue;

      let cat;
      if (r.knownBot)       { cat = 'known'; bots++; }
      else if (r.score >= 60) { cat = 'bot'; bots++; }
      else if (r.score >= 30) { cat = 'suspicious'; sus++; }
      else                    { cat = 'human'; humans++; }

      const row = document.createElement('div');
      row.className = 'uitem';
      row.innerHTML = `
        <div class="uinfo">
          <div class="udot ${cat}"></div>
          <span class="uname">u/${username}</span>
        </div>
        <div>
          <span class="uscore ${cat}">${r.score}%</span>
          <span class="utier">T${r.tier}</span>
        </div>`;
      list.appendChild(row);
    }

    setSummary(entries.length, bots, sus, humans);
  });
}

function setSummary(total, bots, sus, humans) {
  document.getElementById('statTotal').textContent = total;
  document.getElementById('statBots').textContent = bots;
  document.getElementById('statSus').textContent = sus;
  document.getElementById('statHuman').textContent = humans;
}

// ---- Trigger a scan on the active tab ----

function triggerScan() {
  chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
    if (!tabs[0]) return;
    chrome.tabs.sendMessage(tabs[0].id, { type: 'triggerScan' });

    const btn = document.getElementById('btnScan');
    btn.textContent = 'Scanning…';
    btn.disabled = true;

    setTimeout(() => {
      btn.textContent = 'Scan Page';
      btn.disabled = false;
      loadResults();
    }, 3000);
  });
}

// ---- API key management ----

function loadApiKey() {
  chrome.storage.sync.get('geminiApiKey', res => {
    if (res.geminiApiKey) {
      document.getElementById('apiKey').value = res.geminiApiKey;
    }
  });
}

function saveApiKey() {
  const key = document.getElementById('apiKey').value.trim();
  chrome.storage.sync.set({ geminiApiKey: key }, () => {
    flash('btnSave', 'Saved!', 'Save');
  });
}

// ---- Clear cache ----

function clearCache() {
  chrome.runtime.sendMessage({ type: 'clearCache' }, () => {
    flash('btnClear', 'Cleared!', 'Clear Cache');
    loadResults();
  });
}

// ---- Helpers ----

function flash(id, temp, original) {
  const el = document.getElementById(id);
  el.textContent = temp;
  setTimeout(() => { el.textContent = original; }, 1500);
}
