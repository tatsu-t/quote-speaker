const { joinVoiceChannel, getVoiceConnection } = require('@discordjs/voice');
const { autoReadStates, boundTextChannels, listenChannels, nameReadStates, activeVoiceChannels, voiceSpeakers } = require('../state');
const persist = require('../services/persist');
const { generateAudio, DEFAULT_SPEAKER } = require('../services/tts');
const { extractTextFromImage } = require('../services/ocr');
const { playAudio, skipCurrent, clearQueue } = require('../services/audio');
const dict = require('../services/dictionary');

const URL_REGEX = /https?:\/\/\S+/g;
const DISCORD_MAX = 2000;

function splitChunks(text) {
    const chunks = [];
    while (text.length > 0) {
        chunks.push(text.slice(0, DISCORD_MAX));
        text = text.slice(DISCORD_MAX);
    }
    return chunks;
}

// processingMsg を編集、2000字超えなら削除してリプライ分割送信
async function editOrReplyChunked(processingMsg, message, text) {
    const chunks = splitChunks(text);
    if (chunks.length === 1) {
        await processingMsg.edit(chunks[0]);
    } else {
        await processingMsg.delete().catch(() => {});
        await message.reply(chunks[0]);
        for (let i = 1; i < chunks.length; i++) {
            await message.channel.send(chunks[i]);
        }
    }
}

// リプライ＋追加チャンク送信
async function replyChunked(message, text) {
    const chunks = splitChunks(text);
    await message.reply(chunks[0]);
    for (let i = 1; i < chunks.length; i++) {
        await message.channel.send(chunks[i]);
    }
}

async function handleMessage(client, message) {
    if (message.author.bot || !message.guild) return;

    const guildId = message.guild.id;

    // s / ss コマンド
    if (message.content === 's' || message.content === 'ｓ') {
        if (skipCurrent(guildId)) await message.react('⏭️');
        return;
    }
    if (message.content === 'ss' || message.content === 'ｓｓ') {
        clearQueue(guildId);
        await message.react('⏹️');
        return;
    }

    // メンション・リプライ判定
    const isDirectMention = message.mentions.users.has(client.user.id)
        && !message.mentions.everyone
        && message.mentions.roles.size === 0;

    let isReplyToBot = false;
    if (message.reference?.messageId) {
        try {
            const ref = await message.channel.messages.fetch(message.reference.messageId);
            isReplyToBot = ref.author.id === client.user.id;
        } catch {}
    }

    const isTargeted = isDirectMention || isReplyToBot;
    const isAutoRead = autoReadStates.get(guildId) || false;
    const nameRead = nameReadStates.get(guildId) || false;
    const connection = getVoiceConnection(guildId);

    // VC相当コンテキスト判定（VC本体 or 聞き専チャンネル）
    const botChannelId = connection?.joinConfig.channelId;
    const listenChannelId = listenChannels.get(guildId);
    const isInVCContext = !!connection && (
        message.channel.id === botChannelId ||
        message.channel.id === listenChannelId
    );

    // 画像の有無チェック
    const urls = message.content.match(URL_REGEX) || [];
    const hasAttachments = message.attachments.size > 0;
    const hasImageUrls = urls.some(u => /\.(png|jpg|jpeg|gif|webp)(\?.*)?$/i.test(u) || u.includes('quote.tksaba.com'));
    const hasEmbeds = message.embeds.some(e => e.image || e.thumbnail);
    const hasEvaluationTargets = hasAttachments || hasEmbeds || hasImageUrls;

    // ターゲットでない場合のフィルタ
    if (!isTargeted) {
        if (!connection) return;
        const boundChannelId = boundTextChannels.get(guildId);
        const isFromVCContext = message.channel.id === botChannelId || message.channel.id === listenChannelId;

        // VCコンテキスト（VC本体 or 聞き専）からの画像 or autoreadテキストはバインドチャンネル制限を無視して通す
        if (boundChannelId && message.channel.id !== boundChannelId && !(isFromVCContext && (hasEvaluationTargets || isAutoRead))) return;
        if (!isAutoRead && !hasEvaluationTargets) return;
    }

    // --- OCRテキスト返信 + VC接続時はTTS ---
    // リプライ先の画像をOCR
    if (isTargeted && message.reference?.messageId) {
        try {
            const ref = await message.channel.messages.fetch(message.reference.messageId);
            if (ref.attachments.size > 0) {
                const processingMsg = await message.reply('画像を読み取っています...');
                const { text } = await extractTextFromImage(ref.attachments.first().url);
                await editOrReplyChunked(processingMsg, message, text ? `OCR結果:\n${text}` : '文字を検出できませんでした。');
                // VC接続中なら読み上げも行う
                if (text && connection) {
                    try {
                        const speakerId = voiceSpeakers.get(guildId) || DEFAULT_SPEAKER;
                        let ttsText = text;
                        if (ttsText.length > 200) ttsText = ttsText.substring(0, 197) + '...';
                        const audio = await generateAudio(ttsText, speakerId);
                        await playAudio(guildId, audio);
                    } catch (err) {
                        console.error('OCR TTS再生エラー:', err.message);
                    }
                }
                return;
            }
        } catch (err) {
            console.error('リプライOCRエラー:', err.message);
        }
    }

    // VC外からのメンション + 画像 → テキスト返信のみ
    if (isTargeted && !isInVCContext && message.attachments.size > 0) {
        const processingMsg = await message.reply('画像を読み取っています...');
        try {
            const { text } = await extractTextFromImage(message.attachments.first().url);
            await editOrReplyChunked(processingMsg, message, text ? `OCR結果:\n${text}` : '文字を検出できませんでした。');
        } catch {
            await processingMsg.edit('エラーが発生しました。');
        }
        return;
    }

    // --- TTS / テキスト返信処理 ---
    let baseText = message.content
        .replace(/<@!?[0-9]+>/g, '')      // メンション除去
        .replace(/<a?:.+?:\d+>/g, '')      // カスタム絵文字除去
        .replace(URL_REGEX, '')             // URL除去
        .replace(/w{3,}/gi, 'www')          // 笑い正規化
        .trim();
    baseText = dict.apply(guildId, baseText);

    const segments = [];
    if (baseText && (isTargeted || isAutoRead)) {
        segments.push(baseText);
    }

    // 画像URL収集（重複排除）
    const imageUrls = new Set();
    for (const [, att] of message.attachments) {
        if (att.contentType?.startsWith('image/')) imageUrls.add(att.url);
    }
    for (const url of urls) {
        if (/\.(png|jpg|jpeg|gif|webp)(\?.*)?$/i.test(url) || url.includes('quote.tksaba.com')) {
            imageUrls.add(url);
        }
    }
    for (const embed of message.embeds) {
        if (embed.image) imageUrls.add(embed.image.url);
        else if (embed.thumbnail) imageUrls.add(embed.thumbnail.url);
    }

    // 画像処理
    if (imageUrls.size > 0) {
        let processingMsg = null;
        if (isTargeted) processingMsg = await message.reply('画像処理中...');
        try {
            for (const url of imageUrls) {
                try {
                    const { text, isQuote, speakerName } = await extractTextFromImage(url);
                    if (!text) continue;

                    // nameRead ON かつ Quote画像でスピーカー名あり → 名前を先頭に付加
                    const quoteText = (nameRead && isQuote && speakerName)
                        ? `${speakerName}。${text}`
                        : text;

                    if (isTargeted) {
                        segments.push(quoteText);
                    } else if (isQuote) {
                        // Quote画像は autoread OFF でも読み上げる
                        segments.push(quoteText);
                    } else if (isAutoRead) {
                        segments.push('添付ファイル');
                    }
                } catch (err) {
                    console.error('OCRエラー:', err.message);
                    if (isAutoRead) segments.push('添付ファイル');
                }
            }
        } finally {
            await processingMsg?.delete().catch(() => {});
        }
    }

    if (segments.length === 0) {
        if (isTargeted) await message.reply('読み上げるテキストか画像を送ってください。');
        return;
    }

    // VC外からのメンション → テキスト返信のみ（TTS不要）
    if (isTargeted && !isInVCContext) {
        await replyChunked(message, `文章：${segments.join(' / ')}`);
        return;
    }

    // VC接続（未接続なら自動参加）
    let conn = getVoiceConnection(guildId);
    if (!conn) {
        if (message.member?.voice.channel) {
            try {
                const vcId = message.member.voice.channel.id;
                conn = joinVoiceChannel({
                    channelId: vcId,
                    guildId: message.guild.id,
                    adapterCreator: message.guild.voiceAdapterCreator,
                });
                activeVoiceChannels.set(guildId, vcId);
                persist.save();
            } catch {
                if (isTargeted) await message.reply('エラー: ボイスチャンネルへの参加に失敗しました。');
                return;
            }
        } else {
            if (isTargeted) await message.reply('ボイスチャンネルに参加してからメンションしてください。');
            return;
        }
    }

    try {
        if (isTargeted) {
            await replyChunked(message, `文章：${segments.join(' / ')}`);
        }

        const speakerId = voiceSpeakers.get(guildId) || DEFAULT_SPEAKER;
        for (let text of segments) {
            if (text.length > 200) text = text.substring(0, 197) + '...';
            const audio = await generateAudio(text, speakerId);
            await playAudio(guildId, audio);
        }
    } catch (err) {
        console.error('TTS/再生エラー:', err.message);
        if (isTargeted) await message.reply(`エラー: ${err.message}`);
    }
}

module.exports = { handleMessage };
