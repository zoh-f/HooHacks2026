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

// ----- Reddit OAuth -----

async function getRedditToken() {
  const data = await chrome.storage.local.get([
    'redditToken', 'redditTokenExpiry', 'redditRefresh', 'redditClientId',
  ]);
  if (!data.redditToken) return null;

  if (data.redditTokenExpiry && Date.now() > data.redditTokenExpiry - 60_000) {
    if (data.redditRefresh && data.redditClientId) {
      try {
        return await refreshRedditToken(data.redditRefresh, data.redditClientId);
      } catch (e) {
        console.warn('[RedBot] Token refresh failed:', e);
        return null;
      }
    }
    return null;
  }

  return data.redditToken;
}

async function refreshRedditToken(refreshToken, clientId) {
  const res = await fetch('https://www.reddit.com/api/v1/access_token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Basic ${btoa(clientId + ':')}`,
    },
    body: `grant_type=refresh_token&refresh_token=${refreshToken}`,
  });

  if (!res.ok) throw new Error(`Token refresh failed: ${res.status}`);
  const tokenData = await res.json();
  if (tokenData.error) throw new Error(tokenData.error);

  await chrome.storage.local.set({
    redditToken: tokenData.access_token,
    redditTokenExpiry: Date.now() + tokenData.expires_in * 1000,
  });

  return tokenData.access_token;
}

async function redditLogin(clientId) {
  const redirectUri = chrome.identity.getRedirectURL();
  const state = crypto.randomUUID();

  const authUrl =
    `https://www.reddit.com/api/v1/authorize?` +
    `client_id=${encodeURIComponent(clientId)}` +
    `&response_type=code` +
    `&state=${state}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&duration=permanent` +
    `&scope=read`;

  const responseUrl = await chrome.identity.launchWebAuthFlow({
    url: authUrl,
    interactive: true,
  });

  const url = new URL(responseUrl);
  const code = url.searchParams.get('code');
  const returnedState = url.searchParams.get('state');

  if (returnedState !== state) throw new Error('State mismatch');
  if (!code) throw new Error('No authorization code received');

  const tokenRes = await fetch('https://www.reddit.com/api/v1/access_token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Basic ${btoa(clientId + ':')}`,
    },
    body: `grant_type=authorization_code&code=${code}&redirect_uri=${encodeURIComponent(redirectUri)}`,
  });

  if (!tokenRes.ok) throw new Error(`Token exchange failed: ${tokenRes.status}`);
  const tokenData = await tokenRes.json();
  if (tokenData.error) throw new Error(tokenData.error);

  await chrome.storage.local.set({
    redditToken: tokenData.access_token,
    redditRefresh: tokenData.refresh_token,
    redditTokenExpiry: Date.now() + tokenData.expires_in * 1000,
    redditClientId: clientId,
  });

  return { success: true };
}

async function redditLogout() {
  await chrome.storage.local.remove([
    'redditToken', 'redditRefresh', 'redditTokenExpiry', 'redditClientId',
  ]);
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
  let authenticated = false;
  try {
    const token = await getRedditToken();
    let fetchUrl = url;
    const headers = {};

    if (token) {
      authenticated = true;
      fetchUrl = url.replace('https://www.reddit.com/', 'https://oauth.reddit.com/');
      headers['Authorization'] = `Bearer ${token}`;
    }

    const res = await fetch(fetchUrl, { headers });
    console.log(`[RedBot] Fetching: ${fetchUrl}${authenticated ? ' (auth)' : ''}`);
    if (res.status === 429) throw new Error('ratelimited');
    if (res.status === 404) throw new Error('not_found');
    if (res.status === 403) throw new Error('suspended');
    if (res.status === 451) throw new Error('banned');
    if (!res.ok) throw new Error(`http_${res.status}`);
    const data = await res.json();
    console.log(`[RedBot] Fetched OK: ${fetchUrl}`);
    resolve(data);
  } catch (err) {
    console.warn(`[RedBot] Fetch failed: ${url} — ${err.message}`);
    reject(err);
  }

  // Authenticated: 60 req/min → 600ms; unauthenticated: ~10 req/min → 1100ms
  setTimeout(() => {
    queueRunning = false;
    drainQueue();
  }, authenticated ? 600 : 1100);
}

// ----- Reddit API helpers -----

function fetchUserAbout(username) {
  return enqueueFetch(`https://www.reddit.com/user/${username}/about.json`);
}

function fetchUserComments(username, limit = 50) {
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
  console.log(`[RedBot] Tier 1 — analyzing u/${d.name}`);
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

  const finalT1 = Math.min(score, 100);
  console.log(`[RedBot] Tier 1 — u/${d.name} score: ${finalT1}`, signals);

  return {
    score: finalT1,
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

  console.log(`[RedBot] Tier 2 — u/${tier1.meta.username}, ${comments.length} comments sampled`);

  if (comments.length === 0) return { ...tier1, tier: 2 };

  comments.sort((a, b) => a.created_utc - b.created_utc);
  const times = comments.map(c => c.created_utc);
  const bodies = comments.map(c => (c.body || '').toLowerCase());

  let t2 = 0;
  const signals = [...tier1.signals];

  // Generic / low-effort comments (15 pts)
  let genericCount = 0;
  for (const c of comments) {
    const body = (c.body || '').toLowerCase().trim().replace(/[!?.]+$/, '');
    if (body.length < 15 || GENERIC_PHRASES.includes(body)) genericCount++;
  }
  const genericRatio = genericCount / comments.length;
  if (genericRatio > 0.5) {
    t2 += 15;
    signals.push({ name: 'Mostly generic comments', detail: `${genericCount}/${comments.length}`, pts: 15 });
  } else if (genericRatio > 0.3) {
    t2 += 8;
    signals.push({ name: 'Many generic comments', detail: `${genericCount}/${comments.length}`, pts: 8 });
  }

  // Post-to-post similarity — consecutive (15 pts)
  if (bodies.length > 1) {
    let consecSum = 0;
    for (let i = 0; i < bodies.length - 1; i++) {
      consecSum += jaccardSimilarity(bodies[i], bodies[i + 1]);
    }
    const avgConsec = consecSum / (bodies.length - 1);
    if (avgConsec > 0.6) {
      t2 += 15;
      signals.push({ name: 'Very repetitive (consecutive)', detail: `${Math.floor(avgConsec * 100)}% avg`, pts: 15 });
    } else if (avgConsec > 0.35) {
      t2 += 8;
      signals.push({ name: 'Repetitive (consecutive)', detail: `${Math.floor(avgConsec * 100)}% avg`, pts: 8 });
    }
  }

  // Subreddit diversity (12 pts)
  const subs = new Set(comments.map(c => c.subreddit));
  const divRatio = subs.size / comments.length;
  if (divRatio < 0.15) {
    t2 += 12;
    signals.push({ name: 'Very low sub diversity', detail: `${subs.size} subs / ${comments.length} comments`, pts: 12 });
  } else if (divRatio < 0.35) {
    t2 += 6;
    signals.push({ name: 'Low sub diversity', detail: `${subs.size} subs / ${comments.length} comments`, pts: 6 });
  }

  // Comment length variance (8 pts)
  const lens = comments.map(c => (c.body || '').length);
  const avgLen = lens.reduce((a, b) => a + b, 0) / lens.length;
  const stddev = Math.sqrt(lens.reduce((s, l) => s + (l - avgLen) ** 2, 0) / lens.length);
  const cv = avgLen > 0 ? stddev / avgLen : 0;
  if (cv < 0.2) {
    t2 += 8;
    signals.push({ name: 'Uniform comment lengths', detail: `CV ${cv.toFixed(2)}`, pts: 8 });
  } else if (cv < 0.35) {
    t2 += 4;
    signals.push({ name: 'Low length variance', detail: `CV ${cv.toFixed(2)}`, pts: 4 });
  }

  // Median interval between posts (12 pts)
  if (times.length > 1) {
    const intervals = [];
    for (let i = 1; i < times.length; i++) intervals.push(times[i] - times[i - 1]);
    intervals.sort((a, b) => a - b);
    const median = intervals[Math.floor(intervals.length / 2)];
    if (median < 60) {
      t2 += 12;
      signals.push({ name: 'Median interval < 1min', detail: `${median}s`, pts: 12 });
    } else if (median < 180) {
      t2 += 6;
      signals.push({ name: 'Median interval < 3min', detail: `${median}s`, pts: 6 });
    }
  }

  // Active hours / day (10 pts)
  const activeHours = new Set(comments.map(c => new Date(c.created_utc * 1000).getUTCHours()));
  if (activeHours.size >= 20) {
    t2 += 10;
    signals.push({ name: 'Active nearly 24h', detail: `${activeHours.size}/24 hrs`, pts: 10 });
  } else if (activeHours.size >= 16) {
    t2 += 5;
    signals.push({ name: 'Unusually wide active hours', detail: `${activeHours.size}/24 hrs`, pts: 5 });
  }

  // Burstiness — max comments in any 5-min window (12 pts)
  let maxBurst = 0;
  for (let i = 0; i < times.length; i++) {
    let count = 1;
    for (let j = i + 1; j < times.length && times[j] - times[i] <= 300; j++) count++;
    if (count > maxBurst) maxBurst = count;
  }
  if (maxBurst >= 8) {
    t2 += 12;
    signals.push({ name: 'Extreme burst (5min)', detail: `${maxBurst} comments`, pts: 12 });
  } else if (maxBurst >= 5) {
    t2 += 6;
    signals.push({ name: 'Comment burst (5min)', detail: `${maxBurst} comments`, pts: 6 });
  }

  // Links % in comments (10 pts)
  const linkRe = /https?:\/\/\S+/;
  const linkCount = comments.filter(c => linkRe.test(c.body || '')).length;
  const linkRatio = linkCount / comments.length;
  if (linkRatio > 0.7) {
    t2 += 10;
    signals.push({ name: 'Most comments have links', detail: `${Math.floor(linkRatio * 100)}%`, pts: 10 });
  } else if (linkRatio > 0.4) {
    t2 += 5;
    signals.push({ name: 'Many comments have links', detail: `${Math.floor(linkRatio * 100)}%`, pts: 5 });
  }

  // Max unique subs in any 24h window (10 pts)
  let maxSubsIn24h = 0;
  for (let i = 0; i < comments.length; i++) {
    const windowSubs = new Set();
    for (let j = i; j < comments.length && comments[j].created_utc - comments[i].created_utc <= 86400; j++) {
      windowSubs.add(comments[j].subreddit);
    }
    if (windowSubs.size > maxSubsIn24h) maxSubsIn24h = windowSubs.size;
  }
  if (maxSubsIn24h >= 15) {
    t2 += 10;
    signals.push({ name: 'Extreme sub spread (24h)', detail: `${maxSubsIn24h} subs`, pts: 10 });
  } else if (maxSubsIn24h >= 10) {
    t2 += 5;
    signals.push({ name: 'High sub spread (24h)', detail: `${maxSubsIn24h} subs`, pts: 5 });
  }

  // Hour entropy — uniform posting across hours is bot-like (10 pts)
  const hourBins = new Array(24).fill(0);
  comments.forEach(c => hourBins[new Date(c.created_utc * 1000).getUTCHours()]++);
  let entropy = 0;
  for (const n of hourBins) {
    if (n > 0) {
      const p = n / comments.length;
      entropy -= p * Math.log2(p);
    }
  }
  if (entropy > 4.0) {
    t2 += 10;
    signals.push({ name: 'Very uniform hour spread', detail: `H=${entropy.toFixed(2)}`, pts: 10 });
  } else if (entropy > 3.5) {
    t2 += 5;
    signals.push({ name: 'Uniform hour spread', detail: `H=${entropy.toFixed(2)}`, pts: 5 });
  }

  const blended = Math.min(100, Math.round(tier1.score * 0.4 + t2 * 0.6));
  console.log(`[RedBot] Tier 2 — u/${tier1.meta.username} T1=${tier1.score} T2raw=${t2} blended=${blended}`);

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
  console.log(`[RedBot] Tier 3 — u/${prior.meta.username}, calling Gemini`);
  const apiKey = await getApiKey();
  if (!apiKey) {
    console.warn('[RedBot] Tier 3 — skipped, no API key set');
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
    console.log(`[RedBot] Tier 3 — u/${prior.meta.username} LLM=${llmScore} final=${finalScore}`, parsed.reasoning);

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
  if (cached) {
    console.log(`[RedBot] Cache hit for u/${username}`);
    return cached;
  }

  console.log(`[RedBot] Starting analysis for u/${username}`);

  try {
    const aboutData = await fetchUserAbout(username);
    const tier1 = runTier1(aboutData);

    if (tier1.score < 10) {
      console.log(`[RedBot] u/${username} — Tier 1 passed (${tier1.score}%), stopping`);
      setCache(username, tier1);
      return tier1;
    }

    console.log(`[RedBot] u/${username} — Tier 1 flagged (${tier1.score}%), advancing to Tier 2`);
    const commentsData = await fetchUserComments(username);
    const tier2 = runTier2(commentsData, tier1);

    if (tier2.score < 40) {
      console.log(`[RedBot] u/${username} — Tier 2 passed (${tier2.score}%), stopping`);
      setCache(username, tier2);
      return tier2;
    }

    console.log(`[RedBot] u/${username} — Tier 2 flagged (${tier2.score}%), advancing to Tier 3`);
    const tier3 = await runTier3(aboutData, commentsData, tier2);
    setCache(username, tier3);
    return tier3;
  } catch (err) {
    console.error(`[RedBot] Analysis failed for u/${username}:`, err.message);

    let errorType = 'error';
    if (err.message === 'ratelimited') errorType = 'ratelimited';
    else if (err.message === 'suspended') errorType = 'suspended';
    else if (err.message === 'banned') errorType = 'banned';
    else if (err.message === 'not_found') errorType = 'deleted';

    const result = {
      score: -1,
      signals: [],
      tier: 0,
      error: err.message,
      errorType,
      meta: { username },
    };
    if (errorType !== 'ratelimited') setCache(username, result);
    return result;
  }
}

// ----- Deep analysis (forced Tier 3) -----

async function deepAnalyzeUser(username) {
  console.log(`[RedBot] Deep analysis — running all tiers for u/${username}`);
  try {
    const aboutData = await fetchUserAbout(username);
    const tier1 = runTier1(aboutData);
    const commentsData = await fetchUserComments(username);
    const tier2 = runTier2(commentsData, tier1);
    const tier3 = await runTier3(aboutData, commentsData, tier2);

    setCache(username, tier3);
    console.log(`[RedBot] Deep analysis complete for u/${username} — score=${tier3.score}`);
    return tier3;
  } catch (err) {
    console.error(`[RedBot] Deep analysis failed for u/${username}:`, err.message);

    let errorType = 'error';
    if (err.message === 'ratelimited') errorType = 'ratelimited';
    else if (err.message === 'suspended') errorType = 'suspended';
    else if (err.message === 'banned') errorType = 'banned';
    else if (err.message === 'not_found') errorType = 'deleted';

    const result = {
      score: -1, signals: [], tier: 0,
      error: err.message, errorType, meta: { username },
    };
    if (errorType !== 'ratelimited') setCache(username, result);
    return result;
  }
}

// ----- Message handling -----

const tabResults = new Map();

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'analyzeUser') {
    console.log(`[RedBot] Message: analyzeUser — u/${msg.username}`);
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

  if (msg.type === 'deepAnalyze') {
    console.log(`[RedBot] Deep analysis requested for u/${msg.username}`);
    deepAnalyzeUser(msg.username).then(result => {
      const tabId = sender.tab?.id;
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

  if (msg.type === 'redditLogin') {
    redditLogin(msg.clientId)
      .then(r => sendResponse(r))
      .catch(e => sendResponse({ error: e.message }));
    return true;
  }

  if (msg.type === 'redditLogout') {
    redditLogout().then(() => sendResponse({ ok: true }));
    return true;
  }

  if (msg.type === 'getRedditAuth') {
    chrome.storage.local.get(
      ['redditToken', 'redditTokenExpiry', 'redditClientId'],
      data => {
        const loggedIn = !!(data.redditToken && data.redditTokenExpiry > Date.now());
        sendResponse({ loggedIn, clientId: data.redditClientId || '' });
      },
    );
    return true;
  }

  if (msg.type === 'getRedirectUrl') {
    sendResponse({ url: chrome.identity.getRedirectURL() });
    return true;
  }
});

chrome.tabs.onRemoved.addListener(id => tabResults.delete(id));
