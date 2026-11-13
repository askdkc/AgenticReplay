# PLAN：kiokuko-dshのAgenticReplay圧縮blob読み取り対応

## 目的と完了条件

圧縮されたAgenticReplay記録について、DSHのページ読み取り・記録検証・HTML出力が継続して動作するようにする。
旧raw形式との互換性を保ち、既存の所有者・権限・リンク対策、ページ予算、展開後サイズ・SHA-256検証を弱めない。
この文書は実装計画であり、kiokuko-dsh側の変更・テスト・リリースは未実施。

対象リポジトリ：`/Users/dkc/Sites/Src/kiokuko-dsh`。
調査時HEAD：`f9bff4a`（2026-11-13）。実装開始時にHEAD・未コミット差分・対象コードを再確認する。
DSH本体の変更は対象外。

## 現在の根拠

- `src/dsh/agenticreplay-files.ts`の`readAgenticReplayPage()`がraw blobパスを直接`readPrivateFile(..., ref.bytes)`へ渡している。
- `checkPrivatePath()`でblobsディレクトリ・shardを検証し、読み取った長さとSHA-256を照合している。
- 同ページ処理はJSONL読み取り量とblob展開相当bytesを`maxBytes`で制限し、`validatedBlobs`で検証済み参照を共有する。
- `scanAgenticReplayTrace()`はページ結果を使い、イベント数・blob数・eventsハッシュ等を照合する。HTML入力予算と保存ディスク使用量は別の責務。
- `src/dsh/agenticreplay-security.ts`の`openPrivateFile()`／`readPrivateFile()`がファイルアクセスの防御を担っている。
- `prepareAgenticReplayParent()`はAgenticReplayの`ensureRunsDir()`を呼ぶ。更新版の自動圧縮はこの経路からも動くため、reader側の対応が必要。
- `agenticreplay-libraries.ts`はインストール済みAgenticReplayからCore等を解決する。ソースだけ変更しても同梱Viewerの互換性は証明できない。

## 実装手順

### 1. ページ読み取りの回帰ケースを追加

既存fixtureのコピーを使い、raw blobをgzipへ変換してrawを取り除く。
現在の`readAgenticReplayPage()`／read serviceが失敗することを先に確認する。
`tests/fixtures/agenticreplay-0.1.9/trace`の原本は変更せず、旧形式の互換試験として残す。

### 2. private-file契約を保ったblob専用ヘルパー

`src/dsh/agenticreplay-blob.ts`を新設し、`readAgenticReplayBlob(dir, ref, remainingBytes)`相当を実装する。
汎用`readPrivateFile()`はmanifest/eventsにも使われるため、その意味を暗黙に変えない。

1. refのdigest、サイズ、残り予算を検証する。上限超過は読み取り・展開前に拒否する。
2. 現行と同じblobs/shard検証を実施する。
3. rawを既存のprivate-file経路で読み、ENOENTの場合のみ`.gz`を同じ経路で読む。
4. unsafe_path、権限不足、file_changed、rawのサイズ／ハッシュ不一致をgzipへ切り替えて隠さない。
5. gzipファイルでも`openPrivateFile()`の通常ファイル・所有者・権限・リンク・ファイル同一性の検査を維持する。汎用Core readerへ丸投げしてこの境界を失わない。
6. 保存入力は独立した上限で読む。提案は`min(ref.bytes + 64 KiB, 256 MiB)`。安全な整数と加算オーバーフローを先に確認する。余分なgzipヘッダーで入力メモリが無制限にならないようにする。
7. Node標準の非同期gunzipを使い、出力を`min(ref.bytes, remainingBytes)`で制限する。0byteは最大1byteの展開上限と厳密な実長0チェックで扱う。
8. 展開後bytesの長さとSHA-256を照合して返す。単なるgzipのCRC成功では内容の同一性を認めない。

破損gzipは固定コード（例：`blob_compression_invalid`）、サイズ／ハッシュ不一致は既存の`blob_mismatch`へ整理する。
実装前に`AgenticReplayError`と表示側のエラーコード処理を確認し、新しいコードを追加しても秘密情報や本文を表示しない。

### 3. ページ・scan・表示経路へ統合

`readAgenticReplayPage()`のraw読み取り1箇所をヘルパーに置換する。

- `blobBytes`と`readBytes`には展開後の長さを加算する。圧縮後サイズでページ予算を水増ししない。
- `validatedBlobs`へ登録するのは展開・実長・ハッシュ検証のすべてが成功してから。
- 同じdigestの異なる`ref.bytes`は従来どおり拒否する。
- ページの途中で予算が尽きた場合、既存のoffset・previousSeq・次ページ開始条件を維持する。先頭イベントが収まらなければ`timeline_blob_limit`を維持する。
- 検証キャッシュは現行のスコープを越えて永続化しない。書き換えられた記録を以前の検証だけで信頼しない。
- `agenticReplayDiskBytes()`はファイルの実容量を数える。展開サイズへ置き換えない。
- `scanAgenticReplayTrace()`のユニークblob数・HTML入力の展開後予算・manifest照合を維持する。
- HTMLは更新版Viewerで検証する。旧Viewerが同梱されていれば、consumer package試験が通る依存解決へ更新する。任意のバージョン番号だけで互換性を断定しない。

### 4. 回帰・統合試験

主な既存テスト：

- `tests/dsh/integration/agenticreplay-read-service.test.ts`
- `tests/dsh/unit/agenticreplay-security.test.ts`
- `tests/dsh/unit/agenticreplay-distribution.test.ts`
- `tests/dsh/unit/agenticreplay-prune.test.ts`
- `tests/dsh/e2e/agenticreplay-native.test.ts`
- `tests/dsh/helpers/agenticreplay-redaction.ts`

blobヘルパーの単体テストは`tests/dsh/unit/agenticreplay-blob.test.ts`へ追加する。

| ケース | 期待結果 |
|---|---|
| raw、gzip、混在、移行途中で両形式あり | 同じイベントと検証結果。raw優先 |
| rawが移行で消えたタイミング | ENOENTのみgzipへフォールバック。無限再試行なし |
| gzip破損、切断、CRC不一致、宣言サイズ偽装、ハッシュ不一致 | 拒否。キャッシュに検証成功を残さない |
| 展開予算の境界・境界＋1、JSONLとblobの合算 | 現行のページ上限とoffsetを維持 |
| 同一blobの重複、ページをまたぐ参照、サイズ宣言の食い違い | 現行のキャッシュ／カウント規約を維持 |
| gzip爆弾、連結メンバー、入力だけ巨大なgzip | 入力・出力をそれぞれ制限 |
| ファイル／shardのsymlink、所有者違い、公開権限、読み取り中の差替え | 不正パス・所有者・権限は拒否。差替え時は検証済みの元handleを安全に読むかfile_changedで拒否 |
| rawに検証違反があり、gzipは正常 | gzipでrawの異常を隠さない |
| gzipで保存された秘密情報・非公開推論 | 表示・HTML・診断に漏れない |

更新版AgenticReplayで記録し、実際のread serviceによるshow、scan、HTML exportを実行する。
同じ記録を`compact`で変換した前後でも結果を比較する。旧0.1.9 fixtureはそのまま正常に読めることを確認する。

## 検証コマンド

対象リポジトリで実行する。以下は計画であり、実行済み結果ではない。

```sh
npm run typecheck
node scripts/run-tests.mjs tests/dsh/unit/agenticreplay-blob.test.ts tests/dsh/unit/agenticreplay-security.test.ts tests/dsh/integration/agenticreplay-read-service.test.ts tests/dsh/unit/agenticreplay-prune.test.ts tests/dsh/unit/agenticreplay-distribution.test.ts
npm run build
npm run test:agenticreplay:package
node scripts/run-tests.mjs tests/dsh/e2e/agenticreplay-native.test.ts
npm test
```

パッケージ検証ではnpmとpnpmの両方について、解決されたCore・Viewerがテスト対象のgzip対応ビルドであることを確認する。
実環境試験は使い捨てfixtureまたは対象リポジトリの既存の試験経路を使う。

## 完了判定と適用順

- read service、scan、HTML exportが圧縮前後で同じ結果を返す。
- 圧縮後の実保存容量と展開後の処理予算を混同していない。
- gzip分岐を無効にした検証用コピーで新規テストが失敗する。
- 型検査・ビルド・関連テスト・配布パッケージ試験・実行した実機試験の結果を個別に記録する。
- 今回AgenticReplay側の自動変換は別途有効化する。kiokuko-dshのこの対応が未配布である間は非互換が残る。
- この修正はKiokuko本体の`replay-extract.ts`を修正しない。両方のPLANは別々に完了確認する。
- 対象リポジトリに書き込み可能な環境で実装する。DSH本体や本番記録の変更、commit・push・公開は本PLANだけでは実行しない。

コミットメッセージ案：`fix(agenticreplay): validate gzip blobs through private bounded reads`
