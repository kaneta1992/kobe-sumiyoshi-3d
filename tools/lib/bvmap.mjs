/**
 * bvmap（optimal_bvmap-v1 z16）の建物ポリゴンを Node 側で取得する。
 * デコード自体はクライアントと共有のモジュールを呼ぶ（契約02 E12: 同じ頂点座標から
 * 同じ footprintKey が出ないと前処理した高さが引けない）。
 */
import { CULL_MARGIN, VECTOR_Z, tileCoords, tileRange } from '../../src/shared/geo.js';
import { readBuildingShapes } from '../../src/shared/bvmap-buildings.js';
import { fetchRetry } from './net.mjs';

const URL_TEMPLATE = 'https://cyberjapandata.gsi.go.jp/xyz/optimal_bvmap-v1/{z}/{x}/{y}.pbf';

/** @returns {Promise<{ shapes: any[], tilesOk: number, tilesFailed: number }>} */
export async function loadBuildingShapes() {
    const range = tileRange(VECTOR_Z, CULL_MARGIN);
    const shapes = [];
    let tilesOk = 0;
    let tilesFailed = 0;
    for (const { x, y } of tileCoords(range)) {
        const url = URL_TEMPLATE.replace('{z}', String(VECTOR_Z))
            .replace('{x}', String(x))
            .replace('{y}', String(y));
        const res = await fetchRetry(url);
        if (!res) {
            tilesFailed++;
            continue;
        }
        tilesOk++;
        for (const s of readBuildingShapes(await res.arrayBuffer(), x, y)) shapes.push(s);
    }
    console.log(`[bvmap] タイル ${tilesOk}枚 / 失敗 ${tilesFailed}枚 → 建物 ${shapes.length}件`);
    return { shapes, tilesOk, tilesFailed };
}
