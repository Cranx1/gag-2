import axios from 'axios';

const PROXY_SOURCES = [
  {
    name: 'ProxyScrape',
    url: 'https://api.proxyscrape.com/v4/free-proxy-list/get',
    parser: (data) => {
      const proxies = [];
      for (const entry of data.proxies || []) {
        if (entry.proxy && entry.alive !== false) {
          const latency = parseFloat(entry.timeout) || 99999;
          const anon = (entry.anonymity || '').toLowerCase();
          proxies.push({ url: entry.proxy, latency, anon });
        }
      }
      return proxies;
    }
  },
  {
    name: 'FreeProxyList',
    url: 'https://api.proxyscrape.com/v3/free-proxy-list/get?request=displayproxies&proxy_format=protocolipport&format=json',
    parser: (data) => {
      const proxies = [];
      for (const entry of data.proxies || []) {
        if (entry.proxy && entry.alive !== false) {
          const latency = parseFloat(entry.timeout) || 99999;
          proxies.push({ url: entry.proxy, latency, anon: 'anonymous' });
        }
      }
      return proxies;
    }
  },
  {
    name: 'PubProxy',
    url: 'https://pubproxy.com/api/proxy?format=json&limit=20&http=true&https=true',
    parser: (data) => {
      const proxies = [];
      for (const entry of data.data || []) {
        if (entry.ip && entry.port) {
          const url = `http://${entry.ip}:${entry.port}`;
          const latency = entry.speed || 99999;
          proxies.push({ url, latency, anon: 'anonymous' });
        }
      }
      return proxies;
    }
  }
];

export class ProxyPool {
  constructor({ fetchLimit = 30, refreshSeconds = 180, minProxies = 5 } = {}) {
    this.fetchLimit = Math.max(5, fetchLimit);
    this.refreshSeconds = Math.max(60, refreshSeconds);
    this.minProxies = Math.max(3, minProxies);
    this.proxies = [];
    this.index = 0;
    this.failed = new Map();
    this.fetchedAt = 0;
    this.currentSource = 0;
    this.workingProxies = new Set();
  }

  async fetch() {
    const allProxies = [];
    
    for (let i = 0; i < PROXY_SOURCES.length; i++) {
      const sourceIndex = (this.currentSource + i) % PROXY_SOURCES.length;
      const source = PROXY_SOURCES[sourceIndex];
      
      try {
        console.log(`[Proxy] Fetching from ${source.name}...`);
        const resp = await axios.get(source.url, { 
          timeout: 15000,
          params: source.params || {}
        });
        
        const proxies = source.parser(resp.data);
        if (proxies.length > 0) {
          allProxies.push(...proxies);
          this.currentSource = sourceIndex;
          console.log(`[Proxy] Got ${proxies.length} proxies from ${source.name}`);
          
          if (allProxies.length >= this.fetchLimit) break;
        }
      } catch (err) {
        console.log(`[Proxy] ${source.name} failed: ${err.message}`);
        continue;
      }
    }

    if (allProxies.length === 0) {
      console.log('[Proxy] No proxies found from any source, using fallback');
      const fallbackProxies = [
        { url: 'http://51.79.248.142:8080', latency: 1000 },
        { url: 'http://51.77.63.169:8080', latency: 1000 },
        { url: 'http://51.158.120.18:8811', latency: 1000 },
        { url: 'http://51.89.14.70:8080', latency: 1000 },
        { url: 'http://51.91.43.143:8080', latency: 1000 },
      ];
      allProxies.push(...fallbackProxies.map(p => ({ ...p, anon: 'anonymous' })));
    }

    const now = Date.now();
    const filtered = allProxies
      .filter(p => {
        const failedTime = this.failed.get(p.url);
        if (failedTime) {
          if (now - failedTime > 300000) {
            this.failed.delete(p.url);
            return true;
          }
          return false;
        }
        return true;
      })
      .sort((a, b) => (a.latency || 99999) - (b.latency || 99999))
      .slice(0, this.fetchLimit);

    this.proxies = filtered.map(p => p.url);
    this.index = 0;
    this.fetchedAt = Date.now();
    
    this.proxies.forEach(p => this.workingProxies.add(p));
    
    console.log(`[Proxy] Loaded ${this.proxies.length} proxies`);
    return this.proxies.length;
  }

  async next() {
    const stale = (Date.now() - this.fetchedAt) / 1000 > this.refreshSeconds;
    if (this.proxies.length < this.minProxies || stale) {
      await this.fetch();
    }

    let attempts = 0;
    while (attempts < this.proxies.length * 2) {
      if (this.index >= this.proxies.length) {
        this.index = 0;
        if (attempts > this.proxies.length) {
          await this.fetch();
        }
      }
      
      const proxy = this.proxies[this.index % this.proxies.length];
      this.index++;
      attempts++;
      
      const failedTime = this.failed.get(proxy);
      if (failedTime && Date.now() - failedTime < 120000) {
        continue;
      }
      
      return proxy;
    }

    await this.fetch();
    if (this.proxies.length > 0) {
      const proxy = this.proxies[0];
      this.index = 1;
      return proxy;
    }
    
    return null;
  }

  markFailed(proxyUrl) {
    if (proxyUrl) {
      this.failed.set(proxyUrl, Date.now());
      this.workingProxies.delete(proxyUrl);
      console.log(`[Proxy] Marked ${proxyUrl} as failed`);
    }
  }

  markWorking(proxyUrl) {
    if (proxyUrl) {
      this.failed.delete(proxyUrl);
      this.workingProxies.add(proxyUrl);
    }
  }

  getStats() {
    return {
      total: this.proxies.length,
      working: this.workingProxies.size,
      failed: this.failed.size,
      index: this.index,
    };
  }
}