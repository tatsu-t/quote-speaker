const axios = require('axios');

const BASE_URL = 'https://api.ai.sakura.ad.jp/tts/v1';
const SPEAKER_ID = 3; // ずんだもん

function getHeaders() {
    return { Authorization: `Bearer ${process.env.SAKURA_API_KEY}` };
}

async function generateAudio(text) {
    // Step 1: audio_query
    const queryRes = await axios.post(`${BASE_URL}/audio_query`, null, {
        params: { text, speaker: SPEAKER_ID },
        headers: getHeaders(),
    });

    // Step 2: synthesis -> audio stream
    const synthRes = await axios.post(`${BASE_URL}/synthesis`, queryRes.data, {
        params: { speaker: SPEAKER_ID },
        headers: { ...getHeaders(), 'Content-Type': 'application/json' },
        responseType: 'stream',
    });

    return synthRes.data;
}

module.exports = { generateAudio };
