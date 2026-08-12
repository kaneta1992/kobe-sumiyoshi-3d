/**
 * 座標変換ユーティリティ。
 * ローカル座標系は右手系 Y-up・単位メートル（data-spec.md §1）:
 *   x = (lon - lon0) * 111320 * cos(lat0)   （東 = +x）
 *   z = -(lat - lat0) * 111132              （北 = -z）
 */
import { AREA_HALF, ORIGIN_LAT, ORIGIN_LON } from './config';

const DEG = Math.PI / 180;
const M_PER_DEG_LAT = 111132;
const M_PER_DEG_LON = 111320 * Math.cos(ORIGIN_LAT * DEG);

export function lonToX(lon: number): number {
    return (lon - ORIGIN_LON) * M_PER_DEG_LON;
}

export function latToZ(lat: number): number {
    return -(lat - ORIGIN_LAT) * M_PER_DEG_LAT;
}

export function xToLon(x: number): number {
    return ORIGIN_LON + x / M_PER_DEG_LON;
}

export function zToLat(z: number): number {
    return ORIGIN_LAT - z / M_PER_DEG_LAT;
}

/** エリアの緯度経度バウンズ（余裕幅 margin[m] を加える） */
export function areaBounds(margin = 0): { west: number; east: number; south: number; north: number } {
    const half = AREA_HALF + margin;
    return {
        west: xToLon(-half),
        east: xToLon(half),
        south: zToLat(half),
        north: zToLat(-half),
    };
}

/** Web Mercator: 経度 → タイルX座標（小数） */
export function lonToTileX(lon: number, z: number): number {
    return ((lon + 180) / 360) * Math.pow(2, z);
}

/** Web Mercator: 緯度 → タイルY座標（小数） */
export function latToTileY(lat: number, z: number): number {
    const s = Math.sin(lat * DEG);
    return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * Math.pow(2, z);
}

/** Web Mercator: タイルX座標（小数） → 経度 */
export function tileXToLon(tx: number, z: number): number {
    return (tx / Math.pow(2, z)) * 360 - 180;
}

/** Web Mercator: タイルY座標（小数） → 緯度 */
export function tileYToLat(ty: number, z: number): number {
    const n = Math.PI - (2 * Math.PI * ty) / Math.pow(2, z);
    return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

export interface TileRange {
    z: number;
    x0: number;
    y0: number;
    nx: number;
    ny: number;
}

/** エリアを覆うタイル範囲を返す */
export function tileRange(z: number, margin = 0): TileRange {
    const b = areaBounds(margin);
    const x0 = Math.floor(lonToTileX(b.west, z));
    const x1 = Math.floor(lonToTileX(b.east, z));
    const y0 = Math.floor(latToTileY(b.north, z));
    const y1 = Math.floor(latToTileY(b.south, z));
    return { z, x0, y0, nx: x1 - x0 + 1, ny: y1 - y0 + 1 };
}

export function* tileCoords(range: TileRange): Generator<{ x: number; y: number }> {
    for (let dy = 0; dy < range.ny; dy++) {
        for (let dx = 0; dx < range.nx; dx++) {
            yield { x: range.x0 + dx, y: range.y0 + dy };
        }
    }
}
