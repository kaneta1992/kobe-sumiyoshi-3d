/**
 * bvmap（optimal_bvmap-v1 z16）の RdCL レイヤー → ローカル座標の道路中心線。
 *
 * bvmap-buildings.js と同じく **ブラウザと前処理スクリプトの両方から読み込まれる**。
 * 前処理（地形カービング）とクライアント（描画・物理）が同じ中心線・同じ幅員・
 * 同じ橋判定を見ないと、カービングした路面と描画した路面がずれる。デコードはここだけに置く。
 *
 * 橋・高架部の判定は docs/data-spec.md §4 の実測結果に従う:
 *   RdCL の vt_code は下1桁が 3 のもの（2703 通常道路の橋 / 2713 軽車道の橋）が橋・高架部。
 *   2701/2711/2721/2731 が通常部。
 */
import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import { AREA_HALF, CULL_MARGIN, VECTOR_Z, latToZ, lonToX, tileXToLon, tileYToLat } from './geo.js';

const LIMIT = AREA_HALF + CULL_MARGIN;

/**
 * 橋・高架部の vt_code か（2703 / 2713 など下1桁が3）。
 * @param {number} code @returns {boolean}
 */
export function isBridgeCode(code) {
    return code >= 2000 && code < 3000 && code % 10 === 3;
}

/**
 * 幅員属性 → メートル。"3m-5.5m未満" のようなレンジ文字列を数値化する。
 * 値が読めない場合は道路種別から控えめな既定値を使う。
 * @param {Record<string, string | number | boolean>} props @returns {number}
 */
export function parseWidth(props) {
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

/**
 * @param {ArrayBuffer} buffer タイルの生バイト列
 * @param {number} tx @param {number} ty タイル座標（z は VECTOR_Z 固定）
 * @returns {{ points: {x: number, z: number}[], width: number, bridge: boolean, code: number }[]}
 */
export function readRoadLines(buffer, tx, ty) {
    const tile = new VectorTile(new PbfReader(buffer));
    const layer = tile.layers['RdCL'];
    /** @type {{ points: {x: number, z: number}[], width: number, bridge: boolean, code: number }[]} */
    const lines = [];
    if (!layer) return lines;

    for (let i = 0; i < layer.length; i++) {
        const f = layer.feature(i);
        const code = Number(f.properties['vt_code'] ?? 0);
        const width = parseWidth(f.properties);
        const bridge = isBridgeCode(code);
        const extent = f.extent;
        for (const line of f.loadGeometry()) {
            if (line.length < 2) continue;
            const points = line.map((p) => {
                const lon = tileXToLon(tx + p.x / extent, VECTOR_Z);
                const lat = tileYToLat(ty + p.y / extent, VECTOR_Z);
                return { x: lonToX(lon), z: latToZ(lat) };
            });
            if (!points.some((p) => Math.abs(p.x) <= LIMIT && Math.abs(p.z) <= LIMIT)) continue;
            lines.push({ points, width, bridge, code });
        }
    }
    return lines;
}
