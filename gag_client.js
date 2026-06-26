import axios from 'axios';
import { ProxyPool } from './proxy_pool.js';

const BASE = 'https://gag.gg';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
const BROWSER_HEADERS = {
  'sec-ch-ua': '"Google Chrome";v="149", "Chromium";v="149", "Not)A;Brand";v="24"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
  'sec-fetch-dest': 'empty',
  'sec-fetch-mode': 'cors',
  'sec-fetch-site': 'same-origin',
  priority: 'u=1, i',
};

export function log(msg) {
  const now = new Date();
  const ts = `${now.getHours()}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
  console.log(`[${ts}] ${msg}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class GagClient {
  constructor({
    cookie,
    timeout = 30000,
    rateLimitRetries = 8,
    rateLimitMaxWaitSeconds = 30,
    useProxiesOnRateLimit = true,
    proxyFetchLimit = 30,
    proxyTimeoutSeconds = 10,
    maxProxyRotations = 10,
    proxyCooldownSeconds = 60,
  } = {}) {
    this.cookie = cookie.trim();
    this.timeout = timeout;
    this.rateLimitRetries = Math.max(0, rateLimitRetries);
    this.rateLimitMaxWaitSeconds = Math.max(1, rateLimitMaxWaitSeconds);
    this.proxyTimeout = Math.max(5, proxyTimeoutSeconds);
    this.useProxies = useProxiesOnRateLimit;
    this.maxProxyRotations = maxProxyRotations;
    this.proxyCooldownSeconds = proxyCooldownSeconds;
    this.proxyPool = useProxiesOnRateLimit ? new ProxyPool({ 
      fetchLimit: proxyFetchLimit,
      refreshSeconds: 120,
      minProxies: 5
    }) : null;
    this.currentProxy = null;
    this.client = this._buildClient(null);
    this.proxyAttempts = 0;
    this.successfulProxies = new Set();
    this.consecutiveFailures = 0;
    this.rateLimitCount = 0;
    this.proxyLastUsed = new Map();
    this.proxyCooldown = new Map();
    this.switchDelayMs = 1000;
  }

  _buildClient(proxyUrl) {
    const headers = {
      'User-Agent': UA,
      Accept: '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      Origin: BASE,
      Referer: `${BASE}/vote/`,
      Cookie: this.cookie,
      ...BROWSER_HEADERS,
    };
    const config = {
      baseURL: BASE,
      timeout: proxyUrl ? this.proxyTimeout * 1000 : this.timeout,
      headers,
    };
    if (proxyUrl) {
      try {
        const url = new URL(proxyUrl);
        config.proxy = {
          host: url.hostname,
          port: parseInt(url.port) || (url.protocol === 'https:' ? 443 : 80),
          protocol: url.protocol.replace(':', ''),
        };
      } catch (e) {
        console.warn('Invalid proxy URL:', proxyUrl);
      }
    }
    return axios.create(config);
  }

  _rebuildClient(proxyUrl) {
    if (this.currentProxy === proxyUrl) return;
    this.currentProxy = proxyUrl;
    this.client = this._buildClient(proxyUrl);
  }

  async _rotateProxy() {
    if (!this.proxyPool) return false;
    
    this.proxyAttempts++;
    
    if (this.proxyAttempts > this.maxProxyRotations) {
      this.proxyAttempts = 0;
      this.consecutiveFailures = 0;
      log('Too many proxy failures, resetting and trying fresh');
      await this.proxyPool.fetch();
    }
    
    let proxy = await this.proxyPool.next();
    let attempts = 0;
    while (proxy && attempts < 10) {
      const cooldownUntil = this.proxyCooldown.get(proxy);
      if (cooldownUntil && Date.now() < cooldownUntil) {
        proxy = await this.proxyPool.next();
        attempts++;
        continue;
      }
      break;
    }
    
    if (!proxy) {
      log('No available proxies (all in cooldown or failed)');
      this.clearProxy();
      return false;
    }
    
    this._rebuildClient(proxy);
    this.proxyLastUsed.set(proxy, Date.now());
    log(`Switched to proxy ${proxy.split('://')[1]} (attempt ${this.proxyAttempts}/${this.maxProxyRotations})`);
    
    await sleep(this.switchDelayMs);
    return true;
  }

  clearProxy() {
    if (this.currentProxy) {
      this._rebuildClient(null);
      this.proxyAttempts = 0;
      log('Back to direct connection');
    }
  }

  close() {
  }

  async _testProxy(proxyUrl) {
    try {
      const testClient = this._buildClient(proxyUrl);
      const resp = await testClient.get('/api/time', { timeout: 5000 });
      if (resp.data && resp.data.time) {
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  async _request(method, path, options = {}) {
    const url = path.startsWith('/') ? path : '/' + path;
    const label = path.split('/').pop() || path;
    let attempt = 0;
    let proxyRotations = 0;

    while (attempt <= this.rateLimitRetries + 3) {
      try {
        const resp = await this.client.request({
          method,
          url,
          ...options,
        });
        
        this.consecutiveFailures = 0;
        if (this.currentProxy) {
          this.successfulProxies.add(this.currentProxy);
          if (this.proxyPool) {
            this.proxyPool.markWorking(this.currentProxy);
          }
          this.proxyCooldown.delete(this.currentProxy);
        }
        return resp.data;
        
      } catch (err) {
        const status = err.response?.status;
        const isTimeout = err.code === 'ECONNREFUSED' || 
                          err.code === 'ETIMEDOUT' || 
                          err.code === 'ECONNRESET' ||
                          err.code === 'ENOTFOUND';
        const isServerError = status === 500 || status === 502 || status === 503 || status === 504;
        const isAuthError = status === 401 || status === 403;
        
        if (isAuthError) {
          throw err;
        }
        
        if (status === 429) {
          this.rateLimitCount++;
          
          if (this.currentProxy) {
            const cooldownMs = this.proxyCooldownSeconds * 1000;
            this.proxyCooldown.set(this.currentProxy, Date.now() + cooldownMs);
            if (this.proxyPool) {
              this.proxyPool.markFailed(this.currentProxy);
            }
            log(`Proxy ${this.currentProxy.split('://')[1]} got 429 — cooling down for ${this.proxyCooldownSeconds}s`);
          }
          
          if (attempt >= this.rateLimitRetries) {
            if (this.useProxies && this.proxyPool && await this._rotateProxy()) {
              attempt++;
              continue;
            }
            throw err;
          }
          
          if (this.useProxies && this.proxyPool && await this._rotateProxy()) {
            log(`Rate limited (429) on ${label} — retrying via new proxy`);
            attempt++;
            continue;
          }
          
          const retryAfter = err.response?.headers?.['retry-after'];
          let waitSeconds = retryAfter ? parseFloat(retryAfter) : null;
          if (!waitSeconds || waitSeconds <= 0) {
            const baseWait = Math.min(this.rateLimitMaxWaitSeconds, Math.pow(1.5, attempt) + Math.random() * 0.5);
            waitSeconds = Math.min(baseWait, this.rateLimitMaxWaitSeconds);
          }
          waitSeconds = Math.max(1, waitSeconds);
          log(`Rate limited (429) on ${label} — waiting ${waitSeconds.toFixed(1)}s (${attempt + 1}/${this.rateLimitRetries})`);
          await sleep(waitSeconds * 1000);
          attempt++;
          continue;
        }

        if (this.currentProxy && (isTimeout || isServerError)) {
          this.consecutiveFailures++;
          if (this.proxyPool) {
            this.proxyPool.markFailed(this.currentProxy);
          }
          log(`Proxy ${this.currentProxy.split('://')[1]} failed (${err.message || status}) — rotating`);
          
          if (await this._rotateProxy()) {
            proxyRotations++;
            attempt++;
            continue;
          } else {
            this.clearProxy();
            attempt++;
            continue;
          }
        }

        if (isServerError && !this.currentProxy) {
          if (attempt >= this.rateLimitRetries) {
            throw err;
          }
          const waitSeconds = Math.min(5, Math.pow(1.5, attempt) + Math.random() * 0.5);
          log(`Server error (${status}) on ${label} — retrying in ${waitSeconds.toFixed(1)}s (${attempt + 1}/${this.rateLimitRetries})`);
          await sleep(waitSeconds * 1000);
          attempt++;
          continue;
        }

        throw err;
      }
    }
    throw new Error(`Request failed for ${path} after ${attempt} attempts`);
  }

  authMe() {
    return this._request('GET', '/api/auth/me');
  }
  profileMe() {
    return this._request('GET', '/api/profile/me');
  }
  voteDeck() {
    return this._request('GET', '/api/vote/deck');
  }
  serverTime() {
    return this._request('GET', '/api/time');
  }
  events() {
    return this._request('GET', '/api/events');
  }
  voteClaim() {
    return this._request('POST', '/api/vote/claim');
  }
  voteSwipe(imageId, vote, decisionMs) {
    return this._request('POST', '/api/vote/swipe', {
      data: { image_id: imageId, vote, decision_ms: Math.max(0, decisionMs) },
      headers: { 'Content-Type': 'application/json' },
    });
  }
  contestState() {
    return this._request('GET', '/api/contest/state', {
      headers: { Referer: `${BASE}/contest/` },
    });
  }
  contestEnter(carrots) {
    return this._request('POST', '/api/contest/enter', {
      data: { carrots },
      headers: { 'Content-Type': 'application/json', Referer: `${BASE}/contest/` },
    });
  }
  deleteAccount() {
    return this._request('POST', '/api/account/delete', {
      headers: { Referer: `${BASE}/profile/` },
    }).catch(() => {});
  }
  updateCookie(cookie) {
    this.cookie = cookie.trim();
    this._rebuildClient(this.currentProxy);
  }

  async isVoteCapped() {
    try {
      const deck = await this.voteDeck();
      return deck.capped === true || (deck.remaining || 0) <= 0;
    } catch {
      return true;
    }
  }
}

export function nextHourlyReset() {
  const now = new Date();
  const reset = new Date(now);
  reset.setUTCMinutes(0, 0, 0);
  if (now.getUTCMinutes() !== 0 || now.getUTCSeconds() > 2) {
    reset.setUTCHours(reset.getUTCHours() + 1);
  }
  reset.setUTCSeconds(2, 0);
  return reset;
}

export async function sleepUntilReset() {
  const target = nextHourlyReset();
  const waitMs = Math.max(0, target.getTime() - Date.now());
  log(`Hourly cap hit — sleeping ${(waitMs / 1000).toFixed(0)}s until ${target.toISOString()}`);
  await sleep(waitMs + Math.random() * 1500 + 500);
}

export function pickVote(mode) {
  if (mode === 'dislike') return 'dislike';
  if (mode === 'random') return Math.random() < 0.5 ? 'like' : 'dislike';
  return 'like';
}

export function formatReward(reward) {
  const count = reward.count || 1;
  const item = reward.item || reward.reward || 'reward';
  const category = reward.category || '?';
  return `${item}${count > 1 ? ` x${count}` : ''} (${category})`;
}

export async function warmupVoteSession(client) {
  await client.authMe().catch(() => {});
  await client.serverTime().catch(() => {});
  await client.events().catch(() => {});
}

export async function claimVoteRewards(client, { quiet = false, stats = null, retries = 1, retryDelayMs = 0 } = {}) {
  for (let i = 0; i < Math.max(1, retries); i++) {
    if (i > 0 && retryDelayMs > 0) await sleep(retryDelayMs);
    try {
      const resp = await client.voteClaim();
      if (resp.claimed) {
        if (stats) stats.claimed.push(resp.claimed);
        log(`  CLAIMED: ${formatReward(resp.claimed)}`);
        return resp.claimed;
      }
    } catch (err) {
      if (!quiet) console.log(`  claim failed: ${err.message}`);
    }
  }
  return null;
}

export async function finalizeVoteRewards(client, stats, { quiet = false, claimRetries = 3 } = {}) {
  await claimVoteRewards(client, { quiet, stats, retries: claimRetries, retryDelayMs: 400 });
}

export async function runSwipeSession(client, {
  voteMode = 'like',
  swipeDelayMs = [80, 350],
  decisionMsRange = [50, 400],
  stats = null,
  skipClaim = false,
  claimRewards = true,
  quiet = false,
  skipWarmup = false,
} = {}) {
  stats = stats || { swipes: 0, carrotsAwarded: 0, jackpots: [], claimed: [], cappedRuns: 0, finished: false, rewardDue: false, rewardWonEver: false };

  if (!skipWarmup) {
    await warmupVoteSession(client);
  }
  if (claimRewards && !skipClaim) {
    await claimVoteRewards(client, { quiet, stats });
  }

  const seen = new Set();
  let deckData = await client.voteDeck();
  let remaining = deckData.remaining || 0;
  const limit = deckData.limit || 20;

  if (!quiet) log(`Deck loaded — ${remaining}/${limit} swipes remaining`);

  if (deckData.capped) {
    stats.cappedRuns++;
    stats.finished = true;
    return stats;
  }

  if (deckData.locked) {
    if (claimRewards) {
      await claimVoteRewards(client, { quiet, stats });
      deckData = await client.voteDeck();
    }
    if (deckData.locked) {
      if (!quiet) log(`Account locked pending claim: ${deckData.claim}`);
      stats.finished = true;
      return stats;
    }
  }

  let queue = (deckData.deck || []).filter(c => c.id && !seen.has(c.id));
  const [delayMin, delayMax] = swipeDelayMs;

  while (remaining > 0 && queue.length > 0) {
    const card = queue.shift();
    const imageId = card.id;
    if (!imageId || seen.has(imageId)) continue;
    seen.add(imageId);

    const vote = pickVote(voteMode);
    const [lo, hi] = decisionMsRange;
    const decisionMs = lo === hi ? lo : Math.floor(Math.random() * (hi - lo + 1)) + lo;
    
    try {
      const result = await client.voteSwipe(imageId, vote, decisionMs);
      stats.lastSwipe = result;

      stats.swipes++;
      if (result.carrotAwarded) stats.carrotsAwarded++;

      remaining = Math.min(result.remaining || 0, remaining);
      if (!quiet) {
        const name = card.name || imageId;
        log(`  [${stats.swipes}] ${vote} "${name}" — ${remaining} left${result.capped ? ' CAP' : ''}`);
      }

      if (result.jackpot) {
        stats.jackpots.push(result.jackpot);
        log(`  JACKPOT: ${formatReward(result.jackpot)}`);
      }

      if (result.claimRequired) {
        const pending = result.claim || result.jackpot;
        if (pending && !stats.jackpots.includes(pending)) {
          stats.jackpots.push(pending);
          log(`  JACKPOT (claim): ${formatReward(pending)}`);
        }
        await claimVoteRewards(client, { quiet, stats, retries: 3, retryDelayMs: 500 });
      }

      if (result.capped || remaining <= 0) {
        stats.cappedRuns++;
        stats.finished = true;
        stats.rewardDue = !!result.rewardDue;
        stats.rewardWonEver = !!result.rewardWonEver;
        break;
      }

      if (queue.length === 0 && remaining > 0) {
        const refill = await client.voteDeck();
        remaining = refill.remaining || remaining;
        for (const c of refill.deck || []) {
          if (c.id && !seen.has(c.id)) queue.push(c);
        }
      }

      if (delayMax > 0) {
        const delay = Math.floor(Math.random() * (delayMax - delayMin + 1)) + delayMin;
        await sleep(delay);
      }
    } catch (err) {
      log(`Error swiping card ${imageId}: ${err.message}`);
      if (err.response?.status === 401 || err.response?.status === 403) {
        throw err;
      }
      continue;
    }
  }

  if (stats.finished) {
    if (!stats.jackpots.length && stats.rewardWonEver) {
      log('  Batch done — rewardWonEver=true (check Roblox mail)');
    } else if (!stats.jackpots.length && stats.rewardDue) {
      log('  Batch done — no seed pack rolled this cycle (RNG miss)');
    }
  }

  if (claimRewards && stats.finished) {
    await finalizeVoteRewards(client, stats, { quiet });
  }

  return stats;
}

export async function runContest(client, carrots = 'all') {
  const state = await client.contestState();
  const balance = state.carrots || state.balance || 0;
  let amount = carrots === 'all' ? balance : Math.min(parseInt(carrots), balance);
  if (amount <= 0) {
    console.log('Contest: no carrots to enter');
    return;
  }
  const result = await client.contestEnter(amount);
  console.log(`Contest: entered ${amount} carrots —`, result);
}