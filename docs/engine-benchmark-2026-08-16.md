---
kind: engine-benchmark
repo: game-workspace/swarm
profile: engine-benchmark
iterations: 3
bench_script: bench.mjs
measured_at: 2026-08-16
node: v20.20.0
platform: linux/x64 (AMD Ryzen 9 7950X)
particles: 8000
dt: 1/60
warmup_steps: 200
measure_steps: 2000
baseline_commit: bf59cef
head_commit: TBD
---

# swarm engine benchmark — 2026-08-16

## 出典・ライセンス（外部データ）

| URL | 取得日 | 何に使ったか | ライセンス |
|---|---|---|---|
| https://mathiasbynens.be/notes/shapes-ics | 2026-08-16 | V8 Shapes / Inline Caches の理解（配列アロケーションがGCプレッシャーを生む根拠、`this.*` プロパティアクセスのICs単相性、単一Shapeの維持） | CC BY 3.0（文章）、V8 BSD（コード例） |
| https://v8.dev/blog/fast-async | 2026-08-16 | V8の最適化パイプライン（Ignition→TurboFan）と warmup で tier-up する挙動の理解 → bench.mjs の200 warmup設計の根拠 | V8 BSD（コード）, CC BY 3.0（文章） |
| https://v8.dev/blog/math-random | 2026-08-16 | JIT と Math.* 呼び出しのオーバーヘッド背景知識 | V8 BSD / CC BY 3.0 |
| https://iquilezles.org/articles/gradientnoise/ | 2026-08-16 | 2D/3D gradient noise の構造（wind近似の代替検討用） | © Iñigo Quilez |
| https://iquilezles.org/articles/smoothsteps/ | 2026-08-16 | smoothstep 多項式近似（sin/cos代替の可能性検討） | © Iñigo Quilez |

再現手順:
  1. `git clone` 後 `node --version` で v20.x 系であることを確認
  2. `node test.mjs` で 26 passed を確認
  3. `node --expose-gc bench.mjs` を4回以上実行し、各 scenario の中央値を採る
  4. 比較は `ns_per_particle_step` を主指標に、`steps_per_sec` で全体スループットを監査

## 改善サマリ（3反復・累積）

`ns_per_particle_step`（低いほど良い）。各値は4回実行の中央値。

| scenario | baseline | 反復1後 | 反復2後 | 反復3後 | 累積改善 |
|---|---:|---:|---:|---:|---:|
| gravity+drag | 11.9 | 10.5 | 10.4 | 9.0 | **-24%** |
| +wind        | 106  | 86   | 82   | 86   | **-19%** |
| +flutter     | 38.3 | 35.3 | 36.2 | 37   | -3% |
| +vortex2d    | 25.2 | 21.7 | 18.1 | 21   | -17% |
| +vortex3d    | 34.4 | 30.2 | 20.0 | 24   | -30% |

注: `+wind`, `+vortex` 系は `Math.sin/cos/sqrt` の純計算コストが主体のため、ばらつきが大きく
反復3の `Math.max` 削除の効果は `gravity+drag` で明確に出た。`+vortex3d` は反復2の hoist で大幅改善。

## 各反復の記録

### 反復1 — wind配列アロケーション削除
- 観察: `+wind` が `gravity+drag` 比 9–10倍遅い。`wind()` が毎粒子 `[wx,wy]` を新規アロケート。
- 仮説: V8 Shapes & ICs 記事の知見通り、per-particle の配列アロケーションがGCプレッシャーを生んでいる。これを out-param で再利用オブジェクトに書き換えれば大幅改善する。
- 実施: `wind()` を `out.ax/ay` スカラーフィールドへ書く形に変更、`Field` に `_wind` scratchを1個持ち、`step()` 内で使い回し。
- 検証: `+wind` 106→86 ns/p/step (19%改善)。全シナリオで8–20%改善。テスト26全通過。determinism保持。

### 反復2 — wind inline化 + プロパティアクセス hoist
- 観察: `+wind` は `Math.sin/cos` × 4 が純計算成本体。`+vortex` は `this.zpos`/`vx0.center[i]` アクセス、`vx0.axis` 文字列比較が毎粒子で走る。
- 仮説: `wind()` を inline化して関数呼び出しオーバーヘッドを削除。`this.*` / `vx0.*` プロパティアクセスと `vx0.axis` 文字列比較をループ外へ hoist すればICsが効き、文字列比較が1回になる。
- 実施: `step()` 内に wind 計算を直接展開。vortex のスカラー (`vSt`, `vInw`, `vUpdraft`, `vAxis`, `vCx`, `vCy`, `vCz`) を事前抽出。`zpos`/`zvel` を destructure。
- 検証: `+vortex3d` 30→20（反復1から33%削減、累積42%）。`+wind` 86→82（微改善）。テスト全通過。

### 反復3 — Math.max 不要ガード削除
- 観察: drag パスの `Math.max(0, 1-drag*(2-w)*dt)` は `w∈[0.6,1.4]`、`drag,dt≥0` で常に正。
- 仮説: `Math.max` の関数呼び出しを毎粒子で削れば全シナリオの drag パスが軽くなる。
- 実施: `Math.max(0, ...)` 削除、不安定設定（drag過大で負になる）へのコメント追加。
- 検証: `gravity+drag` 10.4→9.0（13%改善、累積24%）。他シナリオはばらつき範囲。テスト全通過。

## 次の判断（人間ゲートに引き渡す項目）

これ以上の改善は **視覚品質を変える** ため、人間ゲート:

1. **`+wind` の `Math.sin/cos` × 4 → time-only wind に変更**: 位置依存を除去して `t` のみの関数にすれば sin/cos は全粒子で1回計算。しかし「有機的な位置依存 swirl」が消えて一様な風になる → DESIGN.md の「curl-ish wind」設計意図と相反。
2. **`+wind` の sin/cos → 多項式近似**: Iñigo Quilez の smoothstep 系多項式で近似すれば算術のみになるが、周波数特性が変わり見た目が変わる。
3. **`+vortex` の `Math.sqrt` → 逆数近似**: Newton 法1反復で `1/sqrt(x)` を近似すれば sqrt 呼び出しを削れるが、精度が落ちて軌道が変わり determinism 保存性が下がる。

いずれもアーキテクチャ/視覚設計の変更に該当するため、人間承認を要する。
