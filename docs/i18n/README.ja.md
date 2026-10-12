# AgenticReplay

<sub>[English](../../README.md) · [简体中文](README.zh-CN.md) · **日本語** · [한국어](README.ko.md) · [Deutsch](README.de.md) · [Français](README.fr.md) · [Español](README.es.md) · [العربية](README.ar.md)</sub>

AgenticReplay は、AI ハーネスのデバッグ向けにカスタムした AI API 通信ロガーです。
対応するクライアントのリクエストとレスポンスを記録し、API が実際に返す reasoning/thinking の
内容や要約も含めます。API が公開しない内部の思考は取得できません。
取得した本文は機密情報をマスクして保存し、不完全な記録にはその状態を示します。

API 通信とツールの結果、記録されたシェルコマンド、ファイル変更を照らし合わせて、
ハーネスの実際の動作を調べ、不具合の特定と改善に役立てられます。

## インストール

Node.js 24 以降、Git、および通常の認証情報で利用できるインストール済みのハーネスが必要です。

```console
git clone https://github.com/askdkc/AgenticReplay.git
cd AgenticReplay
npm ci
npm run build
npm install -g .
agenticreplay doctor
```

## 使い方

調査対象のプロジェクトで実行します。

```console
agenticreplay record claude -- -p "Investigate the failing test"
agenticreplay show last
agenticreplay export last -o run.html
```

MCP サーバーだけでなく、Claude Code など、AI API リクエストを送るハーネスを記録対象にします。
記録はそのプロジェクトの `.agenticreplay/runs/` に保存され、`last` は最新の記録を選びます。
HTML エクスポートはブラウザーで確認できます。

`OPENAI_BASE_URL` に対応する独自のハーネスの場合：

```console
agenticreplay record generic-openai -- node agent.js
```

`node agent.js` を自分のハーネスの起動コマンドに置き換えてください。
ChatGPT サブスクリプションでログインした Codex には TLS インターセプトを使います。

```console
agenticreplay record exec --tls-intercept -- codex
```

記録時もハーネスは通常どおり動作し、API 料金が発生する場合があります。
記録にはプロジェクトの機密情報が含まれ得るため、共有前に内容を確認してください。

他のハーネスについては[インテグレーション](../integrations.md)、調査例は
[失敗した実行の調査](../how-to/debug-a-failing-agent-run.md)を参照してください。

## ライセンス

コードは Apache-2.0。トレース仕様は CC BY 4.0 なので、誰でも再実装してよい。
