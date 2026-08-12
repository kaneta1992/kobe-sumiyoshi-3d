#!/usr/bin/env node
/**
 * 兵庫県 50cmメッシュ DSM/DEM → 建物実高さ・高精細ハイトマップ・樹木 の前処理。
 *   npm run build:assets
 *
 * 4段構成で、各段は「やり終えたぶんは二度とやらない」ように作ってある（契約02 E3:
 * 1コマンドの実行時間に上限がある環境でも、何度か叩けば必ず先へ進む）。
 *   index    インデックスタイルから必要な図郭ZIPを列挙          → .cache/sheets.json
 *   download 図郭ZIPを取得（レジューム可・約2.2GB）              → .cache/zip/
 *   raster   XYZテキストを1mグリッドへ集約（図郭単位で再開可能） → .cache/grid/
 *   assets   グリッドから配信アセットを書き出す                  → public/data/
 *
 * 途中の段だけ回したいときは `--only=raster` のように指定する。
 */
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ORIGIN_LAT, ORIGIN_LON, xToLon, zToLat } from '../src/shared/geo.js';
import {
    HEIGHTMAP_SIZE,
    buildBuildingHeights,
    buildGround,
    buildHeightmap,
    buildNdsm,
    buildTrees,
    gridX,
    gridZ,
} from './lib/assets.mjs';
import { loadBuildingShapes } from './lib/bvmap.mjs';
import { downloadSheets, zipPath } from './lib/download.mjs';
import { loadGsiElevation } from './lib/gsi-dem.mjs';
import { encodePngRgb } from './lib/png.mjs';
import { GRID_DIR, OUT_DIR, ensureDirs } from './lib/paths.mjs';
import { resolveSheets } from './lib/sheets.mjs';
import { GN, GRID_MARGIN, NO_DATA, createGrids, rasterizeSheet } from './lib/xyz-raster.mjs';

/** グリッドの作り方を変えたら上げる。上げると .cache/grid が捨てられ作り直しになる */
const GRID_VERSION = 2;

const STATE_PATH = join(GRID_DIR, 'state.json');
const GRID_FILES = {
    dsmMax: join(GRID_DIR, 'dsm-max.f32'),
    demMax: join(GRID_DIR, 'dem-max.f32'),
};

function loadState() {
    if (!existsSync(STATE_PATH)) return { version: GRID_VERSION, done: [] };
    const s = JSON.parse(readFileSync(STATE_PATH, 'utf8'));
    if (s.version !== GRID_VERSION || s.gn !== GN) return { version: GRID_VERSION, done: [] };
    return s;
}

function loadGrids(state) {
    const grids = createGrids();
    if (state.done.length === 0) return grids;
    for (const [key, path] of Object.entries(GRID_FILES)) {
        if (!existsSync(path)) return createGrids();
        const buf = readFileSync(path);
        const view = new Uint8Array(grids[key].buffer);
        if (buf.length !== view.length) return createGrids();
        view.set(buf);
    }
    return grids;
}

function saveGrids(grids, state) {
    for (const [key, path] of Object.entries(GRID_FILES)) {
        writeFileSync(path, Buffer.from(grids[key].buffer, 0, grids[key].byteLength));
    }
    writeFileSync(STATE_PATH, JSON.stringify({ ...state, version: GRID_VERSION, gn: GN }));
}

// ---------------------------------------------------------------- raster 段

async function stageRaster(sheets) {
    const state = loadState();
    const pending = sheets.filter((s) => !state.done.includes(s.name));
    if (pending.length === 0) {
        console.log(`[raster] 全 ${sheets.length} 図郭は集約済み`);
        return;
    }
    const grids = loadGrids(state);
    console.log(`[raster] ${pending.length}/${sheets.length} 図郭を集約します`);
    for (const sheet of pending) {
        const t0 = Date.now();
        const r = await rasterizeSheet(zipPath(sheet), sheet.kind, grids);
        state.done.push(sheet.name);
        saveGrids(grids, state);
        console.log(
            `[raster] ${sheet.name}: 区画 ${r.entriesRead}読/${r.entriesSkipped}skip ` +
                `点 ${r.pointsUsed.toLocaleString('en-US')} (${((Date.now() - t0) / 1000).toFixed(1)}s)`,
        );
    }
}

// ---------------------------------------------------------------- assets 段

function median(values) {
    if (values.length === 0) return NaN;
    const s = Float64Array.from(values).sort();
    return s[s.length >> 1];
}

/** E10: 座標変換の検証。サンプル点が東灘区に落ちること + 地表面高が DEM5A と整合すること */
function verifyGeoreference(ground, gsi) {
    let outside = 0;
    const diffs = [];
    for (let row = 20; row < GN - 20; row += 37) {
        for (let col = 20; col < GN - 20; col += 37) {
            const lon = xToLon(gridX(col));
            const lat = zToLat(gridZ(row));
            if (!(lat > 34.72 && lat < 34.78 && lon > 135.23 && lon < 135.28)) outside++;
            const g = gsi(lon, lat);
            if (!Number.isNaN(g)) diffs.push(ground[row * GN + col] - g);
        }
    }
    const center = { lon: xToLon(0), lat: zToLat(0) };
    if (Math.abs(center.lon - ORIGIN_LON) > 1e-9 || Math.abs(center.lat - ORIGIN_LAT) > 1e-9) {
        throw new Error('ローカル原点の往復変換がずれています');
    }
    if (outside > 0) {
        throw new Error(`E10: サンプル点 ${outside} 個が東灘区の範囲外に落ちました`);
    }
    const med = median(diffs);
    const abs = diffs.map(Math.abs).sort((a, b) => a - b);
    return { median: med, p90: abs[Math.floor(abs.length * 0.9)] ?? NaN, samples: diffs.length };
}

async function stageAssets() {
    const state = loadState();
    const grids = loadGrids(state);
    let filled = 0;
    for (let i = 0; i < grids.dsmMax.length; i++) if (grids.dsmMax[i] !== NO_DATA) filled++;
    console.log(`[assets] DSM セル ${filled.toLocaleString('en-US')} / ${GN}x${GN}`);

    const gsi = await loadGsiElevation(GRID_MARGIN);

    // --- 地面と nDSM ---
    const { ground, filledNeighbour, filledGsi, native } = buildGround(grids.demMax, gsi);
    console.log(
        `[assets] 地面セル: 50cm由来 ${native.toLocaleString('en-US')} / ` +
            `近傍補間 ${filledNeighbour.toLocaleString('en-US')} / DEM5A補完 ${filledGsi.toLocaleString('en-US')}`,
    );
    const { ndsm, valid } = buildNdsm(grids.dsmMax, ground);
    console.log(`[assets] nDSM 有効セル ${valid.toLocaleString('en-US')}`);

    // --- E10 検証 ---
    const geo = verifyGeoreference(ground, gsi);
    console.log(
        `[検証 E10] DSM/DEM由来の地表 − 地理院DEM5A: 中央値 ${geo.median.toFixed(2)} m ` +
            `(|差|の90%点 ${geo.p90.toFixed(2)} m, ${geo.samples} 点)`,
    );
    if (!(Math.abs(geo.median) <= 3)) {
        throw new Error(`E10: 中央値差 ${geo.median.toFixed(2)}m が 3m を超えました`);
    }

    // --- ハイトマップ ---
    const { rgb, meta } = buildHeightmap(ground);
    const png = encodePngRgb(rgb, HEIGHTMAP_SIZE, HEIGHTMAP_SIZE);
    writeFileSync(join(OUT_DIR, 'heightmap.png'), png);
    writeFileSync(join(OUT_DIR, 'heightmap.json'), JSON.stringify(meta));
    console.log(
        `[assets] heightmap.png ${HEIGHTMAP_SIZE}x${HEIGHTMAP_SIZE} ${(png.length / 1048576).toFixed(2)}MB ` +
            `標高 ${meta.hMin.toFixed(1)}〜${meta.hMax.toFixed(1)}m (量子化 ${(meta.scale * 100).toFixed(2)}cm)`,
    );

    // --- 建物の実高さ ---
    const { shapes, tilesFailed } = await loadBuildingShapes();
    if (tilesFailed > 0) console.warn(`[assets] bvmap タイル ${tilesFailed} 枚が取得できませんでした`);
    const { heights, buildingMask, stats } = buildBuildingHeights(shapes, ndsm, ground);
    const matchRate = stats.shapes ? (stats.keys / stats.shapes) * 100 : 0;
    writeFileSync(
        join(OUT_DIR, 'building-heights.json'),
        JSON.stringify({ version: 1, count: stats.keys, heights }),
    );
    console.log(
        `[検証 E11] 建物高さ(生値) 中央値 ${stats.median.toFixed(1)}m / p1 ${stats.p01.toFixed(1)}m / ` +
            `p95 ${stats.p95.toFixed(1)}m / p99 ${stats.p99.toFixed(1)}m / 最大 ${stats.max.toFixed(1)}m、` +
            `[3,60]m に収まる割合 ${(stats.rawInRangeRatio * 100).toFixed(1)}%（範囲外は下限/上限へクランプ: ` +
            `低 ${stats.clampedLow} / 高 ${stats.clampedHigh}）`,
    );
    console.log(
        `[検証 E12] フットプリントハッシュ一致率 ${matchRate.toFixed(1)}% ` +
            `(${stats.keys}/${stats.shapes} 件、nDSM が届かず測れなかった建物 ${stats.noCoverage} 件)`,
    );
    if (matchRate < 80) {
        console.warn('[検証 E12] 一致率が 80% 未満です。要調査');
    }

    // --- 樹木 ---
    const { trees, stats: treeStats } = buildTrees(ndsm, buildingMask);
    writeFileSync(
        join(OUT_DIR, 'trees.json'),
        JSON.stringify({ version: 1, count: trees.length, trees }),
    );
    console.log(
        `[assets] trees.json ${trees.length.toLocaleString('en-US')} 本 ` +
            `(極大候補 ${treeStats.candidates.toLocaleString('en-US')}、` +
            `高すぎて除外 ${treeStats.tooTall.toLocaleString('en-US')}セル / ` +
            `幅が無く除外 ${treeStats.thin.toLocaleString('en-US')}点、` +
            `間隔係数 ${treeStats.radiusScale.toFixed(2)})`,
    );

    const total = ['heightmap.png', 'heightmap.json', 'building-heights.json', 'trees.json'].reduce(
        (a, f) => a + statSync(join(OUT_DIR, f)).size,
        0,
    );
    console.log(`[assets] public/data 合計 ${(total / 1048576).toFixed(2)} MB`);
    if (total > 50 * 1048576) {
        throw new Error('生成アセットが 50MB を超えました（間引き方針の見直しが必要）');
    }
}

// ---------------------------------------------------------------- 実行

async function main() {
    ensureDirs();
    const only = process.argv.find((a) => a.startsWith('--only='))?.slice(7);
    const wants = (name) => !only || only === name;

    const sheets = await resolveSheets(process.argv.includes('--force-index'));
    console.log(`[index] 図郭 ${sheets.length} 件（DSM/DEM 各 ${sheets.length / 2}）`);

    if (wants('download')) await downloadSheets(sheets);
    if (wants('raster')) await stageRaster(sheets);
    if (wants('assets')) await stageAssets();
}

main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
});
