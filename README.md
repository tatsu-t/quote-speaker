# quote-speaker

Discord読み上げBot。テキスト・Quote画像をVCで読み上げる。

## 構成

- TTS: さくらAI API (ずんだもん)
- OCR: さくらAI Qwen3-VL (Quote画像判定付き)
- デプロイ: Docker Compose

## コマンド

| コマンド | 説明 |
|---------|------|
| `/join` | VCに参加 |
| `/leave` | VCから退出 |
| `/speak` | テキスト/画像を読み上げ |
| `/autoread on/off` | 自動読み上げ |
| `/dict add/remove/list` | 読み替え辞書 |
| `/kikisen on/off` | 聞き専チャンネル設定 |
| `/name on/off` | Quote発言者名読み上げ |
| `/ping` | レイテンシ確認 |
| `s` | スキップ / `ss` 全停止 |

## 起動

```
cp .env.example .env  # DISCORD_TOKEN, SAKURA_API_KEY を設定
docker compose up -d --build
```
