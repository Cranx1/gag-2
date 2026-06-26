import 'dotenv/config';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  SlashCommandBuilder,
  MessageFlags,
} from 'discord.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SWIPER_PATH = join(__dirname, 'auto_swipe.js');
const TOKENS_FILE = join(__dirname, 'bot_tokens.json');

const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error('Missing DISCORD_BOT_TOKEN. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

function loadTokens() {
  if (!existsSync(TOKENS_FILE)) return {};
  try {
    return JSON.parse(readFileSync(TOKENS_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveTokens(tokens) {
  try {
    writeFileSync(TOKENS_FILE, JSON.stringify(tokens, null, 2));
  } catch (err) {
    console.error('Failed to persist tokens:', err.message);
  }
}

const credentials = loadTokens();

const sessions = new Map();

const MAX_LINES = 30;
const EMBED_MAX_CHARS = 3800;

function appendLine(session, raw) {
  const text = raw.replace(/\r/g, '').trimEnd();
  if (!text) return;
  for (const line of text.split('\n')) {
    if (line.length === 0) continue;
    session.lines.push(line);
  }
  if (session.lines.length > MAX_LINES) {
    session.lines.splice(0, session.lines.length - MAX_LINES);
  }
  session.dirty = true;
}

function renderLog(session) {
  let body = '';
  const collected = [];
  for (let i = session.lines.length - 1; i >= 0; i--) {
    const candidate = session.lines[i];
    if (body.length + candidate.length + 1 > EMBED_MAX_CHARS) break;
    collected.unshift(candidate);
    body = collected.join('\n');
  }
  return body || 'Waiting for output…';
}

function buildEmbed(session, { status = 'running' } = {}) {
  const colors = { running: 0x2ecc71, stopped: 0xe74c3c, finished: 0x95a5a6 };
  const elapsed = Math.floor((Date.now() - session.startedAt) / 1000);
  const embed = new EmbedBuilder()
    .setTitle('Grow A Garden 2 | Auto-Swiper')
    .setColor(colors[status] ?? 0x3498db)
    .setDescription('```log\n' + renderLog(session) + '\n```')
    .addFields(
      { name: 'Status', value: statusLabel(status), inline: true },
      { name: 'Mode', value: session.mode, inline: true },
      { name: 'Uptime', value: `${elapsed}s`, inline: true },
    )
    .setTimestamp(new Date());
  return embed;
}

function statusLabel(status) {
  if (status === 'running') return '🟢 Running';
  if (status === 'stopped') return '🔴 Stopped';
  if (status === 'finished') return '⚪ Finished';
  return status;
}

async function flushEmbed(session, opts) {
  if (!session.message) return;
  try {
    await session.message.edit({ embeds: [buildEmbed(session, opts)] });
  } catch (err) {
  }
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const commands = [
  new SlashCommandBuilder()
    .setName('session_token')
    .setDescription('Save your gag.gg session token (kept private)')
    .addStringOption((opt) =>
      opt
        .setName('token')
        .setDescription('Your __Host-gag_session value')
        .setRequired(true),
    )
    .addStringOption((opt) =>
      opt
        .setName('roblox_cookie')
        .setDescription('Optional .ROBLOSECURITY cookie (for cap reset loop)')
        .setRequired(false),
    ),
  new SlashCommandBuilder()
    .setName('start')
    .setDescription('Start the auto-swiper and stream logs')
    .addStringOption((opt) =>
      opt
        .setName('mode')
        .setDescription('Swipe mode (default: turbo)')
        .addChoices(
          { name: 'turbo', value: 'turbo' },
          { name: 'relaxed', value: 'relaxed' },
        )
        .setRequired(false),
    ),
  new SlashCommandBuilder()
    .setName('stop')
    .setDescription('Stop your running auto-swiper'),
].map((c) => c.toJSON());

client.once('clientReady', async () => {
  try {
    await client.application.commands.set(commands);
    console.log(`Logged in as ${client.user.tag}. Slash commands registered.`);
  } catch (err) {
    console.error('Failed to register slash commands:', err);
  }
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  try {
    if (interaction.commandName === 'session_token') {
      await handleSessionToken(interaction);
    } else if (interaction.commandName === 'start') {
      await handleStart(interaction);
    } else if (interaction.commandName === 'stop') {
      await handleStop(interaction);
    }
  } catch (err) {
    console.error(`Error handling /${interaction.commandName}:`, err);
    const msg = { content: `Error: ${err.message}`, flags: MessageFlags.Ephemeral };
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp(msg).catch(() => {});
    } else {
      await interaction.reply(msg).catch(() => {});
    }
  }
});

async function handleSessionToken(interaction) {
  const token = interaction.options.getString('token', true).trim();
  const roblox = interaction.options.getString('roblox_cookie')?.trim() || '';

  credentials[interaction.user.id] = {
    gag_session: token,
    ...(roblox ? { roblox_cookie: roblox } : {}),
  };
  saveTokens(credentials);

  await interaction.reply({
    content:
      '✅ Session token saved' +
      (roblox ? ' (with Roblox cookie).' : '.') +
      ' Use `/start` to begin.',
    flags: MessageFlags.Ephemeral,
  });
}

async function handleStart(interaction) {
  const userId = interaction.user.id;
  const creds = credentials[userId];

  if (!creds?.gag_session) {
    await interaction.reply({
      content: '⚠️ No session token set. Use `/session_token` first.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (sessions.has(userId)) {
    await interaction.reply({
      content: '⚠️ A swiper is already running. Use `/stop` first.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const mode = interaction.options.getString('mode') || 'turbo';

  await interaction.deferReply();

  const args = [SWIPER_PATH, '--no-prompt', '--gag-session', creds.gag_session];
  if (creds.roblox_cookie) args.push('--roblox-cookie', creds.roblox_cookie);
  if (mode === 'relaxed') args.push('--relaxed');
  else args.push('--turbo');

  const child = spawn(process.execPath, args, {
    cwd: __dirname,
    env: { ...process.env, FORCE_COLOR: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const session = {
    child,
    lines: [],
    interval: null,
    message: null,
    dirty: false,
    mode,
    startedAt: Date.now(),
  };
  sessions.set(userId, session);

  child.stdout.on('data', (chunk) => appendLine(session, chunk.toString()));
  child.stderr.on('data', (chunk) => appendLine(session, chunk.toString()));

  child.on('error', (err) => {
    appendLine(session, `Failed to launch swiper: ${err.message}`);
    session.dirty = true;
  });

  child.on('exit', async (code, signal) => {
    if (session.interval) clearInterval(session.interval);
    const status = signal ? 'stopped' : 'finished';
    appendLine(
      session,
      signal
        ? `Process stopped (${signal}).`
        : `Process exited with code ${code}.`,
    );
    await flushEmbed(session, { status });
    sessions.delete(userId);
  });

  const reply = await interaction.editReply({ embeds: [buildEmbed(session)] });
  session.message = reply;

  session.interval = setInterval(() => {
    if (session.dirty) {
      session.dirty = false;
      flushEmbed(session, { status: 'running' });
    }
  }, 2000);
}

async function handleStop(interaction) {
  const userId = interaction.user.id;
  const session = sessions.get(userId);

  if (!session) {
    await interaction.reply({
      content: '⚠️ No swiper is currently running.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  session.child.kill('SIGTERM');
  setTimeout(() => {
    if (sessions.has(userId)) session.child.kill('SIGKILL');
  }, 4000);

  await interaction.reply({
    content: '🛑 Stopping your swiper…',
    flags: MessageFlags.Ephemeral,
  });
}

function shutdown() {
  for (const session of sessions.values()) {
    if (session.interval) clearInterval(session.interval);
    session.child.kill('SIGKILL');
  }
  client.destroy();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

client.login(BOT_TOKEN);
