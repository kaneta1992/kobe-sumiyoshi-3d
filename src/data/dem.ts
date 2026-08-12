/**
 * 標高タイル（地理院 DEM5A / dem_png）の取得とデコード。
 * デコード式（data-spec.md §2）:
 *   v = R*65536 + G*256 + B
 *   v == 8388608 (2^23) → 無効値
 *   v > 8388608        → v -= 16777216 (2^24)
 *   h = v * 0.01 [m]
 */
import {
    DEM_FALLBACK_URL,
    DEM_FALLBACK_Z,
    DEM_URL,
    DEM_Z,
    TILE_PX,
    tileUrl,
} from '../config';
import { latToTileY, lonToTileX, tileCoords, tileRange, type TileRange } from '../geo';
import { fetchTileImage, mapPool } from '../net/tiles';

const INVALID = 8388608;

interface DemLayer {
    z: number;
    /** キー "x/y" → 256×256 の標高[m]（無効値は NaN）。取得失敗タイルは保持しない */
    tiles: Map<string, Float32Array>;
}

function decodeTile(bitmap: ImageBitmap): Float32Array {
    const canvas = document.createElement('canvas');
    canvas.width = TILE_PX;
    canvas.height = TILE_PX;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('2D canvas context is unavailable');
    ctx.drawImage(bitmap, 0, 0, TILE_PX, TILE_PX);
    const rgba = ctx.getImageData(0, 0, TILE_PX, TILE_PX).data;
    const out = new Float32Array(TILE_PX * TILE_PX);
    for (let i = 0, p = 0; i < out.length; i++, p += 4) {
        let v = rgba[p] * 65536 + rgba[p + 1] * 256 + rgba[p + 2];
        if (v === INVALID) {
            out[i] = NaN;
            continue;
        }
        if (v > INVALID) v -= 16777216;
        out[i] = v * 0.01;
    }
    return out;
}

async function loadLayer(
    range: TileRange,
    template: string,
    onTile: () => void,
    signal?: AbortSignal,
): Promise<DemLayer> {
    const coords = [...tileCoords(range)];
    const tiles = new Map<string, Float32Array>();
    await mapPool(coords, async ({ x, y }) => {
        const bitmap = await fetchTileImage(tileUrl(template, range.z, x, y), signal);
        onTile();
        if (!bitmap) return; // E1: 404 は欠損として継続（フォールバック層が埋める）
        try {
            tiles.set(`${x}/${y}`, decodeTile(bitmap));
        } finally {
            bitmap.close();
        }
    });
    return { z: range.z, tiles };
}

/** グローバルピクセル座標から1点取得。タイル欠損・無効値は NaN */
function texel(layer: DemLayer, gx: number, gy: number): number {
    const tx = Math.floor(gx / TILE_PX);
    const ty = Math.floor(gy / TILE_PX);
    const tile = layer.tiles.get(`${tx}/${ty}`);
    if (!tile) return NaN;
    const px = gx - tx * TILE_PX;
    const py = gy - ty * TILE_PX;
    return tile[py * TILE_PX + px];
}

/** 双線形補間。有効な角だけで加重平均する（欠損混じりでも破綻しない） */
function sampleLayer(layer: DemLayer, lon: number, lat: number): number {
    const gx = lonToTileX(lon, layer.z) * TILE_PX - 0.5;
    const gy = latToTileY(lat, layer.z) * TILE_PX - 0.5;
    const x0 = Math.floor(gx);
    const y0 = Math.floor(gy);
    const fx = gx - x0;
    const fy = gy - y0;
    let sum = 0;
    let weight = 0;
    for (let j = 0; j < 2; j++) {
        for (let i = 0; i < 2; i++) {
            const w = (i ? fx : 1 - fx) * (j ? fy : 1 - fy);
            if (w <= 0) continue;
            const v = texel(layer, x0 + i, y0 + j);
            if (Number.isNaN(v)) continue;
            sum += v * w;
            weight += w;
        }
    }
    return weight > 0 ? sum / weight : NaN;
}

/** 標高サンプラ。緯度経度 → 標高[m] */
export type ElevationSampler = (lon: number, lat: number) => number;

export function countDemTiles(): number {
    const a = tileRange(DEM_Z);
    const b = tileRange(DEM_FALLBACK_Z);
    return a.nx * a.ny + b.nx * b.ny;
}

/**
 * DEM5A(z15) を主層、dem_png(z14) をフォールバック層として読み込む（E1）。
 * z14 は最大でも数枚なので常に読み、404 と無効値の両方をこれ一本で埋める。
 */
export async function loadElevationSampler(
    onTile: () => void,
    signal?: AbortSignal,
): Promise<ElevationSampler> {
    const [primary, fallback] = await Promise.all([
        loadLayer(tileRange(DEM_Z), DEM_URL, onTile, signal),
        loadLayer(tileRange(DEM_FALLBACK_Z), DEM_FALLBACK_URL, onTile, signal),
    ]);
    if (primary.tiles.size === 0 && fallback.tiles.size === 0) {
        console.warn('[dem] 標高タイルを1枚も取得できなかったため平坦地形になります');
    }
    return (lon, lat) => {
        const h = sampleLayer(primary, lon, lat);
        if (!Number.isNaN(h)) return h;
        const f = sampleLayer(fallback, lon, lat);
        return Number.isNaN(f) ? 0 : f;
    };
}
