/**
 * ワールド定数と座標変換の唯一の定義元。
 *
 * このファイルは **ブラウザ（src/**）と前処理スクリプト（tools/**）の両方から
 * 読み込まれる**。前処理で作った建物高さマップのキーとクライアントが計算する
 * キーは、同じ座標変換・同じ量子化から導かれる必要があるため（契約02 E12）、
 * 実装をここに一本化して二重定義を作らないこと。
 *
 * TypeScript 側の型は同名の geo.d.ts が与える。片方だけ直すと型と実体がずれる。
 *
 * ローカル座標系は右手系 Y-up・単位メートル（docs/data-spec.md §1）:
 *   x = (lon - lon0) * 111320 * cos(lat0)   （東 = +x）
 *   z = -(lat - lat0) * 111132              （北 = -z）
 */

/** ワールド原点: 神戸市東灘区住吉山手九丁目11番 */
export const ORIGIN_LON = 135.252243;
export const ORIGIN_LAT = 34.740726;

/** エリアは原点中心の正方形 2400m × 2400m */
export const AREA_HALF = 1200;

/** エリア外の地物を捨てる余裕幅[m] */
export const CULL_MARGIN = 120;

/** 最適化ベクトルタイル（bvmap）のズーム */
export const VECTOR_Z = 16;

const DEG = Math.PI / 180;
const M_PER_DEG_LAT = 111132;
const M_PER_DEG_LON = 111320 * Math.cos(ORIGIN_LAT * DEG);

/** @param {number} lon @returns {number} */
export function lonToX(lon) {
    return (lon - ORIGIN_LON) * M_PER_DEG_LON;
}

/** @param {number} lat @returns {number} */
export function latToZ(lat) {
    return -(lat - ORIGIN_LAT) * M_PER_DEG_LAT;
}

/** @param {number} x @returns {number} */
export function xToLon(x) {
    return ORIGIN_LON + x / M_PER_DEG_LON;
}

/** @param {number} z @returns {number} */
export function zToLat(z) {
    return ORIGIN_LAT - z / M_PER_DEG_LAT;
}

/**
 * エリアの緯度経度バウンズ（余裕幅 margin[m] を加える）
 * @param {number} [margin]
 * @returns {{ west: number, east: number, south: number, north: number }}
 */
export function areaBounds(margin = 0) {
    const half = AREA_HALF + margin;
    return {
        west: xToLon(-half),
        east: xToLon(half),
        south: zToLat(half),
        north: zToLat(-half),
    };
}

/** Web Mercator: 経度 → タイルX座標（小数） @param {number} lon @param {number} z */
export function lonToTileX(lon, z) {
    return ((lon + 180) / 360) * Math.pow(2, z);
}

/** Web Mercator: 緯度 → タイルY座標（小数） @param {number} lat @param {number} z */
export function latToTileY(lat, z) {
    const s = Math.sin(lat * DEG);
    return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * Math.pow(2, z);
}

/** Web Mercator: タイルX座標（小数） → 経度 @param {number} tx @param {number} z */
export function tileXToLon(tx, z) {
    return (tx / Math.pow(2, z)) * 360 - 180;
}

/** Web Mercator: タイルY座標（小数） → 緯度 @param {number} ty @param {number} z */
export function tileYToLat(ty, z) {
    const n = Math.PI - (2 * Math.PI * ty) / Math.pow(2, z);
    return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

/**
 * エリアを覆うタイル範囲を返す
 * @param {number} z @param {number} [margin]
 * @returns {{ z: number, x0: number, y0: number, nx: number, ny: number }}
 */
export function tileRange(z, margin = 0) {
    const b = areaBounds(margin);
    const x0 = Math.floor(lonToTileX(b.west, z));
    const x1 = Math.floor(lonToTileX(b.east, z));
    const y0 = Math.floor(latToTileY(b.north, z));
    const y1 = Math.floor(latToTileY(b.south, z));
    return { z, x0, y0, nx: x1 - x0 + 1, ny: y1 - y0 + 1 };
}

/**
 * @param {{ z: number, x0: number, y0: number, nx: number, ny: number }} range
 * @returns {Generator<{ x: number, y: number }>}
 */
export function* tileCoords(range) {
    for (let dy = 0; dy < range.ny; dy++) {
        for (let dx = 0; dx < range.nx; dx++) {
            yield { x: range.x0 + dx, y: range.y0 + dy };
        }
    }
}

/**
 * 建物フットプリントの決定的キー（契約02 E12）。
 *
 * 前処理とクライアントで**同一の値**にならなければ高さが引けない。ずれを防ぐため:
 *   - 入力は必ず外周リング（rings[0]）のローカル座標そのまま
 *   - 0.1m 単位に量子化してから混ぜる。浮動小数の最下位ビット差（環境差）を吸収する
 *   - 出力は 48bit を base36 化した固定長10文字。JSON のキーとして短く保つ
 *
 * @param {readonly {x: number, z: number}[]} outerRing
 * @param {number} code bvmap の vt_code
 * @returns {string}
 */
export function footprintKey(outerRing, code) {
    let h1 = (0x811c9dc5 ^ code) | 0;
    let h2 = 0x01000193 | 0;
    for (let i = 0; i < outerRing.length; i++) {
        const qx = Math.round(outerRing[i].x * 10) | 0;
        const qz = Math.round(outerRing[i].z * 10) | 0;
        h1 = Math.imul(h1 ^ qx, 0x85ebca6b);
        h1 = (h1 << 13) | (h1 >>> 19);
        h2 = Math.imul(h2 ^ qz, 0xc2b2ae35);
        h2 = (h2 << 11) | (h2 >>> 21);
        h1 = Math.imul(h1 ^ h2, 0x27d4eb2f);
    }
    h1 ^= outerRing.length;
    h1 = Math.imul(h1 ^ (h1 >>> 16), 0x2545f491);
    h1 ^= h1 >>> 15;
    h2 = Math.imul(h2 ^ (h2 >>> 13), 0x9e3779b1);
    h2 ^= h2 >>> 16;
    // 48bit（h1 の 32bit + h2 の上位 16bit）。2^53 未満なので整数演算が正確
    const n = (h1 >>> 0) * 65536 + (h2 >>> 16);
    return n.toString(36).padStart(10, '0');
}
