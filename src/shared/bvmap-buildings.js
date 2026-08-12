/**
 * bvmap（optimal_bvmap-v1 z16）の BldA レイヤー → ローカル座標の建物ポリゴン。
 *
 * geo.js と同じく **ブラウザと前処理スクリプトの両方から読み込まれる**。
 * 建物集合とその頂点座標が両者で完全に一致しないと footprintKey が食い違い、
 * 前処理で測った実高さが引けなくなる（契約02 E12）ので、デコードはここだけに置く。
 *
 * pbf v5 は PbfReader を named export する（docs/data-spec.md §4 の実測注意書き）。
 */
import { VectorTile, classifyRings } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import { AREA_HALF, CULL_MARGIN, VECTOR_Z, latToZ, lonToX, tileXToLon, tileYToLat } from './geo.js';

const LIMIT = AREA_HALF + CULL_MARGIN;

/**
 * @param {ArrayBuffer} buffer タイルの生バイト列
 * @param {number} tx @param {number} ty タイル座標（z は VECTOR_Z 固定）
 * @returns {{ rings: {x: number, z: number}[][], code: number }[]}
 */
export function readBuildingShapes(buffer, tx, ty) {
    const tile = new VectorTile(new PbfReader(buffer));
    const layer = tile.layers['BldA'];
    /** @type {{ rings: {x: number, z: number}[][], code: number }[]} */
    const shapes = [];
    if (!layer) return shapes;

    for (let i = 0; i < layer.length; i++) {
        const f = layer.feature(i);
        const code = Number(f.properties['vt_code'] ?? 0);
        const extent = f.extent;
        // 穴つきポリゴンに分解する
        for (const polygon of classifyRings(f.loadGeometry())) {
            const rings = polygon
                .map((ring) =>
                    ring.map((p) => {
                        const lon = tileXToLon(tx + p.x / extent, VECTOR_Z);
                        const lat = tileYToLat(ty + p.y / extent, VECTOR_Z);
                        return { x: lonToX(lon), z: latToZ(lat) };
                    }),
                )
                .filter((ring) => ring.length >= 4);
            if (rings.length === 0) continue;
            if (!rings[0].some((p) => Math.abs(p.x) <= LIMIT && Math.abs(p.z) <= LIMIT)) continue;
            shapes.push({ rings, code });
        }
    }
    return shapes;
}
