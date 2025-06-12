require('dotenv').config();
const { Client, GatewayIntentBits, Collection } = require('discord.js');
const fs = require('fs');

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates]
});

client.commands = new Collection();
const commandFiles = fs.readdirSync('./commands').filter(file => file.endsWith('.js'));

for (const file of commandFiles) {
  const command = require(`./commands/${file}`);
  client.commands.set(command.data.name, command);
}

client.once('ready', () => {
  console.log(`Bot online como ${client.user.tag}`);
});

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  const command = client.commands.get(interaction.commandName);
  if (!command) return;

  try {
    await command.execute(interaction);
  } catch (error) {
    console.error(error);
    await interaction.reply({ content: 'Erro ao executar comando.', ephemeral: true });
  }
});

client.login(process.env.DISCORD_TOKEN);

// commands/playspotify.js
const { SlashCommandBuilder } = require('discord.js');
const SpotifyWebApi = require('spotify-web-api-node');
const ytSearch = require('yt-search');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus } = require('@discordjs/voice');
const ytdl = require('ytdl-core');

const queue = new Map();

const spotifyApi = new SpotifyWebApi({
  clientId: process.env.SPOTIFY_CLIENT_ID,
  clientSecret: process.env.SPOTIFY_CLIENT_SECRET
});

async function getSpotifyTrackNames(url) {
  const trackRegex = /track\/([a-zA-Z0-9]+)/;
  const playlistRegex = /playlist\/([a-zA-Z0-9]+)/;
  const trackMatch = url.match(trackRegex);
  const playlistMatch = url.match(playlistRegex);

  const data = await spotifyApi.clientCredentialsGrant();
  spotifyApi.setAccessToken(data.body['access_token']);

  if (trackMatch) {
    const trackId = trackMatch[1];
    const trackData = await spotifyApi.getTrack(trackId);
    return [`${trackData.body.name} ${trackData.body.artists[0].name}`];
  } else if (playlistMatch) {
    const playlistId = playlistMatch[1];
    const playlistData = await spotifyApi.getPlaylistTracks(playlistId, { limit: 10 });
    return playlistData.body.items.map(item => `${item.track.name} ${item.track.artists[0].name}`);
  }
  return null;
}

async function searchYouTube(query) {
  const result = await ytSearch(query);
  return result.videos.length > 0 ? result.videos[0].url : null;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('playspotify')
    .setDescription('Toca uma música ou playlist do Spotify via YouTube.')
    .addStringOption(option =>
      option.setName('url').setDescription('URL da música ou playlist no Spotify').setRequired(true)
    ),

  async execute(interaction) {
    const url = interaction.options.getString('url');
    const voiceChannel = interaction.member.voice.channel;
    if (!voiceChannel) return interaction.reply('Entre em um canal de voz primeiro!');

    const trackNames = await getSpotifyTrackNames(url);
    if (!trackNames) return interaction.reply('Link inválido do Spotify!');

    const youtubeUrls = [];
    for (const name of trackNames) {
      const ytUrl = await searchYouTube(name);
      if (ytUrl) youtubeUrls.push(ytUrl);
    }

    const serverQueue = queue.get(interaction.guild.id);
    const songs = youtubeUrls.map(url => ({ url }));

    if (!serverQueue) {
      const queueContruct = {
        voiceChannel: voiceChannel,
        connection: null,
        songs: [],
        player: createAudioPlayer()
      };
      queue.set(interaction.guild.id, queueContruct);
      queueContruct.songs.push(...songs);

      try {
        const connection = joinVoiceChannel({
          channelId: voiceChannel.id,
          guildId: interaction.guild.id,
          adapterCreator: interaction.guild.voiceAdapterCreator
        });
        queueContruct.connection = connection;
        playSong(interaction.guild, queueContruct.songs[0]);
        await interaction.reply(`🎵 Tocando via Spotify: **${trackNames[0]}** e mais ${trackNames.length - 1} músicas.`);
      } catch (err) {
        console.error(err);
        queue.delete(interaction.guild.id);
        return interaction.reply('Erro ao conectar ao canal.');
      }
    } else {
      serverQueue.songs.push(...songs);
      return interaction.reply(`🎶 ${songs.length} músicas adicionadas à fila!`);
    }
  }
};

function playSong(guild, song) {
  const serverQueue = queue.get(guild.id);
  if (!song) {
    serverQueue.connection.destroy();
    queue.delete(guild.id);
    return;
  }
  const stream = ytdl(song.url, { filter: 'audioonly' });
  const resource = createAudioResource(stream);
  serverQueue.player.play(resource);
  serverQueue.connection.subscribe(serverQueue.player);
  serverQueue.player.on(AudioPlayerStatus.Idle, () => {
    serverQueue.songs.shift();
    playSong(guild, serverQueue.songs[0]);
  });
}

// commands/skip.js
const { SlashCommandBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('skip')
    .setDescription('Pula a música atual.'),
  async execute(interaction) {
    const serverQueue = require('../index').queue.get(interaction.guild.id);
    if (!serverQueue) return interaction.reply('Não há músicas para pular.');
    serverQueue.player.stop();
    await interaction.reply('⏭️ Música pulada!');
  }
};

// commands/stop.js
const { SlashCommandBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('stop')
    .setDescription('Para a música e limpa a fila.'),
  async execute(interaction) {
    const serverQueue = require('../index').queue.get(interaction.guild.id);
    if (!serverQueue) return interaction.reply('Não há músicas tocando.');
    serverQueue.songs = [];
    serverQueue.player.stop();
    await interaction.reply('⏹️ Música parada e fila limpa!');
  }
};

// commands/pause.js
const { SlashCommandBuilder } = require('discord.js');
const { AudioPlayerStatus } = require('@discordjs/voice');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('pause')
    .setDescription('Pausa a música atual.'),
  async execute(interaction) {
    const serverQueue = require('../index').queue.get(interaction.guild.id);
    if (!serverQueue) return interaction.reply('Nenhuma música tocando.');
    serverQueue.player.pause();
    await interaction.reply('⏸️ Música pausada!');
  }
};

// commands/resume.js
const { SlashCommandBuilder } = require('discord.js');
const { AudioPlayerStatus } = require('@discordjs/voice');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('resume')
    .setDescription('Continua a música pausada.'),
  async execute(interaction) {
    const serverQueue = require('../index').queue.get(interaction.guild.id);
    if (!serverQueue) return interaction.reply('Nenhuma música para continuar.');
    serverQueue.player.unpause();
    await interaction.reply('▶️ Música retomada!');
  }
};
