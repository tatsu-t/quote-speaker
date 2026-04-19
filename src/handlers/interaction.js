const { joinVoiceChannel, getVoiceConnection } = require('@discordjs/voice');
const { EmbedBuilder } = require('discord.js');
const { autoReadStates, boundTextChannels, listenChannels, nameReadStates, activeVoiceChannels } = require('../state');
const persist = require('../services/persist');
const { generateAudio } = require('../services/tts');
const { extractTextFromImage } = require('../services/ocr');
const { playAudio } = require('../services/audio');
const dict = require('../services/dictionary');

async function handleInteraction(interaction) {
    if (!interaction.isChatInputCommand()) return;

    const { commandName } = interaction;
    const guildId = interaction.guild.id;

    try {
        if (commandName === 'join') {
            const voiceChannel = interaction.member.voice.channel;
            if (!voiceChannel) {
                return interaction.reply({ content: '先にボイスチャンネルに参加してください。', ephemeral: true });
            }
            joinVoiceChannel({
                channelId: voiceChannel.id,
                guildId: voiceChannel.guild.id,
                adapterCreator: voiceChannel.guild.voiceAdapterCreator,
            });
            autoReadStates.set(guildId, false);
            boundTextChannels.set(guildId, interaction.channel.id);
            activeVoiceChannels.set(guildId, voiceChannel.id);
            persist.save();
            await interaction.reply('接続しました！');
        }

        else if (commandName === 'leave') {
            const connection = getVoiceConnection(guildId);
            if (!connection) {
                return interaction.reply({ content: 'ボイスチャンネルに接続していません。', ephemeral: true });
            }
            connection.destroy();
            boundTextChannels.delete(guildId);
            autoReadStates.delete(guildId);
            activeVoiceChannels.delete(guildId);
            persist.save();
            await interaction.reply('切断しました。');
        }

        else if (commandName === 'autoread') {
            const next = !(autoReadStates.get(guildId) || false);
            autoReadStates.set(guildId, next);
            boundTextChannels.set(guildId, interaction.channel.id);
            persist.save();
            await interaction.reply(`自動読み上げを **${next ? 'ON' : 'OFF'}** にしました。`);
        }

        else if (commandName === 'dict') {
            const sub = interaction.options.getSubcommand();
            if (sub === 'add') {
                const word = interaction.options.getString('word');
                const reading = interaction.options.getString('reading');
                dict.add(word, reading);
                await interaction.reply(`辞書に登録しました: ${word} → ${reading}`);
            } else if (sub === 'remove') {
                const word = interaction.options.getString('word');
                if (dict.remove(word)) {
                    await interaction.reply(`辞書から削除しました: ${word}`);
                } else {
                    await interaction.reply({ content: `その単語は登録されていません: ${word}`, ephemeral: true });
                }
            } else if (sub === 'list') {
                const entries = dict.list();
                if (entries.length === 0) {
                    return interaction.reply({ content: '辞書は空です。', ephemeral: true });
                }
                const chunks = [];
                let chunk = '登録単語一覧:\n';
                for (const entry of entries) {
                    if (chunk.length + entry.length + 1 > 1900) { chunks.push(chunk); chunk = ''; }
                    chunk += entry + '\n';
                }
                if (chunk) chunks.push(chunk);
                await interaction.reply({ content: chunks[0], ephemeral: true });
                for (let i = 1; i < chunks.length; i++) {
                    await interaction.followUp({ content: chunks[i], ephemeral: true });
                }
            }
        }

        else if (commandName === 'name') {
            const next = !(nameReadStates.get(guildId) || false);
            nameReadStates.set(guildId, next);
            persist.save();
            await interaction.reply(`Quote画像の発言者名読み上げを **${next ? 'ON' : 'OFF'}** にしました。`);
        }

        else if (commandName === 'kikisen') {
            const current = listenChannels.get(guildId);
            if (current === interaction.channel.id) {
                listenChannels.delete(guildId);
                persist.save();
                await interaction.reply('このチャンネルの聞き専設定を解除しました。');
            } else {
                listenChannels.set(guildId, interaction.channel.id);
                persist.save();
                await interaction.reply('このチャンネルを聞き専チャンネルに設定しました。');
            }
        }

        else if (commandName === 'ping') {
            const sent = await interaction.reply({ content: 'Pinging...', fetchReply: true });
            const latency = sent.createdTimestamp - interaction.createdTimestamp;
            await interaction.editReply({
                content: '',
                embeds: [new EmbedBuilder().setColor(0x0099FF).setTitle('Pong!').setDescription(`${latency}ms`)],
            });
        }

        else if (commandName === 'speak') {
            await interaction.deferReply();

            let text = interaction.options.getString('text');
            const image = interaction.options.getAttachment('image');

            if (image) {
                if (!image.contentType?.startsWith('image/')) {
                    return interaction.editReply('添付ファイルが画像ではありません。');
                }
                const result = await extractTextFromImage(image.url);
                text = result.text;
                if (!text) return interaction.editReply('画像からテキストを認識できませんでした。');
            }

            if (!text) return interaction.editReply('読み上げるテキストか画像を指定してください。');

            text = dict.apply(text);
            if (text.length > 200) text = text.substring(0, 197) + '...';

            let connection = getVoiceConnection(guildId);
            if (!connection) {
                const voiceChannel = interaction.member.voice.channel;
                if (!voiceChannel) {
                    return interaction.editReply('ボイスチャンネルに参加してから実行してください（または `/join` を使用）。');
                }
                connection = joinVoiceChannel({
                    channelId: voiceChannel.id,
                    guildId: interaction.guild.id,
                    adapterCreator: interaction.guild.voiceAdapterCreator,
                });
                boundTextChannels.set(guildId, interaction.channel.id);
                activeVoiceChannels.set(guildId, voiceChannel.id);
                persist.save();
            }

            await interaction.editReply(`文章：${text}`);
            const audio = await generateAudio(text);
            await playAudio(guildId, audio);
        }

    } catch (err) {
        console.error(`コマンドエラー [${commandName}]:`, err);
        const reply = { content: 'エラーが発生しました。', ephemeral: true };
        if (interaction.deferred || interaction.replied) {
            await interaction.followUp(reply).catch(() => {});
        } else {
            await interaction.reply(reply).catch(() => {});
        }
    }
}

module.exports = { handleInteraction };
