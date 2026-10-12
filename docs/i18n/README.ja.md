# AgenticReplay

<sub>[English](../../README.md) · [简体中文](README.zh-CN.md) · **日本語** · [한국어](README.ko.md) · [Deutsch](README.de.md) · [Français](README.fr.md) · [Español](README.es.md) · [العربية](README.ar.md)</sub>

AgenticReplay は、AI ハーネスの API 通信を記録し、不具合の調査と改善を支援するツールです。
対応クライアントのリクエストとレスポンスを、API が実際に返す reasoning/thinking の内容や要約も含めて記録します。

ログをツールの実行結果、記録されたシェルコマンド、ファイル変更と照らし合わせ、問題が起きた箇所を調べられます。

## インストール

Node.js 24 以降、Git、利用設定済みの AI ハーネスが必要です。

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

Claude Code など、API 通信を行うハーネスを起動して記録します。
ログはプロジェクト内の `.agenticreplay/runs/` に保存され、`last` は最新の記録を選びます。
`run.html` はブラウザーで確認できます。

保存先の名前は `YYYYMMDDHHmmss-agent-title-id`（UTC）です。英小文字・数字・ハイフンのみで、
全体は255文字以下、タイトルは80文字以下に収めます。セッションタイトルがなければ最初の依頼文を使い、
機密情報を伏せてASCIIに変換します。名前は記録終了時に確定します。既存の `run_<id>` ディレクトリや
run IDを指定するコマンドも引き続き使えます。

`OPENAI_BASE_URL` を読み取る独自のハーネスでは、`node agent.js` を起動コマンドに置き換えます。

```console
agenticreplay record generic-openai -- node agent.js
```

ChatGPT サブスクリプションで利用する Codex には、TLS インターセプトを使います。

```console
agenticreplay record exec --tls-intercept -- codex
```

記録時の API 呼び出しには料金が発生する場合があります。自動除去後もログに機密情報が残ることがあるため、共有前に確認してください。

他のハーネスは[連携ガイド](../integrations.md)、調査例は
[失敗した実行の調査](../how-to/debug-a-failing-agent-run.md)を参照してください。

## ライセンス

Apache-2.0。トレース仕様は CC BY 4.0。
