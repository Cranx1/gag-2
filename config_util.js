import readline from 'readline';

export function normalizeGagSession(raw) {
  raw = raw.trim();
  if (!raw) throw new Error('gag_session is empty');
  if (raw.startsWith('__Host-gag_session=')) {
    raw = raw.split('=', 2)[1];
  }
  if (raw.includes('PASTE')) {
    throw new Error('Replace the placeholder gag_session value');
  }
  return raw;
}

export function normalizeRobloxCookie(raw) {
  raw = raw.trim();
  if (!raw) throw new Error('roblox_cookie is empty');
  if (raw.includes('PASTE')) {
    throw new Error('Replace the placeholder roblox_cookie value');
  }
  return raw;
}

export function gagCookieHeader(credentials) {
  const session = normalizeGagSession(credentials.gag_session || '');
  return `__Host-gag_session=${session}`;
}

export function hasGagAuth(credentials) {
  try {
    gagCookieHeader(credentials);
    return true;
  } catch {
    return false;
  }
}

export function credentialsFromArgs(args) {
  const gag = args.gagSession?.trim() || '';
  const roblox = args.robloxCookie?.trim() || '';
  if (!gag && !roblox) return null;
  const creds = { gag_session: normalizeGagSession(gag) };
  if (roblox) creds.roblox_cookie = normalizeRobloxCookie(roblox);
  return creds;
}

export function promptCredentials(requireRoblox = true) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    console.log('\n' + '='.repeat(44));
    console.log('  Auto Swiper JS');
    if (requireRoblox) {
      console.log('  • roblox.com  →  .ROBLOSECURITY  (for delete + re-login loop)');
    }
    console.log();

    rl.question('gag_session: ', (gagRaw) => {
      const credentials = { gag_session: normalizeGagSession(gagRaw) };
      if (requireRoblox) {
        rl.question('.ROBLOSECURITY: ', (rbxRaw) => {
          credentials.roblox_cookie = normalizeRobloxCookie(rbxRaw);
          console.log();
          rl.close();
          resolve(credentials);
        });
      } else {
        rl.close();
        resolve(credentials);
      }
    });
  });
}