# OpenClaw Minecraft Sidecar

Minimal sidecar for Cabal SMP using OpenClaw + Haiku:

- tails `latest.log` every 5 seconds
- only reacts when tagged with `@Herobrine`
- routes each tagged message through a router agent
- calls helper or moderation agent based on router JSON
- sends replies/actions via RCON (`tellraw`, `warn`, `kick`)

## Why sidecar

This keeps Minecraft server overhead low. The game server only writes logs and accepts RCON commands; all AI work runs outside the server.

## Quick setup

1. Configure OpenClaw:
   - copy relevant sections from `openclaw.minecraft.json5` into `~/.openclaw/openclaw.json`
   - ensure your `ANTHROPIC_API_KEY` is available in `~/.openclaw/.env`
2. Configure sidecar:
   - `cp .env.example .env`
   - set `RCON_PASSWORD`
3. Install and run:

```bash
cd integrations/minecraft
npm install
npm start
```

## Agent routing contract

Router agent must return JSON:

```json
{ "route": "helper|moderation|ignore", "target": "optional", "reason": "..." }
```

Moderation agent must return JSON:

```json
{ "action": "ignore|warn|kick", "target": "player", "reason": "...", "response": "..." }
```

## Notes

- Default model is `anthropic/claude-3-5-haiku-latest`.
- If you want longer memory, configure OpenClaw sessions for the `minecraft-*` agents in your `openclaw.json`.
- This is intentionally simple and easy to iterate.
