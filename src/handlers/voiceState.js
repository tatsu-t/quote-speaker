const { getVoiceConnection } = require('@discordjs/voice');
const { autoReadStates, boundTextChannels, activeVoiceChannels, voiceSpeakers } = require('../state');
const persist = require('../services/persist');
const { generateAudio, DEFAULT_SPEAKER } = require('../services/tts');
const { playAudio } = require('../services/audio');

async function handleVoiceStateUpdate(client, oldState, newState) {
    const guildId = oldState.guild.id || newState.guild.id;
    const connection = getVoiceConnection(guildId);
    if (!connection) return;

    const botChannelId = connection.joinConfig.channelId;

    // ボット以外が全員いなくなったら自動退出
    if (oldState.channelId === botChannelId) {
        const channel = oldState.channel ?? oldState.guild.channels.cache.get(oldState.channelId);
        if (channel?.members.size === 1 && channel.members.has(client.user.id)) {
            const textChannelId = boundTextChannels.get(guildId);
            connection.destroy();
            boundTextChannels.delete(guildId);
            autoReadStates.delete(guildId);
            activeVoiceChannels.delete(guildId);
            persist.save();
            if (textChannelId) {
                const ch = client.channels.cache.get(textChannelId);
                ch?.send('ボイスチャンネルに誰もいなくなったため、自動退出しました。');
            }
            return;
        }
    }

    // 入退室通知（自動読み上げON時のみ）
    if (!autoReadStates.get(guildId)) return;
    if (oldState.member?.user.bot || newState.member?.user.bot) return;

    let notification = '';
    if (newState.channelId === botChannelId && oldState.channelId !== botChannelId) {
        notification = `${newState.member.displayName}さんが入室しました`;
    } else if (oldState.channelId === botChannelId && newState.channelId !== botChannelId) {
        notification = `${oldState.member.displayName}さんが退出しました`;
    }

    if (notification) {
        try {
            const speakerId = voiceSpeakers.get(guildId) || DEFAULT_SPEAKER;
            const audio = await generateAudio(notification, speakerId);
            await playAudio(guildId, audio);
        } catch (err) {
            console.error('入退室通知エラー:', err.message);
        }
    }
}

module.exports = { handleVoiceStateUpdate };
