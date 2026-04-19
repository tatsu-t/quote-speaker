const { SlashCommandBuilder, Routes, REST } = require('discord.js');

const commands = [
    new SlashCommandBuilder()
        .setName('join')
        .setDescription('ボイスチャンネルに参加します'),
    new SlashCommandBuilder()
        .setName('leave')
        .setDescription('ボイスチャンネルから退出します'),
    new SlashCommandBuilder()
        .setName('speak')
        .setDescription('テキストまたは画像を読み上げます')
        .addStringOption(opt =>
            opt.setName('text').setDescription('読み上げるテキスト').setRequired(false))
        .addAttachmentOption(opt =>
            opt.setName('image').setDescription('テキストを読み取る画像').setRequired(false)),
    new SlashCommandBuilder()
        .setName('autoread')
        .setDescription('自動読み上げモードの設定/解除/確認')
        .addStringOption(opt =>
            opt.setName('mode').setDescription('on/off')
                .addChoices({ name: 'on', value: 'on' }, { name: 'off', value: 'off' })
                .setRequired(false)),
    new SlashCommandBuilder()
        .setName('dict')
        .setDescription('読み上げ辞書を管理します')
        .addSubcommand(sub => sub
            .setName('add').setDescription('単語を登録')
            .addStringOption(opt => opt.setName('word').setDescription('登録する単語').setRequired(true))
            .addStringOption(opt => opt.setName('reading').setDescription('読み方').setRequired(true)))
        .addSubcommand(sub => sub
            .setName('remove').setDescription('単語を削除')
            .addStringOption(opt => opt.setName('word').setDescription('削除する単語').setRequired(true)))
        .addSubcommand(sub => sub
            .setName('list').setDescription('登録単語の一覧')),
    new SlashCommandBuilder()
        .setName('ping')
        .setDescription('レイテンシを表示します'),
    new SlashCommandBuilder()
        .setName('kikisen')
        .setDescription('聞き専チャンネルの設定/解除/確認')
        .addStringOption(opt =>
            opt.setName('mode').setDescription('on/off')
                .addChoices({ name: 'on', value: 'on' }, { name: 'off', value: 'off' })
                .setRequired(false)),
    new SlashCommandBuilder()
        .setName('name')
        .setDescription('Quote画像の発言者名読み上げのON/OFF/確認')
        .addStringOption(opt =>
            opt.setName('mode').setDescription('on/off')
                .addChoices({ name: 'on', value: 'on' }, { name: 'off', value: 'off' })
                .setRequired(false)),
    new SlashCommandBuilder()
        .setName('voice')
        .setDescription('読み上げ話者の設定/確認/一覧')
        .addSubcommand(sub => sub
            .setName('set').setDescription('話者IDを設定')
            .addIntegerOption(opt => opt.setName('id').setDescription('話者ID').setRequired(true)))
        .addSubcommand(sub => sub
            .setName('current').setDescription('現在の話者を表示'))
        .addSubcommand(sub => sub
            .setName('list').setDescription('利用可能な話者一覧を表示')),
].map(cmd => cmd.toJSON());

async function registerCommands(client) {
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

    // グローバルコマンドをクリア（ギルドコマンドのみ使用）
    await rest.put(Routes.applicationCommands(client.user.id), { body: [] });

    // ギルドコマンド登録（即時反映）
    for (const [guildId] of client.guilds.cache) {
        try {
            await rest.put(Routes.applicationGuildCommands(client.user.id, guildId), { body: commands });
            console.log(`コマンドを登録: ${guildId}`);
        } catch (err) {
            console.error(`コマンドの登録に失敗 (${guildId}):`, err.message);
        }
    }
}

module.exports = { registerCommands };
