/**
 * ワールド定数（docs/data-spec.md の凍結仕様に対応）。
 * ここに書かれた URL・ズーム・座標は実測検証済みのため変更しないこと。
 *
 * 原点・エリア範囲・カリング幅・ベクトルタイルZは前処理スクリプトとの共有定義
 * （src/shared/geo.js）から取る。二重定義を作らないこと。
 */
export {
    AREA_HALF,
    CULL_MARGIN,
    ORIGIN_LAT,
    ORIGIN_LON,
    TERRAIN_VERTS,
    VECTOR_Z,
} from './shared/geo.js';

/** タイルのズームレベル（data-spec.md §2〜§4） */
export const DEM_Z = 15;
export const DEM_FALLBACK_Z = 14;
export const PHOTO_Z = 17;

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

/** 前処理で生成した高精細アセット（存在しなければ従来のタイル由来にフォールバックする） */
export const HEIGHTMAP_URL = 'data/heightmap.png';
export const HEIGHTMAP_META_URL = 'data/heightmap.json';
export const GI_URL = 'data/gi.png';
export const GI_META_URL = 'data/gi.json';
export const BUILDING_HEIGHTS_URL = 'data/building-heights.json';
export const TREES_URL = 'data/trees.json';

export function tileUrl(template: string, z: number, x: number, y: number): string {
    return template.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y));
}
