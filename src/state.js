// Per-guild state shared across handlers
const autoReadStates = new Map();    // guildId -> boolean
const boundTextChannels = new Map(); // guildId -> channelId
const listenChannels = new Map();    // guildId -> channelId (VCと同等扱いのチャンネル)
const nameReadStates = new Map();      // guildId -> boolean (Quote画像のユーザー名読み上げ、デフォルトOFF)
const activeVoiceChannels = new Map(); // guildId -> voiceChannelId (再起動時の自動再接続用)
const voiceSpeakers = new Map();       // guildId -> speakerId (読み上げ話者、デフォルト3)

module.exports = { autoReadStates, boundTextChannels, listenChannels, nameReadStates, activeVoiceChannels, voiceSpeakers };
