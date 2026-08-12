/**
 * 航空写真（地理院シームレス写真 z17）をエリア分だけ1枚のキャンバスに合成する。
 * 合成結果は Web Mercator のタイル座標系そのままなので、地形側は
 * 各頂点の緯度経度からタイル座標を求めて UV を作れば正確に貼れる。
 */
import { PHOTO_URL, PHOTO_Z, TILE_PX, tileUrl } from '../config';
import { tileCoords, tileRange, type TileRange } from '../geo';
import { fetchTileImage, mapPool } from '../net/tiles';

export interface AerialImage {
    canvas: HTMLCanvasElement;
    range: TileRange;
}

export function countPhotoTiles(): number {
    const r = tileRange(PHOTO_Z);
    return r.nx * r.ny;
}

export async function loadAerialImage(onTile: () => void, signal?: AbortSignal): Promise<AerialImage> {
    const range = tileRange(PHOTO_Z);
    const canvas = document.createElement('canvas');
    canvas.width = range.nx * TILE_PX;
    canvas.height = range.ny * TILE_PX;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas context is unavailable');
    // 欠損タイルが穴にならないよう下地を塗っておく（E1）
    ctx.fillStyle = '#5d6a4f';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const coords = [...tileCoords(range)];
    await mapPool(coords, async ({ x, y }) => {
        const bitmap = await fetchTileImage(tileUrl(PHOTO_URL, PHOTO_Z, x, y), signal);
        onTile();
        if (!bitmap) return;
        // 到着順不同でも位置は座標から決まるので合成は常に正しい（E3）
        try {
            ctx.drawImage(bitmap, (x - range.x0) * TILE_PX, (y - range.y0) * TILE_PX);
        } finally {
            bitmap.close();
        }
    });
    return { canvas, range };
}
