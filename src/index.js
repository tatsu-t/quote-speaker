require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const { joinVoiceChannel } = require('@discordjs/voice');
const { registerCommands } = require('./commands');
const { handleInteraction } = require('./handlers/interaction');
const { handleMessage } = require('./handlers/message');
const { handleVoiceStateUpdate } = require('./handlers/voiceState');
const { autoReadStates, boundTextChannels, listenChannels, nameReadStates, activeVoiceChannels, voiceSpeakers } = require('./state');
const persist = require('./services/persist');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
    ],
});

client.once('ready', async () => {
    console.log(`起動完了: ${client.user.tag}`);

    // 前回の状態を復元
    const saved = persist.load();
    for (const [guildId, val] of Object.entries(saved.autoRead || {})) autoReadStates.set(guildId, val);
    for (const [guildId, val] of Object.entries(saved.boundTextChannels || {})) boundTextChannels.set(guildId, val);
    for (const [guildId, val] of Object.entries(saved.listenChannels || {})) listenChannels.set(guildId, val);
    for (const [guildId, val] of Object.entries(saved.nameRead || {})) nameReadStates.set(guildId, val);
    for (const [guildId, val] of Object.entries(saved.voiceSpeakers || {})) voiceSpeakers.set(guildId, val);

    // VCに自動再接続
    for (const [guildId, channelId] of Object.entries(saved.voiceChannels || {})) {
        try {
            const guild = client.guilds.cache.get(guildId);
            const channel = guild?.channels.cache.get(channelId);
            if (!channel) continue;
            joinVoiceChannel({
                channelId,
                guildId,
                adapterCreator: guild.voiceAdapterCreator,
            });
            activeVoiceChannels.set(guildId, channelId);
            console.log(`自動再接続: ${guild.name} #${channel.name}`);
        } catch (err) {
            console.error(`自動再接続に失敗 (${guildId}):`, err.message);
        }
    }

    try {
        await registerCommands(client);
    } catch (err) {
        console.error('コマンド登録に失敗しました:', err);
    }
});

client.on('interactionCreate', (interaction) =>
    handleInteraction(interaction).catch(err => console.error('interactionCreate error:', err))
);
client.on('messageCreate', (msg) =>
    handleMessage(client, msg).catch(err => console.error('messageCreate error:', err))
);
client.on('voiceStateUpdate', (oldState, newState) =>
    handleVoiceStateUpdate(client, oldState, newState).catch(err => console.error('voiceStateUpdate error:', err))
);

process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err));

client.login(process.env.DISCORD_TOKEN);
