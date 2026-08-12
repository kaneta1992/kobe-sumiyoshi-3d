/**
 * bvmap（optimal_bvmap-v1 z16）の建物ポリゴンと道路中心線を Node 側で取得する。
 * デコード自体はクライアントと共有のモジュールを呼ぶ（契約02 E12: 同じ頂点座標から
 * 同じ footprintKey が出ないと前処理した高さが引けない。契約08: 同じ中心線・同じ幅員で
 * カービングしないと路面と地形がずれる）。
 */
import { CULL_MARGIN, VECTOR_Z, tileCoords, tileRange } from '../../src/shared/geo.js';
import { readBuildingShapes } from '../../src/shared/bvmap-buildings.js';
import { readRoadLines } from '../../src/shared/bvmap-roads.js';
import { fetchRetry } from './net.mjs';

const URL_TEMPLATE = 'https://cyberjapandata.gsi.go.jp/xyz/optimal_bvmap-v1/{z}/{x}/{y}.pbf';

/**
 * タイルは1枚につき1回だけ取得し、BldA と RdCL の両方を読む。
 * @returns {Promise<{ shapes: any[], roads: any[], tilesOk: number, tilesFailed: number }>}
 */
export async function loadVectorFeatures() {
    const range = tileRange(VECTOR_Z, CULL_MARGIN);
    const shapes = [];
    const roads = [];
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
        const buf = await res.arrayBuffer();
        for (const s of readBuildingShapes(buf, x, y)) shapes.push(s);
        for (const r of readRoadLines(buf, x, y)) roads.push(r);
    }
    const bridges = roads.filter((r) => r.bridge).length;
    console.log(
        `[bvmap] タイル ${tilesOk}枚 / 失敗 ${tilesFailed}枚 → 建物 ${shapes.length}件 / ` +
            `道路 ${roads.length}本（うち橋 ${bridges}本）`,
    );
    return { shapes, roads, tilesOk, tilesFailed };
}
