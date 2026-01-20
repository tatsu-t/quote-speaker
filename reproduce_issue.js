require('dotenv').config({ path: '/root/quotespeak/.env' });
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const GOOGLE_VISION_API_KEY = process.env.GOOGLE_VISION_API_KEY;

// Improved Cleaning Logic
function improvedCleanOCRText(text) {
    if (!text) return "";

    // Simple normalization
    let cleaned = text.trim();

    // Remove "Make it a Quote" branding if it sneaks in
    cleaned = cleaned.replace(/Make[ \t]*it[ \t]*a[ \t]*Quote/gi, '');
    cleaned = cleaned.replace(/Quote[ \t]*Speaker/gi, '');

    // Basic cleanup
    cleaned = cleaned.replace(/[\u200B-\u200D\uFEFF]/g, ''); // Zero-width spaces

    return cleaned.trim();
}

async function processImage(imagePath) {
    try {
        console.log(`\nProcessing image: ${imagePath}`);
        const base64Image = fs.readFileSync(imagePath).toString('base64');

        const visionUrl = `https://vision.googleapis.com/v1/images:annotate?key=${GOOGLE_VISION_API_KEY}`;
        const requestBody = {
            requests: [
                {
                    image: { content: base64Image },
                    features: [{ type: 'TEXT_DETECTION' }]
                }
            ]
        };

        const response = await axios.post(visionUrl, requestBody);
        const responses = response.data.responses;
        if (!responses || responses.length === 0 || !responses[0].textAnnotations) {
            console.log("No text detected.");
            return;
        }

        const annotations = responses[0].textAnnotations;
        const words = annotations.slice(1);

        let imgWidth = 0;
        let imgHeight = 0;
        words.forEach(word => {
            const vertices = word.boundingPoly.vertices;
            vertices.forEach(v => {
                if (v.x && v.x > imgWidth) imgWidth = v.x;
                if (v.y && v.y > imgHeight) imgHeight = v.y;
            });
        });

        // --- DEBUG OUTPUT ---
        console.log(`Dimensions: ${imgWidth}x${imgHeight}`);
        words.forEach(w => {
            const ys = w.boundingPoly.vertices.map(v => v.y || 0);
            const midY = (Math.min(...ys) + Math.max(...ys)) / 2;
            const xs = w.boundingPoly.vertices.map(v => v.x || 0);
            const midX = (Math.min(...xs) + Math.max(...xs)) / 2;
            console.log(`Text: "${w.description}" | Y: ${Math.round(midY)} (${Math.round(midY / imgHeight * 100)}%) | X: ${Math.round(midX)}`);
        });

        // --- IMPROVED FILTERING ---
        // 1. First pass: strict top/bottom metadata removal
        const filteredWords = words.filter(word => {
            const vertices = word.boundingPoly.vertices;
            const ys = vertices.map(v => v.y || 0);
            const midY = (Math.min(...ys) + Math.max(...ys)) / 2;

            // 1. Top Exclusion (Header/Speaker Name) - Exclude top 15%
            if (midY < imgHeight * 0.15) return false;

            // 2. Bottom Exclusion (Branding only) - Exclude bottom 5%
            if (midY > imgHeight * 0.95) return false;

            // 3. Left Exclusion (Illustration noise) - Exclude left 15%
            // "ROBOTさん" is at X ~ 3-5%. "?" is at ~19%? Let's check the logs.
            // ROBOT: X=28 (2.7%), さん: X=55 (5.4%).
            // Main text typically centers. Let's try 15% left cutoff.
            const midX = (Math.min(...word.boundingPoly.vertices.map(v => v.x || 0)) + Math.max(...word.boundingPoly.vertices.map(v => v.x || 0))) / 2;
            if (midX < imgWidth * 0.10) return false;

            return true;
        });

        // 2. Sort words by Y then X
        filteredWords.sort((a, b) => {
            const ysA = a.boundingPoly.vertices.map(v => v.y || 0);
            const ysB = b.boundingPoly.vertices.map(v => v.y || 0);
            const midYA = (Math.min(...ysA) + Math.max(...ysA)) / 2;
            const midYB = (Math.min(...ysB) + Math.max(...ysB)) / 2;

            if (Math.abs(midYA - midYB) < (imgHeight * 0.02)) {
                const xsA = a.boundingPoly.vertices.map(v => v.x || 0);
                const xsB = b.boundingPoly.vertices.map(v => v.x || 0);
                return Math.min(...xsA) - Math.min(...xsB);
            }
            return midYA - midYB;
        });

        // 3. Group into lines
        const lines = [];
        let currentLine = [];
        let lastY = -1;

        filteredWords.forEach(word => {
            const ys = word.boundingPoly.vertices.map(v => v.y || 0);
            const midY = (Math.min(...ys) + Math.max(...ys)) / 2;

            if (lastY !== -1 && Math.abs(midY - lastY) > (imgHeight * 0.03)) { // New line threshold
                lines.push(currentLine);
                currentLine = [];
            }
            currentLine.push(word);
            lastY = midY;
        });
        if (currentLine.length > 0) lines.push(currentLine);

        // 4. Identify Signature/Footer block
        let validLines = [];
        for (let i = 0; i < lines.length; i++) {
            const lineWords = lines[i];
            const lineText = lineWords.map(w => w.description).join('');
            const lineY = lineWords[0].boundingPoly.vertices[0].y; // Approx Y

            // Check if this line looks like a signature
            // 1. Starts with - or —
            if (/^[-—]/.test(lineText)) continue;
            // 2. Starts with @
            if (/^@/.test(lineText)) continue;

            // Rule D: Drop line if NEXT line starts with @ (Display Name check)
            // Assumes display name is relatively short.
            if (i < lines.length - 1) {
                const nextLineWords = lines[i + 1];
                const nextLineText = nextLineWords.map(w => w.description).join('');
                if (/^@/.test(nextLineText)) {
                    // Check length to be safe? Names are usually < 30 chars?
                    if (lineText.length < 30) {
                        console.log(`Dropping Display Name (followed by @): ${lineText}`);
                        continue;
                    }
                }
            }

            validLines.push(lineText);
        }

        const reconstructedText = validLines.join('');
        console.log(`[Extracted]: ${reconstructedText}`);
        console.log(`[Cleaned]:   ${improvedCleanOCRText(reconstructedText)}`);

    } catch (error) {
        console.error('Error:', error.message);
        if (error.response) console.error(error.response.data);
    }
}

// Run on all uploaded images
const artifactDir = '/root/.gemini/antigravity/brain/e1425828-549c-4d16-9304-3222f740ff73';
// Target specific image provided by user (Heart -> Ku issue)
processImage(path.join(artifactDir, 'uploaded_image_1768905318599.png'));
