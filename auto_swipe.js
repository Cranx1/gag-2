import { program } from 'commander';
import { GagClient, log, runSwipeSession, runContest, sleepUntilReset } from './gag_client.js';
import { gagCookieHeader, credentialsFromArgs, promptCredentials } from './config_util.js';

const APP_SETTINGS = {
  vote: 'like',
  turbo: true,
  quiet: true,
  loopForever: true,
  resetOnCap: true,
  claimRewards: true,
  skipClaim: false,
  swipeDelayMs: [0, 0],
  decisionMs: [1, 20],
  autoContest: false,
  contestCarrots: 'all',
  rateLimitRetries: 8,
  rateLimitMaxWaitSeconds: 30,
  useProxiesOnRateLimit: true,
  proxyFetchLimit: 30,
  proxyTimeoutSeconds: 8,
};

const TURBO_OVERRIDES = {
  swipeDelayMs: [0, 0],
  decisionMs: [1, 20],
  quiet: true,
  skipClaim: true,
};

const RELAXED_OVERRIDES = {
  turbo: false,
  quiet: false,
  swipeDelayMs: [800, 1500],
  decisionMs: [50, 300],
};

function buildRuntimeConfig(args) {
  const cfg = { ...APP_SETTINGS };
  if (args.relaxed) {
    Object.assign(cfg, RELAXED_OVERRIDES);
  } else if (args.turbo || cfg.turbo) {
    Object.assign(cfg, TURBO_OVERRIDES);
    cfg.turbo = true;
  }
  if (args.waitOnCap) cfg.resetOnCap = false;
  else if (args.resetOnCap) cfg.resetOnCap = true;
  if (args.once) cfg.loopForever = false;
  return cfg;
}

async function resetCapBypass(client) {
  const t0 = Date.now();
  try {
    await client.deleteAccount();
  } catch (err) {
    log(`Cap reset failed: ${err.message}`);
    return false;
  }
  const deck = await client.voteDeck();
  const elapsed = (Date.now() - t0) / 1000;
  log(`Reset in ${elapsed.toFixed(1)}s — ${deck.remaining}/${deck.limit} swipes, capped=${deck.capped}`);
  return !deck.capped && (deck.remaining || 0) > 0;
}

async function resolveCredentials(args) {
  const fromCli = credentialsFromArgs(args);
  if (fromCli) return fromCli;
  if (args.noPrompt) {
    console.error('Use --gag-session or run without --no-prompt.');
    process.exit(1);
  }
  return await promptCredentials();
}

async function main() {
  program
    .option('--gag-session <value>', '__Host-gag_session cookie value')
    .option('--roblox-cookie <value>', '.ROBLOSECURITY cookie for reauth')
    .option('--no-prompt', 'Require --gag-session, do not prompt')
    .option('--once', 'Run one swipe session then exit')
    .option('--contest', 'Enter carrot contest after swiping')
    .option('--dry-run', 'Only check auth, no swipes')
    .option('--reset-on-cap', 'Delete profile when capped to refresh quota (default)', true)
    .option('--wait-on-cap', 'Sleep until UTC hour reset instead of delete loop')
    .option('--turbo', 'Max speed mode (default)', true)
    .option('--relaxed', 'Slower, human-like swipe timing')
    .parse(process.argv);

  const args = program.opts();
  const cfg = buildRuntimeConfig(args);
  const credentials = await resolveCredentials(args);

  let cookie;
  try {
    cookie = gagCookieHeader(credentials);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  const voteMode = cfg.vote;
  const swipeDelay = cfg.swipeDelayMs;
  const decisionMs = cfg.decisionMs;
  const skipClaim = cfg.skipClaim;
  const claimRewards = cfg.claimRewards;
  const quiet = cfg.quiet;
  const turbo = cfg.turbo;
  const resetOnCap = cfg.resetOnCap;
  const loopForever = cfg.loopForever;
  const autoContest = args.contest || cfg.autoContest;
  const contestCarrots = cfg.contestCarrots;

  const totals = { swipes: 0, carrotsAwarded: 0, jackpots: [], claimed: [] };

  const client = new GagClient({
    cookie,
    rateLimitRetries: cfg.rateLimitRetries,
    rateLimitMaxWaitSeconds: cfg.rateLimitMaxWaitSeconds,
    useProxiesOnRateLimit: cfg.useProxiesOnRateLimit,
    proxyFetchLimit: cfg.proxyFetchLimit,
    proxyTimeoutSeconds: cfg.proxyTimeoutSeconds,
  });

  try {
    let me;
    try {
      me = await client.authMe();
    } catch (err) {
      console.error(`Auth failed (${err.message}). Check your gag_session cookie.`);
      process.exit(1);
    }

    if (!me.signedIn) {
      console.error('Not signed in — log in on gag.gg and paste a fresh gag_session.');
      process.exit(1);
    }

    const mode = turbo ? 'turbo' : 'relaxed';
    const capMode = resetOnCap ? 'delete-reset loop' : 'hourly wait';
    log(`Signed in as ${me.username} (${me.sub}) — carrots: ${me.carrots || 0} — ${mode} mode, ${capMode}`);

    if (args.dryRun) {
      const deck = await client.voteDeck();
      log(`Dry run OK — ${deck.remaining}/${deck.limit} swipes, capped=${deck.capped}`);
      return;
    }

    let cycle = 0;
    while (true) {
      cycle++;
      if (await client.isVoteCapped()) {
        if (resetOnCap) {
          if (!quiet) log(`--- cycle ${cycle}: capped — reset ---`);
          if (!await resetCapBypass(client)) {
            log('Cap reset failed; exiting.');
            break;
          }
        } else {
          if (!quiet) log(`--- cycle ${cycle}: capped — waiting for UTC reset ---`);
          await sleepUntilReset();
        }
        continue;
      }

      if (!quiet) log(`--- cycle ${cycle}: swiping ---`);
      const t0 = Date.now();
      const stats = await runSwipeSession(client, {
        voteMode,
        swipeDelayMs: swipeDelay,
        decisionMsRange: decisionMs,
        skipClaim,
        claimRewards,
        quiet,
        skipWarmup: turbo && cycle > 1,
        stats: totals,
      });
      totals.swipes = stats.swipes;
      totals.carrotsAwarded = stats.carrotsAwarded;
      totals.jackpots = stats.jackpots;
      totals.claimed = stats.claimed;

      const swipeSeconds = (Date.now() - t0) / 1000;
      const rewards = stats.jackpots.length + stats.claimed.length;
      if (!quiet) {
        log(`Session done in ${swipeSeconds.toFixed(1)}s — swipes=${stats.swipes}, jackpots=${stats.jackpots.length}, claimed=${stats.claimed.length}, total=${totals.swipes}`);
      } else if (stats.swipes) {
        let extra = '';
        if (stats.jackpots.length) {
          extra = `, JACKPOT: ${stats.jackpots[0].item || 'reward'}`;
        } else if (rewards) {
          extra = `, ${rewards} rewards`;
        }
        log(`cycle ${cycle}: ${stats.swipes} swipes in ${swipeSeconds.toFixed(1)}s${extra}`);
      }

      if (autoContest) {
        await runContest(client, contestCarrots);
      }

      if (!loopForever) break;

      if (stats.finished || stats.swipes >= 20) {
        if (resetOnCap) {
          if (!quiet) log(`--- cycle ${cycle}: reset ---`);
          if (await resetCapBypass(client)) {
            continue;
          }
          log('Cap reset failed; exiting.');
          break;
        }
        await sleepUntilReset();
      } else if (!quiet) {
        log('Swipes still available — continuing…');
      }
    }
  } finally {
    client.close();
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});