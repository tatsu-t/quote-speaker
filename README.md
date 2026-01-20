# Quote Speaker Bot

Discordボイスチャンネルでテキスト読み上げ（TTS）と画像内の文字読み上げを行うボットです。
特に、画像化された「引用（Quote）」やスクリーンショットの内容を自動で読み上げることに特化しています。

## 主な機能

*   **ハイブリッドTTSエンジン**:
    *   **通常時**: 軽量な外部API (`tts.quest`) を使用し、サーバー負荷を最小限に抑えます。
    *   **バックアップ**: APIポイント不足時やエラー発生時は、自動的にローカルのDockerコンテナ (VOICEVOX Engine) を起動して読み上げを継続します。
    *   **自動復旧**: APIが復帰すると、自動的にローカルエンジンを停止してリソースを解放します。
*   **画像読み上げ (OCR)**:
    *   Google Vision API を使用して画像内のテキストを抽出・読み上げます。
    *   **Quote画像対応**: 引用画像特有のヘッダー・フッターやノイズを自動除去し、本文のみを抽出します。
*   **自動読み上げモード (`/autoread`)**:
    *   ボイスチャンネル付属のテキストチャットに投稿されたメッセージを自動で読み上げます。
    *   メンション不要で会話の流れを阻害しません。
*   **辞書機能 (`/dict`)**:
    *   読み方の難しい単語や固有名称を辞書登録できます。
*   **ユーザー入退室通知**:
    *   ボイスチャンネルへの入退室を音声で通知します。

## 必要要件

*   Docker & Docker Compose
*   Node.js (開発用)
*   **APIキー**:
    *   Discord Bot Token
    *   Google Cloud Vision API Key
    *   (Optional) VOICEVOX API Key (for `tts.quest` V2 API)

## インストールと起動

1.  **リポジトリのクローン**:
    ```bash
    git clone https://github.com/tatsu-t/quote-speaker.git
    cd quote-speaker
    ```

2.  **環境設定**:
    `.env` ファイルを作成し、必要なキーを設定します。
    ```bash
    DISCORD_TOKEN=your_discord_bot_token
    GOOGLE_VISION_API_KEY=your_google_vision_api_key
    VOICEVOX_API_KEY=your_tts_quest_api_key
    ```
    *   `VOICEVOX_API_KEY` は `tts.quest` のAPIキーです（指定しない場合、無料枠や機能制限がある場合があります）。

3.  **起動**:
    Docker Compose を使用して起動します。
    ```bash
    docker-compose up -d --build
    ```
    *   `bot` コンテナと、必要に応じて使用される `voicevox` コンテナが準備されます。
    *   **重要**: ボットはDockerソケット (`/var/run/docker.sock`) をマウントし、`voicevox` コンテナの起動/停止を制御します。

## 使い方 (コマンド)

### スラッシュコマンド
*   `/join`: ボイスチャンネルに参加し、読み上げ待機状態になります。
*   `/leave`: ボイスチャンネルから切断します。
*   `/autoread`: 自動読み上げモードの ON/OFF を切り替えます。
*   `/speak [text] [image]`: 指定したテキストまたは画像を読み上げます。
*   `/dict add [単語] [読み]`: 辞書に単語を登録します。
*   `/dict remove [単語]`: 辞書から単語を削除します。
*   `/dict list`: 登録されている単語一覧を表示します。

### チャット制御コマンド
*   `s` (または `ｓ`): 現在読み上げ中の音声をスキップします。
*   `ss` (または `ｓｓ`): 読み上げを即時停止し、待機キューを全て削除します。
*   `;` (セミコロン) で始まるメッセージ: 読み上げから除外されます（コメントアウト）。

## 謝辞 / Acknowledgements

このプロジェクトは以下の素晴らしいサービスとライブラリを使用しています。

*   **VOICEVOX**: 無料で使える中品質なテキスト読み上げソフトウェア
*   **TTS Quest (WEB版VOICEVOX API)**:
    *   外部APIとして `tts.quest` を利用しています。
    *   詳細: [https://voicevox.su-shiki.com/su-shikiapis/#step3](https://voicevox.su-shiki.com/su-shikiapis/#step3)

## ライセンス

本プロジェクトは **MIT License** の下で公開されています。詳細については [LICENSE](LICENSE) ファイルを参照してください。
