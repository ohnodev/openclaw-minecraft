import fs from "node:fs";
import path from "node:path";
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
  pollMs: envInt("POLL_INTERVAL_MS", 5000),
  tag: env("HEROBRINE_TAG", "@Herobrine"),
  cli: env("OPENCLAW_CLI", "openclaw"),
  model: env("OPENCLAW_MODEL", "anthropic/claude-haiku-4-5"),
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
};

const routerPrompt = fs.readFileSync(path.resolve(__dirname, "..", "prompts", "router.md"), "utf8");
const helperPrompt = fs.readFileSync(path.resolve(__dirname, "..", "prompts", "helper.md"), "utf8");
const modPrompt = fs.readFileSync(path.resolve(__dirname, "..", "prompts", "moderation.md"), "utf8");

const CHAT_RE = /^\[[^\]]+\]: <([^>]+)>\s+(.+)$/;
const userLastResponse = new Map();
const byUser = new Map();
let globalLastResponse = 0;
let fileOffset = 0;
let fileInode = 0;
let rconClient = null;

function parseLine(line) {
  const idx = line.indexOf("] [Server thread/INFO]: ");
  if (idx < 0) return null;
  const payload = line.slice(idx + "] [Server thread/INFO]: ".length);
  const m = payload.match(CHAT_RE);
  if (!m) return null;
  return { player: m[1], message: m[2], timestamp: new Date().toISOString() };
}

function pushMessage(msg) {
  const key = msg.player.toLowerCase();
  const arr = byUser.get(key) ?? [];
  arr.push(msg);
  const max = config.bufferMax;
  if (arr.length > max) arr.splice(0, arr.length - max);
  byUser.set(key, arr);
}

function getRecent(player) {
  const key = player.toLowerCase();
  const arr = byUser.get(key) ?? [];
  const cutoff = Date.now() - config.bufferWindowMin * 60_000;
  return arr.filter((m) => Date.parse(m.timestamp) >= cutoff).slice(-20);
}

function stripTag(message) {
  const re = new RegExp(`@?${config.tag.replace("@", "")}\\b[:,]?\\s*`, "i");
  return message.replace(re, "").trim();
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

function jsonFromText(text) {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]);
  } catch {
    return null;
  }
}

async function runOpenClaw(agent, message) {
  const args = [
    "agent",
    "--agent",
    agent,
    "--model",
    config.model,
    "--message",
    message,
  ];
  const { stdout } = await execFileAsync(config.cli, args, { maxBuffer: 1024 * 1024 });
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

async function routeAndHandle(msg) {
  const stripped = stripTag(msg.message);
  const routerInput = `${routerPrompt}\n\nrequester=${msg.player}\nmessage=${stripped}`;
  const routerRaw = await runOpenClaw(config.routerAgent, routerInput);
  const route = jsonFromText(routerRaw);
  if (!route || route.route === "ignore") return;

  if (route.route === "helper") {
    const helperInput = `${helperPrompt}\n\nplayer=${msg.player}\nmessage=${stripped}`;
    const helperRaw = await runOpenClaw(config.helperAgent, helperInput);
    const oneLine = helperRaw.split(/\r?\n/).find((x) => x.trim())?.trim();
    if (oneLine) await sendTellraw("@a", `[Herobrine] ${oneLine}`);
    return;
  }

  if (route.route === "moderation") {
    const target = route.target;
    if (!target) {
      await sendTellraw("@a", "[Herobrine] need a name.");
      return;
    }
    const evidence = getRecent(target)
      .map((m) => `[${m.timestamp}] <${m.player}> ${m.message}`)
      .join("\n");
    const modInput = `${modPrompt}\n\nrequester=${msg.player}\ntarget=${target}\nmessage=${stripped}\n\nevidence:\n${evidence || "(none)"}`;
    const modRaw = await runOpenClaw(config.modAgent, modInput);
    const decision = jsonFromText(modRaw);
    if (!decision || decision.action === "ignore") {
      const resp = decision?.response || "nothing to see.";
      await sendTellraw("@a", `[Herobrine] ${resp}`);
      return;
    }
    if (decision.action === "warn") {
      await warnPlayer(target, decision.reason || "watch yourself.");
      await sendTellraw("@a", `[Herobrine] ${decision.response || "last chance."}`);
      return;
    }
    if (decision.action === "kick") {
      await kickPlayer(target, decision.reason || "removed.");
      await sendTellraw("@a", `[Herobrine] ${decision.response || "gone."}`);
    }
  }
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
    return buf.toString("utf8").split(/\r?\n/).filter(Boolean);
  } catch {
    return [];
  }
}

async function tick() {
  const lines = readNewLines();
  for (const line of lines) {
    const msg = parseLine(line);
    if (!msg) continue;
    pushMessage(msg);
    if (!msg.message.toLowerCase().includes(config.tag.toLowerCase())) continue;
    if (!canRespond(msg.player)) continue;
    try {
      await routeAndHandle(msg);
    } catch (err) {
      console.error("[minecraft-sidecar] handler error:", err);
    }
  }
}

console.log("[minecraft-sidecar] starting");
console.log(`  log: ${config.mcLogPath}`);
console.log(`  model: ${config.model}`);
console.log(`  agents: ${config.routerAgent}, ${config.helperAgent}, ${config.modAgent}`);
setInterval(() => {
  void tick();
}, config.pollMs);

