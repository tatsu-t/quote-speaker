require('dotenv').config();
const { Client, GatewayIntentBits, SlashCommandBuilder, Routes, REST, EmbedBuilder } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, VoiceConnectionStatus, entersState, getVoiceConnection } = require('@discordjs/voice');
const axios = require('axios');
const { Readable } = require('stream');
const fs = require('fs');
const path = require('path');

// Configuration
const VOICEVOX_URL = process.env.VOICEVOX_URL || 'http://voicevox:50021';
const GOOGLE_VISION_API_KEY = process.env.GOOGLE_VISION_API_KEY;
// Speaker ID 3 is Zundamon (Normal style).
const SPEAKER_ID = 3;

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

// Track the last active text channel for each guild to send auto-leave notifications
const lastTextChannel = new Map();
const boundTextChannels = new Map(); // Track channel where session started (join/autoread)
// Track auto-read mode state for each guild (Default: OFF)
const autoReadStates = new Map();



// Helper to clean OCR text
function cleanOCRText(text) {
    if (!text) return "";

    // Basic normalization
    let combinedText = text.trim();

    // Remove zero-width spaces
    combinedText = combinedText.replace(/[\u200B-\u200D\uFEFF]/g, '');

    // Remove URLs
    combinedText = combinedText.replace(/https?:\/\/\S+/g, '');

    // OCR Correction: Common katakana/kanji misreads (Generic)
    combinedText = combinedText.replace(/([^\x00-\x7F])かルー/g, '$1から');
    combinedText = combinedText.replace(/([^\x00-\x7F])かル/g, '$1から');
    combinedText = combinedText.replace(/でルー/g, 'で');

    // Normalize repeated 'w' (laughter) to 'www'
    combinedText = combinedText.replace(/w{3,}/gi, 'www');

    // OCR Fix: Leading noise (e.g. '0', '°' from illustrations)
    combinedText = combinedText.replace(/^[0°]+/, '');

    // OCR Fix: Specific misread of "男" (Male) as "0"
    // Case 1: "0だから" -> "男だから"
    combinedText = combinedText.replace(/0だから/g, '男だから');

    // OCR Fix: Heart symbol (♡) misread as "く" (Hiragana Ku)
    // Context: "さーんく" -> "さーん♡" (San-Ku -> San-Heart)
    combinedText = combinedText.replace(/さーんく/g, 'さーん♡');
    // Generic: "Hiragana + Long Vowel + N + Ku" (e.g. 〜ーんく) -> Assume Heart
    combinedText = combinedText.replace(/([ぁ-ん])ーんく/g, '$1ーん♡');

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
        // The first annotation is the full text, subsequent ones are individual words
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

        // Check if image is a "Quote" image based on branding text
        const fullText = annotations[0].description;
        const isQuoteImage = /Make\s*it\s*a\s*Quote|Quote\s*Maker|Fake\s*Quote\s*Maker/i.test(fullText);
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

            // 3. Left Exclusion (Illustration noise) - Exclude left 10%
            // Handles cases where text on illustrations (left side) is picked up.
            const midX = (Math.min(...word.boundingPoly.vertices.map(v => v.x || 0)) + Math.max(...word.boundingPoly.vertices.map(v => v.x || 0))) / 2;
            if (midX < imgWidth * 0.10) return false;

            return true;
        });

        // Robust Sorting: Group by line (Y-axis), then sort by X-axis
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

        // Group into lines
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

        // Filter lines based on content rules
        let validLines = [];
        const getLineText = (line) => line.map(w => w.description).join('');

        for (let i = 0; i < lines.length; i++) {
            const lineText = getLineText(lines[i]);

            if (isQuoteImage) {
                // Rule A: Drop branding
                if (/Make[ \t]*it[ \t]*a[ \t]*Quote/i.test(lineText)) continue;
                if (/Quote[ \t]*Maker/i.test(lineText)) continue;
                if (/Fake[ \t]*Quote[ \t]*Maker/i.test(lineText)) continue;
                if (/^\(Fake\)$/i.test(lineText.trim())) continue;

                // Rule B: Drop lines starting with specific signature chars
                if (/^[-—|]/.test(lineText)) continue;

                // Rule C: Drop lines starting with @ (Handle)
                if (/^@/.test(lineText)) continue;

                // Rule D: Drop line if NEXT line starts with @ (Display Name check)
                // Assumes display name is relatively short.
                if (i < lines.length - 1) {
                    const nextLineText = getLineText(lines[i + 1]);
                    if (/^@/.test(nextLineText)) {
                        if (lineText.length < 30) continue;
                    }
                }
            }

            validLines.push(lineText);
        }

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

// External VOICEVOX API Configuration (Primary)
const VOICEVOX_API_URL = 'https://deprecatedapis.tts.quest/v2/voicevox/audio/';
const VOICEVOX_POINTS_URL = 'https://deprecatedapis.tts.quest/v2/api/';
const VOICEVOX_API_KEY = process.env.VOICEVOX_API_KEY || 'R1y2664_8-0-h_9';

// Local VOICEVOX Engine Configuration (Fallback)
const VOICEVOX_LOCAL_URL = process.env.VOICEVOX_URL || 'http://voicevox:50021';
const VOICEVOX_CONTAINER_NAME = 'quotespeak-voicevox-1';
const DOCKER_SOCKET_PATH = '/var/run/docker.sock';

// State Tracking
let isContainerRunning = true; // Assume running at start until checked/stopped

// Check API Points
async function checkApiPoints() {
    try {
        const response = await axios.get(VOICEVOX_POINTS_URL, {
            params: { key: VOICEVOX_API_KEY }
        });
        return response.data; // { points: number, resetInHours: number }
    } catch (error) {
        console.error('Failed to check API points:', error.message);
        return null; // Assume checking failed but maybe service is up
    }
}

// Control Docker Container (Start/Stop)
async function controlContainer(action) {
    if (action !== 'start' && action !== 'stop') return;

    // Optimization: Skip if already in desired state (based on local flag)
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
        // Ignore "Not Modified" (304) implies already in desired state
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

    // 1. Check Points Strategy
    const pointsData = await checkApiPoints();
    if (pointsData) {
        points = pointsData.points;
        console.log(`Current API Points: ${points}`);
        if (points < 1000) { // Threshold for low points
            console.warn("API Points Low! Switching to Local Engine.");
            useLocal = true;
        } else {
            // Requirement: Auto-switch back implies stopping local to save resources
            if (isContainerRunning) {
                console.log("API Points recovered. Stopping local engine to save resources...");
                controlContainer('stop'); // Fire and forget or await? Safer to await or let it happen
                // To avoid latency, we can not await, but sticking to await for safety
            }
        }
    }

    // 2. Try External API (if points sufficient)
    if (!useLocal) {
        try {
            const response = await axios.get(VOICEVOX_API_URL, {
                params: {
                    text: text,
                    key: VOICEVOX_API_KEY,
                    speaker: speakerId,
                    pitch: 0,
                    intonationScale: 1,
                    speed: 1
                },
                responseType: 'stream',
                timeout: 10000
            });
            return response.data;
        } catch (externalError) {
            console.warn('External API Failed (Error or Points run out). Switching to Local Fallback...', externalError.message);
            useLocal = true;
        }
    }

    // 3. Local Engine Fallback
    if (useLocal) {
        // Ensure container is running
        await controlContainer('start');

        try {
            // Step 1: Query
            const queryResponse = await axios.post(
                `${VOICEVOX_LOCAL_URL}/audio_query`,
                null,
                { params: { text: text, speaker: speakerId } }
            );
            const audioQuery = queryResponse.data;

            // Step 2: Synthesis
            const synthesisResponse = await axios.post(
                `${VOICEVOX_LOCAL_URL}/synthesis`,
                audioQuery,
                {
                    params: { speaker: speakerId },
                    responseType: 'stream'
                }
            );
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
            // Resolve the finished item
            if (state.currentItem && state.currentItem.resolve) {
                state.currentItem.resolve();
            }
            state.currentItem = null;
            processQueue(guildId);
        });

        player.on('error', (error) => {
            console.error('Audio player error:', error);
            // Reject the failed item
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

    // Subscribe if not already subscribed (or re-subscribe to ensure link)
    // Checking subscription.player is tricky, safer to just subscribe always? 
    // Or check connection.state.subscription.
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
    new SlashCommandBuilder()
        .setName('ping')
        .setDescription('Replies with Pong and latency info'),
].map(command => command.toJSON());

// Dictionary Storage
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

// Apply dictionary replacements
// Priority: Longer words first to avoid partial replacements of substrings
function applyDictionary(text) {
    if (!text) return text;
    let processed = text;

    // Sort keys by length descending to match longest first
    const keys = Object.keys(dictionary).sort((a, b) => b.length - a.length);

    for (const key of keys) {
        // Simple global replacement. 
        // Escaping regex special characters in key is important.
        const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(escapedKey, 'g');
        processed = processed.replace(regex, dictionary[key]);
    }
    return processed;
}

// Initial Load
loadDictionary();

client.once('ready', async () => {
    console.log('Ready!');

    // Startup Optimization: Check API points and stop local container if feasible
    const pointsData = await checkApiPoints();
    if (pointsData && pointsData.points > 1000) {
        console.log(`Startup: API Points Sufficient (${pointsData.points}). Stopping local engine to save resources.`);
        await controlContainer('stop');
    } else {
        console.log(`Startup: API Points Low or Unknown. Keeping local engine running (or it is already stopped/started state unknown).`);
        // Optionally ensure start if low?
        // await controlContainer('start');
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
                // Clear guild-specific commands to prevent duplicates (Use Global only)
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

    // 1. Auto-Disconnect Logic (Existing)
    if (oldState.channelId === botChannelId) {
        const channel = oldState.channel || oldState.guild.channels.cache.get(oldState.channelId);
        // If bot is the only one left
        if (channel && channel.members.size === 1 && channel.members.has(client.user.id)) {
            const textChannelId = boundTextChannels.get(guildId) || botChannelId;
            connection.destroy();
            boundTextChannels.delete(guildId); // Cleanup
            if (textChannelId) {
                const textChannel = client.channels.cache.get(textChannelId);
                if (textChannel) {
                    textChannel.send("ボイスチャンネルに誰もいなくなったため、自動退出しました。");
                }
            }
            return; // Exit as bot has left
        }
    }

    // 2. Join/Leave Notifications
    // Only if Auto-Read is ON
    if (!autoReadStates.get(guildId)) return;

    // Ignore bot's own moves (though bot is excluded by 'if (member.user.bot)' checks usually, let's be safe)
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

    // Strict Target Check
    // 1. Ignore @everyone and @here
    if (message.mentions.everyone) return;

    // 2. Check for Direct Mention (User Mention Only)
    const isDirectMention = message.mentions.users.has(client.user.id) && !message.mentions.everyone && message.mentions.roles.size === 0;

    // 3. Check for Reply to Bot
    let isReplyToBot = false;
    if (message.reference && message.reference.messageId) {
        try {
            const referencedMsg = await message.channel.messages.fetch(message.reference.messageId);
            if (referencedMsg.author.id === client.user.id) {
                isReplyToBot = true;
            }
        } catch (e) {
            // Ignore fetch error
        }
    }

    const isTargeted = isDirectMention || isReplyToBot;
    const autoReadState = autoReadStates.get(guildId);
    const isAutoRead = autoReadState || false;

    // Check specific commands first (Skip 's', Stop All 'ss')
    if (message.content === 'ss' || message.content === 'ｓｓ') {
        const state = getGuildAudioPlayer(guildId);
        // Clear entire queue
        state.queue = [];
        // Stop current playback
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

    // Extract URLs early to check for images
    const urlRegex = /https?:\/\/\S+/g;
    const urls = message.content.match(urlRegex) || [];

    // Check for potential images
    const hasAttachments = message.attachments.size > 0;
    const hasEmbeds = message.embeds.length > 0;
    const hasImageUrls = urls.some(url => /\.(png|jpg|jpeg|gif|webp)(\?.*)?$/i.test(url) || url.includes('quote.tksaba.com'));
    const hasEvaluationTargets = hasAttachments || hasEmbeds || hasImageUrls;

    let connection = getVoiceConnection(guildId);

    // Filter Logic:
    // If NOT targeted (i.e. AutoRead or Quote detection):
    // 1. Must have a Voice Connection.
    // 2. Must be in the Bound Text Channel.
    // 3. If AutoRead is OFF, must have potential images (Quote check).
    if (!isTargeted) {
        if (!connection) return;

        const boundChannelId = boundTextChannels.get(guildId);
        if (boundChannelId && message.channel.id !== boundChannelId) return;

        if (!isAutoRead && !hasEvaluationTargets) return;
    }

    let botChannelId = null;
    if (connection) {
        botChannelId = connection.joinConfig.channelId;
    }

    // --- Special OCR Logic (Text Reply Only, No TTS) ---
    if (isTargeted) {
        // Case A: Reply to an image (OCR the referenced image)
        if (message.reference && message.reference.messageId) {
            try {
                const referencedMsg = await message.channel.messages.fetch(message.reference.messageId);
                if (referencedMsg.attachments.size > 0) {
                    const imageUrl = referencedMsg.attachments.first().url;
                    // Initial reply to indicate processing
                    const processingMsg = await message.reply('画像を読み取っています...');

                    const { text } = await processImageAttachment(imageUrl);

                    // Edit reply with result
                    if (text) {
                        await processingMsg.edit(`OCR結果:\n${text}`);
                    } else {
                        await processingMsg.edit('文字を検出できませんでした。');
                    }
                    return; // Stop processing (No TTS)
                }
            } catch (err) {
                console.error("Error fetching referenced message:", err);
            }
        }

        // Case B: Mention outside of VC with image (OCR the attached image)
        const isOutsideVC = !connection || (botChannelId && message.channel.id !== botChannelId);
        if (isOutsideVC && message.attachments.size > 0) {
            const imageUrl = message.attachments.first().url;
            const processingMsg = await message.reply('画像を読み取っています...');

            try {
                const { text } = await processImageAttachment(imageUrl);
                if (text) {
                    await processingMsg.edit(`OCR結果:\n${text}`);
                } else {
                    await processingMsg.edit('文字を検出できませんでした。');
                }
            } catch (err) {
                console.error("Error processing text-only OCR:", err);
                await processingMsg.edit('エラーが発生しました。');
            }
            return; // Stop processing (No TTS)
        }
    }

    // Strict VC Check for Auto-Read (Existing Logic)
    // Requirement Update: Only read messages sent IN the Voice Channel (Text-in-Voice)
    // Ignore messages from other text channels
    if (isAutoRead && !isMention) {
        if (!connection) return; // Bot not connected

        // Check if the MESSAGE was sent in the BOT'S Voice Channel
        if (message.channel.id !== botChannelId) {
            return; // Message is from #general or other text channel -> Ignore
        }
    }

    // Track channel
    lastTextChannel.set(message.guild.id, message.channel.id);

    let contentToSpeak = "";
    // Initialize with message content (stripped of mentions, URLs, custom emojis, and normalize repeated 'w')
    let baseMessageText = message.content
        .replace(/<@!?[0-9]+>/g, '') // Mentions
        .replace(/<a?:.+?:\d+>/g, '') // Custom Emojis (<:name:id> or <a:name:id>)
        .replace(urlRegex, '') // Apply the regex defined earlier
        .replace(/w{3,}/gi, 'www') // Laughter
        .trim();

    // Apply Dictionary
    baseMessageText = applyDictionary(baseMessageText);

    const speechSegments = [];
    // Only speak text if Targeted or AutoRead is ON
    if (baseMessageText && (isMention || isAutoRead)) {
        speechSegments.push(baseMessageText);
    }

    let replyText = baseMessageText;
    let processedAnyImage = false;

    // --- Image Processing ---
    const uniqueImageUrls = new Set();

    // 1. Attachments
    if (message.attachments.size > 0) {
        for (const [id, attachment] of message.attachments) {
            if (attachment.contentType && attachment.contentType.startsWith('image/')) {
                uniqueImageUrls.add(attachment.url);
            }
        }
    }

    // 2. Embeds / URLs
    if (urls.length > 0) {
        for (const url of urls) {
            // Simple check: strict image extensions or known generator domains
            if (/\.(png|jpg|jpeg|gif|webp)(\?.*)?$/i.test(url) || url.includes('quote.tksaba.com')) {
                uniqueImageUrls.add(url);
            }
        }
    }

    // 3. Discord Embeds (if present immediately)
    if (message.embeds.length > 0) {
        for (const embed of message.embeds) {
            if (embed.image) uniqueImageUrls.add(embed.image.url);
            else if (embed.thumbnail) uniqueImageUrls.add(embed.thumbnail.url);
        }
    }

    const imagesToProcess = Array.from(uniqueImageUrls);

    if (imagesToProcess.length > 0) {
        let processingMsg = null;
        if (isTargeted) {
            processingMsg = await message.reply("画像処理中...");
        }

        try {
            for (const imageUrl of imagesToProcess) {
                try {
                    const result = await processImageAttachment(imageUrl);
                    let segmentText = "";

                    if (isTargeted) {
                        if (result.text) {
                            segmentText = result.text;
                        } else {
                            // OCR failed but mentioned
                        }
                    } else {
                        // Auto-Read or "Quote Override" (Even if AutoRead is OFF)
                        if (result.isQuote && result.text) {
                            segmentText = result.text; // Always read quotes if in VC
                        } else if (isAutoRead) {
                            segmentText = "添付ファイル"; // Auto-read non-quotes
                        }
                    }

                    if (segmentText) {
                        speechSegments.push(segmentText);
                        if (replyText) replyText += "\n";
                        replyText += segmentText;
                        processedAnyImage = true;
                    }

                } catch (ocrError) {
                    console.error(`OCR Error for image ${imageUrl}:`, ocrError);
                    if (isAutoRead) {
                        speechSegments.push("添付ファイル");
                        processedAnyImage = true;
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
    // connection variable already declared at top
    connection = getVoiceConnection(message.guild.id);
    if (!connection) {
        if (message.member && message.member.voice.channel) {
            try {
                connection = joinVoiceChannel({
                    channelId: message.member.voice.channel.id,
                    guildId: message.guild.id,
                    adapterCreator: message.guild.voiceAdapterCreator,
                });
            } catch (joinError) {
                if (isTargeted) return message.reply("エラー: ボイスチャンネルへの参加に失敗しました。");
                return;
            }
        } else {
            if (isTargeted) return message.reply("ボイスチャンネルに参加してからメンションしてください。");
            return;
        }
    }

    // Auto-read constraint: Check if user is in the SAME voice channel (Already checked at top, but verify connection exists for play)
    // If bot disconnected mid-process, playAudio will throw error, which is caught.

    try {
        // Reply FIRST (if mention)
        if (isTargeted) {
            // Truncate reply if too long
            let finalReply = `文章：${replyText}`;
            if (finalReply.length > 2000) {
                finalReply = finalReply.substring(0, 1997) + "...";
            }
            await message.reply(finalReply);
        }

        // Queue all segments
        for (const segment of speechSegments) {
            // Further truncate individual segments for TTS limit if needed? (VOICEVOX has limits but let's assume reasonable chunks)
            // Normalizing length for TTS call
            let text = segment;
            if (text.length > 200) text = text.substring(0, 197) + "...";

            if (text) {
                const audioStream = await generateVoicevoxAudio(text, SPEAKER_ID);
                await playAudio(message.guild.id, audioStream);
            }
        }

    } catch (error) {
        console.error(error);
        if (isTargeted) message.reply(`エラー: ${error.message}`);
    }
});

client.on('interactionCreate', async interaction => {
    try {
        if (!interaction.isChatInputCommand()) return;
        const { commandName } = interaction;

        // Track channel
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
                // Default: Auto-read OFF
                autoReadStates.set(interaction.guild.id, false);
                boundTextChannels.set(interaction.guild.id, interaction.channel.id); // Bind to this channel
                await interaction.reply("接続しました！");
            } catch (error) {
                await interaction.reply({ content: "エラーが発生しました: 接続に失敗しました。", ephemeral: true });
            }
        }
        else if (commandName === 'autoread') {
            const currentState = autoReadStates.get(interaction.guild.id) || false;
            const newState = !currentState;
            autoReadStates.set(interaction.guild.id, newState);
            boundTextChannels.set(interaction.guild.id, interaction.channel.id); // Bind on autoread toggle
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
                    const chunks = [];
                    let currentChunk = "登録単語一覧:\n";
                    for (const entry of entries) {
                        if (currentChunk.length + entry.length + 1 > 1900) {
                            chunks.push(currentChunk);
                            currentChunk = "";
                        }
                        currentChunk += entry + "\n";
                    }
                    if (currentChunk) chunks.push(currentChunk);

                    await interaction.reply({ content: chunks[0], ephemeral: true });
                    for (let i = 1; i < chunks.length; i++) {
                        await interaction.followUp({ content: chunks[i], ephemeral: true });
                    }
                }
            }
        }
        else if (commandName === 'ping') {
            const sent = await interaction.reply({ content: 'Pinging...', fetchReply: true });
            const latency = sent.createdTimestamp - interaction.createdTimestamp;

            const embed = new EmbedBuilder()
                .setColor(0x0099FF)
                .setTitle('Pong! 🏓')
                .setDescription(`${latency}ms`);

            await interaction.editReply({ content: '', embeds: [embed] });
        }
        else if (commandName === 'leave') {
            const connection = getVoiceConnection(interaction.guild.id);
            if (connection) {
                connection.destroy();
                boundTextChannels.delete(interaction.guild.id);
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
                // Auto-join logic
                if (interaction.member && interaction.member.voice.channel) {
                    try {
                        connection = joinVoiceChannel({
                            channelId: interaction.member.voice.channel.id,
                            guildId: interaction.guild.id,
                            adapterCreator: interaction.guild.voiceAdapterCreator,
                        });
                        boundTextChannels.set(interaction.guild.id, interaction.channel.id); // Bind on auto-join
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
