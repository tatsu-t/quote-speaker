const axios = require('axios');

const BASE_URL = 'https://api.ai.sakura.ad.jp/v1';
const OCR_MODEL = 'preview/Qwen3-VL-30B-A3B-Instruct';

function getHeaders() {
    return {
        Authorization: `Bearer ${process.env.SAKURA_API_KEY}`,
        'Content-Type': 'application/json',
    };
}

/**
 * @returns {{ text: string, isQuote: boolean }}
 */
async function extractTextFromImage(imageUrl) {
    const imageRes = await axios.get(imageUrl, { responseType: 'arraybuffer' });
    const base64 = Buffer.from(imageRes.data).toString('base64');
    const mimeType = (imageRes.headers['content-type'] || 'image/jpeg').split(';')[0].trim();

    const response = await axios.post(`${BASE_URL}/chat/completions`, {
        model: OCR_MODEL,
        max_tokens: 512,
        messages: [{
            role: 'user',
            content: [
                {
                    type: 'image_url',
                    image_url: { url: `data:${mimeType};base64,${base64}` },
                },
                {
                    type: 'text',
                    text: `画像を解析し、以下のJSON形式のみで返してください（マークダウン不要）:
{"text":"抽出したテキスト","isQuote":boolean,"speakerName":"発言者名"}

ルール:
- isQuote: "Make it a Quote" / "Quote Maker" / "Fake Quote Maker" などで作られた名言画像ならtrue
- isQuoteがtrueの場合、textには名言の本文のみ（発言者名・@ハンドル・ブランド名は除外）
- isQuoteがtrueの場合、speakerNameには発言者の表示名（@ハンドルやブランド名は除く）。不明な場合は""
- isQuoteがfalseの場合、textには画像内の全テキスト、speakerNameは""
- テキストがない場合はtext=""
- "Make it a Quote#6660" という文字列は絶対にtextに含めないこと`,
                },
            ],
        }],
    }, { headers: getHeaders() });

    const content = response.data.choices[0].message.content.trim();

    try {
        const parsed = JSON.parse(content);
        return {
            text: (parsed.text || '').trim(),
            isQuote: !!parsed.isQuote,
            speakerName: (parsed.speakerName || '').trim(),
        };
    } catch {
        return { text: content, isQuote: false, speakerName: '' };
    }
}

module.exports = { extractTextFromImage };
