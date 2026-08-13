---
name: kobe-sumiyoshi-3d-dev
description: 神戸・住吉山手3D街歩きアプリ（kobe-sumiyoshi-3d）の開発を引き継ぐための設計思想・アーキテクチャ・ドメイン知見・落とし穴。当プロジェクトのコードを変更する前に必ず読む。
---

# kobe-sumiyoshi-3d 開発引き継ぎ

## プロジェクト概要

神戸市東灘区住吉山手9-11（lon 135.252243, lat 34.740726）を中心とする2.4km四方の実在の町を、
実測オープンデータからブラウザ上に3D再現し、徒歩・車・P2Pマルチプレイで歩き回れるWebアプリ。
- 公開: https://kaneta1992.github.io/kobe-sumiyoshi-3d/ （GitHub Pages、mainへのpushで自動デプロイ）
- リポジトリ: kaneta1992/kobe-sumiyoshi-3d（public）
- 品質目標: AAA志向のライティング / **Pixel 7a 30fps・デスクトップ60fps**（ユーザー明示要件）
- 経緯・裁定の全記録: orchestration-log.md と .claude/contracts/01〜05（各契約末尾の「実装後追記」が正）

## 最重要のドメイン前提

1. **神戸市はPLATEAU未整備**（2026-08時点、4経路で検証済み — orchestration-log参照）。データは以下の合成:
   - 地形: 兵庫県50cmメッシュDEM（前処理済みアセット）+ 地理院DEM5Aフォールバック
   - 建物footprint/道路: 地理院 最適化ベクトルタイル optimal_bvmap-v1 z16（実行時fetch）
   - 建物実高さ・樹木37,987本: 兵庫県50cm DSM/DEMのnDSMから前処理で算出
   - 航空写真: seamlessphoto z17（**拡張子.jpg**。.pngは404）
   - URL・デコード式・座標系は docs/data-spec.md に凍結済み（実測検証済み — 探し直さない）
2. **ライセンス表記は法的必須**: 「地理院タイル（国土地理院）」+ 兵庫県CC-BY改変クレジット（index.html内。消すな）
3. **決定性が生命線**: Math.random()禁止（grepがCIゲート）。建物・樹木・色はすべて座標由来ハッシュ。
   マルチプレイは「ワールドは全員同一」を前提に動的な物だけを同期している。

## アーキテクチャ

- Vite + TypeScript + three.js（**three/webgpu 単一エントリ**。addonsは使わない — コア二重ロードとinstanceof不一致を起こす）。WebGL2自動フォールバック（?webgl で強制）
- src/data/ = データ取得・デコード、src/world/ = 描画（terrain/buildings/roads/vegetation/props/hlod）、
  src/game/ = 物理・操作（physics/character/vehicle/input/avatar）、src/net/ = マルチプレイ、src/ui/ = HUD類
- 前処理: tools/build-terrain-assets.mjs（`npm run build:assets`）→ public/data/{heightmap.png, building-heights.json, trees.json}。
  図郭ZIP（1個252MB）は .cache/ にキャッシュ（git外）。座標変換はproj4の2次テイラー近似
- 性能設計: HLOD四分木（180/360/720m）+ 空間チャンクカリング + 樹木3段LOD（共有InstancedMeshの詰め直し方式）+
  動的解像度スケーリング + mobile/desktop品質プリセット（自動判定・自動降格は一方通行）
- 物理: rapier3d-compat 0.12、固定60Hz・決定的。地形は描画と同一の1024ハイトフィールド
- マルチ: trystero v0.25（nostrのみ。torrent/mqttは削除済み）、12Hz送信+150ms補間、遠隔はゴースト（コライダーなし）

## 検証・運用

- L1ゲート: `npx tsc --noEmit` / `npm run build` / `grep -RIn "Math.random" src/ | grep -v "// allow"; test $? -eq 1`
- 動作確認URL: `?stats`（計測HUD）, `?walk`は廃止で既定が三人称, `?fly`（自由カメラ・物理なし）, `?quality=mobile`, `?webgl`, `?hour=17.5`, `?room=xxx`, `?solo`, `?spawn=x,z`（最寄り道路上に開始）, `?superman`（+Gキーで飛行デバッグ）, `?shot=1..6`（定点カメラ）, `?match`（トレジャーロワイヤル。検証は `?solo&match&matchauto&matchspeed=6&matchgoto=key`。他: ?matchseed/?matchspeed/?matchgoto=key|chest）
- マッチの設計の正は docs/game-design.md。src/match/{index,rules,objects,hud}.ts。配置はシード+mulberry32で全員再現、裁定のみホスト（最小ピアID）
- 渦森橋: ワールド座標 (x 82, z 132)。`?spawn=82,132` で直行
- 2タブマルチ検証: 各タブを一度前面にしてロード完了させること（裏タブは描画停止でワールド構築が進まない）
- コミットは日本語・機密スキャン後。契約ベース開発（.claude/contracts/、番号連番）

## 既知の落とし穴（実測で判明したもの）

- rapier3d-compat 0.12 の QueryFilterFlags は TS定義とWASMのビット配置がずれており、レイに指定すると全部外れる → 衝突グループで絞る
- rapier の currentVehicleSpeed() は符号がステップ毎に反転することがある → 剛体速度の正面射影で自前算出
- pbf v5 は `PbfReader` named export（v3の default `Pbf` と非互換）
- 道路ドレープは**+0.03m**（契約08で0.32mから縮小）。前処理で道路コリドーの地形を縦断プロファイルへカービングしてハイトマップに焼いてある — 道路の高さを変えたいときは**必ず前処理側**（tools/lib/road-carve.mjs + src/shared/road-profile.js）を触る。クライアント側で縦断ソルバーを再適用してはいけない（pinned・二度掛けで路面が浮く）
- 橋は RdCL vt_code 下1桁3（2703/2713）。カービング除外・桁/高欄/橋脚は src/world/bridges.ts。橋上には電柱・下草を置かない
- 兵庫県DEMの集約は「最大値」でDSMと揃える（平均にすると崖・擁壁で偽の樹高が出る）
- 建物高さは[高さ, 測定時地面標高]の2値 — 急斜面で屋根の絶対高を固定するため。片方だけ使うと浮き/埋まりが出る
- L字建物はOBB屋根が破綻する → 充填率<0.74 or 短辺<1.4mは陸屋根に落とす
- GitHub Pages デプロイが self-signed certificate で稀に落ちる（GitHub側の一時障害）→ `gh run rerun <id> --failed`

## 未解決・次の課題

- three.webgpu 内部で起動時に `Cannot read properties of null (reading 'update')` が数回出る（?flyでも発生・実害未確認・契約03以前から）
- Pixel 7a 実機での30fps実測は未確認（エミュレーションではmobileプリセット60fps/draw81）
- デスクトップtier0の60fpsは内蔵GPU検証機では未達（自動降格で46-52fps維持。単体GPUでは要実測）
- 樹木・電柱にコライダーなし（すり抜ける）
- 車はプレイヤーごとにローカル1台。降車中の遠隔者の車は非表示（共有車両は未実装）
- 見た目の次の伸びしろ: 夜間窓明かり、KTX2圧縮、オクルージョンカリング、Blenderでの小物アセット（未インストール・ユーザー導入許可済み）

## ゲーム完成状態（2026-08-13）

- ?match = トレジャーロワイヤル完成形: 降下→安置3段収縮→アイテム（7種+イノシシ笛・千里眼=9種+切れ端）→鍵→宝箱→勝利→リマッチ。BOT最大8体（src/match/bots.ts・ホスト思考・別チャンネルbots配信）、ヘリ（src/game/helicopter.ts・アーケード積分）、イノシシ（src/match/wildlife.ts）、ディレクター（src/match/director.ts・リード<2で前倒し）
- 検証チートシート: ?solo&match&matchauto&matchspeed=6&matchseed=N&stats + matchgoto=key|chest|item|mimic|lookout + matchitem=door,stick,cape,tabi,umbrella,map,fog,whistle,eye|all + matchdebug + matchherd + matchlead=99
- 道路グラフ: src/world/road-graph.ts（A*・ノード2万）— BOTナビ以外にも流用可
