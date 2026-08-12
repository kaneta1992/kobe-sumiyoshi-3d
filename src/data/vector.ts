/**
 * 最適化ベクトルタイル（optimal_bvmap-v1 z16）のデコード。
 * BldA（建物ポリゴン）と RdCL（道路中心線）をローカル座標のジオメトリに変換する。
 * pbf v5 は PbfReader を named export する（data-spec.md §4 の実測注意書き）。
 */
import { VectorTile, classifyRings } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import { AREA_HALF, CULL_MARGIN, VECTOR_URL, VECTOR_Z, tileUrl } from '../config';
import { latToZ, lonToX, tileCoords, tileRange, tileXToLon, tileYToLat } from '../geo';
import { fetchTileBuffer, mapPool } from '../net/tiles';

export interface Point2 {
    x: number;
    z: number;
}

/** 建物: rings[0] が外周、rings[1..] が穴 */
export interface BuildingShape {
    rings: Point2[][];
    code: number;
}

export interface RoadLine {
    points: Point2[];
    width: number;
}

export interface VectorFeatures {
    buildings: BuildingShape[];
    roads: RoadLine[];
    tilesFailed: number;
}

export function countVectorTiles(): number {
    const r = tileRange(VECTOR_Z, CULL_MARGIN);
    return r.nx * r.ny;
}

const LIMIT = AREA_HALF + CULL_MARGIN;

function inArea(p: Point2): boolean {
    return Math.abs(p.x) <= LIMIT && Math.abs(p.z) <= LIMIT;
}

/**
 * 幅員属性 → メートル。"3m-5.5m未満" のようなレンジ文字列を数値化する。
 * 値が読めない場合は道路種別から控えめな既定値を使う。
 */
function parseWidth(props: Record<string, string | number | boolean>): number {
    const raw = props['vt_rnkwidth'] ?? props['vt_width'];
    if (typeof raw === 'number' && raw > 0) return Math.min(raw, 40);
    if (typeof raw === 'string') {
        const nums = raw.match(/\d+(?:\.\d+)?/g);
        if (nums && nums.length >= 2) return (Number(nums[0]) + Number(nums[1])) / 2;
        if (nums && nums.length === 1) {
            const n = Number(nums[0]);
            return raw.includes('未満') ? n * 0.75 : n;
        }
    }
    return props['vt_motorway'] ? 12 : 4;
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
    const tile = new VectorTile(new PbfReader(buf));

    const toWorld = (px: number, py: number, extent: number): Point2 => {
        const lon = tileXToLon(tx + px / extent, VECTOR_Z);
        const lat = tileYToLat(ty + py / extent, VECTOR_Z);
        return { x: lonToX(lon), z: latToZ(lat) };
    };

    const bld = tile.layers['BldA'];
    if (bld) {
        for (let i = 0; i < bld.length; i++) {
            const f = bld.feature(i);
            const code = Number(f.properties['vt_code'] ?? 0);
            const extent = f.extent;
            // 穴つきポリゴンに分解する（E7）
            for (const polygon of classifyRings(f.loadGeometry())) {
                const rings = polygon
                    .map((ring) => ring.map((p) => toWorld(p.x, p.y, extent)))
                    .filter((ring) => ring.length >= 4);
                if (rings.length === 0) continue;
                if (!rings[0].some(inArea)) continue;
                buildings.push({ rings, code });
            }
        }
    }

    const rd = tile.layers['RdCL'];
    if (rd) {
        for (let i = 0; i < rd.length; i++) {
            const f = rd.feature(i);
            const width = parseWidth(f.properties);
            const extent = f.extent;
            for (const line of f.loadGeometry()) {
                if (line.length < 2) continue;
                const points = line.map((p) => toWorld(p.x, p.y, extent));
                if (!points.some(inArea)) continue;
                roads.push({ points, width });
            }
        }
    }
}
