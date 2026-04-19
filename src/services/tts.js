const axios = require('axios');

const BASE_URL = 'https://api.ai.sakura.ad.jp/tts/v1';
const DEFAULT_SPEAKER = 3; // ずんだもん

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

async function listSpeakers() {
    const res = await axios.get(`${BASE_URL}/speakers`, { headers: getHeaders() });
    return res.data;
}

module.exports = { generateAudio, listSpeakers, DEFAULT_SPEAKER };
