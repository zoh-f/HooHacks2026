// ============================================================
// AstroGuard — Content Script
// Injected into Reddit pages. Finds comment authors, requests
// analysis from the background worker, and injects score badges.
// ============================================================

(function () {
  'use strict';

  const ATTR = 'data-redbot';
  const resultCache = new Map();     // username → analysis result
  const pendingElements = new Map(); // username → [elements waiting for badge]

  function currentSubreddit() {
    const m = location.pathname.match(/^\/r\/([^/]+)/i);
    return m ? m[1] : null;
  }

  function getCommentTs(el) {
    const comment = el.closest('shreddit-comment') || el.closest('.comment');
    if (!comment) return null;
    const timeEl = comment.querySelector('faceplate-timeago') || comment.querySelector('time[datetime]');
    if (!timeEl) return null;
    const raw = timeEl.getAttribute('ts') || timeEl.getAttribute('datetime');
    if (!raw) return null;
    const ms = Number(raw);
    if (!isNaN(ms) && ms > 1e12) return ms;
    if (!isNaN(ms) && ms > 1e9) return ms * 1000;
    const d = new Date(raw);
    return isNaN(d.getTime()) ? null : d.getTime();
  }

  function isTopLevelComment(el) {
    const comment = el.closest('shreddit-comment') || el.closest('.comment');
    if (!comment) return false;
    if (comment.tagName?.toLowerCase() === 'shreddit-comment') {
      return comment.getAttribute('depth') === '0';
    }
    return !comment.parentElement?.closest('.comment');
  }

  // ---- Settings (synced from popup) ----

  let botAction = 'badge';
  let botThreshold = 40;
  let settingsReady = false;

  function loadSettings() {
    return new Promise(resolve => {
      chrome.storage.sync.get(['botAction', 'botThreshold'], res => {
        botAction = res.botAction || 'badge';
        botThreshold = res.botThreshold ?? 40;
        settingsReady = true;
        resolve();
      });
    });
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    if (changes.botAction) botAction = changes.botAction.newValue || 'badge';
    if (changes.botThreshold) botThreshold = changes.botThreshold.newValue ?? 40;
  });

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

    if (result?.errorType === 'ratelimited') {
      b.classList.add('redbot-ratelimit');
      b.textContent = '\u{23F3}';
      b.title = 'Rate limited — try again in a bit';
    } else if (score < 0 && result?.errorType) {
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
      b.title = 'Not scanned';
    } else if (score < 20) {
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
    const card = document.createElement('div');
    card.className = 'redbot-card';

    if (r.errorType === 'ratelimited') {
      card.innerHTML = `
        <div class="redbot-card-hdr redbot-card-ratelimit">
          <span class="redbot-card-user">u/${r.meta?.username || '?'}</span>
          <span class="redbot-card-pct">\u{23F3}</span>
        </div>
        <div class="redbot-card-body">
          <div class="redbot-card-label" style="color:#3b82f6">Rate Limited</div>
          <p style="font-size:12px;color:#94a3b8;line-height:1.5;margin-top:8px">
            Reddit is limiting requests. Please wait before trying again.
          </p>
        </div>`;
    } else {
      let cls, label;
      if (r.score < 0 && r.errorType === 'suspended') { cls = 'bot'; label = 'Suspended'; }
      else if (r.score < 0 && r.errorType === 'banned') { cls = 'bot'; label = 'Banned'; }
      else if (r.score < 0 && r.errorType === 'deleted') { cls = 'bot'; label = 'Deleted'; }
      else if (r.score < 0) { cls = 'unknown'; label = 'Not Scanned'; }
      else if (r.score >= 40) { cls = 'bot'; label = 'Likely Bot'; }
      else if (r.score >= 20) { cls = 'suspicious'; label = 'Suspicious'; }
      else { cls = 'human'; label = 'Likely Human'; }

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
            ${r.heuristicScore != null ? `<span class="redbot-chip">Heuristic: ${r.heuristicScore}</span>` : ''}
            ${r.trustMultiplier != null && r.trustMultiplier < 1 ? `<span class="redbot-chip">Trust: x${r.trustMultiplier}</span>` : ''}
            ${r.llmScore != null ? `<span class="redbot-chip">LLM: ${r.llmScore}</span>` : ''}
            <span class="redbot-chip">${r.tier === 2 ? 'LLM verified' : 'Heuristic only'}</span>
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
              <div class="redbot-card-sigs-title">Bot Analysis (LLM)</div>
              <p>${r.llmReasoning}</p>
            </div>` : ''}
          ${r.aiContentScore > 0 ? `
            <div class="redbot-card-llm">
              <div class="redbot-card-sigs-title">AI Content Detection</div>
              <p>${r.aiContentScore}% AI-written — ${r.aiContentNote || 'No details'}</p>
            </div>` : ''}
          ${r.llmSkipped ? `
            <div class="redbot-card-llm">
              <div class="redbot-card-sigs-title">AI Analysis Skipped</div>
              <p>${r.llmReason || 'No API key'}</p>
            </div>` : ''}
        </div>`;
    }

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

  // ---- Comment actions (minimize / hide) ----

  function applyCommentAction(el, result) {
    if (botAction !== 'minimize') return;
    if (result.score < 0 || result.score < botThreshold) return;
    if (!isTopLevelComment(el)) return;

    const comment =
      el.closest('shreddit-comment') ||
      el.closest('.comment') ||
      el.closest('.Comment') ||
      el.closest('[data-testid="comment"]');
    if (!comment || comment.hasAttribute('data-redbot-action')) return;
    comment.setAttribute('data-redbot-action', 'minimize');

    const bar = document.createElement('div');
    bar.className = 'redbot-minimize-bar';
    bar.innerHTML =
      `<span>\u{1F916} ${result.score}% bot — u/${result.meta?.username || '?'}</span>` +
      `<button class="redbot-expand-btn">Show</button>`;
    bar.querySelector('.redbot-expand-btn').addEventListener('click', () => {
      comment.style.display = '';
      bar.remove();
      comment.removeAttribute('data-redbot-action');
    });
    comment.before(bar);
    comment.style.display = 'none';
  }

  // ---- Scan queue ----

  const scanQueue = [];
  let busy = false;
  const commentTsMap = new Map();
  let rlDelay = 0;
  let rlUntil = 0;
  let rlTimer = null;
  let rlCountdown = null;

  function reportScanProgress() {
    const pending = scanQueue.length + (busy ? 1 : 0);
    chrome.runtime.sendMessage({ type: 'scanProgress', pending }).catch(() => {});
  }

  function attachBadge(el, result) {
    if (el.nextElementSibling?.classList.contains('redbot-badge')) return;
    const parent = el.parentElement;
    if (parent && parent.querySelector('.redbot-badge')) {
      el.setAttribute(ATTR, 'done');
      return;
    }
    const badge = makeBadge(result.score, result.tier, result);
    el.after(badge);
    el.setAttribute(ATTR, 'done');
    badge.addEventListener('click', e => {
      e.preventDefault();
      e.stopPropagation();
      document.querySelectorAll('.redbot-card').forEach(c => c.remove());
      badge.after(makeCard(result));
    });
    applyCommentAction(el, result);
  }

  function flushPending(username, result) {
    resultCache.set(username, result);
    const waiting = pendingElements.get(username) || [];
    for (const { el, spinner } of waiting) {
      if (spinner) spinner.remove();
      attachBadge(el, result);
    }
    pendingElements.delete(username);
  }

  async function drain() {
    if (busy || scanQueue.length === 0) {
      if (!busy && scanQueue.length === 0) reportScanProgress();
      return;
    }
    if (rlUntil > Date.now()) return;
    busy = true;

    const username = scanQueue.shift();
    console.log(`[AstroGuard] Scanning u/${username}...`);

    try {
      const result = await chrome.runtime.sendMessage({
        type: 'analyzeUser',
        username,
        subreddit: currentSubreddit(),
        commentTs: commentTsMap.get(username) || null,
      });

      if (result?.errorType === 'ratelimited') {
        scanQueue.unshift(username);
        rlDelay = rlDelay ? Math.min(rlDelay * 2, 120000) : 30000;
        rlUntil = Date.now() + rlDelay;
        startRlCountdown();
        busy = false;
        return;
      }

      rlDelay = 0;
      commentTsMap.delete(username);
      console.log(`[AstroGuard] u/${username} → score=${result.score} tier=${result.tier}`, result.errorType || '');
      flushPending(username, result);
    } catch (err) {
      console.error(`[AstroGuard] Error scanning u/${username}:`, err);
      commentTsMap.delete(username);
      const errResult = { score: -1, tier: 0, signals: [], error: err.message };
      flushPending(username, errResult);
    }

    busy = false;
    reportScanProgress();
    drain();
  }

  function startRlCountdown() {
    convertSpinnersToRl();
    if (rlCountdown) clearInterval(rlCountdown);
    if (rlTimer) clearTimeout(rlTimer);

    rlCountdown = setInterval(() => {
      const secs = Math.max(0, Math.ceil((rlUntil - Date.now()) / 1000));
      convertSpinnersToRl();
      document.querySelectorAll('.redbot-rl-wait').forEach(el => {
        el.title = `Rate limited \u2014 retrying in ${secs}s`;
      });
      if (secs <= 0) {
        clearInterval(rlCountdown);
        rlCountdown = null;
      }
    }, 1000);

    rlTimer = setTimeout(() => {
      rlUntil = 0;
      revertRlToSpinners();
      drain();
    }, rlDelay);
  }

  function convertSpinnersToRl() {
    document.querySelectorAll('.redbot-spin').forEach(el => {
      el.textContent = '\u23F3';
      el.classList.remove('redbot-spin');
      el.classList.add('redbot-ratelimit', 'redbot-rl-wait');
    });
  }

  function revertRlToSpinners() {
    document.querySelectorAll('.redbot-rl-wait').forEach(el => {
      el.textContent = '\u00B7\u00B7\u00B7';
      el.title = '';
      el.classList.remove('redbot-ratelimit', 'redbot-rl-wait');
      el.classList.add('redbot-spin');
    });
  }

  // ---- Page scanning ----

  function scanPage() {
    if (botAction === 'off') return;
    const els = getUsernameElements();
    console.log(`[AstroGuard] Page scan: found ${els.length} username elements`);

    const newUsernames = new Set();
    const processedContainers = new Set();

    for (const { el, username } of els) {
      const nextSib = el.nextElementSibling;
      if (nextSib?.classList.contains('redbot-badge') || nextSib?.classList.contains('redbot-spin') || nextSib?.classList.contains('redbot-rl-wait')) continue;

      const ctr = el.closest('shreddit-comment') || el.closest('shreddit-post') || el.closest('.comment') || el.closest('.Post');
      if (ctr) {
        if (processedContainers.has(ctr)) continue;
        if (ctr.querySelector('.redbot-badge, .redbot-spin, .redbot-rl-wait')) continue;
        processedContainers.add(ctr);
      }

      if (resultCache.has(username)) {
        attachBadge(el, resultCache.get(username));
        continue;
      }

      if (!commentTsMap.has(username)) {
        const ts = getCommentTs(el);
        if (ts) commentTsMap.set(username, ts);
      }

      const spinner = document.createElement('span');
      spinner.className = 'redbot-badge redbot-spin';
      spinner.textContent = '\u00B7\u00B7\u00B7';
      el.after(spinner);
      el.setAttribute(ATTR, 'pending');

      if (rlUntil > Date.now()) {
        spinner.textContent = '\u23F3';
        spinner.classList.remove('redbot-spin');
        spinner.classList.add('redbot-ratelimit', 'redbot-rl-wait');
        const secs = Math.ceil((rlUntil - Date.now()) / 1000);
        spinner.title = `Rate limited \u2014 retrying in ${secs}s`;
      }

      if (!pendingElements.has(username)) pendingElements.set(username, []);
      pendingElements.get(username).push({ el, spinner });

      newUsernames.add(username);
    }

    for (const username of newUsernames) {
      if (!scanQueue.includes(username)) {
        scanQueue.push(username);
      }
    }
    reportScanProgress();
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

  function initPanelDrag(panel, handle) {
    let dragging = false, startX, startY, origX, origY;

    handle.addEventListener('mousedown', e => {
      if (e.target.closest('.redbot-pp-close')) return;
      dragging = true;
      startX = e.clientX;
      startY = e.clientY;
      const rect = panel.getBoundingClientRect();
      origX = rect.left;
      origY = rect.top;
      e.preventDefault();
    });

    document.addEventListener('mousemove', e => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      panel.style.left = `${origX + dx}px`;
      panel.style.top = `${origY + dy}px`;
      panel.style.right = 'auto';
    });

    document.addEventListener('mouseup', () => { dragging = false; });
  }

  async function injectProfilePanel() {
    if (botAction === 'off') return;
    const username = getProfileUsername();
    if (!username || document.getElementById('redbot-profile-panel')) return;

    console.log(`[AstroGuard] Profile page detected: u/${username}`);

    const panel = document.createElement('div');
    panel.id = 'redbot-profile-panel';
    panel.innerHTML = `
      <div class="redbot-pp-hdr" id="redbot-pp-drag-handle">
        <img src="${chrome.runtime.getURL('logo.png')}" class="redbot-pp-logo" alt="AstroGuard">
        <div>
          <div class="redbot-pp-title">AstroGuard Analysis</div>
          <div class="redbot-pp-user">u/${username}</div>
        </div>
        <button class="redbot-pp-close" id="redbot-pp-close" title="Close">\u2715</button>
      </div>
      <div class="redbot-pp-body">
        <div class="redbot-pp-loading">Analyzing...</div>
      </div>`;

    document.body.appendChild(panel);

    panel.querySelector('#redbot-pp-close').addEventListener('click', () => panel.remove());
    initPanelDrag(panel, panel.querySelector('#redbot-pp-drag-handle'));

    try {
      const result = await chrome.runtime.sendMessage({
        type: 'analyzeUser',
        username,
        subreddit: currentSubreddit(),
      });

      renderProfileResult(panel, username, result);
    } catch (err) {
      console.error(`[AstroGuard] Profile analysis error:`, err);
      panel.querySelector('.redbot-pp-body').innerHTML =
        '<div class="redbot-pp-err">Could not analyze this user.</div>';
    }
  }

  function renderProfileResult(panel, username, r) {
    if (r.errorType === 'ratelimited') {
      panel.querySelector('.redbot-pp-body').innerHTML = `
        <div class="redbot-pp-score-row redbot-pp-ratelimit">
          <div>
            <span class="redbot-pp-score">\u{23F3}</span>
            <span class="redbot-pp-label">Rate Limited</span>
          </div>
        </div>
        <div class="redbot-pp-ratelimit-msg">
          Reddit is rate limiting requests right now.<br>
          Please wait a minute and try again.
        </div>
        <button class="redbot-pp-retry-btn" id="redbot-retry-btn">Retry Analysis</button>`;

      panel.querySelector('#redbot-retry-btn').addEventListener('click', async () => {
        const btn = panel.querySelector('#redbot-retry-btn');
        btn.textContent = 'Retrying…';
        btn.disabled = true;
        try {
          const result = await chrome.runtime.sendMessage({ type: 'analyzeUser', username, subreddit: currentSubreddit() });
          renderProfileResult(panel, username, result);
        } catch (err) {
          btn.textContent = 'Still rate limited — try again';
          btn.disabled = false;
        }
      });
      return;
    }

    let cls, label;
    if (r.score < 0 && r.errorType === 'suspended') { cls = 'bot'; label = 'Suspended'; }
    else if (r.score < 0 && r.errorType === 'banned') { cls = 'bot'; label = 'Banned'; }
    else if (r.score < 0 && r.errorType === 'deleted') { cls = 'bot'; label = 'Deleted'; }
    else if (r.score < 0) { cls = 'unknown'; label = 'Not Scanned'; }
    else if (r.score >= 40) { cls = 'bot'; label = 'Likely Bot'; }
    else if (r.score >= 20) { cls = 'suspicious'; label = 'Suspicious'; }
    else { cls = 'human'; label = 'Likely Human'; }

    const scoreDisplay = r.score < 0 ? '--' : `${r.score}%`;
    const tierLabel = r.tier === 2 ? 'LLM verified' : r.tier === 1 ? 'Heuristic only' : '';

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
        ${r.heuristicScore != null ? `<span class="redbot-chip">Heuristic: ${r.heuristicScore}</span>` : ''}
        ${r.trustMultiplier != null && r.trustMultiplier < 1 ? `<span class="redbot-chip">Trust: x${r.trustMultiplier}</span>` : ''}
        ${r.llmScore != null ? `<span class="redbot-chip">LLM: ${r.llmScore}</span>` : ''}
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
          <div class="redbot-pp-section-title">Bot Analysis (LLM)</div>
          <p class="redbot-pp-reasoning">${r.llmReasoning}</p>
        </div>` : ''}

      ${r.aiContentScore > 0 ? `
        <div class="redbot-pp-section">
          <div class="redbot-pp-section-title">AI Content Detection</div>
          <p class="redbot-pp-reasoning">${r.aiContentScore}% likely AI-written — ${r.aiContentNote || 'No details'}</p>
        </div>` : ''}

      ${commentsHtml}

      ${r.tier < 2 ? `
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
        console.log(`[AstroGuard] Deep analysis triggered for u/${username}`);

        try {
          const deepResult = await chrome.runtime.sendMessage({
            type: 'deepAnalyze',
            username,
            subreddit: currentSubreddit(),
          });
          renderProfileResult(panel, username, deepResult);
        } catch (err) {
          console.error(`[AstroGuard] Deep analysis error:`, err);
          deepBtn.textContent = 'Error — try again';
          deepBtn.disabled = false;
        }
      });
    }
  }

  // ---- Listen for manual scan from popup ----

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'triggerScan') {
      resultCache.clear();
      pendingElements.clear();
      document.querySelectorAll(`[${ATTR}]`).forEach(el => el.removeAttribute(ATTR));
      document.querySelectorAll('.redbot-badge, .redbot-card').forEach(el => el.remove());
      scanPage();
    }
    if (msg.type === 'getContentResults') {
      const out = {};
      resultCache.forEach((v, k) => { out[k] = v; });
      sendResponse(out);
      return true;
    }
  });

  // ---- SPA navigation detection (new Reddit is an SPA) ----

  let lastUrl = location.href;
  function checkUrlChange() {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      resultCache.clear();
      pendingElements.clear();
      const oldPanel = document.getElementById('redbot-profile-panel');
      if (oldPanel) oldPanel.remove();
      setTimeout(() => {
        if (botAction === 'off') return;
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

  // ---- Initial scan (deferred until settings load) ----
  loadSettings().then(() => {
    if (botAction === 'off') return;
    scanPage();
    if (isProfilePage()) {
      setTimeout(injectProfilePanel, 500);
    }
  });
})();
