# 神戸・住吉山手 3D

兵庫県神戸市東灘区住吉山手周辺 **2.4km四方**の実在の地形・建物・道路を three.js で3D表示する Web アプリ。
将来的には GitHub Pages 上で「実在の町を歩き回れるマルチプレイ Web アプリ」にすることを目指しており、
本リポジトリはその描画基盤にあたる。

- ワールド原点: 住吉山手九丁目11番（lon 135.252243 / lat 34.740726、標高およそ 234m）
- エリア標高レンジ: 約 60m（南東の市街地側）〜 約 700m（北西の六甲山麓）

## 動かす

```sh
npm install
npm run dev      # http://localhost:5173/ を開く
npm run build    # dist/ に静的成果物を出力（GitHub Pages 用に base='./'）
npm run preview  # ビルド成果物の確認
npm run typecheck
```

初回表示時にタイル（標高 / 航空写真 / ベクトル）を約 170 枚取得するため、
ロード完了までネットワーク環境により十数秒かかる。進捗はローディング画面に表示される。

### 操作

| 操作 | 内容 |
| --- | --- |
| 左ドラッグ | 視点回転 |
| W / A / S / D | 前後左右移動 |
| Space / C（または E / Q） | 上下移動 |
| Shift | 加速 |
| ホイール | 移動速度の調整 |

`?webgl` を付けて開くと WebGL2 バックエンドを強制する（WebGPU 非対応環境の確認用）。
画面左上のステータスに、実際に選択されたバックエンドと建物・道路数、標高レンジが出る。

## 構成

```
src/
  config.ts          エリア・ズーム・タイルURL等の定数（docs/data-spec.md に対応）
  geo.ts             緯度経度 ⇔ ローカル座標(Y-up, m) ⇔ Web Mercator タイル座標
  camera.ts          簡易フライカメラ
  net/tiles.ts       タイル取得（並列・リトライ1回・失敗は null で継続）
  data/dem.ts        標高タイルのデコードと標高サンプラ（z15 主層 + z14 フォールバック）
  data/photo.ts      航空写真 z17 のキャンバス合成
  data/vector.ts     最適化ベクトルタイル（BldA / RdCL）のデコード
  world/terrain.ts   512×512 ハイトフィールドと地形メッシュ、getElevationAt
  world/buildings.ts 建物の押し出し（決定的ハッシュで高さ・色を決める）
  world/roads.ts     道路中心線のリボン化
  world/environment.ts 空・太陽光・フォグ
  world/index.ts     ワールド構築の入口、進捗/完了イベント
  ui/loading.ts      ローディング進捗UI
```

### 後続タスク向けの接続点

- `world/index.ts` の `worldEvents`（`EventTarget`）が `progress` と `ready` を発火する。
  物理スポーン等は `ready` を購読してから開始すること。
- `World.getElevationAt(x, z)` で任意地点の地表標高[m]が取れる（接地判定・スポーン位置決定用）。
- データ取得層（`net/` `data/`）は描画に依存していないので、コライダー生成などから再利用できる。

## データ出典

本アプリは以下を利用しています。利用にあたっては出典表示が条件のため、画面内に常時クレジットを表示しています。

- [地理院タイル（国土地理院）](https://maps.gsi.go.jp/development/ichiran.html)
  - 標高タイル DEM5A（`dem5a_png`）／ 10mメッシュ標高（`dem_png`）
  - 全国最新写真（シームレス）（`seamlessphoto`）
  - 最適化ベクトルタイル（`optimal_bvmap-v1`）

建物の高さはベクトルタイルに属性が無いため、建物分類コードとフットプリント面積からの推定値であり、
実際の建物高さとは一致しません。
