const fs = require('fs');
const path = require('path');

const DICT_FILE = path.join(__dirname, '../../data/dictionary.json');
let dictionary = {};

function load() {
    try {
        if (fs.existsSync(DICT_FILE)) {
            dictionary = JSON.parse(fs.readFileSync(DICT_FILE, 'utf8'));
        }
    } catch (e) {
        console.error('辞書の読み込みに失敗しました:', e);
        dictionary = {};
    }
}

function save() {
    try {
        fs.mkdirSync(path.dirname(DICT_FILE), { recursive: true });
        fs.writeFileSync(DICT_FILE, JSON.stringify(dictionary, null, 2));
    } catch (e) {
        console.error('辞書の保存に失敗しました:', e);
    }
}

function apply(text) {
    if (!text) return text;
    const keys = Object.keys(dictionary).sort((a, b) => b.length - a.length);
    for (const key of keys) {
        const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        text = text.replace(new RegExp(escaped, 'g'), dictionary[key]);
    }
    return text;
}

function add(word, reading) {
    dictionary[word] = reading;
    save();
}

function remove(word) {
    if (!dictionary[word]) return false;
    delete dictionary[word];
    save();
    return true;
}

function list() {
    return Object.entries(dictionary).map(([k, v]) => `${k} → ${v}`);
}

load();

module.exports = { apply, add, remove, list };
