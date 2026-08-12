/**
 * 座標変換ユーティリティ。
 *
 * 実体は src/shared/geo.js にある（前処理スクリプト tools/** と共有するため。
 * 建物高さマップのキーを両者で一致させるには変換が完全に同一である必要がある）。
 * ここはクライアント側の従来の import パスを保つための再エクスポート。
 */
export {
    areaBounds,
    footprintKey,
    latToTileY,
    latToZ,
    lonToTileX,
    lonToX,
    tileCoords,
    tileRange,
    tileXToLon,
    tileYToLat,
    xToLon,
    zToLat,
} from './shared/geo.js';

export type { AreaBounds, TileRange } from './shared/geo.js';
