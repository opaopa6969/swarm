# swarm — MCP 化調査（Phase 1）

## 概要

`swarm` は純粋 ESM・零依存・単ファイル（`index.js` 229 行）の粒子／軽量流体シミュレーションエンジンライブラリ。重力・ドラッグ・curl-ish 風・flutter・渦で数千粒子を決定論的に駆動し、結果を flat typed-array buffer（`Float64Array`）として host renderer に渡す。three.js / canvas / DOM への依存なし。M1 完了（gravity / drag / wind / flutter / vortex / seeded emit / lifetime cull / optional z 軸）、M2 SPH-lite と M3 collision は TODO。

## 判定と理由

**判定: `skip`（対応しない）**

1. **純粋ライブラリ設計**: in-process import が前提。零依存・単ファイル 229 行で `Field` クラスと `mulberry32` 関数のみ export。HTTP API も CLI も MCP も持たない。
2. **操作が sub-ms**: `emit` / `step` / `positions` は全てマイクロ秒オーダー。HTTP + JSON serialization のオーバーヘッドが計算自体を超える。常駐サーバ化の性能利点がない。
3. **出力が renderer 前提**: 返り値は `Float64Array` の flat positions（`[x0,y0, x1,y1, ...]`）。renderer なしでは agent に actional でない（数値の羅列を返しても意思決定に使えない）。
4. **決定論性は in-process でこそ意味がある**: seeded PRNG + fixed dt で byte-identical 再現を実現しているが、MCP 越しだと stateless 呼出ごとに `Field` を再構築する必要があり state 管理が複雑化する。
5. **sibling パターンの一貫性**: `motion-engine`・`xpbd-body` も全て volta 未登録の import 型ライブラリ。ゲームエンジン群は in-process import が意図された設計。
6. **netmahg M4 は直接 import**: DESIGN.md の M4 計画では `netmahg` が swarm を直接 import して季節演出・勝利バースト・水しぶきを実装する。MCP 越しではなく import が適切。

## 公開候補

| kind | name | io | 副作用 | 長時間 | 備考 |
|------|------|----|--------|--------|------|
| tool | `emit` | `{n, pos, spread, vel, velJitter, life, ...}` → count | write | No | seeded 確定性付き spawn。しかし in-process でないと意味がない |
| tool | `step` | `dt` → positions/velocities 更新 | write | No | forces → integrate → age/cull。sub-ms |
| tool | `positions` | void → `Float64Array` | read | No | flat `[x0,y0, ...]`。renderer なしでは agent に actional でない |
| tool | `bench` | `[warmup] [measure] [particles]` → JSON | read | Yes | `bench.mjs` で十分。MCP 化の価値なし |
| resource | `spec` | `swarm://spec` | — | — | 能力の機械可読仕様 |
| resource | `guide` | `swarm://guide` | — | — | 使い方 |
| resource | `design` | `swarm://design` | — | — | DESIGN.md の内容 |
| skill | `particle-effect-recipe` | locality: repo | — | — | 粒子エフェクトの組み立て方 |

※ `skip` 判定のため、これらは候補の記録であり実装しない。

## 組み合わせ例

1. `swarm__step → showcase__search_cases`（パーティクル演出に合う映像表現を検索）— ただし swarm は in-process import 前提なので MCP 越しの組合せは非現実的
2. `swarm__emit + swarm__step` を netmahg の勝利演出に組み込む — これは MCP ではなく直接 import で行うべき（M4 計画通り）
3. `swarm__bench → kamishibai__validate` のようにベンチ結果を動画化 — しかし `node bench.mjs` で十分

## 依存と協調

| 相手 repo | 向き | 能力 | 今あるか | 備考 |
|-----------|------|------|----------|------|
| netmahg | provides_to | `Field` / `emit` / `step`（M4 host wiring で季節演出・勝利バースト・水しぶき） | Yes | volta 登録済み（https://mahjong.unlaxer.org）だが MCP なし。swarm は直接 import される設計 |
| motion-engine | provides_to | sibling engine — 独立リポジトリ | No | volta 未登録。in-process import 型ライブラリ |
| xpbd-body | provides_to | sibling engine — 独立リポジトリ | No | 同上 |

協調が必要な相手はいない。swarm は他の MCP 入口に依存せず、他に入口を提供することもない。

## ライブラリのサーバ化

該当しない（`needed: false`）。純粋計算ライブラリで、サーバ化に必要な新規実装（healthz, PORT, volta.service.json, systemd unit, MCP server）を追加する価値がない。

## リスク

- **出力が renderer 前提**: `Float64Array` の flat positions を MCP で返しても agent に actional でない
- **ラップコスト > 計算コスト**: 各操作が sub-ms なので HTTP/Serde ラップのオーバーヘッドが計算自体を超える
- **決定論性の複雑化**: MCP 越しだと stateless 呼出ごとに Field を再構築する必要がある
- **未実装マイルストーン**: M2 SPH-lite / M3 collision が未実装 — 完了前の MCP 化は価値が薄い
- **ライセンス**: MIT（問題なし）
- **秘密情報・課金・破壊的操作**: なし（純粋計算ライブラリ）

## 持ち主への質問

1. M2 SPH-lite 完了後に再評価する価値があるか？ — 水しぶきシミュレーションを agent から叩ける意義は、renderer 連携が MCP で解決できない限り薄い
2. sibling engine 群（motion-engine, xpbd-body）を含めて「ゲームエンジン群の MCP ファサード」を作る構想はあるか？ — 個別サーバ化より統合入口の方が意味がある可能性
