import { spawn, type ChildProcess } from "node:child_process";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import {
  AudioPlayerStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
  StreamType,
  VoiceConnectionStatus,
  type AudioResource,
  type VoiceConnection,
} from "@discordjs/voice";
import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder,
  type Attachment,
  type Guild,
  type ChatInputCommandInteraction,
} from "discord.js";
import pino from "pino";
import play from "play-dl";

const logger = pino({ level: process.env["LOG_LEVEL"] ?? "info" });
const botToken = process.env["DISCORD_BOT_TOKEN"];
const workspaceRoot = fileURLToPath(new URL("../..", import.meta.url));
const maxAttachmentBytes = 100 * 1024 * 1024;
const maxQueueLength = 30;

if (!botToken) {
  throw new Error(
    "DISCORD_BOT_TOKEN is missing. Add the bot token in Replit Secrets.",
  );
}

interface MusicTrack {
  title: string;
  url: string;
  durationSeconds?: number;
  kind: "youtube" | "file";
  requester: string;
  channelId: string;
  sourceLabel: string;
}

interface GuildMusicState {
  player: ReturnType<typeof createAudioPlayer>;
  connection: VoiceConnection | null;
  queue: MusicTrack[];
  current: MusicTrack | null;
  resource: AudioResource<MusicTrack> | null;
  extractor: ChildProcess | null;
  volume: number;
  active: boolean;
  starting: boolean;
}

const musicByGuild = new Map<string, GuildMusicState>();

interface PreparedTrack {
  resource: AudioResource<MusicTrack>;
  extractor: ChildProcess | null;
}

function terminateExtractor(extractor: ChildProcess | null): void {
  if (
    extractor &&
    extractor.exitCode === null &&
    extractor.signalCode === null
  ) {
    extractor.kill("SIGTERM");
  }
}

function stopExtractor(state: GuildMusicState): void {
  const extractor = state.extractor;
  state.extractor = null;
  terminateExtractor(extractor);
}

const commandBuilders = [
  new SlashCommandBuilder()
    .setName("play")
    .setDescription("Lance un titre YouTube, un lien Spotify ou un fichier audio")
    .addStringOption((option) =>
      option
        .setName("lien")
        .setDescription("Lien YouTube ou Spotify, ou recherche par titre")
        .setMaxLength(500)
        .setRequired(false),
    )
    .addAttachmentOption((option) =>
      option
        .setName("fichier")
        .setDescription("Fichier audio à lire")
        .setRequired(false),
    ),
  new SlashCommandBuilder()
    .setName("pause")
    .setDescription("Met la lecture en pause"),
  new SlashCommandBuilder()
    .setName("resume")
    .setDescription("Reprend la lecture"),
  new SlashCommandBuilder()
    .setName("skip")
    .setDescription("Passe au titre suivant"),
  new SlashCommandBuilder()
    .setName("stop")
    .setDescription("Arrête la musique et quitte le salon vocal"),
  new SlashCommandBuilder()
    .setName("queue")
    .setDescription("Affiche le titre en cours et la file d’attente"),
  new SlashCommandBuilder()
    .setName("volume")
    .setDescription("Affiche ou règle le volume")
    .addIntegerOption((option) =>
      option
        .setName("niveau")
        .setDescription("Volume entre 0 et 100")
        .setMinValue(0)
        .setMaxValue(100)
        .setRequired(false),
    ),
];

function getMusicState(guildId: string): GuildMusicState {
  const existing = musicByGuild.get(guildId);
  if (existing) return existing;

  const state: GuildMusicState = {
    player: createAudioPlayer(),
    connection: null,
    queue: [],
    current: null,
    resource: null,
    extractor: null,
    volume: 0.7,
    active: true,
    starting: false,
  };

  state.player.on(AudioPlayerStatus.Idle, () => {
    stopExtractor(state);
    if (!state.current || !state.active) return;
    state.current = null;
    state.resource = null;
    void playNext(state);
  });

  state.player.on("error", (error) => {
    stopExtractor(state);
    logger.error(
      { err: error, guildId, trackTitle: state.current?.title },
      "Audio playback failed",
    );
    if (state.current) void notifyPlaybackFailure(state.current);
    state.current = null;
    state.resource = null;
    void playNext(state);
  });

  musicByGuild.set(guildId, state);
  return state;
}

async function ensureVoiceConnection(
  guild: Guild,
  userId: string,
): Promise<GuildMusicState> {
  const voiceState = guild.voiceStates.cache.get(userId);
  const channelId = voiceState?.channelId;
  const channel = channelId ? guild.channels.cache.get(channelId) : null;

  if (!channel || channel.type !== ChannelType.GuildVoice) {
    throw new Error("Rejoins d’abord un salon vocal classique.");
  }

  const botMember = guild.members.me ?? (await guild.members.fetchMe());
  const permissions = channel.permissionsFor(botMember);
  if (
    !permissions?.has([
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.Connect,
      PermissionFlagsBits.Speak,
    ])
  ) {
    throw new Error(
      "Le bot doit avoir les permissions Voir le salon, Se connecter et Parler.",
    );
  }

  const state = getMusicState(guild.id);
  if (state.connection?.state.status === VoiceConnectionStatus.Destroyed) {
    state.connection = null;
  }

  if (
    state.connection &&
    state.connection.joinConfig.channelId !== channel.id
  ) {
    throw new Error("Le bot joue déjà dans un autre salon vocal.");
  }

  if (!state.connection) {
    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: true,
    });

    state.connection = connection;
    connection.subscribe(state.player);
    connection.on("error", (error) => {
      logger.error({ err: error, guildId: guild.id }, "Voice connection error");
    });

    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
    } catch (error) {
      connection.destroy();
      state.connection = null;
      throw new Error(
        `Connexion au salon vocal impossible : ${error instanceof Error ? error.message : "délai dépassé"}`,
      );
    }
  }

  state.active = true;
  return state;
}

function safeTitle(title: string | undefined, fallback: string): string {
  return (title || fallback)
    .replace(/[\r\n]+/g, " ")
    .replace(/@/g, "@\u200b")
    .slice(0, 180);
}

function youtubeVideoId(url: URL): string | null {
  const hostname = url.hostname.toLowerCase().replace(/^www\./, "");
  if (hostname === "youtu.be") {
    return url.pathname.split("/").filter(Boolean)[0] ?? null;
  }
  if (
    hostname !== "youtube.com" &&
    hostname !== "m.youtube.com" &&
    hostname !== "music.youtube.com"
  ) {
    return null;
  }
  const watchId = url.searchParams.get("v");
  if (watchId) return watchId;
  const segments = url.pathname.split("/").filter(Boolean);
  if (["shorts", "embed", "live"].includes(segments[0] ?? "")) {
    return segments[1] ?? null;
  }
  return null;
}

async function findYouTubeTrack(
  query: string,
  requester: string,
  channelId: string,
  sourceLabel: string,
): Promise<MusicTrack> {
  const videos = await play.search(query, {
    limit: 1,
    source: { youtube: "video" },
  });
  const video = videos.find(
    (candidate) => candidate.url && !candidate.live && !candidate.private,
  );
  if (!video?.url) {
    throw new Error("Aucun résultat YouTube lisible n’a été trouvé.");
  }

  return {
    title: safeTitle(video.title, query),
    url: video.url,
    durationSeconds: video.durationInSec,
    kind: "youtube",
    requester,
    channelId,
    sourceLabel,
  };
}

async function spotifyTrackToYouTube(
  input: string,
  requester: string,
  channelId: string,
): Promise<MusicTrack> {
  const url = new URL(input);
  if (
    url.hostname !== "open.spotify.com" &&
    url.hostname !== "spotify.link"
  ) {
    throw new Error("Ce lien Spotify n’est pas reconnu.");
  }

  if (url.hostname === "spotify.link") {
    const redirectResponse = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(12_000),
    });
    if (!redirectResponse.ok) {
      throw new Error("Impossible d’ouvrir ce lien Spotify.");
    }
    return spotifyTrackToYouTube(redirectResponse.url, requester, channelId);
  }

  const segments = url.pathname
    .split("/")
    .filter(Boolean)
    .filter((segment) => !segment.startsWith("intl-"));
  if (segments[0] !== "track" || !segments[1]) {
    throw new Error(
      "Pour Spotify, utilise le lien d’un morceau individuel (pas un album ou une playlist).",
    );
  }

  const canonicalUrl = `https://open.spotify.com/track/${segments[1]}`;
  const oEmbedUrl = new URL("https://open.spotify.com/oembed");
  oEmbedUrl.searchParams.set("url", canonicalUrl);
  const response = await fetch(oEmbedUrl, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) {
    throw new Error("Spotify n’a pas fourni les informations de ce morceau.");
  }

  const metadata = (await response.json()) as {
    title?: unknown;
    author_name?: unknown;
  };
  if (
    typeof metadata.title !== "string" ||
    typeof metadata.author_name !== "string"
  ) {
    throw new Error("Les informations de ce morceau Spotify sont incomplètes.");
  }

  const spotifyTitle = safeTitle(metadata.title, "Titre Spotify");
  const artist = safeTitle(metadata.author_name, "");
  const track = await findYouTubeTrack(
    `${spotifyTitle} ${artist}`,
    requester,
    channelId,
    "Spotify → YouTube",
  );
  return { ...track, title: `${spotifyTitle} — ${artist}`.slice(0, 180) };
}

async function resolveTrack(
  input: string,
  requester: string,
  channelId: string,
): Promise<MusicTrack> {
  const trimmed = input.trim();
  let parsedUrl: URL | null = null;
  try {
    parsedUrl = new URL(trimmed);
  } catch {
    // Plain text is handled as a YouTube search below.
  }

  if (parsedUrl) {
    if (
      parsedUrl.hostname === "open.spotify.com" ||
      parsedUrl.hostname === "spotify.link"
    ) {
      return spotifyTrackToYouTube(trimmed, requester, channelId);
    }

    const videoId = youtubeVideoId(parsedUrl);
    if (!videoId) {
      throw new Error(
        "Lien non pris en charge. Utilise une vidéo YouTube, un morceau Spotify ou une recherche par titre.",
      );
    }

    const videoUrl = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
    const info = await play.video_basic_info(videoUrl);
    const details = info.video_details;
    if (details.live || details.private) {
      throw new Error("Les directs et vidéos privées ne peuvent pas être lus.");
    }

    return {
      title: safeTitle(details.title, "Vidéo YouTube"),
      url: videoUrl,
      durationSeconds: details.durationInSec,
      kind: "youtube",
      requester,
      channelId,
      sourceLabel: "YouTube",
    };
  }

  return findYouTubeTrack(
    trimmed,
    requester,
    channelId,
    "Recherche YouTube",
  );
}

function resolveAudioFile(
  attachment: Attachment,
  requester: string,
  channelId: string,
): MusicTrack {
  const filename = attachment.name.toLowerCase();
  const isAudioMime = attachment.contentType?.toLowerCase().startsWith("audio/");
  const hasAudioExtension =
    /\.(mp3|m4a|aac|wav|ogg|oga|opus|flac|webm)$/i.test(filename);

  if (!isAudioMime && !hasAudioExtension) {
    throw new Error("Le fichier joint doit être un fichier audio.");
  }
  if (attachment.size > maxAttachmentBytes) {
    throw new Error("Le fichier audio doit faire 100 Mo ou moins.");
  }

  return {
    title: safeTitle(attachment.name, "Fichier audio"),
    url: attachment.url,
    kind: "file",
    requester,
    channelId,
    sourceLabel: "Fichier audio",
  };
}

async function notifyPlaybackFailure(track: MusicTrack): Promise<void> {
  try {
    const channel = await client.channels.fetch(track.channelId);
    if (channel?.isSendable()) {
      await channel.send({
        content: `Impossible de lire **${track.title}**. Le bot passe au titre suivant.`,
        allowedMentions: { parse: [] },
      });
    }
  } catch (error) {
    logger.warn(
      { err: error, channelId: track.channelId },
      "Could not send playback failure notice",
    );
  }
}

async function createTrackResource(
  track: MusicTrack,
): Promise<PreparedTrack> {
  if (track.kind === "youtube") {
    const extractor = spawn(
      "uv",
      [
        "run",
        "--project",
        workspaceRoot,
        "yt-dlp",
        "--ignore-config",
        "--js-runtimes",
        "deno",
        "--no-warnings",
        "--no-progress",
        "--quiet",
        "--no-playlist",
        "--format",
        "bestaudio/best",
        "--output",
        "-",
        "--",
        track.url,
      ],
      {
        cwd: workspaceRoot,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const stream = extractor.stdout;
    if (!stream) {
      terminateExtractor(extractor);
      throw new Error("Impossible de démarrer le lecteur YouTube.");
    }
    extractor.stderr?.resume();
    extractor.once("error", (error) => {
      logger.error({ err: error }, "Could not start yt-dlp");
      if (!stream.destroyed) {
        stream.destroy(new Error("Impossible de démarrer le lecteur YouTube."));
      }
    });
    extractor.once("close", (code) => {
      if (code !== null && code !== 0 && !stream.destroyed) {
        stream.destroy(new Error(`yt-dlp a échoué (code ${code}).`));
      }
    });

    try {
      return {
        resource: createAudioResource(stream, {
          inputType: StreamType.Arbitrary,
          inlineVolume: true,
          metadata: track,
        }),
        extractor,
      };
    } catch (error) {
      terminateExtractor(extractor);
      throw error;
    }
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  let response: Response;
  try {
    response = await fetch(track.url, { signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok || !response.body) {
    throw new Error("Impossible de télécharger le fichier audio joint.");
  }

  const stream = Readable.from(
    response.body as unknown as AsyncIterable<Uint8Array>,
  );
  return {
    resource: createAudioResource(stream, {
      inputType: StreamType.Arbitrary,
      inlineVolume: true,
      metadata: track,
    }),
    extractor: null,
  };
}

async function playNext(state: GuildMusicState): Promise<void> {
  if (state.starting || state.current || !state.active) return;
  const next = state.queue.shift();
  if (!next) return;

  state.current = next;
  state.starting = true;
  let playbackFailed = false;
  let extractor: ChildProcess | null = null;

  try {
    const prepared = await createTrackResource(next);
    extractor = prepared.extractor;
    if (!state.active || state.current !== next) {
      prepared.resource.playStream.destroy();
      terminateExtractor(extractor);
      return;
    }
    state.extractor = extractor;
    prepared.resource.volume?.setVolume(state.volume);
    state.resource = prepared.resource;
    state.player.play(prepared.resource);
    logger.info(
      { title: next.title, source: next.sourceLabel },
      "Started playback",
    );
  } catch (error) {
    playbackFailed = true;
    terminateExtractor(extractor);
    stopExtractor(state);
    logger.error(
      { err: error, title: next.title, source: next.sourceLabel },
      "Could not start track",
    );
    void notifyPlaybackFailure(next);
  } finally {
    state.starting = false;
  }

  if (playbackFailed) {
    state.current = null;
    state.resource = null;
    void playNext(state);
  }
}

function formatDuration(seconds?: number): string {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) {
    return "durée inconnue";
  }
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.floor(seconds % 60)
    .toString()
    .padStart(2, "0");
  return `${minutes}:${remainingSeconds}`;
}

async function handlePlay(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const input = interaction.options.getString("lien");
  const attachment = interaction.options.getAttachment("fichier");
  if ((!input && !attachment) || (input && attachment)) {
    throw new Error("Indique un lien ou un fichier audio, mais pas les deux.");
  }

  await interaction.deferReply();
  const track = attachment
    ? resolveAudioFile(
        attachment,
        interaction.user.username,
        interaction.channelId,
      )
    : await resolveTrack(
        input!,
        interaction.user.username,
        interaction.channelId,
      );
  const state = await ensureVoiceConnection(
    interaction.guild!,
    interaction.user.id,
  );

  if (state.queue.length >= maxQueueLength) {
    throw new Error(`La file est limitée à ${maxQueueLength} titres.`);
  }

  state.queue.push(track);
  void playNext(state);
  await interaction.editReply(
    `Ajouté à la file : **${track.title}** (${track.sourceLabel}).`,
  );
}

async function handleInteraction(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  if (!interaction.inGuild() || !interaction.guild) {
    await interaction.reply({
      content: "Cette commande fonctionne uniquement dans un serveur.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const state = musicByGuild.get(interaction.guild.id);

  try {
    switch (interaction.commandName) {
      case "play":
        await handlePlay(interaction);
        return;
      case "pause":
        if (!state?.current || !state.player.pause()) {
          throw new Error("Aucun titre n’est en cours de lecture.");
        }
        await interaction.reply("Lecture mise en pause.");
        return;
      case "resume":
        if (!state?.current || !state.player.unpause()) {
          throw new Error("Aucun titre en pause à reprendre.");
        }
        await interaction.reply("Lecture reprise.");
        return;
      case "skip":
        if (!state?.current) throw new Error("Aucun titre à passer.");
        state.player.stop(true);
        await interaction.reply("Titre passé.");
        return;
      case "stop":
        if (!state) throw new Error("Le bot ne joue rien pour le moment.");
        state.active = false;
        stopExtractor(state);
        state.queue.length = 0;
        state.current = null;
        state.resource = null;
        state.player.stop(true);
        state.connection?.destroy();
        musicByGuild.delete(interaction.guild.id);
        await interaction.reply("Lecture arrêtée, le bot a quitté le salon.");
        return;
      case "queue": {
        if (!state?.current && !state?.queue.length) {
          throw new Error("La file d’attente est vide.");
        }
        const lines = [
          state.current
            ? `En cours : **${state.current.title}** (${formatDuration(state.current.durationSeconds)})`
            : "Aucun titre en cours.",
          ...state.queue.slice(0, 10).map(
            (track, index) =>
              `${index + 1}. **${track.title}** (${formatDuration(track.durationSeconds)})`,
          ),
        ];
        if (state.queue.length > 10) {
          lines.push(`… et ${state.queue.length - 10} autre(s) titre(s).`);
        }
        await interaction.reply(lines.join("\n"));
        return;
      }
      case "volume": {
        if (!state) throw new Error("Le bot ne joue rien pour le moment.");
        const requestedVolume = interaction.options.getInteger("niveau");
        if (requestedVolume === null) {
          await interaction.reply(
            `Volume actuel : ${Math.round(state.volume * 100)} %.`,
          );
          return;
        }
        state.volume = requestedVolume / 100;
        state.resource?.volume?.setVolume(state.volume);
        await interaction.reply(`Volume réglé à ${requestedVolume} %.`);
        return;
      }
      default:
        return;
    }
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Une erreur est survenue.";
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(message);
    } else {
      await interaction.reply({ content: message, flags: MessageFlags.Ephemeral });
    }
  }
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});
const rest = new REST({ version: "10" }).setToken(botToken);

client.once(Events.ClientReady, async (readyClient) => {
  try {
    await rest.put(Routes.applicationCommands(readyClient.user.id), {
      body: commandBuilders.map((command) => command.toJSON()),
    });

    const permissions =
      PermissionFlagsBits.ViewChannel |
      PermissionFlagsBits.SendMessages |
      PermissionFlagsBits.EmbedLinks |
      PermissionFlagsBits.ReadMessageHistory |
      PermissionFlagsBits.Connect |
      PermissionFlagsBits.Speak;
    const inviteUrl = new URL("https://discord.com/oauth2/authorize");
    inviteUrl.searchParams.set("client_id", readyClient.user.id);
    inviteUrl.searchParams.set("permissions", permissions.toString());
    inviteUrl.searchParams.set("scope", "bot applications.commands");

    logger.info(
      { bot: readyClient.user.tag, inviteUrl: inviteUrl.toString() },
      "Discord music bot is ready. Use the invite link to add it to a server.",
    );
  } catch (error) {
    logger.error({ err: error }, "Could not register slash commands");
  }
});

client.on(Events.InteractionCreate, (interaction) => {
  if (interaction.isChatInputCommand()) {
    void handleInteraction(interaction).catch((error: unknown) => {
      logger.error({ err: error }, "Unhandled command error");
    });
  }
});

client.on(Events.Error, (error) => {
  logger.error({ err: error }, "Discord client error");
});

client.login(botToken).catch((error: unknown) => {
  logger.fatal({ err: error }, "Discord login failed");
  process.exitCode = 1;
});
