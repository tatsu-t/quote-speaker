const fs = require('fs');
const path = require('path');
const { autoReadStates, boundTextChannels, listenChannels, nameReadStates, activeVoiceChannels } = require('../state');

const PERSIST_FILE = path.join(__dirname, '../../data/persist.json');

function save() {
    try {
        fs.mkdirSync(path.dirname(PERSIST_FILE), { recursive: true });
        fs.writeFileSync(PERSIST_FILE, JSON.stringify({
            autoRead: Object.fromEntries(autoReadStates),
            boundTextChannels: Object.fromEntries(boundTextChannels),
            listenChannels: Object.fromEntries(listenChannels),
            nameRead: Object.fromEntries(nameReadStates),
            voiceChannels: Object.fromEntries(activeVoiceChannels),
        }, null, 2));
    } catch (e) {
        console.error('状態の保存に失敗しました:', e);
    }
}

function load() {
    try {
        if (fs.existsSync(PERSIST_FILE)) {
            return JSON.parse(fs.readFileSync(PERSIST_FILE, 'utf8'));
        }
    } catch (e) {
        console.error('状態の読み込みに失敗しました:', e);
    }
    return {};
}

module.exports = { save, load };
