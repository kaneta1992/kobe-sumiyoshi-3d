/**
 * 兵庫県 50cmメッシュ DSM/DEM のインデックスタイル（ベクトルタイル）から、
 * 対象エリアを覆う図郭ZIPの URL を列挙する（docs/data-spec.md §4.5）。
 *
 * インデックスのポリゴン属性: MESH_NO（例 "05OG61"）と URL（図郭ZIPの直リンク）。
 */
import { VectorTile, classifyRings } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
    AREA_HALF,
    CULL_MARGIN,
    latToZ,
    lonToX,
    tileCoords,
    tileRange,
    tileXToLon,
    tileYToLat,
} from '../../src/shared/geo.js';
import { fetchRetry } from './net.mjs';
import { CACHE_DIR } from './paths.mjs';

const INDEX_Z = 16;
const INDEX_URL = {
    dsm: 'https://gic-hyogo.s3.ap-northeast-1.amazonaws.com/2022/Vectortile2026/dsm/{z}/{x}/{y}.pbf',
    dem: 'https://gic-hyogo.s3.ap-northeast-1.amazonaws.com/2022/Vectortile2026/dem/{z}/{x}/{y}.pbf',
};
const LAYER = { dsm: 'DSM', dem: 'DEM' };

/** 図郭ポリゴンとエリア矩形の交差判定に使う余裕幅[m]（bboxで粗く判定する） */
const LIMIT = AREA_HALF + CULL_MARGIN;

/**
 * @typedef {{ kind: 'dsm'|'dem', mesh: string, url: string, name: string }} Sheet
 */

/** @returns {Promise<Sheet[]>} */
async function fetchSheets(kind) {
    const range = tileRange(INDEX_Z, CULL_MARGIN);
    /** @type {Map<string, Sheet>} */
    const found = new Map();
    let tilesOk = 0;
    let tilesMissing = 0;

    for (const { x, y } of tileCoords(range)) {
        const url = INDEX_URL[kind]
            .replace('{z}', String(INDEX_Z))
            .replace('{x}', String(x))
            .replace('{y}', String(y));
        const res = await fetchRetry(url);
        if (!res) {
            // インデックスが無い区画（海側など）は欠損として続行する
            tilesMissing++;
            continue;
        }
        tilesOk++;
        const tile = new VectorTile(new PbfReader(await res.arrayBuffer()));
        const layer = tile.layers[LAYER[kind]];
        if (!layer) continue;
        for (let i = 0; i < layer.length; i++) {
            const f = layer.feature(i);
            const extent = f.extent;
            // 図郭ポリゴンの bbox がエリア矩形と重なるものだけ採用する
            let minX = Infinity;
            let maxX = -Infinity;
            let minZ = Infinity;
            let maxZ = -Infinity;
            for (const polygon of classifyRings(f.loadGeometry())) {
                for (const ring of polygon) {
                    for (const p of ring) {
                        const lon = tileXToLon(x + p.x / extent, INDEX_Z);
                        const lat = tileYToLat(y + p.y / extent, INDEX_Z);
                        const wx = lonToX(lon);
                        const wz = latToZ(lat);
                        if (wx < minX) minX = wx;
                        if (wx > maxX) maxX = wx;
                        if (wz < minZ) minZ = wz;
                        if (wz > maxZ) maxZ = wz;
                    }
                }
            }
            if (minX > LIMIT || maxX < -LIMIT || minZ > LIMIT || maxZ < -LIMIT) continue;
            const zipUrl = String(f.properties['URL'] ?? '');
            const mesh = String(f.properties['MESH_NO'] ?? '');
            if (!zipUrl.startsWith('http')) continue;
            const name = `${kind}-${mesh || zipUrl.split('/').pop()}`;
            found.set(zipUrl, { kind, mesh, url: zipUrl, name });
        }
    }

    console.log(
        `[sheets] ${kind}: インデックスタイル ${tilesOk}枚取得 / ${tilesMissing}枚欠損 → 図郭 ${found.size}件`,
    );
    return [...found.values()].sort((a, b) => a.url.localeCompare(b.url));
}

/**
 * 図郭一覧を取得する。結果は .cache/sheets.json にキャッシュされ、再実行では再取得しない。
 * @param {boolean} [force]
 * @returns {Promise<Sheet[]>}
 */
export async function resolveSheets(force = false) {
    const cachePath = join(CACHE_DIR, 'sheets.json');
    if (!force && existsSync(cachePath)) {
        /** @type {Sheet[]} */
        const cached = JSON.parse(readFileSync(cachePath, 'utf8'));
        console.log(`[sheets] キャッシュから ${cached.length} 図郭`);
        return cached;
    }
    const sheets = [...(await fetchSheets('dsm')), ...(await fetchSheets('dem'))];
    if (sheets.length === 0) {
        throw new Error('インデックスタイルから図郭を1件も列挙できませんでした');
    }
    writeFileSync(cachePath, JSON.stringify(sheets, null, 2));
    return sheets;
}
