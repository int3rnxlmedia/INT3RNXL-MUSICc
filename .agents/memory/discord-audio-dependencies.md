---
name: Discord audio dependencies
description: Replit package-firewall behavior for Discord voice encoding dependencies.
---

For Discord voice in this workspace, `@discordjs/opus` pulled `@discordjs/node-pre-gyp` and a `tar@6.2.1` package that the Replit package firewall rejected. Pure-JS `opusscript@0.0.8` with FFmpeg avoids that dependency chain.

For YouTube audio, `play-dl@1.9.7` can find videos but its stream extraction returned an undefined media URL. The Nix-provided yt-dlp was too old for current YouTube extraction. The current yt-dlp Python package needs to run inside the workspace's `uv` environment, with Deno available for JavaScript challenges.

**Why:** The native Opus install was blocked by the package firewall, and the old YouTube stream extractor failed on active links.

**How to apply:** Use `opusscript` with system FFmpeg for Discord voice encoding. For YouTube, keep yt-dlp current, install its `default` extra, and invoke it through `uv run --project <workspace-root> yt-dlp` with Deno available; do not call the `.pythonlibs` launcher directly.
