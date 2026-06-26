import axios from 'axios';
import { parse as parseUrl } from 'url';

const BASE = 'https://gag.gg';
const LOGIN_URL = `${BASE}/api/auth/roblox/login?return=/vote`;
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cookieHeaderFromClient(client) {
  const parts = [];
  for (const cookie of client.defaults.headers?.common?.Cookie?.split(';') || []) {
    const trimmed = cookie.trim();
    if (trimmed.startsWith('__Host-gag_session=')) {
      parts.push(trimmed);
    }
  }
  return parts.join('; ');
}


async function followRedirects(client, url, maxSteps = 10) {
  let current = url;
  for (let i = 0; i < maxSteps; i++) {
    const resp = await client.get(current, {
      headers: { Accept: 'text/html,*/*' },
      maxRedirects: 0,
      validateStatus: (status) => status >= 200 && status < 400,
    });
    if (resp.status >= 300 && resp.status < 400 && resp.headers.location) {
      const location = resp.headers.location;
      current = new URL(location, current).toString();
      continue;
    }
    return resp;
  }
  throw new Error('Too many redirects');
}

async function getOAuthParams(client) {
  const loginResp = await client.get(LOGIN_URL, {
    headers: { Accept: 'text/html,*/*', Referer: `${BASE}/vote/` },
    maxRedirects: 0,
  });
  if (loginResp.status < 300 || loginResp.status >= 400) {
    throw new Error(`Login redirect failed: ${loginResp.status}`);
  }
  let location = loginResp.headers.location;
  if (!location) throw new Error('No location header in login response');
  let url = new URL(location, LOGIN_URL).toString();

  for (let i = 0; i < 8; i++) {
    const resp = await client.get(url, {
      headers: { Accept: 'text/html,*/*' },
      maxRedirects: 0,
    });
    if (resp.status >= 300 && resp.status < 400 && resp.headers.location) {
      const next = new URL(resp.headers.location, url).toString();
      const qs = new URL(next).searchParams;
      if (qs.has('code_challenge') && qs.has('state')) {
        const params = {};
        for (const [key, value] of qs.entries()) {
          params[key] = value;
        }
        return { params, url: next };
      }
      url = next;
      continue;
    }
    const qs = new URL(resp.request.res.responseUrl || url).searchParams;
    if (qs.has('code_challenge') && qs.has('state')) {
      const params = {};
      for (const [key, value] of qs.entries()) {
        params[key] = value;
      }
      return { params, url: resp.request.res.responseUrl || url };
    }
    break;
  }
  throw new Error('OAuth params missing from redirect chain');
}

export async function reauthWithRobloxCookie(robloxSecurity, { timeout = 45000, gagSession = null, verifySession = true } = {}) {
  robloxSecurity = robloxSecurity.trim();
  if (!robloxSecurity) throw new Error('roblox_security cookie is empty');

  const client = axios.create({
    timeout,
    headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
    maxRedirects: 0,
    validateStatus: (status) => status >= 200 && status < 400,
  });

  client.defaults.headers.common['Cookie'] = `.ROBLOSECURITY=${robloxSecurity}`;

  let userId;
  if (gagSession) {
    try {
      const payload = gagSession.split('.')[0];
      const json = JSON.parse(Buffer.from(payload, 'base64').toString());
      userId = json.sub?.toString();
    } catch {}
  }
  if (!userId) {
    const userResp = await client.get('https://users.roblox.com/v1/users/authenticated');
    userId = userResp.data.id?.toString();
    if (!userId) throw new Error('Could not retrieve Roblox user ID');
  }

  const { params, url: oauthUrl } = await getOAuthParams(client);

  const prResp = await client.get('https://apis.roblox.com/oauth/v1/permission-request', {
    params: {
      clientId: params.client_id,
      redirectUri: params.redirect_uri,
      scopes: params.scope || 'openid profile',
      responseTypes: 'code',
    },
  });
  const prData = prResp.data;

  const body = {
    userId: userId,
    clientId: params.client_id,
    resourceInfos: [{ owner: { id: userId, type: 'User' }, resources: {} }],
    responseTypes: prData.responseTypes || ['Code'],
    redirectUri: params.redirect_uri,
    scopes: (prData.scopes || []).map(s => ({ scopeType: s.scopeType, operations: s.operations })) ||
             [{ scopeType: 'openid', operations: ['read'] }, { scopeType: 'profile', operations: ['read'] }],
    state: params.state,
    codeChallenge: params.code_challenge,
    codeChallengeMethod: params.code_challenge_method,
  };
  if (params.nonce) body.nonce = params.nonce;

  const grantResp = await client.post('https://apis.roblox.com/oauth/v1/authorizations', body, {
    headers: {
      'Content-Type': 'application/json-patch+json',
      Referer: oauthUrl,
      Origin: 'https://authorize.roblox.com',
      'X-CSRF-TOKEN': '',
    },
  });

  if (grantResp.status === 403 && grantResp.headers['x-csrf-token']) {
    const token = grantResp.headers['x-csrf-token'];
    const retry = await client.post('https://apis.roblox.com/oauth/v1/authorizations', body, {
      headers: {
        'Content-Type': 'application/json-patch+json',
        Referer: oauthUrl,
        Origin: 'https://authorize.roblox.com',
        'X-CSRF-TOKEN': token,
      },
    });
    if (retry.status >= 200 && retry.status < 400) {
      grantResp.data = retry.data;
    } else {
      throw new Error(`Grant failed after CSRF: ${retry.status}`);
    }
  }
  const grantData = grantResp.data;
  if (!grantData.location) {
    throw new Error(`Roblox OAuth grant returned no redirect: ${JSON.stringify(grantData).slice(0, 200)}`);
  }

  const callbackResp = await followRedirects(client, grantData.location);
  const cookieHeader = client.defaults.headers.common['Cookie'] || '';

  let jar = {};
  const setCookie = (header) => {
    const parts = header.split(';')[0].split('=');
    if (parts.length === 2) {
      jar[parts[0].trim()] = parts[1].trim();
    }
  };
  const interceptor = (config) => {
    const cookieString = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
    if (cookieString) {
      config.headers['Cookie'] = (config.headers['Cookie'] ? config.headers['Cookie'] + '; ' : '') + cookieString;
    }
    return config;
  };
  const responseInterceptor = (response) => {
    const setCookie = response.headers['set-cookie'];
    if (setCookie) {
      (Array.isArray(setCookie) ? setCookie : [setCookie]).forEach(h => {
        const parts = h.split(';')[0].split('=');
        if (parts.length === 2) {
          jar[parts[0].trim()] = parts[1].trim();
        }
      });
    }
    return response;
  };
  const requestInterceptor = client.interceptors.request.use(interceptor);
  const responseInterceptorHandle = client.interceptors.response.use(responseInterceptor);

  const finalResp = await followRedirects(client, grantData.location);

  client.interceptors.request.eject(requestInterceptor);
  client.interceptors.response.eject(responseInterceptorHandle);

  const gagSessionCookie = jar['__Host-gag_session'];
  if (!gagSessionCookie) {
    throw new Error('gag_session cookie not found after OAuth');
  }
  const finalCookie = `__Host-gag_session=${gagSessionCookie}`;

  if (verifySession) {
    const meResp = await axios.get(`${BASE}/api/auth/me`, {
      headers: { Cookie: finalCookie, 'User-Agent': UA },
    });
    if (!meResp.data.signedIn) {
      throw new Error('gag.gg session cookie set but /api/auth/me is not signed in');
    }
  }
  return finalCookie;
}

export async function reauthWithPlaywright({ userDataDir = null, headless = false, timeoutSeconds = 120 } = {}) {
  let playwright;
  try {
    const pkg = await import('playwright');
    playwright = pkg;
  } catch {
    throw new Error('Playwright required. Run: npm install playwright && npx playwright install chromium');
  }

  const { chromium } = playwright;
  const browser = await chromium.launch({
    headless,
    channel: 'chrome',
  });
  const context = userDataDir
    ? await browser.newContext({ userDataDir })
    : await browser.newContext();
  const page = await context.newPage();

  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });

  const deadline = Date.now() + timeoutSeconds * 1000;
  let cookieHeader = null;

  while (Date.now() < deadline) {
    const cookies = await context.cookies();
    const gagCookie = cookies.find(c => c.name === '__Host-gag_session' && c.domain.includes('gag.gg'));
    if (gagCookie) {
      cookieHeader = `__Host-gag_session=${gagCookie.value}`;
      const url = page.url();
      if (url.includes('gag.gg')) {
        break;
      }
    }

    if (page.url().includes('authorize.roblox.com')) {
      const buttons = ['Continue', 'Accept', 'Authorize', 'Agree'];
      for (const label of buttons) {
        const btn = page.getByRole('button', { name: label });
        const count = await btn.count();
        if (count > 0) {
          try {
            await btn.first().click({ timeout: 3000 });
            break;
          } catch {}
        }
      }
    }
    await page.waitForTimeout(800);
  }

  await browser.close();

  if (!cookieHeader) {
    throw new Error(`OAuth did not finish within ${timeoutSeconds}s (last url: ${await page.url()})`);
  }
  return cookieHeader;
}