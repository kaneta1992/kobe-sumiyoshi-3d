# 契約01: プロジェクト雛形 + ワールド描画（地形・航空写真・建物・道路）

ダイヤル: Opus向けゴール委譲（内部設計は委ねる。E転写・合格基準・出力契約・エスカレーションは厳守）

## 目的

- 要求: Vite + TypeScript + three.js のプロジェクト雛形を C:\Users\kanet\nine に構築し、神戸市東灘区住吉山手周辺 2.4km四方の実在地形・建物・道路を3D表示する。
- ゴール: GitHub Pages で公開する「実在の町を歩き回れるマルチプレイWebアプリ」の描画基盤。後続タスク（徒歩物理・車両・P2P同期）がこの上に載る。
- 成功条件: `npm run dev` でブラウザに住吉山手〜渦森台の地形（航空写真テクスチャ）と押し出し建物・道路が表示され、自由カメラで見回せる。`npm run build` が静的成果物を出力する。

## コンテキスト（これを読め。探すな）

- **詳細仕様: C:\Users\kanet\nine\docs\data-spec.md（凍結済み・URL/数式は実測検証済み）**。ここに書かれたURL・タイル座標・デコード式・座標系・ライセンス表記義務にすべて従うこと
- 対象ディレクトリ: C:\Users\kanet\nine（雛形は空ディレクトリからの新規。既存の orchestration-log.md / docs / .claude / .git はそのまま残す）
- Node v24 / npm 11 利用可

## 実装ガイド（設計は委ねるが、以下は決定事項）

- Vite + TypeScript + three.js（最新安定版）。フレームワーク（React等）は**使わない**（素のTS + three.js）
- レンダラー: WebGPURenderer（three/webgpu）を使い WebGL2 自動フォールバックに任せる。ただし動作が不安定なら WebGLRenderer に切り替えてよい（決定を報告に含める）
- ライティング基礎: 太陽光 DirectionalLight + シャドウ、空（three.jsの Sky アドオン等）、ヘミスフィアライト、距離フォグ、ACESトーンマッピング。品質の磨き込みは後続タスク — 破綻なく自然に見えるレベルでよい
- カメラ: 当面 OrbitControls もしくは簡易フライカメラ（WASD+マウス）。原点（住吉山手9-11上空）から町を見下ろす初期配置
- 地形: DEM z15 タイルからハイトマップ生成 → グリッドメッシュ（エリア全体で頂点 512×512 目安）。航空写真 z17 を合成した1枚テクスチャ（4096px目安）を貼る
- 建物: bvmap BldA を押し出し。屋根/壁で色調を分け、決定的ハッシュで彩度・高さに揺らぎ。建物の足元は地形にめり込ませる（浮き対策: 基底を地形標高-1m）
- 道路: RdCL を幅員（vt_rnkwidth/vt_width）に応じたリボンメッシュ化し、地形に沿って少し浮かせてドレープ（z-fighting回避）。アスファルト色
- ローディングUI: タイル取得中の進捗表示（E2用: ロード完了イベントを後続タスクが購読できる形にする）
- データ取得層は後続タスク（物理コライダー生成）から再利用できるよう、描画と分離したモジュールにする（例: 地形の高さ取得関数 `getElevationAt(x,z)` をエクスポート）

## エッジケース（転写 — 実装前に確認し、必要なら En+1.. を追補せよ）

- E1: エリア端・データ欠損 — DEMタイル404/無効値(2^23)はフォールバック（dem_png z14 or 近傍補間）で継続。建物タイルが欠けても例外で停止しない
- E2: ロード完了前の状態 — ロード進捗UIと「ワールド準備完了」イベントを提供（後続の物理スポーンが購読する）
- E3: 非同期ストリーミング — タイル取得は並列・順不同で完了しても正しく合成されること。fetch失敗はリトライ1回
- E5-a: 建物の浮き/埋まり — 基底を地形標高より下げて解消。目視確認対象
- E5-b: WebGPU非対応 — WebGL2フォールバックで表示されること
- E5-c: タイルURL誤り — data-spec.md の実測済みURLをそのまま使う（拡張子: DEM=.png, 写真=.jpg, ベクトル=.pbf）
- E5-d: Vite base未設定でPages白画面 — `base: './'` を設定
- E5-e: pbf ライブラリのエクスポート形式差（data-spec.md §4 注意書き参照）

## スコープと負の制約

- 変更してよい: C:\Users\kanet\nine 配下の新規ファイル一式（package.json, vite.config.ts, src/**, index.html, .gitignore, README.md）
- 変更禁止: orchestration-log.md, docs/data-spec.md, .claude/**, .git/**
- **git commit は行わない**（コミットはメインが行う）
- npm パッケージ追加は three / @mapbox/vector-tile / pbf / vite / typescript 系のみ（物理・マルチプレイ系は入れない — 後続契約の担当）
- **出典表記**: 画面内に「地理院タイル（国土地理院）」を常時表示（data-spec.md §5 — 法的必須）
- Math.random() を建物生成に使わない（決定的ハッシュ必須 — data-spec.md §4）
- diff上限: 新規プロジェクトのため行数上限は設けないが、ファイル数は20以内を目安

## 合格基準（全て実行し、コマンドと exit code を報告に含めること）

実行シェル: bash（Git Bash）

- `cd /c/Users/kanet/nine && npm install` → exit 0
- `cd /c/Users/kanet/nine && npx tsc --noEmit` → exit 0
- `cd /c/Users/kanet/nine && npm run build` → exit 0 かつ `test -f dist/index.html` → exit 0
- `grep -RIn "Math.random" src/ | grep -v "// allow"; test $? -eq 1` → exit 0（建物生成の決定性）
- `grep -RIn "地理院タイル" src/ index.html; test $? -eq 0` → exit 0（出典表記の存在）
- ブラウザでの見た目検証（地形・建物の表示、E5-a）はメインが preview で実施する — dev サーバーの起動方法を報告に含めること

## 出力契約

最終報告は日本語で以下のみ、全体20行以内。詳細はファイルに書きパスを返す。

- status: success | failed | blocked
- files_changed（一覧 or ディレクトリ要約）
- commands_run（合格基準コマンドと exit code）
- summary（結論1〜3行。WebGPU/WebGLどちらになったか、追補したエッジケース）
- notes（スコープ外の発見）

## エスカレーション条件

以下に該当したら作業を進めず status: blocked で終了（推測で埋めることを禁止）:

- data-spec.md 記載のURLが実際には200を返さない（メインの疎通確認と矛盾）
- npm レジストリにアクセスできない / three.js の WebGPU まわりで data-spec.md の前提と根本的に矛盾する事象
- 合格基準を満たす見込みのない設計上の袋小路（理由と代替案を添えて blocked）
