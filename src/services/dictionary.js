const fs = require('fs');
const path = require('path');

const DICT_FILE = path.join(__dirname, '../../data/dictionary.json');
let dictionaries = {}; // { guildId: { word: reading } }

function load() {
    try {
        if (fs.existsSync(DICT_FILE)) {
            const raw = JSON.parse(fs.readFileSync(DICT_FILE, 'utf8'));
            // フラット形式（旧）かギルド形式（新）かを判定
            const isLegacy = Object.keys(raw).length > 0
                && !Object.values(raw).some(v => typeof v === 'object' && v !== null);
            if (isLegacy) {
                // 旧フラットデータは破棄（空だった場合も含む）
                dictionaries = {};
                save();
            } else {
                dictionaries = raw;
            }
        }
    } catch (e) {
        console.error('辞書の読み込みに失敗しました:', e);
        dictionaries = {};
    }
}

function save() {
    try {
        fs.mkdirSync(path.dirname(DICT_FILE), { recursive: true });
        fs.writeFileSync(DICT_FILE, JSON.stringify(dictionaries, null, 2));
    } catch (e) {
        console.error('辞書の保存に失敗しました:', e);
    }
}

function getGuildDict(guildId) {
    return dictionaries[guildId] || {};
}

function apply(guildId, text) {
    if (!text) return text;
    const dict = getGuildDict(guildId);
    const keys = Object.keys(dict).sort((a, b) => b.length - a.length);
    for (const key of keys) {
        const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        text = text.replace(new RegExp(escaped, 'g'), dict[key]);
    }
    return text;
}

function add(guildId, word, reading) {
    if (!dictionaries[guildId]) dictionaries[guildId] = {};
    dictionaries[guildId][word] = reading;
    save();
}

function remove(guildId, word) {
    if (!dictionaries[guildId]?.[word]) return false;
    delete dictionaries[guildId][word];
    save();
    return true;
}

function list(guildId) {
    const dict = getGuildDict(guildId);
    return Object.entries(dict).map(([k, v]) => `${k} → ${v}`);
}

load();

module.exports = { apply, add, remove, list };
