const axios = require('axios');

const BASE_URL = 'https://api.ai.sakura.ad.jp/tts/v1';
const DEFAULT_SPEAKER = 3; // ずんだもん(あまあま)

const SPEAKERS = [
    { name: '四国めたん', styles: [
        { id: 0, name: 'ノーマル' }, { id: 2, name: 'あまあま' },
        { id: 4, name: 'ツンツン' }, { id: 6, name: 'セクシー' },
        { id: 36, name: 'ささやき' }, { id: 37, name: 'ヒソヒソ' },
    ]},
    { name: 'ずんだもん', styles: [
        { id: 1, name: 'ノーマル' }, { id: 3, name: 'あまあま' },
        { id: 5, name: 'ツンツン' }, { id: 7, name: 'セクシー' },
        { id: 22, name: 'ささやき' }, { id: 38, name: 'ヒソヒソ' },
        { id: 75, name: 'ヘロヘロ' }, { id: 76, name: 'なみだめ' },
    ]},
    { name: '春日部つむぎ', styles: [{ id: 8, name: 'ノーマル' }] },
    { name: '冥鳴ひまり', styles: [{ id: 14, name: 'ノーマル' }] },
];

function getHeaders() {
    return { Authorization: `Bearer ${process.env.SAKURA_API_KEY}` };
}

async function generateAudio(text, speakerId = DEFAULT_SPEAKER) {
    const queryRes = await axios.post(`${BASE_URL}/audio_query`, null, {
        params: { text, speaker: speakerId },
        headers: getHeaders(),
    });

    const synthRes = await axios.post(`${BASE_URL}/synthesis`, queryRes.data, {
        params: { speaker: speakerId },
        headers: { ...getHeaders(), 'Content-Type': 'application/json' },
        responseType: 'stream',
    });

    return synthRes.data;
}

function listSpeakers() {
    return SPEAKERS;
}

module.exports = { generateAudio, listSpeakers, DEFAULT_SPEAKER };
