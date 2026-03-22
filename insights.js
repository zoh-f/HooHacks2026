/* ============================================================
   AstroGuard — Insights Dashboard
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

  function classifySubreddit(name) {
    const lc = name.toLowerCase();
    let seriousHits = 0;
    for (const kw of SERIOUS_KEYWORDS) if (lc.includes(kw)) seriousHits++;
    if (seriousHits > 0) return 'serious';
    return 'entertainment';
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

    let seriousScans = 0, seriousSum = 0;
    let entScans = 0, entSum = 0;
    const seriousNames = [];
    const entNames = [];

    for (const [name, v] of Object.entries(subs)) {
      const cat = classifySubreddit(name);
      if (cat === 'serious') {
        seriousScans += v.scans; seriousSum += v.scoreSum;
        seriousNames.push(name);
      } else {
        entScans += v.scans; entSum += v.scoreSum;
        entNames.push(name);
      }
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

    let html = card('Policy / Discussion', sAvg, seriousScans, seriousNames.length, 'policy/news');
    html += card('Entertainment / General', eAvg, entScans, entNames.length, 'entertainment');

    if (sAvg !== null && eAvg !== null) {
      const diff = Math.abs(sAvg - eAvg);
      const higher = sAvg > eAvg ? 'Policy / Discussion' : 'Entertainment / General';
      if (diff > 0) {
        html += `<div class="compare-note">${higher} has a ${diff} percentage point higher average bot score</div>`;
      } else {
        html += '<div class="compare-note">Both categories have equal average bot scores</div>';
      }
    }

    function subList(title, names) {
      if (names.length === 0) return '';
      const items = names.sort().map(n => `<li>r/${n}</li>`).join('');
      return `<div class="compare-sub-list"><h4>${title}</h4><ul>${items}</ul></div>`;
    }
    html += '<div class="compare-subs">';
    html += subList('Policy / Discussion', seriousNames);
    html += subList('Entertainment / General', entNames);
    html += '</div>';

    document.getElementById('compareRow').innerHTML = html;
  }

  function heatColor(botPct, intensity) {
    if (intensity === 0) return '#12261a';
    const hue = 130 - (botPct / 100) * 130;
    const sat = 55 + intensity * 7;
    const light = 12 + intensity * 9;
    return `hsl(${Math.round(hue)}, ${sat}%, ${light}%)`;
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

    const counts = Object.values(buckets).map(b => b.count);
    const maxCount = Math.max(...counts, 1);
    const q1 = maxCount * 0.25, q2 = maxCount * 0.5, q3 = maxCount * 0.75;
    function intensity(count) {
      if (count === 0) return 0;
      if (count <= q1) return 1;
      if (count <= q2) return 2;
      if (count <= q3) return 3;
      return 4;
    }

    const sorted = Object.keys(buckets).sort();
    const endDate = new Date(sorted[sorted.length - 1] + 'T00:00:00');
    const numWeeks = 17;
    const startDate = new Date(endDate);
    startDate.setDate(startDate.getDate() - numWeeks * 7 + 1);
    while (startDate.getDay() !== 0) startDate.setDate(startDate.getDate() - 1);

    const weeks = [];
    const cursor = new Date(startDate);
    while (cursor <= endDate) {
      const week = [];
      for (let d = 0; d < 7; d++) {
        const key = cursor.toISOString().slice(0, 10);
        const b = buckets[key] || null;
        week.push({ key, date: new Date(cursor), data: b });
        cursor.setDate(cursor.getDate() + 1);
      }
      weeks.push(week);
    }

    const monthLabels = [];
    let lastMonth = -1;
    weeks.forEach((week, wi) => {
      const first = week.find(d => d.date.getDate() <= 7 && d.date.getMonth() !== lastMonth);
      if (first) {
        lastMonth = first.date.getMonth();
        monthLabels.push({ wi, label: first.date.toLocaleDateString(undefined, { month: 'short' }) });
      }
    });

    const cellW = 13, gap = 3;
    const monthsHtml = (() => {
      let html = '';
      let prev = 0;
      for (const { wi, label } of monthLabels) {
        const left = (wi - prev) * (cellW + gap);
        html += `<span style="width:${left}px"></span>${label}`;
        prev = wi;
      }
      return html;
    })();

    const dayLabels = ['', 'Mon', '', 'Wed', '', 'Fri', ''];

    const chartEl = document.getElementById('temporalChart');
    chartEl.className = 'heatmap-wrap';
    chartEl.innerHTML =
      `<div class="heatmap-months">${monthsHtml}</div>` +
      `<div class="heatmap-body">` +
        `<div class="heatmap-days">${dayLabels.map(l => `<span>${l}</span>`).join('')}</div>` +
        `<div class="heatmap-grid">${weeks.map(week =>
          `<div class="heatmap-week">${week.map(cell => {
            const b = cell.data;
            const count = b ? b.count : 0;
            const botP = b ? pct(b.botCount, b.count) : 0;
            const color = heatColor(botP, intensity(count));
            const dateStr = cell.date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
            const tipText = count === 0
              ? `${dateStr}: No scans`
              : `${dateStr}: ${count} scan${count !== 1 ? 's' : ''}, ${botP}% bots`;
            return `<div class="heatmap-cell" style="background:${color}" data-tip="${tipText}"></div>`;
          }).join('')}</div>`
        ).join('')}</div>` +
      `</div>` +
      `<div class="heatmap-legend">` +
        `<span>Less</span>` +
        `<span class="heatmap-legend-cell" style="background:#12261a"></span>` +
        `<span class="heatmap-legend-cell" style="background:${heatColor(0, 1)}"></span>` +
        `<span class="heatmap-legend-cell" style="background:${heatColor(0, 3)}"></span>` +
        `<span class="heatmap-legend-cell" style="background:${heatColor(50, 2)}"></span>` +
        `<span class="heatmap-legend-cell" style="background:${heatColor(100, 3)}"></span>` +
        `<span class="heatmap-legend-cell" style="background:${heatColor(100, 4)}"></span>` +
        `<span>More bots</span>` +
      `</div>`;

    let tip = document.getElementById('temporal-tooltip');
    if (!tip) {
      tip = document.createElement('div');
      tip.id = 'temporal-tooltip';
      tip.className = 'chart-tooltip';
      document.body.appendChild(tip);
    }
    chartEl.querySelectorAll('.heatmap-cell').forEach(cell => {
      cell.addEventListener('mouseenter', () => {
        tip.textContent = cell.dataset.tip;
        tip.style.display = 'block';
        const rect = cell.getBoundingClientRect();
        tip.style.left = rect.left + rect.width / 2 + 'px';
        tip.style.top = rect.top - 6 + 'px';
      });
      cell.addEventListener('mouseleave', () => { tip.style.display = 'none'; });
    });
  }

  const SIGNAL_EXPLANATIONS = {
    'Very new account': 'Accounts under 30 days old are frequently disposable bot accounts created for short-term campaigns.',
    'New account': 'Accounts under 90 days old have less history to verify, a common trait of bot farms.',
    'Young account': 'Accounts under 6 months may still be building a fake identity to appear legitimate.',
    'Extreme karma rate': 'Gaining karma at an abnormally high rate suggests automated activity or karma farming.',
    'High karma rate': 'Elevated karma gain speed can indicate coordinated upvoting or bot farming behavior.',
    'Elevated karma rate': 'Above-average karma acquisition may reflect early-stage karma farming.',
    'Default Reddit name': 'Auto-generated usernames (e.g. Adjective-Noun-1234) are a hallmark of mass-created bot accounts.',
    'Random-looking name': 'Random alphanumeric usernames suggest the account was programmatically generated.',
    'Default avatar': 'Not setting a custom avatar is common for bot accounts that skip personalization.',
    'No bio': 'Empty profile descriptions suggest minimal effort to appear as a real user.',
    'Unverified email': 'Lack of email verification is more common among throwaway or bot accounts.',
    'Extreme karma imbalance': 'Having nearly all karma from one type (comment or post) suggests narrow automated behavior.',
    'Karma imbalance': 'A skewed karma ratio can indicate specialized bot activity focused on one interaction type.',
    'FirstNameLastName pattern': 'Usernames matching this pattern are commonly generated by bot account creation scripts.',
    '"Bot" in username': 'The username explicitly contains "bot," which may indicate a self-identified automated account.',
    'Self-identifies as bot': 'The account uses footers or disclaimers identifying itself as a bot.',
    'Bot footer detected': 'Comments contain automated bot footers or signatures.',
    'Mostly generic comments': 'A high ratio of vague, low-effort comments suggests templated or auto-generated responses.',
    'Many generic comments': 'Multiple generic comments can indicate a bot padding its history with filler content.',
    'Very repetitive (consecutive)': 'Posting nearly identical consecutive comments is a strong indicator of automated behavior.',
    'Repetitive (consecutive)': 'Repeating similar comments in sequence suggests scripted posting patterns.',
    'Very low sub diversity': 'Posting in very few subreddits suggests the account is targeting specific communities.',
    'Low sub diversity': 'Limited subreddit variety may indicate a single-purpose or campaign-driven account.',
    'Uniform comment lengths': 'Comments with suspiciously similar character counts suggest templated generation.',
    'Low length variance': 'Little variation in comment length can indicate automated or formulaic writing.',
    'Median interval < 1min': 'Posting faster than one comment per minute is difficult for humans but easy for bots.',
    'Median interval < 3min': 'Very rapid posting intervals suggest possible automation or scripted behavior.',
    'Extreme burst (5min)': 'Posting many comments within a 5-minute window indicates likely automated rapid-fire activity.',
    'Comment burst (5min)': 'Clusters of comments in short time spans can indicate scripted behavior.',
    'Most comments have links': 'Accounts that primarily post links may be running spam or promotional campaigns.',
    'Many comments have links': 'Frequent link posting can indicate promotional bot activity.',
    'Likely AI-written comments': 'Comments show strong markers of large language model generation (e.g., hedging phrases, list formatting).',
    'Possible AI-written comments': 'Some comments exhibit patterns consistent with AI text generation.',
    'Long dormancy before activity': 'A long inactive period followed by sudden activity can indicate a compromised or sold account.',
    'Dormancy gap': 'Gaps in activity may suggest the account changed hands or was reactivated for a campaign.',
    'Mostly AskReddit comments': 'Heavy AskReddit activity is a common karma-farming strategy for new bot accounts.',
    'Heavy AskReddit activity': 'Concentrated AskReddit commenting is a well-known tactic for quickly building karma.',
    'Hidden karma': 'High karma with few visible comments suggests deleted history or manipulated scores.',
    'Karma with few comments': 'A mismatch between karma and visible activity may indicate scrubbed post history.',
    'HTML entity artifacts': 'HTML artifacts (&amp;, &gt;, etc.) in comments suggest copy-paste from automated pipelines.',
    'Quote format artifacts': 'Comments that are entirely quoted text may be auto-scraped from other sources.',
    'Quote format artifact': 'Quoted text in comments can indicate content copied from elsewhere automatically.',
    'Suspicious link domains': 'Links to .live, .shop, or similar domains are commonly associated with spam bots.',
    'Many duplicate comments': 'Posting identical comments repeatedly is a clear indicator of automated spamming.',
    'Duplicate comments': 'Repeated identical comments suggest scripted behavior.',
    'LLM bot analysis': 'Gemini AI analysis flagged behavioral patterns consistent with bot activity.',
    'AI content detection': 'Statistical analysis suggests the writing style is consistent with AI-generated text.',
    'Known bot': 'This account is in the known-bot database.',
  };

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
    document.getElementById('signalBars').innerHTML = sorted.map(([name, count]) => {
      const desc = SIGNAL_EXPLANATIONS[name] || '';
      return `
        <div class="signal-row">
          <div class="signal-main">
            <span class="signal-name">${name}</span>
            <div class="bar-track">
              <div class="bar-fill signal" style="width:${(count / maxVal) * 100}%"></div>
              <span class="bar-value">${count}</span>
            </div>
          </div>
          ${desc ? `<div class="signal-desc">${desc}</div>` : ''}
        </div>`;
    }).join('');
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
