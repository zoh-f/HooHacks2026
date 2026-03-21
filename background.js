// ============================================================
// RedBot — Background Service Worker
// Handles Reddit API fetching, tiered detection, and caching.
// ============================================================

// ----- Cache -----

const CACHE_TTL = 60 * 60 * 1000;
const cache = new Map();

function getCached(username) {
  const entry = cache.get(username);
  if (entry && Date.now() - entry.ts < CACHE_TTL) return entry.data;
  cache.delete(username);
  return null;
}

function setCache(username, data) {
  cache.set(username, { data, ts: Date.now() });
}

// ----- Rate-Limited Request Queue -----

const queue = [];
let queueRunning = false;

function enqueueFetch(url) {
  return new Promise((resolve, reject) => {
    queue.push({ url, resolve, reject });
    drainQueue();
  });
}

async function drainQueue() {
  if (queueRunning || queue.length === 0) return;
  queueRunning = true;

  const { url, resolve, reject } = queue.shift();
  try {
    const res = await fetch(url);
    if (res.status === 404) throw new Error('not_found');
    if (res.status === 403) throw new Error('suspended');
    if (!res.ok) throw new Error(`http_${res.status}`);
    resolve(await res.json());
  } catch (err) {
    reject(err);
  }

  setTimeout(() => {
    queueRunning = false;
    drainQueue();
  }, 1100);
}

// ----- Reddit API helpers -----

function fetchUserAbout(username) {
  return enqueueFetch(`https://www.reddit.com/user/${username}/about.json`);
}

function fetchUserComments(username, limit = 10) {
  return enqueueFetch(
    `https://www.reddit.com/user/${username}/comments.json?limit=${limit}&sort=new`
  );
}

// ----- Tier 1 — Heuristic filter (account metadata only) -----

const SKIP_USERS = new Set([
  'automoderator', 'autotldr', 'remindmebot', 'sneakpeekbot',
  'gifendore', 'stabbot', 'repostsleuthbot', 'savevideo',
  'vredditdownloader', 'haikibot', 'tweetlinker',
]);

function runTier1(aboutData) {
  const d = aboutData.data;
  let score = 0;
  const signals = [];

  const ageDays = (Date.now() - d.created_utc * 1000) / 86_400_000;

  // Account age (15 pts)
  if (ageDays < 30) {
    score += 15;
    signals.push({ name: 'Very new account', detail: `${Math.floor(ageDays)}d old`, pts: 15 });
  } else if (ageDays < 90) {
    score += 10;
    signals.push({ name: 'New account', detail: `${Math.floor(ageDays)}d old`, pts: 10 });
  } else if (ageDays < 180) {
    score += 5;
    signals.push({ name: 'Young account', detail: `${Math.floor(ageDays)}d old`, pts: 5 });
  }

  // Karma-to-age ratio (20 pts)
  const totalKarma = (d.link_karma || 0) + (d.comment_karma || 0);
  const kpd = totalKarma / Math.max(ageDays, 1);
  if (kpd > 500) {
    score += 20;
    signals.push({ name: 'Extreme karma rate', detail: `${Math.floor(kpd)}/day`, pts: 20 });
  } else if (kpd > 100) {
    score += 12;
    signals.push({ name: 'High karma rate', detail: `${Math.floor(kpd)}/day`, pts: 12 });
  } else if (kpd > 50) {
    score += 6;
    signals.push({ name: 'Elevated karma rate', detail: `${Math.floor(kpd)}/day`, pts: 6 });
  }

  // Username pattern (15 pts)
  const name = d.name;
  const defaultName = /^[A-Z][a-z]+-[A-Z][a-z]+-\d{3,}$/;
  const randomish = /^[a-z]{2,8}\d{3,}$/i;
  const underscoreNum = /^[A-Za-z]+_[A-Za-z]+\d{2,}$/;
  if (defaultName.test(name)) {
    score += 15;
    signals.push({ name: 'Default Reddit name', detail: name, pts: 15 });
  } else if (randomish.test(name) || underscoreNum.test(name)) {
    score += 10;
    signals.push({ name: 'Random-looking name', detail: name, pts: 10 });
  }

  // Default avatar (10 pts)
  const icon = d.icon_img || d.snoovatar_img || '';
  if (!icon || icon.includes('default') || icon.includes('snoo_default')) {
    score += 10;
    signals.push({ name: 'Default avatar', detail: 'No custom avatar', pts: 10 });
  }

  // No bio (10 pts)
  const bio = d.subreddit?.public_description || '';
  if (!bio.trim()) {
    score += 10;
    signals.push({ name: 'No bio', detail: 'Empty profile description', pts: 10 });
  }

  // Email not verified (10 pts)
  if (!d.has_verified_email) {
    score += 10;
    signals.push({ name: 'Unverified email', detail: '', pts: 10 });
  }

  // Karma type imbalance (20 pts)
  const lk = d.link_karma || 0;
  const ck = d.comment_karma || 0;
  const tk = lk + ck;
  if (tk > 100) {
    const ratio = Math.max(lk, ck) / tk;
    if (ratio > 0.98) {
      score += 20;
      signals.push({ name: 'Extreme karma imbalance', detail: `${Math.floor(ratio * 100)}% one type`, pts: 20 });
    } else if (ratio > 0.92) {
      score += 12;
      signals.push({ name: 'Karma imbalance', detail: `${Math.floor(ratio * 100)}% one type`, pts: 12 });
    }
  }

  return {
    score: Math.min(score, 100),
    signals,
    tier: 1,
    meta: {
      username: d.name,
      ageDays: Math.floor(ageDays),
      totalKarma,
      linkKarma: lk,
      commentKarma: ck,
      verified: !!d.has_verified_email,
      icon: d.icon_img,
    },
  };
}

// ----- Tier 2 — Content analysis (sample comments) -----

const GENERIC_PHRASES = [
  'great point', 'this is so true', "couldn't agree more", 'well said',
  'take my upvote', 'this deserves more upvotes', 'underrated comment',
  'came here to say this', 'this is the way', 'you nailed it',
  'totally agree', 'so much this', 'exactly this', 'right on',
  'amen to that', 'preach', 'facts', 'say it louder',
  'this right here', 'big if true', 'based', 'same here',
  'i agree', 'agreed', 'lol', 'lmao', 'nice',
];

function jaccardSimilarity(a, b) {
  const sa = new Set(a.split(/\s+/));
  const sb = new Set(b.split(/\s+/));
  let inter = 0;
  for (const w of sa) if (sb.has(w)) inter++;
  const union = sa.size + sb.size - inter;
  return union > 0 ? inter / union : 0;
}

function runTier2(commentsPayload, tier1) {
  const comments = commentsPayload.data.children
    .filter(c => c.kind === 't1')
    .map(c => c.data);

  if (comments.length === 0) return { ...tier1, tier: 2 };

  let t2 = 0;
  const signals = [...tier1.signals];

  // Generic / low-effort comments (20 pts)
  let genericCount = 0;
  for (const c of comments) {
    const body = (c.body || '').toLowerCase().trim().replace(/[!?.]+$/, '');
    if (body.length < 15 || GENERIC_PHRASES.includes(body)) genericCount++;
  }
  const genericRatio = genericCount / comments.length;
  if (genericRatio > 0.5) {
    t2 += 20;
    signals.push({ name: 'Mostly generic comments', detail: `${genericCount}/${comments.length}`, pts: 20 });
  } else if (genericRatio > 0.3) {
    t2 += 12;
    signals.push({ name: 'Many generic comments', detail: `${genericCount}/${comments.length}`, pts: 12 });
  }

  // Comment-to-comment similarity (25 pts)
  const bodies = comments.map(c => (c.body || '').toLowerCase());
  let simSum = 0, pairs = 0;
  for (let i = 0; i < bodies.length; i++) {
    for (let j = i + 1; j < bodies.length; j++) {
      simSum += jaccardSimilarity(bodies[i], bodies[j]);
      pairs++;
    }
  }
  const avgSim = pairs > 0 ? simSum / pairs : 0;
  if (avgSim > 0.5) {
    t2 += 25;
    signals.push({ name: 'Very repetitive comments', detail: `${Math.floor(avgSim * 100)}% similar`, pts: 25 });
  } else if (avgSim > 0.3) {
    t2 += 15;
    signals.push({ name: 'Somewhat repetitive', detail: `${Math.floor(avgSim * 100)}% similar`, pts: 15 });
  }

  // Subreddit diversity (20 pts)
  const subs = new Set(comments.map(c => c.subreddit));
  const divRatio = subs.size / comments.length;
  if (divRatio < 0.2) {
    t2 += 20;
    signals.push({ name: 'Very low sub diversity', detail: `${subs.size} subs / ${comments.length} comments`, pts: 20 });
  } else if (divRatio < 0.4) {
    t2 += 12;
    signals.push({ name: 'Low sub diversity', detail: `${subs.size} subs / ${comments.length} comments`, pts: 12 });
  }

  // Posting frequency (20 pts)
  const times = comments.map(c => c.created_utc).sort((a, b) => a - b);
  let rapid = 0;
  for (let i = 1; i < times.length; i++) {
    if ((times[i] - times[i - 1]) < 120) rapid++;
  }
  if (rapid > times.length * 0.5) {
    t2 += 20;
    signals.push({ name: 'Inhuman post speed', detail: `${rapid} gaps < 2min`, pts: 20 });
  } else if (rapid > times.length * 0.3) {
    t2 += 10;
    signals.push({ name: 'Rapid posting', detail: `${rapid} gaps < 2min`, pts: 10 });
  }

  // Comment length variance (15 pts)
  const lens = comments.map(c => (c.body || '').length);
  const avg = lens.reduce((a, b) => a + b, 0) / lens.length;
  const stddev = Math.sqrt(lens.reduce((s, l) => s + (l - avg) ** 2, 0) / lens.length);
  const cv = avg > 0 ? stddev / avg : 0;
  if (cv < 0.2) {
    t2 += 15;
    signals.push({ name: 'Uniform comment lengths', detail: `CV ${cv.toFixed(2)}`, pts: 15 });
  } else if (cv < 0.4) {
    t2 += 8;
    signals.push({ name: 'Low length variance', detail: `CV ${cv.toFixed(2)}`, pts: 8 });
  }

  const blended = Math.min(100, Math.round(tier1.score * 0.4 + t2 * 0.6));

  return {
    score: blended,
    signals,
    tier: 2,
    meta: tier1.meta,
    t1Score: tier1.score,
    t2Score: t2,
  };
}

// ----- Tier 3 — Gemini LLM -----

async function getApiKey() {
  return new Promise(r =>
    chrome.storage.sync.get('geminiApiKey', res => r(res.geminiApiKey || ''))
  );
}

async function runTier3(aboutPayload, commentsPayload, prior) {
  const apiKey = await getApiKey();
  if (!apiKey) {
    return { ...prior, tier: 3, llmSkipped: true, llmReason: 'No API key set' };
  }

  const samples = commentsPayload.data.children
    .filter(c => c.kind === 't1')
    .map(c => ({
      body: c.data.body,
      sub: c.data.subreddit,
      score: c.data.score,
      date: new Date(c.data.created_utc * 1000).toISOString(),
    }));

  const m = prior.meta;
  const prompt = `You are a Reddit bot-detection expert. Analyze this account and return a bot probability score from 0 (definitely human) to 100 (definitely bot).

Account metadata:
- Username: ${m.username}
- Account age: ${m.ageDays} days
- Link karma: ${m.linkKarma}, Comment karma: ${m.commentKarma}
- Email verified: ${m.verified}

Recent comments (${samples.length}):
${samples.map((s, i) => `${i + 1}. [r/${s.sub}] (score ${s.score}) "${s.body}"`).join('\n')}

Prior heuristic signals:
${prior.signals.map(s => `- ${s.name}: ${s.detail}`).join('\n')}

Respond with ONLY valid JSON, no markdown fences:
{"score": <0-100>, "reasoning": "<1-2 sentence explanation>"}`;

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.2, maxOutputTokens: 256 },
        }),
      }
    );

    if (!res.ok) throw new Error(`Gemini ${res.status}`);

    const json = await res.json();
    const text = json.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const parsed = JSON.parse(text.replace(/```json\n?|\n?```/g, '').trim());

    const llmScore = parsed.score;
    const finalScore = Math.min(100, Math.round(prior.score * 0.3 + llmScore * 0.7));

    return {
      score: finalScore,
      signals: [
        ...prior.signals,
        { name: 'LLM analysis', detail: parsed.reasoning, pts: llmScore },
      ],
      tier: 3,
      meta: m,
      t1Score: prior.t1Score ?? prior.score,
      t2Score: prior.t2Score,
      t3Score: llmScore,
      llmReasoning: parsed.reasoning,
    };
  } catch (err) {
    console.error('Tier 3 failed:', err);
    return { ...prior, tier: 3, llmSkipped: true, llmReason: err.message };
  }
}

// ----- Main analysis orchestrator -----

async function analyzeUser(username) {
  if (SKIP_USERS.has(username.toLowerCase())) {
    return {
      score: 100, signals: [{ name: 'Known bot', detail: username, pts: 100 }],
      tier: 0, meta: { username }, knownBot: true,
    };
  }

  const cached = getCached(username);
  if (cached) return cached;

  try {
    const aboutData = await fetchUserAbout(username);
    const tier1 = runTier1(aboutData);

    if (tier1.score < 30) {
      setCache(username, tier1);
      return tier1;
    }

    const commentsData = await fetchUserComments(username);
    const tier2 = runTier2(commentsData, tier1);

    if (tier2.score < 60) {
      setCache(username, tier2);
      return tier2;
    }

    const tier3 = await runTier3(aboutData, commentsData, tier2);
    setCache(username, tier3);
    return tier3;
  } catch (err) {
    console.error(`Analysis failed for ${username}:`, err);
    return { score: -1, signals: [], tier: 0, error: err.message, meta: { username } };
  }
}

// ----- Message handling -----

const tabResults = new Map();

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'analyzeUser') {
    const tabId = sender.tab?.id;
    analyzeUser(msg.username).then(result => {
      if (tabId) {
        if (!tabResults.has(tabId)) tabResults.set(tabId, {});
        tabResults.get(tabId)[msg.username] = result;
      }
      sendResponse(result);
    });
    return true;
  }

  if (msg.type === 'getTabResults') {
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      const id = tabs[0]?.id;
      sendResponse(tabResults.get(id) || {});
    });
    return true;
  }

  if (msg.type === 'clearCache') {
    cache.clear();
    tabResults.clear();
    sendResponse({ ok: true });
    return true;
  }
});

chrome.tabs.onRemoved.addListener(id => tabResults.delete(id));
