---
name: Discord audio dependencies
description: Replit package-firewall behavior for Discord voice encoding dependencies.
---

For Discord voice in this workspace, `@discordjs/opus` pulled `@discordjs/node-pre-gyp` and a `tar@6.2.1` package that the Replit package firewall rejected.

**Why:** The first dependency install failed before the bot could start, even though the Discord packages themselves resolved.

**How to apply:** Prefer the Prism Media-compatible `opusscript@0.0.8` encoder with system FFmpeg unless the native Opus dependency chain is updated and available through the package firewall.
