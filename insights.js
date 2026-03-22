/* ============================================================
   RedBot — Insights Dashboard
   Loads persisted scan data from chrome.storage.local and
   renders an AI-safety-oriented dashboard.
   ============================================================ */

(function () {
  'use strict';

  // ---- Subreddit classification ----

  const SERIOUS_KEYWORDS = [
    'politic', 'policy', 'news', 'worldnews', 'geopolitic', 'law', 'legal',
    'econom', 'finance', 'elect', 'congress', 'senate', 'democrat', 'republican',
    'liberal', 'conservative', 'libertarian', 'socialist', 'govern', 'debate',
    'health', 'science', 'climate', 'environ', 'tech', 'cyber', 'privacy',
    'regulation', 'legislation', 'rights', 'justice', 'court', 'suprem',
    'foreign', 'affairs', 'militar', 'defense', 'immigra', 'educ',
    'vaccine', 'covid', 'pandemic', 'public', 'housing', 'tax',
    'ukraine', 'china', 'nato', 'middle east', 'israel', 'gaza',
    'ai', 'artificial', 'singularity', 'ubi', 'crypto', 'blockchain',
    'whistleblow', 'corruption', 'lobby', 'activism', 'protest',
    'truereddit', 'neutralpolitics', 'changemyview', 'outoftheloop',
    'explainlikeimfive', 'askscience', 'askhistorians', 'asksocialscience',
  ];

  const ENTERTAINMENT_KEYWORDS = [
    'meme', 'funny', 'gaming', 'game', 'aww', 'cute', 'animal', 'cat', 'dog',
    'dankmeme', 'shitpost', 'wholesome', 'comic', 'anime', 'manga',
    'movie', 'film', 'television', 'tv', 'netflix', 'hbo',
    'music', 'hiphop', 'rock', 'edm', 'sport', 'nba', 'nfl', 'soccer',
    'football', 'baseball', 'hockey', 'formula1', 'motorsport',
    'food', 'cooking', 'recipe', 'travel', 'photo', 'art', 'drawing',
    'fashion', 'makeup', 'fitness', 'yoga', 'crafts', 'diy',
    'minecraft', 'fortnite', 'valorant', 'leagueoflegends', 'csgo',
    'pokemon', 'zelda', 'mario', 'steam', 'pcgaming', 'playstation', 'xbox',
    'tiktok', 'youtube', 'twitch', 'streaming', 'celebrit',
  ];

  function classifySubreddit(name) {
    const lc = name.toLowerCase();
    let seriousHits = 0;
    let entertainmentHits = 0;
    for (const kw of SERIOUS_KEYWORDS) if (lc.includes(kw)) seriousHits++;
    for (const kw of ENTERTAINMENT_KEYWORDS) if (lc.includes(kw)) entertainmentHits++;
    if (seriousHits > entertainmentHits) return 'serious';
    if (entertainmentHits > seriousHits) return 'entertainment';
    return 'unknown';
  }

  // ---- Helpers ----

  function pct(n, d) { return d === 0 ? 0 : Math.round((n / d) * 100); }

  function integrityScore(avgScore) {
    return Math.max(0, Math.min(100, Math.round(100 - avgScore)));
  }

  function integrityClass(score) {
    if (score >= 70) return 'ib-high';
    if (score >= 40) return 'ib-mid';
    return 'ib-low';
  }

  function timeAgo(ts) {
    const diff = Date.now() - ts;
    const m = Math.floor(diff / 60000);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    return `${Math.floor(h / 24)}d ago`;
  }

  function formatDate(ts) {
    return new Date(ts).toLocaleDateString(undefined, {
      month: 'short', day: 'numeric', year: 'numeric',
    });
  }

  // ---- Rendering ----

  function show(id) { document.getElementById(id).style.display = ''; }

  function renderGlobal(db, subs) {
    show('secGlobal');
    const totalSubs = Object.keys(subs).length;
    const totalBots = Object.values(subs).reduce((s, v) => s + v.botCount, 0);
    const totalSus = Object.values(subs).reduce((s, v) => s + v.suspiciousCount, 0);
    const totalHuman = Object.values(subs).reduce((s, v) => s + v.humanCount, 0);
    const avgScore = db.totalScans > 0
      ? Math.round(Object.values(subs).reduce((s, v) => s + v.scoreSum, 0) / db.totalScans)
      : 0;

    const stats = [
      { v: db.totalScans, l: 'Total Scans', c: 'clr-blue' },
      { v: totalSubs, l: 'Subreddits', c: 'clr-purple' },
      { v: totalBots, l: 'Bots Found', c: 'clr-red' },
      { v: totalSus, l: 'Suspicious', c: 'clr-yellow' },
      { v: totalHuman, l: 'Likely Human', c: 'clr-green' },
      { v: avgScore + '%', l: 'Avg Bot Score', c: '' },
    ];

    document.getElementById('globalStats').innerHTML = stats.map(s =>
      `<div class="stat-card"><span class="sv ${s.c}">${s.v}</span><span class="sl">${s.l}</span></div>`
    ).join('');

    const range = `Data collected from ${formatDate(db.firstScan)} to ${formatDate(Date.now())}`;
    document.getElementById('globalRange').textContent = range;
  }

  function renderIntegrity(subs) {
    const eligible = Object.entries(subs)
      .filter(([, v]) => v.scans >= 3)
      .map(([name, v]) => {
        const avg = v.scoreSum / v.scans;
        return { name, avg, integrity: integrityScore(avg), scans: v.scans };
      })
      .sort((a, b) => a.integrity - b.integrity);

    if (eligible.length === 0) return;
    show('secIntegrity');

    const maxVal = 100;
    document.getElementById('integrityBars').innerHTML = eligible.map(s => `
      <div class="bar-row">
        <span class="bar-label">r/${s.name}</span>
        <div class="bar-track">
          <div class="bar-fill integrity" style="width:${s.integrity}%"></div>
          <span class="bar-value">${s.integrity}%</span>
        </div>
      </div>
    `).join('');
  }

  function renderComparison(subs) {
    show('secComparison');

    let seriousScans = 0, seriousSum = 0, seriousSubs = 0;
    let entScans = 0, entSum = 0, entSubs = 0;

    for (const [name, v] of Object.entries(subs)) {
      const cat = classifySubreddit(name);
      if (cat === 'serious') { seriousScans += v.scans; seriousSum += v.scoreSum; seriousSubs++; }
      else if (cat === 'entertainment') { entScans += v.scans; entSum += v.scoreSum; entSubs++; }
    }

    const sAvg = seriousScans > 0 ? Math.round(seriousSum / seriousScans) : null;
    const eAvg = entScans > 0 ? Math.round(entSum / entScans) : null;

    if (sAvg === null && eAvg === null) {
      document.getElementById('compareRow').innerHTML =
        '<div class="compare-empty">No subreddits have been classified yet. Browse policy or entertainment subreddits to see a comparison.</div>';
      return;
    }

    function card(title, avg, scans, subCount, hint) {
      if (avg === null) return `
        <div class="compare-card compare-card-empty">
          <h3>${title}</h3>
          <div class="cv" style="color:#475569;">\u2014</div>
          <div class="cl">No data yet \u2014 browse ${hint} subreddits</div>
        </div>`;
      const clr = avg >= 40 ? 'clr-red' : avg >= 20 ? 'clr-yellow' : 'clr-green';
      return `
        <div class="compare-card">
          <h3>${title}</h3>
          <div class="cv ${clr}">${avg}%</div>
          <div class="cl">${scans} scans across ${subCount} subreddit${subCount !== 1 ? 's' : ''}</div>
        </div>`;
    }

    let html = card('Policy / Discussion', sAvg, seriousScans, seriousSubs, 'policy/news');
    html += card('Entertainment / General', eAvg, entScans, entSubs, 'entertainment');

    if (sAvg !== null && eAvg !== null) {
      const diff = Math.abs(sAvg - eAvg);
      const higher = sAvg > eAvg ? 'Policy / Discussion' : 'Entertainment / General';
      if (diff > 0) {
        html += `<div class="compare-note">${higher} has a ${diff} percentage point higher average bot score</div>`;
      } else {
        html += '<div class="compare-note">Both categories have equal average bot scores</div>';
      }
    }

    document.getElementById('compareRow').innerHTML = html;
  }

  function renderTemporal(timeline) {
    if (timeline.length < 2) return;
    show('secTemporal');

    const buckets = {};
    for (const entry of timeline) {
      const day = new Date(entry.ts).toISOString().slice(0, 10);
      if (!buckets[day]) buckets[day] = { count: 0, botCount: 0 };
      buckets[day].count++;
      if (entry.score >= 40) buckets[day].botCount++;
    }

    const days = Object.entries(buckets).sort((a, b) => a[0].localeCompare(b[0]));
    const maxCount = Math.max(...days.map(([, b]) => b.count), 1);

    document.getElementById('temporalChart').innerHTML = days.map(([day, b]) => {
      const h = Math.max(4, (b.count / maxCount) * 100);
      const botPct = pct(b.botCount, b.count);
      const r = Math.min(255, Math.round(botPct * 2.55));
      const g = Math.min(255, Math.round((100 - botPct) * 2.55));
      const label = new Date(day + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
      return `<div class="t-bar" style="height:${h}%;background:rgb(${r},${g},80);" data-tip="${label}: ${b.count} scans, ${botPct}% bots"></div>`;
    }).join('');
  }

  function renderSignals(subs) {
    const agg = {};
    for (const v of Object.values(subs)) {
      for (const [sig, count] of Object.entries(v.signals || {})) {
        agg[sig] = (agg[sig] || 0) + count;
      }
    }

    const sorted = Object.entries(agg).sort((a, b) => b[1] - a[1]).slice(0, 15);
    if (sorted.length === 0) return;
    show('secSignals');

    const maxVal = sorted[0][1];
    document.getElementById('signalBars').innerHTML = sorted.map(([name, count]) => `
      <div class="bar-row">
        <span class="bar-label">${name}</span>
        <div class="bar-track">
          <div class="bar-fill signal" style="width:${(count / maxVal) * 100}%"></div>
          <span class="bar-value">${count}</span>
        </div>
      </div>
    `).join('');
  }

  function renderCompromised(subs) {
    const rows = Object.entries(subs)
      .filter(([, v]) => v.scans >= 3)
      .map(([name, v]) => {
        const avg = Math.round(v.scoreSum / v.scans);
        const botPctVal = pct(v.botCount, v.scans);
        const is = integrityScore(avg);
        return { name, scans: v.scans, avg, botPct: botPctVal, integrity: is };
      })
      .sort((a, b) => b.botPct - a.botPct)
      .slice(0, 20);

    if (rows.length === 0) return;
    show('secCompromised');

    const tbody = document.querySelector('#compromisedTable tbody');
    tbody.innerHTML = rows.map(r => `
      <tr>
        <td>r/${r.name}</td>
        <td>${r.scans}</td>
        <td>${r.avg}%</td>
        <td>${r.botPct}%</td>
        <td><span class="integrity-badge ${integrityClass(r.integrity)}">${r.integrity}%</span></td>
      </tr>
    `).join('');
  }

  // ---- Bootstrap ----

  function render(db) {
    if (!db || db.totalScans === 0) {
      show('emptyState');
      return;
    }

    const subs = db.subreddits || {};
    renderGlobal(db, subs);
    renderIntegrity(subs);
    renderComparison(subs);
    renderTemporal(db.timeline || []);
    renderSignals(subs);
    renderCompromised(subs);
  }

  chrome.runtime.sendMessage({ type: 'getInsightsData' }, db => {
    render(db);
  });

  document.getElementById('btnClearInsights').addEventListener('click', () => {
    if (!confirm('This will permanently delete all collected insights data. Continue?')) return;
    chrome.runtime.sendMessage({ type: 'clearInsights' }, () => {
      location.reload();
    });
  });
})();
