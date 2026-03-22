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
const MAX_BACKOFF = 60000;   // cap at 60s
const MAX_RETRIES = 6;       // 2s → 4s → 8s → 16s → 32s → 60s then give up

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
  let backoff = 2000;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const token = await getRedditToken();
      let fetchUrl = url;
      const headers = {};

      if (token) {
        authenticated = true;
        fetchUrl = url.replace('https://www.reddit.com/', 'https://oauth.reddit.com/');
        headers['Authorization'] = `Bearer ${token}`;
      }

      if (attempt > 0) {
        console.log(`[RedBot] Retry #${attempt} for: ${url} (waited ${backoff / 1000}s)`);
      }

      const res = await fetch(fetchUrl, { headers });
      console.log(`[RedBot] Fetching: ${fetchUrl}${authenticated ? ' (auth)' : ''}`);

      if (res.status === 429) {
        if (attempt < MAX_RETRIES) {
          console.warn(`[RedBot] Rate limited on ${url} — backing off ${backoff / 1000}s (attempt ${attempt + 1}/${MAX_RETRIES})`);
          await new Promise(r => setTimeout(r, backoff));
          backoff = Math.min(backoff * 2, MAX_BACKOFF);
          continue;
        }
        throw new Error('ratelimited');
      }

      if (res.status === 404) throw new Error('not_found');
      if (res.status === 403) throw new Error('suspended');
      if (res.status === 451) throw new Error('banned');
      if (!res.ok) throw new Error(`http_${res.status}`);

      const data = await res.json();
      console.log(`[RedBot] Fetched OK: ${fetchUrl}`);
      resolve(data);
      break;
    } catch (err) {
      if (err.message !== 'ratelimited' && attempt < MAX_RETRIES) {
        console.warn(`[RedBot] Fetch error on ${url}: ${err.message} — not retryable, failing`);
      }
      if (attempt === MAX_RETRIES || err.message !== 'ratelimited') {
        console.warn(`[RedBot] Fetch failed: ${url} — ${err.message}`);
        reject(err);
        break;
      }
    }
  }

  const delay = authenticated ? 600 : 1100;
  setTimeout(() => {
    queueRunning = false;
    drainQueue();
  }, delay);
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

// ----- Known bots -----

const SKIP_USERS = new Set([
  'automoderator', 'autotldr', 'remindmebot', 'sneakpeekbot',
  'gifendore', 'stabbot', 'repostsleuthbot', 'savevideo',
  'vredditdownloader', 'haikibot', 'tweetlinker',
  'judgement_bot_aita', 'botdefense', 'b0teleprompter',
  'totesmessenger', 'sub_doesnt_exist_bot', 'nice-scores',
  'haikubot-1911', 'anti-teleportation-b', 'whynotcollegeboard',
  'original-poster-bot', 'userleansbot', 'nwordcountbot',
  'profanitycounter', 'commonmisspellingbot',
]);

// ----- Tier 1 — Combined heuristics (metadata + content) -----

const GENERIC_PHRASES = new Set([
  'great point', 'this is so true', "couldn't agree more", 'well said',
  'take my upvote', 'this deserves more upvotes', 'underrated comment',
  'came here to say this', 'this is the way', 'you nailed it',
  'totally agree', 'so much this', 'exactly this', 'right on',
  'amen to that', 'preach', 'facts', 'say it louder',
  'this right here', 'big if true', 'based', 'same here',
  'i agree', 'agreed', 'lol', 'lmao', 'nice',
]);

// Phrases that LLMs tend to overuse — presence across multiple comments is a strong signal
const AI_TELL_PHRASES = [
  "it's worth noting", "it's important to note", "it's important to remember",
  "that being said", "that said,", "having said that",
  "i completely understand", "i understand your concern",
  "great question", "excellent point", "fascinating",
  "in terms of", "when it comes to", "in the context of",
  "it's crucial", "it's essential", "it's vital",
  "navigate", "leverage", "utilize", "delve", "tapestry",
  "comprehensive", "multifaceted", "nuanced",
  "i'd be happy to", "absolutely!", "certainly!",
  "here's the thing", "at the end of the day",
  "from my perspective", "in my humble opinion",
  "it depends on", "there are several factors",
  "on the other hand", "however, it's",
  "hope this helps", "feel free to",
  "first and foremost", "last but not least",
  "in conclusion", "to summarize",
  "the key takeaway", "the bottom line",
];

function jaccardSimilarity(a, b) {
  const sa = new Set(a.split(/\s+/));
  const sb = new Set(b.split(/\s+/));
  let inter = 0;
  for (const w of sa) if (sb.has(w)) inter++;
  const union = sa.size + sb.size - inter;
  return union > 0 ? inter / union : 0;
}

function trustMultiplier(ageDays, totalKarma) {
  if (ageDays > 730 && totalKarma > 10000) return 0.4;
  if (ageDays > 365 && totalKarma > 5000) return 0.6;
  if (ageDays > 180 && totalKarma > 1000) return 0.8;
  return 1.0;
}

function runHeuristics(aboutData, commentsPayload) {
  const d = aboutData.data;
  console.log(`[RedBot] Heuristics — analyzing u/${d.name}`);
  let raw = 0;
  const signals = [];

  const ageDays = (Date.now() - d.created_utc * 1000) / 86_400_000;
  const totalKarma = (d.link_karma || 0) + (d.comment_karma || 0);
  const lk = d.link_karma || 0;
  const ck = d.comment_karma || 0;

  // ---- Account metadata signals ----

  // Account age (max 12)
  if (ageDays < 30) {
    raw += 12;
    signals.push({ name: 'Very new account', detail: `${Math.floor(ageDays)}d old`, pts: 12 });
  } else if (ageDays < 90) {
    raw += 8;
    signals.push({ name: 'New account', detail: `${Math.floor(ageDays)}d old`, pts: 8 });
  } else if (ageDays < 180) {
    raw += 5;
    signals.push({ name: 'Young account', detail: `${Math.floor(ageDays)}d old`, pts: 5 });
  }

  // Karma-to-age ratio (max 12)
  const kpd = totalKarma / Math.max(ageDays, 1);
  if (kpd > 500) {
    raw += 12;
    signals.push({ name: 'Extreme karma rate', detail: `${Math.floor(kpd)}/day`, pts: 12 });
  } else if (kpd > 100) {
    raw += 8;
    signals.push({ name: 'High karma rate', detail: `${Math.floor(kpd)}/day`, pts: 8 });
  } else if (kpd > 50) {
    raw += 4;
    signals.push({ name: 'Elevated karma rate', detail: `${Math.floor(kpd)}/day`, pts: 4 });
  }

  // Username pattern (max 10)
  const name = d.name;
  const defaultName = /^[A-Z][a-z]+-[A-Z][a-z]+-\d{3,}$/;
  const randomish = /^[a-z]{2,8}\d{3,}$/i;
  const underscoreNum = /^[A-Za-z]+_[A-Za-z]+\d{2,}$/;
  if (defaultName.test(name)) {
    raw += 10;
    signals.push({ name: 'Default Reddit name', detail: name, pts: 10 });
  } else if (randomish.test(name) || underscoreNum.test(name)) {
    raw += 6;
    signals.push({ name: 'Random-looking name', detail: name, pts: 6 });
  }

  // Default avatar (3)
  const icon = d.icon_img || d.snoovatar_img || '';
  if (!icon || icon.includes('default') || icon.includes('snoo_default')) {
    raw += 3;
    signals.push({ name: 'Default avatar', detail: 'No custom avatar', pts: 3 });
  }

  // No bio (3)
  const bio = d.subreddit?.public_description || '';
  if (!bio.trim()) {
    raw += 3;
    signals.push({ name: 'No bio', detail: 'Empty profile description', pts: 3 });
  }

  // Unverified email (3)
  if (!d.has_verified_email) {
    raw += 3;
    signals.push({ name: 'Unverified email', detail: '', pts: 3 });
  }

  // Karma type imbalance (max 8)
  const tk = lk + ck;
  if (tk > 100) {
    const ratio = Math.max(lk, ck) / tk;
    if (ratio > 0.98) {
      raw += 8;
      signals.push({ name: 'Extreme karma imbalance', detail: `${Math.floor(ratio * 100)}% one type`, pts: 8 });
    } else if (ratio > 0.92) {
      raw += 5;
      signals.push({ name: 'Karma imbalance', detail: `${Math.floor(ratio * 100)}% one type`, pts: 5 });
    }
  }

  // Username pattern: FirstnameLastname with no separators (max 4)
  const camelName = /^[A-Z][a-z]{2,10}[A-Z][a-z]{2,10}$/;
  if (camelName.test(name)) {
    raw += 4;
    signals.push({ name: 'FirstNameLastName pattern', detail: name, pts: 4 });
  }

  // Username contains "bot" — strong self-identification signal (max 15)
  const lowerName = name.toLowerCase();
  if (/bot($|[_\-\d])/.test(lowerName) || lowerName.startsWith('bot_') || lowerName.startsWith('bot-')) {
    raw += 15;
    signals.push({ name: '"Bot" in username', detail: name, pts: 15 });
  }

  // ---- Content analysis signals ----

  const comments = commentsPayload.data.children
    .filter(c => c.kind === 't1')
    .map(c => c.data);

  console.log(`[RedBot] Heuristics — u/${d.name}, ${comments.length} comments sampled`);

  const flaggedComments = [];

  if (comments.length > 0) {
    comments.sort((a, b) => a.created_utc - b.created_utc);
    const times = comments.map(c => c.created_utc);
    const bodies = comments.map(c => (c.body || '').toLowerCase());

    // Self-identifies as bot — "I am a bot" footer (instant 50 pts)
    const botFooterRe = /i am a bot|this action was performed automatically|please contact the moderators.*if you have.*questions/i;
    let botFooterCount = 0;
    for (const c of comments) {
      if (botFooterRe.test(c.body || '')) botFooterCount++;
    }
    if (botFooterCount > 0) {
      const ratio = botFooterCount / comments.length;
      if (ratio > 0.3) {
        raw += 50;
        signals.push({ name: 'Self-identifies as bot', detail: `${botFooterCount}/${comments.length} have bot footer`, pts: 50 });
      } else {
        raw += 25;
        signals.push({ name: 'Bot footer detected', detail: `${botFooterCount}/${comments.length} have bot footer`, pts: 25 });
      }
    }

    // Generic / low-effort comments (max 10)
    let genericCount = 0;
    for (const c of comments) {
      const body = (c.body || '').toLowerCase().trim().replace(/[!?.]+$/, '');
      const isGeneric = body.length < 15 || GENERIC_PHRASES.has(body);
      if (isGeneric) {
        genericCount++;
        flaggedComments.push({ body: c.body, sub: c.subreddit, reason: 'generic' });
      }
    }
    const genericRatio = genericCount / comments.length;
    if (genericRatio > 0.5) {
      raw += 10;
      signals.push({ name: 'Mostly generic comments', detail: `${genericCount}/${comments.length}`, pts: 10 });
    } else if (genericRatio > 0.3) {
      raw += 5;
      signals.push({ name: 'Many generic comments', detail: `${genericCount}/${comments.length}`, pts: 5 });
    }

    // Consecutive comment similarity (max 10)
    if (bodies.length > 1) {
      let consecSum = 0;
      let maxSim = 0;
      let maxSimIdx = -1;
      for (let i = 0; i < bodies.length - 1; i++) {
        const sim = jaccardSimilarity(bodies[i], bodies[i + 1]);
        consecSum += sim;
        if (sim > maxSim) { maxSim = sim; maxSimIdx = i; }
      }
      const avgConsec = consecSum / (bodies.length - 1);
      if (avgConsec > 0.6) {
        raw += 10;
        signals.push({ name: 'Very repetitive (consecutive)', detail: `${Math.floor(avgConsec * 100)}% avg`, pts: 10 });
      } else if (avgConsec > 0.35) {
        raw += 5;
        signals.push({ name: 'Repetitive (consecutive)', detail: `${Math.floor(avgConsec * 100)}% avg`, pts: 5 });
      }
      if (maxSim > 0.5 && maxSimIdx >= 0) {
        flaggedComments.push({ body: comments[maxSimIdx].body, sub: comments[maxSimIdx].subreddit, reason: 'similar' });
        flaggedComments.push({ body: comments[maxSimIdx + 1].body, sub: comments[maxSimIdx + 1].subreddit, reason: 'similar' });
      }
    }

    // Subreddit diversity (max 8, single signal)
    const subs = new Set(comments.map(c => c.subreddit));
    const divRatio = subs.size / comments.length;
    if (divRatio < 0.15) {
      raw += 8;
      signals.push({ name: 'Very low sub diversity', detail: `${subs.size} subs / ${comments.length} comments`, pts: 8 });
    } else if (divRatio < 0.35) {
      raw += 4;
      signals.push({ name: 'Low sub diversity', detail: `${subs.size} subs / ${comments.length} comments`, pts: 4 });
    }

    // Comment length variance (max 6)
    const lens = comments.map(c => (c.body || '').length);
    const avgLen = lens.reduce((a, b) => a + b, 0) / lens.length;
    const stddev = Math.sqrt(lens.reduce((s, l) => s + (l - avgLen) ** 2, 0) / lens.length);
    const cv = avgLen > 0 ? stddev / avgLen : 0;
    if (cv < 0.2) {
      raw += 6;
      signals.push({ name: 'Uniform comment lengths', detail: `CV ${cv.toFixed(2)}`, pts: 6 });
    } else if (cv < 0.35) {
      raw += 3;
      signals.push({ name: 'Low length variance', detail: `CV ${cv.toFixed(2)}`, pts: 3 });
    }

    // Median posting interval (max 8)
    if (times.length > 1) {
      const intervals = [];
      for (let i = 1; i < times.length; i++) intervals.push(times[i] - times[i - 1]);
      intervals.sort((a, b) => a - b);
      const median = intervals[Math.floor(intervals.length / 2)];
      if (median < 60) {
        raw += 8;
        signals.push({ name: 'Median interval < 1min', detail: `${median}s`, pts: 8 });
      } else if (median < 180) {
        raw += 4;
        signals.push({ name: 'Median interval < 3min', detail: `${median}s`, pts: 4 });
      }
    }

    // Burstiness — max comments in any 5-min window (max 8, replaces active hours + entropy)
    let maxBurst = 0;
    for (let i = 0; i < times.length; i++) {
      let count = 1;
      for (let j = i + 1; j < times.length && times[j] - times[i] <= 300; j++) count++;
      if (count > maxBurst) maxBurst = count;
    }
    if (maxBurst >= 8) {
      raw += 8;
      signals.push({ name: 'Extreme burst (5min)', detail: `${maxBurst} comments`, pts: 8 });
    } else if (maxBurst >= 5) {
      raw += 4;
      signals.push({ name: 'Comment burst (5min)', detail: `${maxBurst} comments`, pts: 4 });
    }

    // Link ratio (max 6)
    const linkRe = /https?:\/\/\S+/;
    const linkCount = comments.filter(c => linkRe.test(c.body || '')).length;
    const linkRatio = linkCount / comments.length;
    if (linkRatio > 0.7) {
      raw += 6;
      signals.push({ name: 'Most comments have links', detail: `${Math.floor(linkRatio * 100)}%`, pts: 6 });
    } else if (linkRatio > 0.5) {
      raw += 3;
      signals.push({ name: 'Many comments have links', detail: `${Math.floor(linkRatio * 100)}%`, pts: 3 });
    }

    // AI-generated content detection (max 10)
    let aiTellHits = 0;
    const aiHitComments = [];
    for (const c of comments) {
      const lower = (c.body || '').toLowerCase();
      let hitCount = 0;
      for (const phrase of AI_TELL_PHRASES) {
        if (lower.includes(phrase)) hitCount++;
      }
      if (hitCount >= 2) {
        aiTellHits++;
        aiHitComments.push({ body: c.body, sub: c.subreddit, reason: 'ai-style' });
      }
    }
    const aiRatio = aiTellHits / comments.length;
    if (aiRatio > 0.4) {
      raw += 10;
      signals.push({ name: 'Likely AI-written comments', detail: `${aiTellHits}/${comments.length} with AI tells`, pts: 10 });
      aiHitComments.slice(0, 3).forEach(c => flaggedComments.push(c));
    } else if (aiRatio > 0.2) {
      raw += 5;
      signals.push({ name: 'Possible AI-written comments', detail: `${aiTellHits}/${comments.length} with AI tells`, pts: 5 });
      aiHitComments.slice(0, 2).forEach(c => flaggedComments.push(c));
    }

    // Dormancy gap — account sat idle before becoming active (max 6)
    const oldestComment = comments[0].created_utc;
    const dormancyDays = (oldestComment - d.created_utc) / 86400;
    if (dormancyDays > 180) {
      raw += 6;
      signals.push({ name: 'Long dormancy before activity', detail: `${Math.floor(dormancyDays)}d idle`, pts: 6 });
    } else if (dormancyDays > 30) {
      raw += 3;
      signals.push({ name: 'Dormancy gap', detail: `${Math.floor(dormancyDays)}d idle`, pts: 3 });
    }

    // AskReddit karma farming — bots disproportionately farm in AskReddit (max 6)
    const askRedditCount = comments.filter(c =>
      (c.subreddit || '').toLowerCase() === 'askreddit'
    ).length;
    const askRedditRatio = askRedditCount / comments.length;
    if (askRedditRatio > 0.6) {
      raw += 6;
      signals.push({ name: 'Mostly AskReddit comments', detail: `${askRedditCount}/${comments.length}`, pts: 6 });
    } else if (askRedditRatio > 0.4) {
      raw += 3;
      signals.push({ name: 'Heavy AskReddit activity', detail: `${askRedditCount}/${comments.length}`, pts: 3 });
    }

    // Hidden karma — has comment karma but few visible comments (max 6)
    if (ck > 500 && comments.length < 5) {
      raw += 6;
      signals.push({ name: 'Hidden karma', detail: `${ck} karma, only ${comments.length} visible`, pts: 6 });
    } else if (ck > 200 && comments.length < 3) {
      raw += 4;
      signals.push({ name: 'Karma with few comments', detail: `${ck} karma, only ${comments.length} visible`, pts: 4 });
    }

    // HTML entity artifacts — bots can't process symbols properly (max 8)
    let entityCount = 0;
    const entityRe = /&amp;|&lt;|&gt;|&quot;|&#\d+;/;
    for (const c of comments) {
      if (entityRe.test(c.body || '')) entityCount++;
    }
    if (entityCount > 0) {
      const pts = entityCount >= 3 ? 8 : 4;
      raw += pts;
      signals.push({ name: 'HTML entity artifacts', detail: `${entityCount} comments with &amp; etc.`, pts });
      comments.filter(c => entityRe.test(c.body || '')).slice(0, 2).forEach(c =>
        flaggedComments.push({ body: c.body, sub: c.subreddit, reason: 'html-entity' })
      );
    }

    // Quote format artifacts — entire comment in blockquote from copy-paste (max 6)
    let quoteCount = 0;
    for (const c of comments) {
      const body = (c.body || '').trim();
      if (body.startsWith('>') && !body.includes('\n\n') && body.length > 20) {
        quoteCount++;
      }
    }
    if (quoteCount >= 3) {
      raw += 6;
      signals.push({ name: 'Quote format artifacts', detail: `${quoteCount} comments fully quoted`, pts: 6 });
    } else if (quoteCount >= 1) {
      raw += 3;
      signals.push({ name: 'Quote format artifact', detail: `${quoteCount} comment(s) fully quoted`, pts: 3 });
    }

    // Scam link patterns — .live, .life, .shop domains (max 8)
    const scamDomainRe = /https?:\/\/[^\s]*\.(live|life|shop|xyz|click|top|buzz|gdn|icu)\b/i;
    let scamLinkCount = 0;
    for (const c of comments) {
      if (scamDomainRe.test(c.body || '')) {
        scamLinkCount++;
        flaggedComments.push({ body: c.body, sub: c.subreddit, reason: 'scam-link' });
      }
    }
    if (scamLinkCount > 0) {
      const pts = scamLinkCount >= 2 ? 8 : 5;
      raw += pts;
      signals.push({ name: 'Suspicious link domains', detail: `${scamLinkCount} comments with .live/.shop/etc.`, pts });
    }

    // Exact duplicate comments — same comment posted multiple times (max 8)
    const bodySet = new Map();
    for (const c of comments) {
      const norm = (c.body || '').trim().toLowerCase();
      if (norm.length > 10) bodySet.set(norm, (bodySet.get(norm) || 0) + 1);
    }
    let dupeCount = 0;
    for (const [, count] of bodySet) {
      if (count > 1) dupeCount += count;
    }
    if (dupeCount >= 5) {
      raw += 8;
      signals.push({ name: 'Many duplicate comments', detail: `${dupeCount} duplicates`, pts: 8 });
    } else if (dupeCount >= 2) {
      raw += 4;
      signals.push({ name: 'Duplicate comments', detail: `${dupeCount} duplicates`, pts: 4 });
    }
  }

  // ---- Apply trust multiplier ----

  const trust = trustMultiplier(ageDays, totalKarma);
  const finalScore = Math.min(100, Math.round(raw * trust));

  console.log(`[RedBot] Heuristics — u/${d.name} raw=${raw} trust=${trust} final=${finalScore}`, signals);

  // Pick top 5 most suspicious sample comments
  const uniqueFlagged = [];
  const seenBodies = new Set();
  for (const fc of flaggedComments) {
    const key = (fc.body || '').slice(0, 80);
    if (!seenBodies.has(key)) {
      seenBodies.add(key);
      uniqueFlagged.push(fc);
    }
    if (uniqueFlagged.length >= 5) break;
  }

  return {
    score: finalScore,
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
    heuristicScore: raw,
    trustMultiplier: trust,
    _sampleComments: uniqueFlagged,
  };
}

// ----- Tier 2 — Gemini LLM -----

async function getApiKey() {
  return new Promise(r =>
    chrome.storage.sync.get('geminiApiKey', res => r(res.geminiApiKey || ''))
  );
}

async function runLLM(aboutPayload, commentsPayload, prior) {
  console.log(`[RedBot] LLM — u/${prior.meta.username}, calling Gemini`);
  const apiKey = await getApiKey();
  if (!apiKey) {
    console.warn('[RedBot] LLM — skipped, no API key set');
    return { ...prior, tier: 2, llmSkipped: true, llmReason: 'No API key set' };
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
  const prompt = `You are a Reddit bot and AI-content detection expert. Analyze this account and its comments for two things:
1. Whether this is a bot account (automated posting, spam, manipulation)
2. Whether the comments appear to be AI-generated (written by ChatGPT, Claude, etc.)

Account metadata:
- Username: ${m.username}
- Account age: ${m.ageDays} days
- Link karma: ${m.linkKarma}, Comment karma: ${m.commentKarma}
- Email verified: ${m.verified}

Recent comments (${samples.length}):
${samples.map((s, i) => `${i + 1}. [r/${s.sub}] (score ${s.score}) "${s.body}"`).join('\n')}

Prior heuristic signals:
${prior.signals.map(s => `- ${s.name}: ${s.detail}`).join('\n')}

When evaluating AI-generated content, look for:
- Overly polished/formal tone unusual for Reddit (e.g. "It's important to note", "delve", "navigate", "I'd be happy to")
- Perfectly structured responses with clear intros/conclusions where a human would be casual
- Hedging language, balanced viewpoints, and lack of personal voice
- Suspiciously comprehensive answers that read like an encyclopedia
- Lack of typos, slang, or emotional rawness typical of real Reddit users

Respond with ONLY valid JSON, no markdown fences:
{"score": <0-100>, "reasoning": "<1-2 sentence explanation>", "aiContentScore": <0-100>, "aiContentNote": "<1 sentence about AI writing detection>"}`;

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.2, maxOutputTokens: 512 },
        }),
      }
    );

    if (!res.ok) throw new Error(`Gemini ${res.status}`);

    const json = await res.json();
    const text = json.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const parsed = JSON.parse(text.replace(/```json\n?|\n?```/g, '').trim());

    const llmScore = parsed.score;
    const aiScore = parsed.aiContentScore ?? 0;
    const aiNote = parsed.aiContentNote || '';
    const finalScore = Math.min(100, Math.round(prior.score * 0.3 + llmScore * 0.7));
    console.log(`[RedBot] LLM — u/${m.username} bot=${llmScore} ai=${aiScore} final=${finalScore}`, parsed.reasoning);

    const llmSignals = [
      ...prior.signals,
      { name: 'LLM bot analysis', detail: parsed.reasoning, pts: llmScore },
    ];
    if (aiScore > 0) {
      llmSignals.push({ name: 'AI content detection', detail: `${aiScore}% — ${aiNote}`, pts: aiScore });
    }

    return {
      score: finalScore,
      signals: llmSignals,
      tier: 2,
      meta: m,
      heuristicScore: prior.heuristicScore,
      trustMultiplier: prior.trustMultiplier,
      llmScore,
      llmReasoning: parsed.reasoning,
      aiContentScore: aiScore,
      aiContentNote: aiNote,
      _sampleComments: prior._sampleComments,
    };
  } catch (err) {
    console.error('[RedBot] LLM failed:', err);
    return { ...prior, tier: 2, llmSkipped: true, llmReason: err.message };
  }
}

// ----- Main analysis orchestrator -----

const LLM_THRESHOLD = 40;

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
    const commentsData = await fetchUserComments(username);
    const heuristic = runHeuristics(aboutData, commentsData);

    if (heuristic.score < LLM_THRESHOLD) {
      console.log(`[RedBot] u/${username} — heuristic=${heuristic.score}%, below LLM threshold, done`);
      setCache(username, heuristic);
      return heuristic;
    }

    console.log(`[RedBot] u/${username} — heuristic=${heuristic.score}%, advancing to LLM`);
    const llmResult = await runLLM(aboutData, commentsData, heuristic);
    setCache(username, llmResult);
    return llmResult;
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

// ----- Deep analysis (forced LLM) -----

async function deepAnalyzeUser(username) {
  console.log(`[RedBot] Deep analysis — heuristics + LLM for u/${username}`);
  try {
    const aboutData = await fetchUserAbout(username);
    const commentsData = await fetchUserComments(username);
    const heuristic = runHeuristics(aboutData, commentsData);
    const llmResult = await runLLM(aboutData, commentsData, heuristic);

    setCache(username, llmResult);
    console.log(`[RedBot] Deep analysis complete for u/${username} — score=${llmResult.score}`);
    return llmResult;
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
/** @type {Map<number, number>} tabId → scan queue depth (content script) */
const tabScanPending = new Map();

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
      sendResponse({
        results: tabResults.get(id) || {},
        pending: id != null ? (tabScanPending.get(id) ?? 0) : 0,
      });
    });
    return true;
  }

  if (msg.type === 'scanProgress') {
    const tabId = sender.tab?.id;
    if (tabId != null) {
      if (msg.pending > 0) tabScanPending.set(tabId, msg.pending);
      else tabScanPending.delete(tabId);
    }
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'clearCache') {
    cache.clear();
    tabResults.clear();
    tabScanPending.clear();
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

chrome.tabs.onRemoved.addListener(id => {
  tabResults.delete(id);
  tabScanPending.delete(id);
});
