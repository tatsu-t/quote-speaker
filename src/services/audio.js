const { createAudioPlayer, createAudioResource, AudioPlayerStatus, getVoiceConnection } = require('@discordjs/voice');

const guildPlayers = new Map(); // guildId -> { player, queue, isPlaying, currentItem }

function getPlayer(guildId) {
    if (guildPlayers.has(guildId)) return guildPlayers.get(guildId);

    const player = createAudioPlayer();
    const state = { player, queue: [], isPlaying: false, currentItem: null };

    player.on(AudioPlayerStatus.Idle, () => {
        state.currentItem?.resolve?.();
        state.currentItem = null;
        processQueue(guildId);
    });

    player.on('error', (err) => {
        console.error('Audio player error:', err);
        state.currentItem?.reject?.(err);
        state.currentItem = null;
        processQueue(guildId);
    });

    guildPlayers.set(guildId, state);
    return state;
}

function processQueue(guildId) {
    const state = guildPlayers.get(guildId);
    if (!state || state.queue.length === 0) {
        if (state) state.isPlaying = false;
        return;
    }
    state.isPlaying = true;
    const next = state.queue.shift();
    state.currentItem = next;
    state.player.play(next.resource);
}

async function playAudio(guildId, audioStream) {
    const connection = getVoiceConnection(guildId);
    if (!connection) throw new Error('ボイスチャンネルに接続していません。');

    const state = getPlayer(guildId);

    if (!connection.state.subscription || connection.state.subscription.player !== state.player) {
        connection.subscribe(state.player);
    }

    return new Promise((resolve, reject) => {
        state.queue.push({ resource: createAudioResource(audioStream), resolve, reject });
        if (!state.isPlaying) processQueue(guildId);
    });
}

function skipCurrent(guildId) {
    const state = guildPlayers.get(guildId);
    if (state?.isPlaying) {
        state.player.stop();
        return true;
    }
    return false;
}

function clearQueue(guildId) {
    const state = guildPlayers.get(guildId);
    if (!state) return;
    state.queue = [];
    if (state.isPlaying) state.player.stop();
}

module.exports = { playAudio, skipCurrent, clearQueue };
