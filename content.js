// ============================================================
// RedBot — Content Script
// Injected into Reddit pages. Finds comment authors, requests
// analysis from the background worker, and injects score badges.
// ============================================================

(function () {
  'use strict';

  const ATTR = 'data-redbot';
  const PROCESSED = new Set();

  // ---- Reddit version detection ----

  function isOldReddit() {
    return (
      location.hostname === 'old.reddit.com' ||
      document.getElementById('siteTable') !== null
    );
  }

  // ---- Find username elements in the DOM ----

  function getUsernameElements() {
    const results = [];

    if (isOldReddit()) {
      // Old Reddit: a.author covers both post authors and comment authors
      document.querySelectorAll(`a.author:not([${ATTR}])`).forEach(el => {
        const name = el.textContent.trim();
        if (name) results.push({ el, username: name });
      });
      return results;
    }

    const seen = new Set();
    function addEl(el) {
      if (el.hasAttribute(ATTR) || seen.has(el)) return;
      const href = el.getAttribute('href') || '';
      const match = href.match(/\/user\/([^/?#]+)/);
      const username = match ? match[1] : el.textContent.trim();
      if (username && username !== 'me' && username !== '[deleted]') {
        seen.add(el);
        results.push({ el, username });
      }
    }

    // New Reddit — comment authors
    const commentSelectors = [
      `shreddit-comment:not([${ATTR}]) [slot="commentMeta"] a[href*="/user/"]`,
      `a[data-testid="comment_author_link"]:not([${ATTR}])`,
      `.comment .author:not([${ATTR}])`,
    ];

    // New Reddit — post authors (on post detail pages and subreddit listings)
    const postSelectors = [
      `shreddit-post:not([${ATTR}]) a[href*="/user/"]:not([${ATTR}])`,
      `a[data-testid="post_author_link"]:not([${ATTR}])`,
      `[data-click-id="user"]:not([${ATTR}])`,
      `.Post a[href*="/user/"]:not([${ATTR}])`,
      `[data-testid="post-top-meta"] a[href*="/user/"]:not([${ATTR}])`,
    ];

    for (const sel of [...commentSelectors, ...postSelectors]) {
      try {
        document.querySelectorAll(sel).forEach(addEl);
      } catch (_) { /* selector may not match this Reddit variant */ }
    }

    // Broad fallback: any user-profile link inside a post or comment container
    if (results.length === 0) {
      document.querySelectorAll(`a[href*="/user/"]:not([${ATTR}])`).forEach(el => {
        const href = el.getAttribute('href') || '';
        const match = href.match(/\/user\/([^/?#]+)/);
        if (!match) return;
        const username = match[1];
        const isRelevant =
          el.closest('shreddit-comment') ||
          el.closest('shreddit-post') ||
          el.closest('.comment') ||
          el.closest('.Post') ||
          el.closest('[data-testid="comment"]') ||
          el.closest('[data-testid="post-container"]');
        if (isRelevant && username !== 'me' && username !== '[deleted]' && !seen.has(el)) {
          seen.add(el);
          results.push({ el, username });
        }
      });
    }

    return results;
  }

  // ---- Badge creation ----

  function makeBadge(score, tier, result) {
    const b = document.createElement('span');
    b.className = 'redbot-badge';

    if (score < 0 && result?.errorType) {
      b.classList.add('redbot-err');
      if (result.errorType === 'suspended') {
        b.textContent = '\u{1F6A8}';
        b.title = 'Account suspended';
      } else if (result.errorType === 'banned') {
        b.textContent = '\u{1F528}';
        b.title = 'Account banned';
      } else if (result.errorType === 'deleted') {
        b.textContent = '\u{1F6AB}';
        b.title = 'Account deleted';
      } else {
        b.textContent = '?';
        b.title = 'Scan error';
      }
    } else if (score < 0) {
      b.classList.add('redbot-err');
      b.textContent = '?';
      b.title = 'Scan error';
    } else if (score < 10) {
      b.classList.add('redbot-green');
      b.textContent = score + '%';
      b.title = `Likely human (${score}%) — Tier ${tier}`;
    } else if (score < 40) {
      b.classList.add('redbot-yellow');
      b.textContent = score + '%';
      b.title = `Suspicious (${score}%) — Tier ${tier}`;
    } else {
      b.classList.add('redbot-red');
      b.textContent = score + '%';
      b.title = `Likely bot (${score}%) — Tier ${tier}`;
    }

    return b;
  }

  // ---- Detail card ----

  function makeCard(result) {
    const r = result;
    let cls, label;
    if (r.score < 0 && r.errorType === 'suspended') { cls = 'bot'; label = 'Suspended'; }
    else if (r.score < 0 && r.errorType === 'banned') { cls = 'bot'; label = 'Banned'; }
    else if (r.score < 0 && r.errorType === 'deleted') { cls = 'bot'; label = 'Deleted'; }
    else if (r.score >= 40) { cls = 'bot'; label = 'Likely Bot'; }
    else if (r.score >= 10) { cls = 'suspicious'; label = 'Suspicious'; }
    else { cls = 'human'; label = 'Likely Human'; }

    const card = document.createElement('div');
    card.className = 'redbot-card';
    card.innerHTML = `
      <div class="redbot-card-hdr redbot-card-${cls}">
        <span class="redbot-card-user">u/${r.meta?.username || '?'}</span>
        <span class="redbot-card-pct">${r.score}%</span>
      </div>
      <div class="redbot-card-body">
        <div class="redbot-card-label">${label}</div>
        <div class="redbot-card-chips">
          ${r.meta?.ageDays != null ? `<span class="redbot-chip">Age: ${r.meta.ageDays}d</span>` : ''}
          ${r.meta?.totalKarma != null ? `<span class="redbot-chip">Karma: ${r.meta.totalKarma.toLocaleString()}</span>` : ''}
          <span class="redbot-chip">Tier ${r.tier}</span>
          ${r.t1Score != null ? `<span class="redbot-chip">T1: ${r.t1Score}</span>` : ''}
          ${r.t2Score != null ? `<span class="redbot-chip">T2: ${r.t2Score}</span>` : ''}
          ${r.t3Score != null ? `<span class="redbot-chip">T3: ${r.t3Score}</span>` : ''}
        </div>
        <div class="redbot-card-sigs">
          <div class="redbot-card-sigs-title">Signals</div>
          ${(r.signals || []).map(s => `
            <div class="redbot-sig">
              <span>${s.name}</span>
              <span class="redbot-sig-d">${s.detail || ''}</span>
            </div>`).join('')}
        </div>
        ${r.llmReasoning ? `
          <div class="redbot-card-llm">
            <div class="redbot-card-sigs-title">AI Analysis</div>
            <p>${r.llmReasoning}</p>
          </div>` : ''}
        ${r.llmSkipped ? `
          <div class="redbot-card-llm">
            <div class="redbot-card-sigs-title">AI Analysis Skipped</div>
            <p>${r.llmReason || 'No API key'}</p>
          </div>` : ''}
      </div>`;

    // Close when clicking outside
    const close = e => {
      if (!card.contains(e.target)) {
        card.remove();
        document.removeEventListener('click', close, true);
      }
    };
    setTimeout(() => document.addEventListener('click', close, true), 0);
    return card;
  }

  // ---- Scan queue ----

  const scanQueue = [];
  let busy = false;

  async function drain() {
    if (busy || scanQueue.length === 0) return;
    busy = true;

    const { el, username } = scanQueue.shift();
    console.log(`[RedBot] Scanning u/${username}...`);

    const dot = document.createElement('span');
    dot.className = 'redbot-badge redbot-spin';
    dot.textContent = '···';
    el.after(dot);
    el.setAttribute(ATTR, 'pending');

    try {
      const result = await chrome.runtime.sendMessage({
        type: 'analyzeUser',
        username,
      });

      console.log(`[RedBot] u/${username} → score=${result.score} tier=${result.tier}`, result.errorType || '');
      dot.remove();
      const badge = makeBadge(result.score, result.tier, result);
      el.after(badge);
      el.setAttribute(ATTR, 'done');

      badge.addEventListener('click', e => {
        e.preventDefault();
        e.stopPropagation();
        document.querySelectorAll('.redbot-card').forEach(c => c.remove());
        badge.after(makeCard(result));
      });
    } catch (err) {
      console.error(`[RedBot] Error scanning u/${username}:`, err);
      dot.remove();
      const badge = makeBadge(-1, 0, null);
      el.after(badge);
      el.setAttribute(ATTR, 'error');
    }

    busy = false;
    drain();
  }

  // ---- Page scanning ----

  function scanPage() {
    const els = getUsernameElements();
    const newUsers = els.filter(e => !PROCESSED.has(e.username));
    console.log(`[RedBot] Page scan: found ${els.length} usernames, ${newUsers.length} new`);
    for (const { el, username } of els) {
      if (PROCESSED.has(username)) {
        el.setAttribute(ATTR, 'dup');
        continue;
      }
      PROCESSED.add(username);
      scanQueue.push({ el, username });
    }
    drain();
  }

  // ---- Profile page panel ----

  function getProfileUsername() {
    const m = location.pathname.match(/^\/user\/([^/?#/]+)/);
    return m ? m[1] : null;
  }

  function isProfilePage() {
    return !!getProfileUsername();
  }

  async function injectProfilePanel() {
    const username = getProfileUsername();
    if (!username || document.getElementById('redbot-profile-panel')) return;

    console.log(`[RedBot] Profile page detected: u/${username}`);

    const panel = document.createElement('div');
    panel.id = 'redbot-profile-panel';
    panel.innerHTML = `
      <div class="redbot-pp-hdr">
        <img src="${chrome.runtime.getURL('rbot.webp')}" class="redbot-pp-logo" alt="RedBot">
        <div>
          <div class="redbot-pp-title">RedBot Analysis</div>
          <div class="redbot-pp-user">u/${username}</div>
        </div>
      </div>
      <div class="redbot-pp-body">
        <div class="redbot-pp-loading">Analyzing...</div>
      </div>`;

    const target =
      document.querySelector('[data-testid="profile-header"]') ||
      document.querySelector('shreddit-profile-header') ||
      document.querySelector('.side') ||
      document.querySelector('#siteTable') ||
      document.body.querySelector('main') ||
      document.body;

    if (target === document.body || target === document.body.querySelector('main')) {
      document.body.prepend(panel);
    } else {
      target.parentElement.insertBefore(panel, target);
    }

    try {
      const result = await chrome.runtime.sendMessage({
        type: 'analyzeUser',
        username,
      });

      renderProfileResult(panel, username, result);
    } catch (err) {
      console.error(`[RedBot] Profile analysis error:`, err);
      panel.querySelector('.redbot-pp-body').innerHTML =
        '<div class="redbot-pp-err">Could not analyze this user.</div>';
    }
  }

  function renderProfileResult(panel, username, r) {
    let cls, label;
    if (r.score < 0 && r.errorType === 'suspended') { cls = 'bot'; label = 'Suspended'; }
    else if (r.score < 0 && r.errorType === 'banned') { cls = 'bot'; label = 'Banned'; }
    else if (r.score < 0 && r.errorType === 'deleted') { cls = 'bot'; label = 'Deleted'; }
    else if (r.score >= 40) { cls = 'bot'; label = 'Likely Bot'; }
    else if (r.score >= 10) { cls = 'suspicious'; label = 'Suspicious'; }
    else { cls = 'human'; label = 'Likely Human'; }

    const scoreDisplay = r.score < 0 ? '--' : `${r.score}%`;
    const tierLabel = r.tier > 0 ? `Tier ${r.tier} analysis` : '';

    const exampleComments = r._sampleComments || [];
    const commentsHtml = exampleComments.length > 0
      ? `<div class="redbot-pp-section">
          <div class="redbot-pp-section-title">Flagged Comments</div>
          ${exampleComments.map(c => `
            <div class="redbot-pp-comment">
              <span class="redbot-pp-comment-sub">r/${c.sub}</span>
              <p>"${c.body.length > 200 ? c.body.slice(0, 200) + '…' : c.body}"</p>
            </div>`).join('')}
        </div>`
      : '';

    panel.querySelector('.redbot-pp-body').innerHTML = `
      <div class="redbot-pp-score-row redbot-pp-${cls}">
        <div>
          <span class="redbot-pp-score">${scoreDisplay}</span>
          <span class="redbot-pp-label">${label}</span>
        </div>
        <span class="redbot-pp-tier">${tierLabel}</span>
      </div>

      <div class="redbot-pp-chips">
        ${r.meta?.ageDays != null ? `<span class="redbot-chip">Age: ${r.meta.ageDays}d</span>` : ''}
        ${r.meta?.totalKarma != null ? `<span class="redbot-chip">Karma: ${r.meta.totalKarma.toLocaleString()}</span>` : ''}
        ${r.t1Score != null ? `<span class="redbot-chip">T1: ${r.t1Score}</span>` : ''}
        ${r.t2Score != null ? `<span class="redbot-chip">T2: ${r.t2Score}</span>` : ''}
        ${r.t3Score != null ? `<span class="redbot-chip">T3: ${r.t3Score}</span>` : ''}
      </div>

      <div class="redbot-pp-section">
        <div class="redbot-pp-section-title">Signals</div>
        ${(r.signals || []).map(s => `
          <div class="redbot-sig">
            <span>${s.name}</span>
            <span class="redbot-sig-d">${s.detail || ''}</span>
          </div>`).join('') || '<div class="redbot-pp-none">No signals detected</div>'}
      </div>

      ${r.llmReasoning ? `
        <div class="redbot-pp-section">
          <div class="redbot-pp-section-title">AI Analysis</div>
          <p class="redbot-pp-reasoning">${r.llmReasoning}</p>
        </div>` : ''}

      ${commentsHtml}

      ${r.tier < 3 ? `
        <button class="redbot-pp-deep-btn" id="redbot-deep-btn">
          Deep Analysis (LLM)
        </button>
        <p class="redbot-pp-deep-hint">Runs Gemini on up to 50 comments for a thorough assessment. Requires API key.</p>
      ` : `
        <div class="redbot-pp-deep-done">Deep analysis complete</div>
      `}`;

    const deepBtn = panel.querySelector('#redbot-deep-btn');
    if (deepBtn) {
      deepBtn.addEventListener('click', async () => {
        deepBtn.textContent = 'Analyzing…';
        deepBtn.disabled = true;
        console.log(`[RedBot] Deep analysis triggered for u/${username}`);

        try {
          const deepResult = await chrome.runtime.sendMessage({
            type: 'deepAnalyze',
            username,
          });
          renderProfileResult(panel, username, deepResult);
        } catch (err) {
          console.error(`[RedBot] Deep analysis error:`, err);
          deepBtn.textContent = 'Error — try again';
          deepBtn.disabled = false;
        }
      });
    }
  }

  // ---- Listen for manual scan from popup ----

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'triggerScan') {
      PROCESSED.clear();
      document.querySelectorAll(`[${ATTR}]`).forEach(el => el.removeAttribute(ATTR));
      document.querySelectorAll('.redbot-badge, .redbot-card').forEach(el => el.remove());
      scanPage();
    }
  });

  // ---- SPA navigation detection (new Reddit is an SPA) ----

  let lastUrl = location.href;
  function checkUrlChange() {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      PROCESSED.clear();
      const oldPanel = document.getElementById('redbot-profile-panel');
      if (oldPanel) oldPanel.remove();
      setTimeout(() => {
        scanPage();
        if (isProfilePage()) injectProfilePanel();
      }, 1500);
    }
  }
  setInterval(checkUrlChange, 2000);

  // ---- MutationObserver for infinite scroll / expanding threads ----

  let debounceTimer = null;
  const observer = new MutationObserver(() => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(scanPage, 800);
  });

  observer.observe(document.body, { childList: true, subtree: true });

  // ---- Initial scan ----
  scanPage();
  if (isProfilePage()) {
    setTimeout(injectProfilePanel, 500);
  }
})();
