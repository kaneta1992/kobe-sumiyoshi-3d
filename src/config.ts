/**
 * ワールド定数（docs/data-spec.md の凍結仕様に対応）。
 * ここに書かれた URL・ズーム・座標は実測検証済みのため変更しないこと。
 */

/** ワールド原点: 神戸市東灘区住吉山手九丁目11番 */
export const ORIGIN_LON = 135.252243;
export const ORIGIN_LAT = 34.740726;

/** エリアは原点中心の正方形 2400m × 2400m */
export const AREA_HALF = 1200;

/** 地形メッシュの1辺頂点数（512×512 目安） */
export const TERRAIN_VERTS = 512;

/** タイルのズームレベル（data-spec.md §2〜§4） */
export const DEM_Z = 15;
export const DEM_FALLBACK_Z = 14;
export const PHOTO_Z = 17;
export const VECTOR_Z = 16;

/** タイルURL（拡張子は実測済み: DEM=.png / 写真=.jpg / ベクトル=.pbf） */
export const DEM_URL = 'https://cyberjapandata.gsi.go.jp/xyz/dem5a_png/{z}/{x}/{y}.png';
export const DEM_FALLBACK_URL = 'https://cyberjapandata.gsi.go.jp/xyz/dem_png/{z}/{x}/{y}.png';
export const PHOTO_URL = 'https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg';
export const VECTOR_URL = 'https://cyberjapandata.gsi.go.jp/xyz/optimal_bvmap-v1/{z}/{x}/{y}.pbf';

/** ラスタタイルの一辺ピクセル数 */
export const TILE_PX = 256;

/** 同時fetch数 */
export const FETCH_CONCURRENCY = 8;

/** bvmap の建物分類コード（data-spec.md §4） */
export const BLD_ORDINARY = 3101;
export const BLD_FIREPROOF = 3102;
export const BLD_NO_WALL = 3111;

/** エリア外の地物を捨てる余裕幅[m] */
export const CULL_MARGIN = 120;

export function tileUrl(template: string, z: number, x: number, y: number): string {
    return template.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y));
}
