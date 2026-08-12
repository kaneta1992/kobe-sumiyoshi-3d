/** src/shared/geo.js の型。実体を変えたらこちらも直すこと。 */

export declare const ORIGIN_LON: number;
export declare const ORIGIN_LAT: number;
export declare const AREA_HALF: number;
export declare const CULL_MARGIN: number;
export declare const VECTOR_Z: number;

export declare function lonToX(lon: number): number;
export declare function latToZ(lat: number): number;
export declare function xToLon(x: number): number;
export declare function zToLat(z: number): number;

export interface AreaBounds {
    west: number;
    east: number;
    south: number;
    north: number;
}
export declare function areaBounds(margin?: number): AreaBounds;

export declare function lonToTileX(lon: number, z: number): number;
export declare function latToTileY(lat: number, z: number): number;
export declare function tileXToLon(tx: number, z: number): number;
export declare function tileYToLat(ty: number, z: number): number;

export interface TileRange {
    z: number;
    x0: number;
    y0: number;
    nx: number;
    ny: number;
}
export declare function tileRange(z: number, margin?: number): TileRange;
export declare function tileCoords(range: TileRange): Generator<{ x: number; y: number }>;

export declare function footprintKey(
    outerRing: readonly { x: number; z: number }[],
    code: number,
): string;
