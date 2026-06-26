# gag.gg Auto-Swiper (Node.js)

A Node.js reimplementation of the gag.gg vote auto-swiper with proxy rotation and Roblox OAuth re‑authentication.

## Features

- Automatic swiping (like/dislike) with human‑like timings.
- Two modes: **Turbo** (fast) and **Relaxed** (slower).
- Automatic voting quota reset (delete profile or wait for hour reset).
- Proxy rotation using free ProxyScrape proxies when rate‑limited.
- Claim seed pack rewards automatically.
- Optional contest entry after swiping.
- Re‑authentication using `.ROBLOSECURITY` cookie (headless) or Playwright (browser).

## Requirements

- Node.js 18+
- npm

## Installation

```bash
git clone <repository>
cd gag-auto-swiper
npm install
```

## Discord Bot

Control the swiper from Discord with slash commands and live log embeds.

### Setup

1. Create an application + bot at https://discord.com/developers/applications and copy the bot token.
2. Put the bot token in .env.
3. Invite the bot to your server with the `bot` and `applications.commands` scopes.
4. Start the bot:

```bash
npm run bot
```

### Commands

- `/session_token token:<gag_session> [roblox_cookie:<.ROBLOSECURITY>]` — saves your credentials (replies privately).
- `/start [mode:turbo|relaxed]` — launches the swiper and streams logs into a live‑updating embed.
- `/stop` — stops your running swiper.