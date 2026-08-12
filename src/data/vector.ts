/**
 * 最適化ベクトルタイル（optimal_bvmap-v1 z16）のデコード。
 * BldA（建物ポリゴン）と RdCL（道路中心線）と WA（水域）をローカル座標の
 * ジオメトリに変換する。
 * pbf v5 は PbfReader を named export する（data-spec.md §4 の実測注意書き）。
 *
 * BldA / RdCL のデコードはどちらも前処理スクリプトと共有する
 * （src/shared/bvmap-buildings.js / src/shared/bvmap-roads.js）。
 * WA は 2Dマップ（src/ui/map.ts）だけが使うのでここに置く（前処理は使わない）。
 */
import { VectorTile, classifyRings } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import { AREA_HALF, CULL_MARGIN, VECTOR_URL, VECTOR_Z, tileUrl } from '../config';
import { latToZ, lonToX, tileCoords, tileRange, tileXToLon, tileYToLat } from '../geo';
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

/** 水域ポリゴン（WA レイヤー・vt_code 5200）。rings[0] が外周、rings[1..] が穴 */
export interface WaterShape {
    rings: Point2[][];
}

export interface VectorFeatures {
    buildings: BuildingShape[];
    roads: RoadLine[];
    water: WaterShape[];
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
    const water: WaterShape[] = [];
    let tilesFailed = 0;

    await mapPool(coords, async ({ x, y }) => {
        const buf = await fetchTileBuffer(tileUrl(VECTOR_URL, VECTOR_Z, x, y), signal);
        onTile();
        if (!buf) {
            tilesFailed++;
            return; // E1: 建物タイルが欠けても停止しない
        }
        try {
            readTile(buf, x, y, buildings, roads, water);
        } catch (err) {
            // 壊れたタイルは黙って捨てる（描画は継続する）
            tilesFailed++;
            console.warn('[vector] decode failed:', x, y, err);
        }
    });

    return { buildings, roads, water, tilesFailed };
}

function readTile(
    buf: ArrayBuffer,
    tx: number,
    ty: number,
    buildings: BuildingShape[],
    roads: RoadLine[],
    water: WaterShape[],
): void {
    // 穴つきポリゴンへの分解（E7）・幅員/橋の判定・エリア外カリングは共有モジュール側で行う
    for (const shape of readBuildingShapes(buf, tx, ty)) buildings.push(shape);
    for (const line of readRoadLines(buf, tx, ty)) roads.push(line);
    for (const shape of readWaterShapes(buf, tx, ty)) water.push(shape);
}

/** エリア外の地物を捨てる境界[m]（共有デコーダと同じ扱い） */
const LIMIT = AREA_HALF + CULL_MARGIN;

/**
 * WA（水域）レイヤー → ローカル座標のポリゴン。住吉川・千丈谷川などが入る。
 * 建物と同じ穴つきポリゴン分解を使う（同じタイルバッファを読み直すだけで再fetchはしない）。
 */
function readWaterShapes(buffer: ArrayBuffer, tx: number, ty: number): WaterShape[] {
    const layer = new VectorTile(new PbfReader(buffer)).layers['WA'];
    const shapes: WaterShape[] = [];
    if (!layer) return shapes;

    for (let i = 0; i < layer.length; i++) {
        const f = layer.feature(i);
        const extent = f.extent;
        for (const polygon of classifyRings(f.loadGeometry())) {
            const rings: Point2[][] = [];
            for (const ring of polygon) {
                if (ring.length < 4) continue;
                const points: Point2[] = [];
                for (const p of ring) {
                    const lon = tileXToLon(tx + p.x / extent, VECTOR_Z);
                    const lat = tileYToLat(ty + p.y / extent, VECTOR_Z);
                    points.push({ x: lonToX(lon), z: latToZ(lat) });
                }
                rings.push(points);
            }
            if (rings.length === 0) continue;
            if (!rings[0].some((p) => Math.abs(p.x) <= LIMIT && Math.abs(p.z) <= LIMIT)) continue;
            shapes.push({ rings });
        }
    }
    return shapes;
}
