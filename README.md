# QuoteSpeaker Bot 🗣️

Voicevoxを使用したDiscord読み上げBotです。画像OCR機能、辞書機能、自動読み上げ機能を搭載しています。
利用環境に合わせて「分散構成（推奨）」または「統一構成」を選択できます。

> [!NOTE]
> 本Botの読み上げ機能は「おまけ」としての実装です。安定した読み上げ環境が必要な場合は、他の専用読み上げBotとの併用を推奨します。

## 機能 🚀

- **読み上げ機能 (TTS)**
  - Voicevox (Zundamon / Speaker ID: 3) を使用。
  - テキストチャットの内容をボイスチャットで読み上げ。
  - `/autoread` で読み上げのON/OFF切り替え。
  - 外部API (`tts.quest`) を優先利用し、リソースがない場合やAPI制限時に自宅PC（またはローカル）のエンジンへフォールバック。

- **画像読み上げ (OCR)**
  - 画像が添付された場合、Google Vision APIで文字を認識して読み上げ。
  - **Quote画像対応**: Make it a Quoteなどで作成された画像を自動判別し、ヘッダー・フッター・IDなどのノイズを除去して本文のみ読み上げ。
  - **テキストOCR**: リプライやVC外でのメンション時は、読み上げずにテキストでOCR結果を返信。

- **便利機能**
  - `/dict`: 読み間違いを修正する辞書登録機能（追加/削除/一覧）。
  - `/ping`: Botの応答速度確認。
  - `s` コマンド: 現在の読み上げをスキップ。
  - `ss` コマンド: 読み上げキューを全削除して停止。
  - 入退室通知: Auto-read有効時、メンバーの入退室を読み上げ。

## システム構成 🏗️

### A. 分散構成（推奨）
VPSと自宅PCを連携させ、重い処理（VOICEVOX）を自宅PCにオフロードします。
- **VPS (`dist_vps`)**: Bot本体。軽量。自宅PCへFRP等で接続。
- **自宅PC (`dist_home`)**: VOICEVOXエンジン。FRPでポートをVPSへ転送。

### B. 統一構成
1つのマシン（PCまたは高性能VPS）ですべてを動作させます。
- **統一 (`dist_unified`)**: BotとVOICEVOXをdocker-composeで一括管理。手軽ですがマシンスペックが必要です。

## セットアップ手順 🛠️

### A. 分散構成の場合

#### 1. VPS側 (`/dist_vps`)
1. `dist_vps` フォルダをVPSに配置します。
2. `.env` ファイルを作成・編集します。
   ```bash
   DISCORD_TOKEN=your_token_here
   GOOGLE_VISION_API_KEY=your_key_here
   VOICEVOX_API_KEY=your_voicevox_api_key_here
   # VOICEVOX_URL=http://host.docker.internal:5000 (デフォルト)
   ```
3. 起動します。
   ```bash
   docker-compose up -d --build
   ```

#### 2. 自宅PC側 (`/dist_home`)
1. `dist_home` フォルダを自宅PCに配置します。
2. VOICEVOXエンジンを起動します。
   ```bash
   docker-compose up -d
   ```
3. `frpc.toml` を編集して、VPSのFRPサーバーへ接続設定を行います。
   - ローカルポート: `50021`
   - リモートポート: `5000` (VPS側から見えるポート)
4. FRPクライアントを起動してトンネルを確立します。

---

### B. 統一構成の場合 (`/dist_unified`)

1. `dist_unified` フォルダを配置します。
2. `.env` ファイルを作成・編集します。
   ```bash
   DISCORD_TOKEN=your_token_here
   GOOGLE_VISION_API_KEY=your_key_here
   VOICEVOX_API_KEY=your_voicevox_api_key_here
   ```
3. 起動します（初回はVoicevoxのダウンロードに時間がかかります）。
   ```bash
   docker-compose up -d --build
   ```

## コマンド一覧 📜

| コマンド | 説明 |
| --- | --- |
| `/join` | ボイスチャンネルに参加 |
| `/leave` | ボイスチャンネルから退出 |
| `/autoread` | 自動読み上げモードの切り替え (ON/OFF) |
| `/speak [text] [image]` | 指定したテキストまたは画像を読み上げ |
| `/dict add [word] [reading]` | 辞書に単語を登録 |
| `/dict remove [word]` | 辞書から単語を削除 |
| `/dict list` | 辞書一覧を表示 |
| `/ping` | レイテンシを表示 |
| `s` | (チャット) 現在の読み上げをスキップ |
| `ss` | (チャット) 全ての読み上げをスキップ |

## ディレクトリ構造

- `dist_vps/`: VPSデプロイ用 (分散構成-Bot側)
- `dist_home/`: 自宅PCデプロイ用 (分散構成-Voicevox側)
- `dist_unified/`: 統一デプロイ用 (全て入り)
- `index.js`: (開発用) オリジナルソースコード
