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
      document.querySelectorAll(`a.author:not([${ATTR}])`).forEach(el => {
        const name = el.textContent.trim();
        if (name) results.push({ el, username: name });
      });
      return results;
    }

    // New Reddit — multiple possible selectors
    const selectors = [
      `shreddit-comment:not([${ATTR}]) [slot="commentMeta"] a[href*="/user/"]`,
      `a[data-testid="comment_author_link"]:not([${ATTR}])`,
      `.comment .author:not([${ATTR}])`,
      `[data-click-id="user"] :not([${ATTR}])`,
    ];

    const seen = new Set();
    for (const sel of selectors) {
      try {
        document.querySelectorAll(sel).forEach(el => {
          if (el.hasAttribute(ATTR)) return;
          const href = el.getAttribute('href') || '';
          const match = href.match(/\/user\/([^/?#]+)/);
          const username = match ? match[1] : el.textContent.trim();
          if (username && username !== 'me' && !seen.has(el)) {
            seen.add(el);
            results.push({ el, username });
          }
        });
      } catch (_) { /* selector may not match this Reddit variant */ }
    }

    // Broad fallback: any user-profile link inside a comment-like container
    if (results.length === 0) {
      document.querySelectorAll(`a[href*="/user/"]:not([${ATTR}])`).forEach(el => {
        const href = el.getAttribute('href') || '';
        const match = href.match(/\/user\/([^/?#]+)/);
        if (!match) return;
        const username = match[1];
        const isInComment =
          el.closest('shreddit-comment') ||
          el.closest('.comment') ||
          el.closest('[data-testid="comment"]');
        if (isInComment && username !== 'me' && !seen.has(el)) {
          seen.add(el);
          results.push({ el, username });
        }
      });
    }

    return results;
  }

  // ---- Badge creation ----

  function makeBadge(score, tier) {
    const b = document.createElement('span');
    b.className = 'redbot-badge';

    if (score < 0) {
      b.classList.add('redbot-err');
      b.textContent = '?';
      b.title = 'Scan error';
    } else if (score < 30) {
      b.classList.add('redbot-green');
      b.textContent = score + '%';
      b.title = `Likely human (${score}%) — Tier ${tier}`;
    } else if (score < 60) {
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
    if (r.score >= 60) { cls = 'bot'; label = 'Likely Bot'; }
    else if (r.score >= 30) { cls = 'suspicious'; label = 'Suspicious'; }
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

    // Spinner while scanning
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

      dot.remove();
      const badge = makeBadge(result.score, result.tier);
      el.after(badge);
      el.setAttribute(ATTR, 'done');

      badge.addEventListener('click', e => {
        e.preventDefault();
        e.stopPropagation();
        document.querySelectorAll('.redbot-card').forEach(c => c.remove());
        badge.after(makeCard(result));
      });
    } catch (err) {
      dot.remove();
      const badge = makeBadge(-1, 0);
      el.after(badge);
      el.setAttribute(ATTR, 'error');
    }

    busy = false;
    drain();
  }

  // ---- Page scanning ----

  function scanPage() {
    const els = getUsernameElements();
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
      setTimeout(scanPage, 1500);
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
})();
