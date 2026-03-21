document.addEventListener('DOMContentLoaded', () => {
  loadResults();
  loadApiKey();
  loadRedditAuth();
  loadBotSettings();

  document.getElementById('btnScan').addEventListener('click', triggerScan);
  document.getElementById('btnSave').addEventListener('click', saveApiKey);
  document.getElementById('btnClear').addEventListener('click', clearCache);
  document.getElementById('btnLogin').addEventListener('click', handleRedditLogin);
  document.getElementById('botAction').addEventListener('change', saveBotSettings);
  document.getElementById('botThreshold').addEventListener('change', saveBotSettings);
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

    let rateLimited = 0;
    for (const [username, r] of entries) {
      let cat, display;

      if (r.errorType === 'ratelimited') {
        cat = 'ratelimited';
        rateLimited++;
        display = '\u{23F3} Rate Limited';
      } else if (r.score < 0 && r.errorType) {
        cat = 'known';
        bots++;
        const labels = { suspended: '\u{1F6A8} Suspended', banned: '\u{1F528} Banned', deleted: '\u{1F6AB} Deleted' };
        display = labels[r.errorType] || '? Error';
      } else if (r.score < 0) {
        continue;
      } else if (r.knownBot) {
        cat = 'known'; bots++;
        display = `${r.score}%`;
      } else if (r.score >= 40) {
        cat = 'bot'; bots++;
        display = `${r.score}%`;
      } else if (r.score >= 20) {
        cat = 'suspicious'; sus++;
        display = `${r.score}%`;
      } else {
        cat = 'human'; humans++;
        display = `${r.score}%`;
      }

      const row = document.createElement('div');
      row.className = 'uitem';
      row.innerHTML = `
        <div class="uinfo">
          <div class="udot ${cat}"></div>
          <a class="uname uname-link" href="https://www.reddit.com/user/${username}" target="_blank">u/${username}</a>
        </div>
        <div>
          <span class="uscore ${cat}">${display}</span>
          ${r.errorType !== 'ratelimited' ? `<span class="utier">T${r.tier}</span>` : ''}
        </div>`;
      list.appendChild(row);
    }

    if (rateLimited > 0) {
      const notice = document.createElement('div');
      notice.className = 'rate-limit-notice';
      notice.textContent = `Reddit is rate limiting requests. ${rateLimited} user(s) could not be scanned — try again in a minute.`;
      list.prepend(notice);
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
    btn.textContent = 'Scanning\u2026';
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

// ---- Reddit OAuth ----

function loadRedditAuth() {
  chrome.runtime.sendMessage({ type: 'getRedirectUrl' }, res => {
    if (res?.url) {
      document.getElementById('redirectUri').textContent = res.url;
    }
  });

  chrome.runtime.sendMessage({ type: 'getRedditAuth' }, res => {
    if (chrome.runtime.lastError) return;
    const btn = document.getElementById('btnLogin');
    const status = document.getElementById('authStatus');
    const clientInput = document.getElementById('clientId');

    if (res?.loggedIn) {
      btn.textContent = 'Logout';
      btn.className = 'btn btn-ghost';
      status.textContent = '\u2713 Logged in \u2014 using authenticated requests (higher rate limit)';
      status.style.color = '#22c55e';
      if (res.clientId) clientInput.value = res.clientId;
    } else {
      btn.textContent = 'Login';
      btn.className = 'btn btn-primary';
      status.textContent = 'Not logged in \u2014 limited API requests';
      status.style.color = '';
      if (res?.clientId) clientInput.value = res.clientId;
    }
  });
}

function handleRedditLogin() {
  const btn = document.getElementById('btnLogin');

  if (btn.textContent === 'Logout') {
    chrome.runtime.sendMessage({ type: 'redditLogout' }, () => loadRedditAuth());
    return;
  }

  const clientId = document.getElementById('clientId').value.trim();
  if (!clientId) {
    flash('btnLogin', 'Need Client ID', 'Login');
    return;
  }

  btn.textContent = 'Connecting\u2026';
  btn.disabled = true;

  chrome.runtime.sendMessage({ type: 'redditLogin', clientId }, res => {
    btn.disabled = false;
    if (res?.error) {
      btn.textContent = 'Failed';
      setTimeout(() => { btn.textContent = 'Login'; }, 2000);
    } else {
      loadRedditAuth();
    }
  });
}

// ---- Bot action settings ----

function loadBotSettings() {
  chrome.storage.sync.get(['botAction', 'botThreshold'], res => {
    if (res.botAction) document.getElementById('botAction').value = res.botAction;
    if (res.botThreshold != null) document.getElementById('botThreshold').value = res.botThreshold;
  });
}

function saveBotSettings() {
  const action = document.getElementById('botAction').value;
  const threshold = parseInt(document.getElementById('botThreshold').value) || 40;
  chrome.storage.sync.set({ botAction: action, botThreshold: threshold });
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
