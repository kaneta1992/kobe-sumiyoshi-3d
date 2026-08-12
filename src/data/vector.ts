/**
 * 最適化ベクトルタイル（optimal_bvmap-v1 z16）のデコード。
 * BldA（建物ポリゴン）と RdCL（道路中心線）をローカル座標のジオメトリに変換する。
 * pbf v5 は PbfReader を named export する（data-spec.md §4 の実測注意書き）。
 *
 * BldA / RdCL のデコードはどちらも前処理スクリプトと共有する
 * （src/shared/bvmap-buildings.js / src/shared/bvmap-roads.js）。
 */
import { CULL_MARGIN, VECTOR_URL, VECTOR_Z, tileUrl } from '../config';
import { tileCoords, tileRange } from '../geo';
import { readBuildingShapes } from '../shared/bvmap-buildings.js';
import type { SharedBuildingShape, SharedPoint2 } from '../shared/bvmap-buildings.js';
import { readRoadLines } from '../shared/bvmap-roads.js';
import type { SharedRoadLine } from '../shared/bvmap-roads.js';
import { fetchTileBuffer, mapPool } from '../net/tiles';

export type Point2 = SharedPoint2;

/** 建物: rings[0] が外周、rings[1..] が穴 */
export type BuildingShape = SharedBuildingShape;

/** 道路中心線。bridge = true は橋・高架部（vt_code 2703/2713） */
export type RoadLine = SharedRoadLine;

export interface VectorFeatures {
    buildings: BuildingShape[];
    roads: RoadLine[];
    tilesFailed: number;
}

export function countVectorTiles(): number {
    const r = tileRange(VECTOR_Z, CULL_MARGIN);
    return r.nx * r.ny;
}

export async function loadVectorFeatures(
    onTile: () => void,
    signal?: AbortSignal,
): Promise<VectorFeatures> {
    const range = tileRange(VECTOR_Z, CULL_MARGIN);
    const coords = [...tileCoords(range)];
    const buildings: BuildingShape[] = [];
    const roads: RoadLine[] = [];
    let tilesFailed = 0;

    await mapPool(coords, async ({ x, y }) => {
        const buf = await fetchTileBuffer(tileUrl(VECTOR_URL, VECTOR_Z, x, y), signal);
        onTile();
        if (!buf) {
            tilesFailed++;
            return; // E1: 建物タイルが欠けても停止しない
        }
        try {
            readTile(buf, x, y, buildings, roads);
        } catch (err) {
            // 壊れたタイルは黙って捨てる（描画は継続する）
            tilesFailed++;
            console.warn('[vector] decode failed:', x, y, err);
        }
    });

    return { buildings, roads, tilesFailed };
}

function readTile(
    buf: ArrayBuffer,
    tx: number,
    ty: number,
    buildings: BuildingShape[],
    roads: RoadLine[],
): void {
    // 穴つきポリゴンへの分解（E7）・幅員/橋の判定・エリア外カリングは共有モジュール側で行う
    for (const shape of readBuildingShapes(buf, tx, ty)) buildings.push(shape);
    for (const line of readRoadLines(buf, tx, ty)) roads.push(line);
}
