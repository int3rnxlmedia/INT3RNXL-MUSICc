# Bot musical Discord

Bot Discord avec commandes slash pour lire des liens YouTube, retrouver sur YouTube un titre partagé depuis Spotify, ou lire un fichier audio joint.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm --filter @workspace/scripts run music-bot` — run the Discord music bot
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required secret: `DISCORD_BOT_TOKEN`
- FFmpeg is required for decoding audio, and Deno is required by yt-dlp for current YouTube extraction.
- The bot runs yt-dlp from the root Python environment with `uv run --project <workspace-root>`.

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- Discord bot: discord.js, @discordjs/voice, play-dl (search), yt-dlp (YouTube audio extraction)
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `scripts/src/music-bot.ts` — Discord bot, slash commands, queue and streaming
- The API server remains a separate shared service.

## Architecture decisions

- Spotify links provide track metadata only; playback resolves the title and artist to a YouTube video.
- YouTube audio is streamed by yt-dlp into FFmpeg; keep yt-dlp current because YouTube changes its stream formats.
- Slash commands are registered globally when the bot starts.

## Product

- `/play` accepts a YouTube URL, an individual Spotify track URL, a search query, or one audio attachment.
- `/pause`, `/resume`, `/skip`, `/stop`, `/queue`, and `/volume` control playback.
- The bot operates in one voice channel per Discord server and keeps an in-memory queue.

## User preferences

- User requested a music bot that accepts Spotify and YouTube links or an audio file.

## Gotchas

- Spotify does not stream audio to the bot; the bot searches YouTube for the linked track.
- The bot must be invited to a server with voice and slash-command permissions.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
