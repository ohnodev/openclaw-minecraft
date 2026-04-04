import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { Rcon } from "rcon-client";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadEnvFile(envPath) {
  if (!fs.existsSync(envPath)) return;
  const raw = fs.readFileSync(envPath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!process.env[key]) process.env[key] = value;
  }
}

function env(key, fallback = "") {
  const v = process.env[key];
  return v && v.trim() ? v.trim() : fallback;
}

function envInt(key, fallback) {
  const v = Number.parseInt(env(key, String(fallback)), 10);
  return Number.isFinite(v) ? v : fallback;
}

loadEnvFile(path.resolve(__dirname, "..", ".env"));

const config = {
  mcLogPath: env("MC_LOG_PATH", "/root/minecraft-cabal/server/logs/latest.log"),
  statePath: env("STATE_PATH", path.resolve(__dirname, "..", ".state", "cursor.json")),
  pollMs: envInt("POLL_INTERVAL_MS", 1000),
  followMode: env("FOLLOW_MODE", "watch").toLowerCase(),
  fallbackPollMs: envInt("FALLBACK_POLL_MS", 2000),
  tag: env("HEROBRINE_TAG", "@Herobrine"),
  cli: env("OPENCLAW_CLI", "openclaw"),
  model: env("OPENCLAW_MODEL", "anthropic/claude-haiku-4-5"),
  thinking: env("OPENCLAW_THINKING", "off"),
  openclawTimeoutSec: envInt("OPENCLAW_TIMEOUT_SEC", 35),
  routerAgent: env("OPENCLAW_ROUTER_AGENT", "minecraft-router"),
  helperAgent: env("OPENCLAW_HELPER_AGENT", "minecraft-helper"),
  modAgent: env("OPENCLAW_MOD_AGENT", "minecraft-moderation"),
  rconHost: env("RCON_HOST", "127.0.0.1"),
  rconPort: envInt("RCON_PORT", 25575),
  rconPassword: env("RCON_PASSWORD"),
  userCooldownMs: envInt("USER_COOLDOWN_MS", 8000),
  globalCooldownMs: envInt("GLOBAL_COOLDOWN_MS", 2000),
  bufferMax: envInt("MESSAGE_BUFFER_MAX", 50),
  bufferWindowMin: envInt("MESSAGE_BUFFER_WINDOW_MIN", 15),
  ambientEnabled: env("AMBIENT_ENABLED", "1") !== "0",
  ambientMinMs: envInt("AMBIENT_MIN_INTERVAL_MS", 1_800_000),
  ambientMaxMs: envInt("AMBIENT_MAX_INTERVAL_MS", 3_600_000),
  ambientContextLines: envInt("AMBIENT_CONTEXT_LINES", 8),
  dedupeWindowMs: envInt("DEDUPE_WINDOW_MS", 30_000),
};

const CHAT_RE = /^<([^>]+)>\s+(.+)$/;
const PM_RE = /^\[CHAT_PM\]\s+from=([^\s]+)\s+from_uuid=([^\s]+)\s+cmd=([^\s]+)\s+to=([^\s]+)\s+message=(.*)$/;
const REPORT_RE = /^\/?report\s+(@?[A-Za-z0-9_]{1,16})(?:\s+(.+))?$/i;
const HEROBRINE_MENTION_PATTERNS = [
  /(^|\s)@?herobrine(?=\s|$|[?!.,:;])/i,
  /(^|\s)@?hereobrine(?=\s|$|[?!.,:;])/i,
  /(^|\s)@?herobrin(?:e)?(?=\s|$|[?!.,:;])/i,
  /(^|\s)@?herobine(?=\s|$|[?!.,:;])/i,
  /(^|\s)@?hero\s*brine(?=\s|$|[?!.,:;])/i,
  /(^|\s)@?hero\s*brin(?=\s|$|[?!.,:;])/i,
];
const HEROBRINE_STRIP_PATTERNS = [
  /(^|\s)@?herobrine(?=\s|$|[?!.,:;])/gi,
  /(^|\s)@?hereobrine(?=\s|$|[?!.,:;])/gi,
  /(^|\s)@?herobrin(?:e)?(?=\s|$|[?!.,:;])/gi,
  /(^|\s)@?herobine(?=\s|$|[?!.,:;])/gi,
  /(^|\s)@?hero\s*brine(?=\s|$|[?!.,:;])/gi,
  /(^|\s)@?hero\s*brin(?=\s|$|[?!.,:;])/gi,
];
const userLastResponse = new Map();
const byUser = new Map();
const allMessages = [];
let globalLastResponse = 0;
let fileOffset = 0;
let fileInode = 0;
let rconClient = null;
let tickInFlight = false;
let nextAmbientAtMs = Date.now();
const processedLineHashes = new Set();
let watchDebounceTimer = null;
const inFlightPlayers = new Set();
const recentPromptByPlayer = new Map();

function hashLine(line) {
  return crypto.createHash("sha1").update(line).digest("hex");
}

function rememberLineHash(hash) {
  processedLineHashes.add(hash);
  if (processedLineHashes.size > 2000) {
    const first = processedLineHashes.values().next().value;
    if (first) processedLineHashes.delete(first);
  }
}

function readCursorState() {
  try {
    const raw = fs.readFileSync(config.statePath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const inode = Number(parsed.inode);
    const offset = Number(parsed.offset);
    if (!Number.isFinite(inode) || !Number.isFinite(offset) || inode <= 0 || offset < 0) return null;
    return { inode, offset };
  } catch {
    return null;
  }
}

function writeCursorState() {
  try {
    const dir = path.dirname(config.statePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${config.statePath}.${process.pid}.tmp`;
    const payload = JSON.stringify(
      {
        version: 1,
        inode: fileInode,
        offset: fileOffset,
        updatedAt: new Date().toISOString(),
      },
      null,
      2
    );
    fs.writeFileSync(tmp, payload);
    fs.renameSync(tmp, config.statePath);
  } catch (err) {
    console.error("[minecraft-sidecar] failed writing cursor state:", err);
  }
}

function initializeCursor() {
  try {
    const st = fs.statSync(config.mcLogPath);
    const saved = readCursorState();
    fileInode = st.ino;
    if (saved && saved.inode === st.ino && saved.offset >= 0 && saved.offset <= st.size) {
      fileOffset = saved.offset;
      return;
    }
    // Fresh start or rotated/truncated file: start at end to avoid replay spam.
    fileOffset = st.size;
    writeCursorState();
  } catch (err) {
    console.error("[minecraft-sidecar] failed initializing cursor:", err);
    fileInode = 0;
    fileOffset = 0;
  }
}

function parseLine(line) {
  const idx = line.indexOf("] [Server thread/INFO]: ");
  if (idx < 0) return null;
  const payload = line.slice(idx + "] [Server thread/INFO]: ".length);
  if (payload.startsWith("{")) {
    try {
      const obj = JSON.parse(payload);
      if (obj && obj.event === "CHAT_PM" && obj.from && obj.to) {
        return {
          kind: "pm",
          player: String(obj.from),
          message: String(obj.message ?? ""),
          target: String(obj.to),
          timestamp: new Date().toISOString(),
        };
      }
    } catch {
      // ignore non-JSON payloads
    }
  }
  const chat = payload.match(CHAT_RE);
  if (chat) {
    return {
      kind: "chat",
      player: chat[1],
      message: chat[2],
      timestamp: new Date().toISOString(),
    };
  }
  const pm = payload.match(PM_RE);
  if (pm) {
    return {
      kind: "pm",
      player: pm[1],
      message: pm[5] ?? "",
      target: pm[4],
      timestamp: new Date().toISOString(),
    };
  }
  return null;
}

function pushMessage(msg) {
  const key = msg.player.toLowerCase();
  const arr = byUser.get(key) ?? [];
  arr.push(msg);
  const max = config.bufferMax;
  if (arr.length > max) arr.splice(0, arr.length - max);
  byUser.set(key, arr);

  allMessages.push(msg);
  const cutoff = Date.now() - Math.max(config.bufferWindowMin, 60) * 60_000;
  while (allMessages.length > 0 && Date.parse(allMessages[0].timestamp) < cutoff) {
    allMessages.shift();
  }
  if (allMessages.length > 2000) {
    allMessages.splice(0, allMessages.length - 2000);
  }
}

function getRecent(player) {
  const key = player.toLowerCase();
  const arr = byUser.get(key) ?? [];
  const cutoff = Date.now() - config.bufferWindowMin * 60_000;
  return arr.filter((m) => Date.parse(m.timestamp) >= cutoff).slice(-20);
}

function getRecentGlobal(limit = 8, withinMinutes = 20) {
  const cutoff = Date.now() - withinMinutes * 60_000;
  return allMessages
    .filter((m) => Date.parse(m.timestamp) >= cutoff)
    .slice(-Math.max(1, limit));
}

function stripTag(message) {
  let out = String(message || "");
  for (const re of HEROBRINE_STRIP_PATTERNS) {
    out = out.replace(re, "");
  }
  return out.replace(/^[:,\s-]+/, "").replace(/\s+/g, " ").trim();
}

function canRespond(player) {
  const now = Date.now();
  if (now - globalLastResponse < config.globalCooldownMs) return false;
  const key = player.toLowerCase();
  const last = userLastResponse.get(key) ?? 0;
  if (now - last < config.userCooldownMs) return false;
  globalLastResponse = now;
  userLastResponse.set(key, now);
  return true;
}

function normalizedPromptText(msg) {
  if (msg.kind === "pm") {
    return String(msg.message || "").trim().toLowerCase();
  }
  return stripTag(msg.message).toLowerCase();
}

function isDuplicatePrompt(msg, normalizedText) {
  if (!normalizedText) return true;
  const key = String(msg.player || "").toLowerCase();
  const now = Date.now();
  const prev = recentPromptByPlayer.get(key);
  if (prev && prev.text === normalizedText && now - prev.ts < config.dedupeWindowMs) {
    return true;
  }
  recentPromptByPlayer.set(key, { text: normalizedText, ts: now });
  if (recentPromptByPlayer.size > 5000) {
    const firstKey = recentPromptByPlayer.keys().next().value;
    if (firstKey) recentPromptByPlayer.delete(firstKey);
  }
  return false;
}

function jsonFromText(text) {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]);
  } catch {
    return null;
  }
}

function extractAssistantLine(raw) {
  const lines = String(raw || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const filtered = lines.filter(
    (l) => !l.startsWith("[tools]") && !l.startsWith("⚠️") && !l.startsWith("Gateway ")
  );
  const pool = filtered.length > 0 ? filtered : lines;
  return pool.length > 0 ? pool[pool.length - 1] : "";
}

function sessionKeyForMessage(msg) {
  const player = String(msg.player || "unknown")
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "_");
  return msg.kind === "pm" ? `mc_pm_${player}` : `mc_public_${player}`;
}

async function runOpenClaw(agent, message, sessionKey) {
  const args = [
    "agent",
    "--agent",
    agent,
    "--session-id",
    sessionKey,
    "--thinking",
    config.thinking,
    "--verbose",
    "off",
    "--message",
    message
  ];
  const { stdout, stderr } = await execFileAsync(config.cli, args, {
    maxBuffer: 1024 * 1024,
    timeout: Math.max(5, config.openclawTimeoutSec) * 1000,
  });
  const errText = String(stderr || "");
  if (errText.includes("falling back to embedded") || errText.includes("pairing required")) {
    throw new Error("gateway_only_path_failed");
  }
  return (stdout || "").trim();
}

async function ensureRcon() {
  if (rconClient?.authenticated) return rconClient;
  rconClient = await Rcon.connect({
    host: config.rconHost,
    port: config.rconPort,
    password: config.rconPassword,
  });
  rconClient.on("end", () => {
    rconClient = null;
  });
  return rconClient;
}

async function sendTellraw(target, text) {
  const conn = await ensureRcon();
  const json = JSON.stringify({ text, color: "gray", italic: true });
  await conn.send(`tellraw ${target} ${json}`);
}

async function sendWhisper(player, text) {
  const conn = await ensureRcon();
  const oneLine = String(text).replace(/\r?\n/g, " ").trim();
  await conn.send(`msg ${player} ${oneLine}`);
}

async function warnPlayer(player, reason) {
  const conn = await ensureRcon();
  const json = JSON.stringify([
    { text: "[Herobrine] ", color: "dark_red", bold: true },
    { text: reason, color: "red" },
  ]);
  await conn.send(`tellraw ${player} ${json}`);
}

async function kickPlayer(player, reason) {
  const conn = await ensureRcon();
  await conn.send(`kick ${player} ${reason}`);
}

function isPmTargetForHerobrine(target) {
  const normalize = (s) => String(s || "").replace(/^@/, "").toLowerCase();
  return normalize(target) === normalize(config.tag);
}

function isMessageForHerobrine(message) {
  const text = String(message || "");
  return HEROBRINE_MENTION_PATTERNS.some((re) => re.test(text));
}

async function replyAsHerobrine(msg, text) {
  const line = `[Herobrine] ${text}`;
  const target = msg.kind === "pm" ? msg.player : "@a";

  if (msg.kind === "pm") {
    await sendWhisper(target, line);
  } else {
    await sendTellraw(target, line);
  }
}

async function routeAndHandle(msg) {
  const stripped = stripTag(msg.message);
  const promptMessage =
    stripped.length > 0
      ? stripped
      : "The player called your name directly without extra text. Reply briefly in-character.";
  const reportMatch = stripped.match(REPORT_RE);
  if (reportMatch) {
    const target = String(reportMatch[1] || "").replace(/^@/, "");
    const reason = String(reportMatch[2] || "reported by a player").trim();
    if (!target) {
      await replyAsHerobrine(msg, "usage: /report <player> <reason>");
      return;
    }
    await warnPlayer(target, `reported: ${reason.slice(0, 180)}`);
    await replyAsHerobrine(msg, `report noted for ${target}.`);
    return;
  }

  const chatSessionKey = sessionKeyForMessage(msg);
  const recent = getRecent(msg.player)
    .slice(-6)
    .map((m) => `<${m.player}> ${m.message}`)
    .join("\n");
  const helperInput =
    `player=${msg.player}\n` +
    `kind=${msg.kind}\n` +
    `message=${promptMessage}\n` +
    `recent:\n${recent || "(none)"}`;
  const helperRaw = await runOpenClaw(config.helperAgent, helperInput, chatSessionKey);
  const oneLine = extractAssistantLine(helperRaw);
  if (oneLine) await replyAsHerobrine(msg, oneLine);
}

function randomAmbientIntervalMs() {
  const min = Math.max(60_000, config.ambientMinMs);
  const max = Math.max(min, config.ambientMaxMs);
  if (max === min) return min;
  return min + Math.floor(Math.random() * (max - min + 1));
}

function scheduleNextAmbient() {
  nextAmbientAtMs = Date.now() + randomAmbientIntervalMs();
}

async function maybeSendAmbientLine() {
  if (!config.ambientEnabled) return;
  const now = Date.now();
  if (now < nextAmbientAtMs) return;
  scheduleNextAmbient();

  const context = getRecentGlobal(config.ambientContextLines, 20);
  if (context.length === 0) return;

  const contextLines = context.map((m) => `<${m.player}> ${m.message}`).join("\n");
  const prompt =
    "Write one ambient Herobrine line for the whole server based on this recent chat context. " +
    "Do not mention policy. Keep it one line.\n\nRecent chat:\n" +
    contextLines;
  const raw = await runOpenClaw(config.helperAgent, prompt, "mc_ambient_global");
  const oneLine = extractAssistantLine(raw);
  if (!oneLine) return;
  await sendTellraw("@a", `[Herobrine] ${oneLine}`);
}

function readNewLines() {
  try {
    const st = fs.statSync(config.mcLogPath);
    const inode = st.ino;
    const rotated = inode !== fileInode || st.size < fileOffset;
    if (rotated) {
      fileInode = inode;
      fileOffset = 0;
    }
    if (st.size === fileOffset) return [];
    const fd = fs.openSync(config.mcLogPath, "r");
    const len = st.size - fileOffset;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, fileOffset);
    fs.closeSync(fd);
    fileOffset = st.size;
    writeCursorState();
    return buf.toString("utf8").split(/\r?\n/).filter(Boolean);
  } catch {
    return [];
  }
}

async function tick() {
  const lines = readNewLines();
  for (const line of lines) {
    const lineHash = hashLine(line);
    if (processedLineHashes.has(lineHash)) continue;
    rememberLineHash(lineHash);

    const msg = parseLine(line);
    if (!msg) continue;
    pushMessage(msg);
    if (msg.kind === "pm") {
      if (!isPmTargetForHerobrine(msg.target)) continue;
    } else if (!isMessageForHerobrine(msg.message)) {
      continue;
    }
    const normalizedText = normalizedPromptText(msg);
    if (isDuplicatePrompt(msg, normalizedText)) continue;
    const playerKey = String(msg.player || "").toLowerCase();
    if (inFlightPlayers.has(playerKey)) continue;
    if (!canRespond(msg.player)) continue;
    inFlightPlayers.add(playerKey);
    try {
      await routeAndHandle(msg);
    } catch (err) {
      console.error("[minecraft-sidecar] handler error:", err);
    } finally {
      inFlightPlayers.delete(playerKey);
    }
  }

  try {
    await maybeSendAmbientLine();
  } catch (err) {
    console.error("[minecraft-sidecar] ambient error:", err);
  }
}

function requestTick() {
  if (tickInFlight) return;
  tickInFlight = true;
  void tick().finally(() => {
    tickInFlight = false;
  });
}

function startWatcher() {
  const logDir = path.dirname(config.mcLogPath);
  const logFile = path.basename(config.mcLogPath);
  try {
    const watcher = fs.watch(logDir, (eventType, filename) => {
      const changed = filename ? String(filename) : "";
      if (changed && changed !== logFile) return;
      if (watchDebounceTimer) {
        clearTimeout(watchDebounceTimer);
      }
      watchDebounceTimer = setTimeout(() => {
        watchDebounceTimer = null;
        requestTick();
      }, 50);
    });
    watcher.on("error", (err) => {
      console.error("[minecraft-sidecar] file watch error:", err);
    });
    console.log(`[minecraft-sidecar] follow mode: watch (${logDir}/${logFile})`);
  } catch (err) {
    console.error("[minecraft-sidecar] failed to start file watch:", err);
  }
}

console.log("[minecraft-sidecar] starting");
console.log(`  log: ${config.mcLogPath}`);
console.log(`  model: ${config.model}`);
console.log(`  agents: ${config.routerAgent}, ${config.helperAgent}, ${config.modAgent}`);
initializeCursor();
scheduleNextAmbient();

if (config.followMode === "watch") {
  startWatcher();
}

const intervalMs = config.followMode === "watch" ? Math.max(250, config.fallbackPollMs) : Math.max(250, config.pollMs);
setInterval(requestTick, intervalMs);

// Run one immediate pass on startup.
requestTick();

