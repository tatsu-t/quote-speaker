require('dotenv').config();
const { Client, GatewayIntentBits, SlashCommandBuilder, Routes, REST } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, VoiceConnectionStatus, entersState, getVoiceConnection } = require('@discordjs/voice');
const axios = require('axios');
const { Readable } = require('stream');
const fs = require('fs');
const path = require('path');

// 設定
const VOICEVOX_URL = process.env.VOICEVOX_URL || 'http://voicevox:50021';
const GOOGLE_VISION_API_KEY = process.env.GOOGLE_VISION_API_KEY;
// 話者ID 3: ずんだもん (ノーマル)
const SPEAKER_ID = 3;

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

const lastTextChannel = new Map();
const autoReadStates = new Map();



function cleanOCRText(text) {
    if (!text) return "";

    // Basic normalization
    let combinedText = text.trim();

    // OCR補正処理
    combinedText = combinedText.replace(/[\u200B-\u200D\uFEFF]/g, '')
        .replace(/https?:\/\/\S+/g, '')
        .replace(/([^\x00-\x7F])かルー/g, '$1から')
        .replace(/([^\x00-\x7F])かル/g, '$1から')
        .replace(/でルー/g, 'で')
        .replace(/w{3,}/gi, 'www')
        //    - 末尾ノイズ ('0', '°')
        //    - "男" の誤認 ('0だから' -> '男だから')
        //    - ハート記号 (♡) の誤認 ('さーんく' -> 'さーん♡')
        .replace(/^[0°]+/, '')
        .replace(/0だから/g, '男だから')
        .replace(/さーんく/g, 'さーん♡')
        .replace(/([ぁ-ん])ーんく/g, '$1ーん♡');

    return combinedText.trim();
}

async function processImageAttachment(imageUrl) {
    try {
        console.log(`Processing image with Google Vision: ${imageUrl}`);

        if (!GOOGLE_VISION_API_KEY) {
            throw new Error("GOOGLE_VISION_API_KEY is not set in .env");
        }

        const imageResponse = await axios.get(imageUrl, { responseType: 'arraybuffer' });
        const base64Image = Buffer.from(imageResponse.data, 'binary').toString('base64');

        const visionUrl = `https://vision.googleapis.com/v1/images:annotate?key=${GOOGLE_VISION_API_KEY}`;
        const requestBody = {
            requests: [
                {
                    image: { content: base64Image },
                    features: [{ type: 'TEXT_DETECTION' }]
                }
            ]
        };

        const response = await axios.post(visionUrl, requestBody);
        const responses = response.data.responses;
        if (!responses || responses.length === 0 || !responses[0].textAnnotations) {
            console.log("No text detected in image.");
            return "";
        }

        const annotations = responses[0].textAnnotations;
        // 最初の要素は全文、以後は個別の単語
        const words = annotations.slice(1);

        let imgWidth = 0;
        let imgHeight = 0;
        words.forEach(word => {
            const vertices = word.boundingPoly.vertices;
            vertices.forEach(v => {
                if (v.x && v.x > imgWidth) imgWidth = v.x;
                if (v.y && v.y > imgHeight) imgHeight = v.y;
            });
        });

        console.log(`Estimated Image Size: ${imgWidth}x${imgHeight}`);

        // Quote画像判定 (各行のテキストに基づく)
        const fullText = annotations[0].description;
        const isQuoteImage = /Make\s*it\s*a\s*Quote|Quote\s*Maker/i.test(fullText);
        console.log(`Is Quote Image: ${isQuoteImage}`);

        const filteredWords = words.filter(word => {
            // If not a quote image, skip spatial filtering (read everything)
            if (!isQuoteImage) return true;

            const vertices = word.boundingPoly.vertices;
            const ys = vertices.map(v => v.y || 0);
            const midY = (Math.min(...ys) + Math.max(...ys)) / 2;

            // 1. Top Exclusion (Header/Speaker Name) - Exclude top 15%
            if (midY < imgHeight * 0.15) return false;

            // 2. Bottom Exclusion (Branding only) - Exclude bottom 5%
            if (midY > imgHeight * 0.95) return false;

            // 3. 左側の除外処理 (イラスト由来のノイズ除去)
            // イラスト上の文字が誤検知されるケースへの対応
            const midX = (Math.min(...word.boundingPoly.vertices.map(v => v.x || 0)) + Math.max(...word.boundingPoly.vertices.map(v => v.x || 0))) / 2;
            if (midX < imgWidth * 0.10) return false;

            return true;
        });

        // 並び替え処理: 行単位(Y軸)でグループ化し、X軸でソート
        filteredWords.sort((a, b) => {
            const ysA = a.boundingPoly.vertices.map(v => v.y || 0);
            const ysB = b.boundingPoly.vertices.map(v => v.y || 0);
            const midYA = (Math.min(...ysA) + Math.max(...ysA)) / 2;
            const midYB = (Math.min(...ysB) + Math.max(...ysB)) / 2;

            if (Math.abs(midYA - midYB) < (imgHeight * 0.02)) {
                const xsA = a.boundingPoly.vertices.map(v => v.x || 0);
                const xsB = b.boundingPoly.vertices.map(v => v.x || 0);
                return Math.min(...xsA) - Math.min(...xsB);
            }
            return midYA - midYB;
        });

        // 行ごとのグループ化
        const lines = [];
        let currentLine = [];
        let lastY = -1;

        filteredWords.forEach(word => {
            const ys = word.boundingPoly.vertices.map(v => v.y || 0);
            const midY = (Math.min(...ys) + Math.max(...ys)) / 2;

            if (lastY !== -1 && Math.abs(midY - lastY) > (imgHeight * 0.03)) {
                lines.push(currentLine);
                currentLine = [];
            }
            currentLine.push(word);
            lastY = midY;
        });
        if (currentLine.length > 0) lines.push(currentLine);

        // コンテンツルールに基づくフィルタリング
        // 不要な行（ブランディング、署名、ハンドル名、表示名）を除外
        const validLines = lines.map(getLineText).filter((lineText, i, arr) => {
            if (!isQuoteImage) return true;
            if (/Make[ \t]*it[ \t]*a[ \t]*Quote|Quote[ \t]*Maker/i.test(lineText)) return false;
            if (/^[-—|]/.test(lineText)) return false;
            if (/^@/.test(lineText)) return false;
            // 次の行が @ で始まる場合（表示名と推測される）も除外
            if (i < arr.length - 1 && /^@/.test(arr[i + 1]) && lineText.length < 30) return false;
            return true;
        });

        const reconstructedText = validLines.join('');
        console.log(`Filtered Text: ${reconstructedText}`);

        let finalText = cleanOCRText(reconstructedText);
        // Apply Dictionary to OCR text as well
        finalText = applyDictionary(finalText);

        return { text: finalText, isQuote: isQuoteImage };
    } catch (error) {
        console.error('Google Vision API Error:', error.response?.data || error.message);
        throw error;
    }
}

// 外部VOICEVOX API設定 (メイン)
const VOICEVOX_API_URL = 'https://deprecatedapis.tts.quest/v2/voicevox/audio/';
const VOICEVOX_POINTS_URL = 'https://deprecatedapis.tts.quest/v2/api/';
const VOICEVOX_API_KEY = process.env.VOICEVOX_API_KEY;

// ローカルVOICEVOXエンジン設定 (フォールバック)
const VOICEVOX_LOCAL_URL = process.env.VOICEVOX_URL || 'http://voicevox:50021';
const VOICEVOX_CONTAINER_NAME = 'quotespeak-voicevox-1';
const DOCKER_SOCKET_PATH = '/var/run/docker.sock';

// コンテナ状態追跡
let isContainerRunning = true; // 起動時チェックまでは実行中と仮定

// APIポイント確認
async function checkApiPoints() {
    try {
        const response = await axios.get(VOICEVOX_POINTS_URL, {
            params: { key: VOICEVOX_API_KEY }
        });
        return response.data; // { points: number, resetInHours: number }
    } catch (error) {
        console.error('Failed to check API points:', error.message);
        return null; // 確認失敗時
    }
}

// Dockerコンテナ制御 (起動/停止)
async function controlContainer(action) {
    if (action !== 'start' && action !== 'stop') return;

    // 最適化: 既に目的の状態であればスキップ
    if (action === 'start' && isContainerRunning) return;
    if (action === 'stop' && !isContainerRunning) return;

    try {
        console.log(`Docker: Attempting to ${action} container ${VOICEVOX_CONTAINER_NAME}...`);
        await axios.post(
            `http://localhost/containers/${VOICEVOX_CONTAINER_NAME}/${action}`,
            null,
            { socketPath: DOCKER_SOCKET_PATH }
        );
        console.log(`Docker: Successfully ${action}ed container ${VOICEVOX_CONTAINER_NAME}.`);
        isContainerRunning = (action === 'start');

        if (action === 'start') {
            // Wait a bit for the service to be ready
            await new Promise(resolve => setTimeout(resolve, 5000));
        }
    } catch (error) {
        // "Not Modified" (304) は無視（既に目的の状態）
        if (error.response && error.response.status === 304) {
            console.log(`Docker: Container ${VOICEVOX_CONTAINER_NAME} already ${action}ed (304).`);
            isContainerRunning = (action === 'start');
        } else {
            console.error(`Docker Control Error (${action}):`, error.message);
        }
    }
}

async function generateVoicevoxAudio(text, speakerId = 1) {
    let useLocal = false;
    let points = 0;

    // 1. ポイント確認・リソース管理
    const pointsData = await checkApiPoints();
    if (pointsData) {
        points = pointsData.points;
        console.log(`Current API Points: ${points}`);
        if (points < 1000) {
            console.warn("API Points Low! Switching to Local Engine.");
            useLocal = true;
        } else if (isContainerRunning) {
            console.log("API Points recovered. Stopping local engine...");
            controlContainer('stop');
        }
    }

    // 2. 外部API試行
    if (!useLocal) {
        try {
            const response = await axios.get(VOICEVOX_API_URL, {
                params: { text, key: VOICEVOX_API_KEY, speaker: speakerId, pitch: 0, intonationScale: 1, speed: 1 },
                responseType: 'stream',
                timeout: 10000
            });
            return response.data;
        } catch (externalError) {
            console.warn('External API Failed. Switching to Local Fallback...', externalError.message);
            useLocal = true;
        }
    }

    // 3. ローカルエンジン（フォールバック）
    if (useLocal) {
        await controlContainer('start');
        try {
            const queryResponse = await axios.post(`${VOICEVOX_LOCAL_URL}/audio_query`, null, { params: { text, speaker: speakerId } });
            const synthesisResponse = await axios.post(`${VOICEVOX_LOCAL_URL}/synthesis`, queryResponse.data, { params: { speaker: speakerId }, responseType: 'stream' });
            return synthesisResponse.data;
        } catch (localError) {
            console.error('Local Fallback Failed:', localError.message);
            throw new Error("TTS Generation Failed on both External and Local engines.");
        }
    }
}

const guildAudioPlayers = new Map();

function getGuildAudioPlayer(guildId) {
    if (!guildAudioPlayers.has(guildId)) {
        const player = createAudioPlayer();
        const state = {
            player: player,
            queue: [], // Array of { resource, resolve, reject }
            isPlaying: false,
            currentItem: null
        };

        player.on(AudioPlayerStatus.Idle, () => {
            // 完了した項目の解決処理
            if (state.currentItem && state.currentItem.resolve) {
                state.currentItem.resolve();
            }
            state.currentItem = null;
            processQueue(guildId);
        });

        player.on('error', (error) => {
            console.error('Audio player error:', error);
            // 失敗した項目の拒否処理
            if (state.currentItem && state.currentItem.reject) {
                state.currentItem.reject(error);
            }
            state.currentItem = null;
            processQueue(guildId);
        });

        guildAudioPlayers.set(guildId, state);
    }
    return guildAudioPlayers.get(guildId);
}

function processQueue(guildId) {
    const state = guildAudioPlayers.get(guildId);
    if (!state) return;

    if (state.queue.length === 0) {
        state.isPlaying = false;
        return;
    }

    state.isPlaying = true;
    const nextItem = state.queue.shift();
    state.currentItem = nextItem;
    state.player.play(nextItem.resource);
}


async function playAudio(guildId, audioStream) {
    const connection = getVoiceConnection(guildId);
    if (!connection) throw new Error("Not connected to a voice channel.");

    const state = getGuildAudioPlayer(guildId);

    // 既にサブスクライブ済みか確認

    if (!connection.state.subscription || connection.state.subscription.player !== state.player) {
        connection.subscribe(state.player);
    }

    const resource = createAudioResource(audioStream);

    return new Promise((resolve, reject) => {
        state.queue.push({
            resource,
            resolve,
            reject
        });

        if (!state.isPlaying) {
            processQueue(guildId);
        }
    });
}

const commands = [
    new SlashCommandBuilder()
        .setName('join')
        .setDescription('Joins your voice channel'),
    new SlashCommandBuilder()
        .setName('leave')
        .setDescription('Leaves the voice channel'),
    new SlashCommandBuilder()
        .setName('speak')
        .setDescription('Speaks the provided text or reads text from an image')
        .addStringOption(option =>
            option.setName('text')
                .setDescription('The text to speak')
                .setRequired(false))
        .addAttachmentOption(option =>
            option.setName('image')
                .setDescription('Image containing text to read')
                .setRequired(false)),
    new SlashCommandBuilder()
        .setName('autoread')
        .setDescription('Toggle auto-read mode for this channel'),
    new SlashCommandBuilder()
        .setName('dict')
        .setDescription('Manage pronunciation dictionary')
        .addSubcommand(subcommand =>
            subcommand
                .setName('add')
                .setDescription('Register a word to the dictionary')
                .addStringOption(option => option.setName('word').setDescription('Word to register').setRequired(true))
                .addStringOption(option => option.setName('reading').setDescription('Pronunciation (Reading)').setRequired(true)))
        .addSubcommand(subcommand =>
            subcommand
                .setName('remove')
                .setDescription('Remove a word from the dictionary')
                .addStringOption(option => option.setName('word').setDescription('Word to remove').setRequired(true)))
        .addSubcommand(subcommand =>
            subcommand
                .setName('list')
                .setDescription('List all registered words')),
].map(command => command.toJSON());

// 辞書ストレージ
const DICT_FILE = path.join(__dirname, 'dictionary.json');
let dictionary = {};

function loadDictionary() {
    try {
        if (fs.existsSync(DICT_FILE)) {
            const data = fs.readFileSync(DICT_FILE, 'utf8');
            dictionary = JSON.parse(data);
        }
    } catch (e) {
        console.error("Failed to load dictionary:", e);
        dictionary = {};
    }
}

function saveDictionary() {
    try {
        fs.writeFileSync(DICT_FILE, JSON.stringify(dictionary, null, 2));
    } catch (e) {
        console.error("Failed to save dictionary:", e);
    }
}

// 辞書適用処理
// 部分一致を防ぐため、長い単語から順に置換
function applyDictionary(text) {
    if (!text) return text;
    let processed = text;

    // 長さ降順でソート
    const keys = Object.keys(dictionary).sort((a, b) => b.length - a.length);

    for (const key of keys) {
        // 正規表現エスケープして置換
        const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(escapedKey, 'g');
        processed = processed.replace(regex, dictionary[key]);
    }
    return processed;
}

// 初期ロード
loadDictionary();

client.once('ready', async () => {
    console.log('Ready!');

    // 起動時の最適化: ポイント確認し、可能ならローカルコンテナを停止
    const pointsData = await checkApiPoints();
    if (pointsData && pointsData.points > 1000) {
        console.log(`Startup: API Points Sufficient (${pointsData.points}). Stopping local engine to save resources.`);
        await controlContainer('stop');
    } else {
        console.log(`Startup: API Points Low or Unknown. Keeping local engine running (or it is already stopped/started state unknown).`);
        // 必要に応じて起動待機処理を入れる
    }

    console.log(`VOICEVOX URL set to: ${VOICEVOX_URL}`);

    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    try {
        console.log('Started refreshing application (/) commands.');
        await rest.put(
            Routes.applicationCommands(client.user.id),
            { body: commands },
        );
        console.log('Successfully reloaded application (/) commands (Global).');

        const guildIds = client.guilds.cache.map(guild => guild.id);
        for (const guildId of guildIds) {
            try {
                // ギルド固有コマンドを削除（グローバルのみ使用）
                await rest.put(
                    Routes.applicationGuildCommands(client.user.id, guildId),
                    { body: [] },
                );
                console.log(`Successfully cleared application (/) commands for guild: ${guildId}`);
            } catch (guildError) {
                console.error(`Failed to clear commands for guild ${guildId}:`, guildError);
            }
        }
    } catch (error) {
        console.error(error);
    }
});

client.on('voiceStateUpdate', async (oldState, newState) => {
    const guildId = oldState.guild.id || newState.guild.id;
    const connection = getVoiceConnection(guildId);

    // If bot is not connected, do nothing (besides maybe cleanup, but connection usage implies active)
    if (!connection) return;

    const botChannelId = connection.joinConfig.channelId;
    if (oldState.channelId === botChannelId) {
        const channel = oldState.channel || oldState.guild.channels.cache.get(oldState.channelId);
        if (channel && channel.members.size === 1 && channel.members.has(client.user.id)) {
            connection.destroy();
            const textChannelId = lastTextChannel.get(guildId);
            if (textChannelId) {
                const textChannel = client.channels.cache.get(textChannelId);
                if (textChannel) {
                    textChannel.send("ボイスチャンネルに誰もいなくなったため、自動退出しました。");
                }
            }
            return;
        }
    }

    if (!autoReadStates.get(guildId)) return;
    if (oldState.member?.user.bot || newState.member?.user.bot) return;

    let notificationText = "";

    // User Joined Bot's Channel
    if (newState.channelId === botChannelId && oldState.channelId !== botChannelId) {
        notificationText = `${newState.member.displayName}さんが入室しました`;
    }
    // User Left Bot's Channel
    else if (oldState.channelId === botChannelId && newState.channelId !== botChannelId) {
        notificationText = `${oldState.member.displayName}さんが退出しました`;
    }

    if (notificationText) {
        try {
            // Check if audio player is idle? 
            // If we just play, it might overlap or cut off current speech. 
            // Ideally we queue, but for now `playAudio` interrupts. Simple is fine for now as per "speak" command behavior.
            const audioStream = await generateVoicevoxAudio(notificationText, SPEAKER_ID);
            await playAudio(guildId, audioStream);
        } catch (error) {
            console.error("Error playing join/leave notification:", error);
        }
    }
});

client.on('messageCreate', async message => {
    if (message.author.bot) return;

    const guildId = message.guild.id;
    const isMention = message.mentions.has(client.user);
    const autoReadState = autoReadStates.get(guildId);
    const isAutoRead = autoReadState || false;

    if (message.content === 'ss' || message.content === 'ｓｓ') {
        const state = getGuildAudioPlayer(guildId);
        state.queue = [];
        if (state.isPlaying) {
            state.player.stop();
        }
        await message.react('⏹️');
        return;
    }

    if (message.content === 's' || message.content === 'ｓ') {
        const state = getGuildAudioPlayer(guildId);
        if (state.isPlaying) {
            state.player.stop();
            await message.react('⏭️');
        }
        return;
    }

    // Ignore messages starting with ;
    if (message.content.startsWith(';') || message.content.startsWith('；')) return;

    if (!isMention && !isAutoRead) return;

    if (isAutoRead && !isMention) {
        const connection = getVoiceConnection(guildId);
        if (!connection || message.channel.id !== connection.joinConfig.channelId) {
            return;
        }
    }

    // チャンネル情報を更新
    lastTextChannel.set(message.guild.id, message.channel.id);

    // メッセージ内容の正規化 (メンション、URL、絵文字、笑いの表現)
    let baseMessageText = message.content
        .replace(/<@!?[0-9]+>/g, '') // Mentions
        .replace(/<a?:.+?:\d+>/g, '') // Custom Emojis (<:name:id> or <a:name:id>)
        .replace(/https?:\/\/\S+/g, '') // URLs
        .replace(/w{3,}/gi, 'www') // Laughter
        .trim();

    // 辞書適用
    baseMessageText = applyDictionary(baseMessageText);

    const speechSegments = [];
    if (baseMessageText) {
        speechSegments.push(baseMessageText);
    }

    let replyText = baseMessageText;
    let processedAnyImage = false;

    // 画像スキャン処理
    if (message.attachments.size > 0) {
        let processingMsg = null;
        if (isMention) {
            processingMsg = await message.reply("画像処理中...");
        }

        try {
            // 全添付ファイルを処理
            for (const [id, attachment] of message.attachments) {
                if (attachment.contentType && attachment.contentType.startsWith('image/')) {

                    try {
                        const result = await processImageAttachment(attachment.url);
                        let segmentText = "";

                        if (isMention) {
                            // メンション時は常に読み上げ
                            if (result.text) {
                                segmentText = result.text;
                            } else {
                                // 失敗時のエラー処理（必要なら）
                            }
                        } else if (isAutoRead) {
                            // 自動読み上げ時
                            if (result.isQuote && result.text) {
                                segmentText = result.text;
                            } else {
                                // Quote以外は「添付ファイル」として処理
                                segmentText = "添付ファイル";
                            }
                        }

                        if (segmentText) {
                            speechSegments.push(segmentText);
                            if (replyText) replyText += "\n";
                            replyText += segmentText;
                            processedAnyImage = true;
                        }

                    } catch (ocrError) {
                        console.error(`OCR Error for attachment ${id}:`, ocrError);
                        if (isAutoRead) {
                            speechSegments.push("添付ファイル");
                            processedAnyImage = true;
                        }
                    }
                }
            }
        } finally {
            if (processingMsg) await processingMsg.delete().catch(() => { });
        }
    }

    if (speechSegments.length === 0) {
        if (isMention && !processedAnyImage) return message.reply("読み上げるテキストか画像を送ってください。");
        return;
    }

    // Auto-join logic
    let connection = getVoiceConnection(message.guild.id);
    if (!connection) {
        if (message.member && message.member.voice.channel) {
            try {
                connection = joinVoiceChannel({
                    channelId: message.member.voice.channel.id,
                    guildId: message.guild.id,
                    adapterCreator: message.guild.voiceAdapterCreator,
                });
            } catch (joinError) {
                if (isMention) return message.reply("エラー: ボイスチャンネルへの参加に失敗しました。");
                return;
            }
        } else {
            if (isMention) return message.reply("ボイスチャンネルに参加してからメンションしてください。");
            return;
        }
    }

    // 自動読み上げの制約確認は冒頭で実行済み

    try {
        // 返信処理 (メンション時)
        if (isMention) {
            // 長すぎる場合は省略
            let finalReply = `文章：${replyText}`;
            if (finalReply.length > 2000) {
                finalReply = finalReply.substring(0, 1997) + "...";
            }
            await message.reply(finalReply);
        }

        // セグメントごとの読み上げキュー登録
        for (const segment of speechSegments) {
            // ローカルVoicevox等の制限に合わせた長さ調整処理（簡略化）
            let text = segment;
            if (text.length > 200) text = text.substring(0, 197) + "...";

            if (text) {
                const audioStream = await generateVoicevoxAudio(text, SPEAKER_ID);
                await playAudio(message.guild.id, audioStream);
            }
        }

    } catch (error) {
        console.error(error);
        if (isMention) message.reply(`エラー: ${error.message}`);
    }
});

client.on('interactionCreate', async interaction => {
    try {
        if (!interaction.isChatInputCommand()) return;
        const { commandName } = interaction;

        // チャンネル追跡
        lastTextChannel.set(interaction.guild.id, interaction.channel.id);

        if (commandName === 'join') {
            const voiceChannel = interaction.member.voice.channel;
            if (!voiceChannel) return interaction.reply({ content: "先にボイスチャンネルに参加してください！", ephemeral: true });
            try {
                joinVoiceChannel({
                    channelId: voiceChannel.id,
                    guildId: voiceChannel.guild.id,
                    adapterCreator: voiceChannel.guild.voiceAdapterCreator,
                });
                // デフォルト: 自動読み上げ OFF
                autoReadStates.set(interaction.guild.id, false);
                await interaction.reply("接続しました！");
            } catch (error) {
                await interaction.reply({ content: "エラーが発生しました: 接続に失敗しました。", ephemeral: true });
            }
        }
        else if (commandName === 'autoread') {
            const currentState = autoReadStates.get(interaction.guild.id) || false;
            const newState = !currentState;
            autoReadStates.set(interaction.guild.id, newState);
            await interaction.reply(`読み上げモードを ${newState ? 'ON' : 'OFF'} にしました。`);
        }
        else if (commandName === 'dict') {
            const sub = interaction.options.getSubcommand();
            if (sub === 'add') {
                const word = interaction.options.getString('word');
                const reading = interaction.options.getString('reading');
                dictionary[word] = reading;
                saveDictionary();
                await interaction.reply(`辞書に登録しました: ${word} -> ${reading}`);
            } else if (sub === 'remove') {
                const word = interaction.options.getString('word');
                if (dictionary[word]) {
                    delete dictionary[word];
                    saveDictionary();
                    await interaction.reply(`辞書から削除しました: ${word}`);
                } else {
                    await interaction.reply(`その単語は登録されていません: ${word}`);
                }
            } else if (sub === 'list') {
                const entries = Object.entries(dictionary).map(([k, v]) => `${k} -> ${v}`);
                if (entries.length === 0) {
                    await interaction.reply({ content: "辞書は空です。", ephemeral: true });
                } else {
                    // 2000文字制限対応（分割）
                    const chunks = [];
                    let currentChunk = "登録単語一覧:\n";
                    for (const entry of entries) {
                        if (currentChunk.length + entry.length + 1 > 1900) {
                            chunks.push(currentChunk);
                            currentChunk = "";
                        }
                        currentChunk += entry + "\n";
                    }
                    chunks.push(currentChunk);

                    await interaction.reply({ content: chunks[0], ephemeral: true });
                    for (let i = 1; i < chunks.length; i++) {
                        await interaction.followUp({ content: chunks[i], ephemeral: true });
                    }
                }
            }
        }
        else if (commandName === 'leave') {
            const connection = getVoiceConnection(interaction.guild.id);
            if (connection) {
                connection.destroy();
                await interaction.reply("切断しました。");
            } else {
                await interaction.reply({ content: "ボイスチャンネルに接続していません。", ephemeral: true });
            }
        }
        else if (commandName === 'speak') {
            if (!interaction.deferred && !interaction.replied) {
                await interaction.deferReply();
            }

            let textToSpeak = interaction.options.getString('text');
            const image = interaction.options.getAttachment('image');
            let isFromImage = false;

            if (image) {
                if (!image.contentType.startsWith('image/')) {
                    return interaction.editReply("添付ファイルが画像ではありません。");
                }
                try {
                    const result = await processImageAttachment(image.url);
                    textToSpeak = result.text;
                    isFromImage = true;
                    if (!textToSpeak) return interaction.editReply("エラーが発生しました: 画像から文字を認識できませんでした。");
                } catch (error) {
                    console.error(error);
                    return interaction.editReply("エラーが発生しました: 画像処理に失敗しました。");
                }
            }

            if (!textToSpeak) {
                return interaction.editReply("読み上げるテキストか画像を指定してください。");
            }

            if (textToSpeak.length > 200) textToSpeak = textToSpeak.substring(0, 197) + "...";

            let connection = getVoiceConnection(interaction.guild.id);
            if (!connection) {
                // 自動参加ロジック
                if (interaction.member && interaction.member.voice.channel) {
                    try {
                        connection = joinVoiceChannel({
                            channelId: interaction.member.voice.channel.id,
                            guildId: interaction.guild.id,
                            adapterCreator: interaction.guild.voiceAdapterCreator,
                        });
                    } catch (joinError) {
                        return interaction.editReply("エラーが発生しました: ボイスチャンネルへの参加に失敗しました。");
                    }
                } else {
                    return interaction.editReply("ボイスチャンネルに参加してから実行してください（または `/join` を使用）。");
                }
            }

            try {
                const replyContent = { content: `文章：${textToSpeak}` };
                if (isFromImage && image) {
                    replyContent.files = [image.url];
                }
                await interaction.editReply(replyContent);

                const audioStream = await generateVoicevoxAudio(textToSpeak, SPEAKER_ID);
                await playAudio(interaction.guild.id, audioStream);

            } catch (error) {
                console.error(error);
                await interaction.editReply(`エラーが発生しました: ${error.message}`);
            }
        }
    } catch (error) {
        console.error('Interaction Error:', error);
        if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({ content: '予期せぬエラーが発生しました。', ephemeral: true }).catch(() => { });
        } else {
            await interaction.followUp({ content: '予期せぬエラーが発生しました。', ephemeral: true }).catch(() => { });
        }
    }
});

client.login(process.env.DISCORD_TOKEN);
