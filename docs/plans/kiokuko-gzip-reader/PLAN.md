# PLAN：KiokukoのAgenticReplay圧縮blob読み取り対応

## 目的と完了条件

AgenticReplayの新規圧縮記録・既存記録の圧縮変換後も、Kiokukoが同じ記憶候補を抽出できるようにする。
旧形式とgzip形式が混在しても、元のパス検証、展開後サイズ制限、内容ハッシュ検証、公開情報だけを抽出する条件を維持する。
この文書は実装計画であり、Kiokuko側の変更・テスト・リリースは未実施。

対象リポジトリ：`/Users/dkc/Sites/Src/kiokuko`。
調査時HEAD：`b0103a9`（2026-11-13）。実装開始時にHEAD・未コミット差分・対象コードを再確認する。

## 現在の根拠

- `src/memory/replay-extract.ts`の`extractReplayProposal()`は、`blobs/<先頭2桁>/<digest>`を直接読み取る。
- 同ファイルの`bounded()`はrealpathでrun配下への包含を確認し、通常ファイル・保存サイズ・読み取ったサイズを制限する。
- blob単体は2 MiB、blob合計は32 MiB。現状、同じblobが複数イベントに出た場合もその都度合計へ加算する。この意味は変更しない。
- 展開されていない非圧縮bytesを前提に、`envelope.bytes`との一致とSHA-256を確認してからJSONとして解釈している。
- manifestは64 KiB、eventsは8 MiB。`events.jsonl`と`event.jsonl`の曖昧性拒否も別途存在する。
- `src/agenticreplay/turn-receipt.ts`はevents/manifestを検証する。blob圧縮でevents内容やreceiptのハッシュを変更する必要はない。
- `extractTurnReceiptProposal()`のChatGPT未対応／Codex transcript要求は別の条件。圧縮対応を理由に緩めない。

## 実装手順

### 1. 失敗を再現するテストを先に追加

既存の有効なraw blob fixtureをgzipに変換し、元ファイルを除去する。現在の抽出処理がENOENTで失敗することを確認する。
同じevents・manifest・receiptを維持し、圧縮前の候補を期待値にする。既存テストを成功させるために検証条件を弱めない。

### 2. blob専用読み取りヘルパーを導入

`src/memory/replay-blob.ts`を追加し、`readReplayBlob(directory, digest, declaredBytes, remainingBytes)`相当の責務にする。
`bounded()`のmanifest/events読み取りを一律にgzip対応させず、blobの分岐だけ置き換える。

1. digestは64桁の小文字16進数、宣言サイズは非負の安全な整数であることを確認する。
2. 宣言サイズが2 MiBまたは残りの32 MiB予算を超える場合は、展開前に拒否する。
3. rawパスを優先し、**ENOENTの場合だけ**同じパスの`.gz`を試す。
4. rawの権限エラー、範囲外パス、サイズ違反、ハッシュ不一致をgzipへの切替で隠さない。両方存在する移行途中はrawが優先。
5. `.gz`にもrun配下へのrealpath検証と通常ファイル検証を適用する。既存の「範囲外へのリンクを拒否」という条件を維持する。
6. Node標準の非同期gunzipを使用し、新規外部依存を追加しない。保存入力にも独立した上限を置く。提案値は2 MiB＋64 KiB。AgenticReplayは小さくなる場合だけ圧縮するため通常は2 MiB未満に収まる。
7. 展開上限は`min(2 MiB, remainingBytes, declaredBytes)`とする。宣言サイズ0はAPIの正の上限要件に合わせて最大1byteまで展開後、実長0を厳密に検証する。
8. 展開後の長さとSHA-256を確認したbytesだけ返す。gzip末尾のサイズ値だけを信用しない。

圧縮破損と展開上限超過を区別し、固定エラーコードに整理する。既存の`replay_blob_integrity`、`replay_source_bound`、`replay_blob_budget_exceeded`との対応をテストで固定する。原文・認証情報をエラー本文へ出さない。

### 3. 抽出処理へ統合

`extractReplayProposal()`の直接読み取りを置換する。`blobBytes`は圧縮後の保存サイズではなく、検証済み展開後bytesで加算する。
`payloadHash`、候補の参照ID、JSON string wrapperの扱い、Codexのsession/turn対応、秘密情報除去の処理順は維持する。
圧縮移行中にrawが消えた場合もENOENTならgzipへ進める。開いたrawを読める場合はそれを使い、無限再試行しない。

### 4. 実際の記憶候補生成経路で検証

主な既存テスト：

- `tests/integration/replay-review.test.ts`
- `tests/integration/replay-codex-wire.test.ts`
- `tests/integration/capture-consideration.test.ts`

追加する比較表：

| ケース | 期待結果 |
|---|---|
| rawのみ／gzipのみ／混在／両形式あり | 同じ候補、参照ID、payloadHash。両形式時はraw優先 |
| 不正digest、ファイル欠落、範囲外リンク | 拒否。gzipで検証を迂回しない |
| 壊れたgzip、切れたgzip、連結メンバー | 不正データ拒否。全展開サイズを上限管理 |
| 宣言サイズ不一致、内容ハッシュ不一致 | 候補を作らず拒否 |
| 2 MiBと32 MiBの境界、各境界＋1byte、重複参照 | 既存の予算意味を維持 |
| 小さい圧縮入力から巨大展開 | 上限で停止し、過剰なバッファを確保しない |
| 圧縮中にraw削除、検証失敗、拒否された記録 | 有限の再試行／明確な失敗。記憶へ昇格しない |
| system、reasoning、秘密情報を含む本文 | 圧縮前と同じ除外・マスキング |

新しいAgenticReplayのビルドから実際に記録を作り、`compact`前後で`extractReplayProposal()`の出力を比較する。
記憶への保存は別の承認フローを維持し、試験で本番メモリへ保存しない。

## 検証コマンド

対象リポジトリで実行する。以下は計画であり、実行済み結果ではない。

```sh
npm run typecheck
node scripts/run-tests.mjs tests/integration/replay-review.test.ts tests/integration/replay-codex-wire.test.ts tests/integration/capture-consideration.test.ts
npm run build
npm run test:agenticreplay
npm test
```

新しい単体テストを追加した場合は、そのファイルも狭いテスト実行に含める。
AgenticReplayの読込先が更新版のビルドであることを確認し、開発中のソースが存在するだけで依存パッケージも更新済みと見なさない。

## 完了判定とリリース

- 上記比較が実際のKiokuko抽出経路で成功し、従来のraw fixtureも成功する。
- gzip分岐を無効化した検証用コピーで新しい回帰テストが失敗する。
- 型検査・ビルド・関連テスト・既存のパッケージ連携試験の結果を記録する。
- HTTPや実機試験が制約で実行できなければ、未確認と明示する。
- AgenticReplayの自動変換は今回別途有効化するため、この修正が配布されるまではKiokukoの非互換が残る。自動変換の有効化をこのPLAN完了の証拠にしない。
- 実装・試験は対象リポジトリに書き込み可能な環境で行う。コミット・push・公開は本PLANだけでは実行しない。

コミットメッセージ案：`fix(replay): read gzip blobs with bounded decompression and integrity checks`
