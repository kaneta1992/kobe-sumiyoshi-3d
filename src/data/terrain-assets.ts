/**
 * 前処理（tools/build-terrain-assets.mjs）が作った静的アセットの読み込み。
 * 兵庫県 50cmメッシュ DSM/DEM 由来の高精細ハイトマップ・建物実高さ・樹木。
 *
 * どれも「無ければ無いなりに動く」ことを守る: public/data/ を配置していない状態でも
 * 地理院タイルだけで従来どおり表示できる（E16）。読み込み失敗は警告だけ出して null。
 */
import {
    AREA_HALF,
    BUILDING_HEIGHTS_URL,
    HEIGHTMAP_META_URL,
    HEIGHTMAP_URL,
    TREES_URL,
} from '../config';

interface HeightmapMeta {
    version: number;
    size: number;
    areaHalf: number;
    hMin: number;
    scale: number;
}

export interface Heightmap {
    size: number;
    /** ローカル座標の標高[m]。エリア外は端の値にクランプ */
    sampleAt(x: number, z: number): number;
}

/** 建物フットプリントのキー → [高さ[m], 屋根の基準となる地表標高[m]] */
export type BuildingHeightMap = Map<string, readonly [number, number]>;

export interface TreeInstance {
    x: number;
    z: number;
    height: number;
    crown: number;
}

async function fetchJson<T>(url: string, signal?: AbortSignal): Promise<T | null> {
    try {
        const res = await fetch(url, { signal });
        if (!res.ok) return null;
        return (await res.json()) as T;
    } catch {
        return null;
    }
}

/**
 * ハイトマップ PNG を読む。値は R=上位バイト / G=下位バイトの 16bit
 * （canvas は 16bit PNG を 8bit に落としてしまうため、前処理側でこの形にしてある）。
 */
export async function loadHeightmap(signal?: AbortSignal): Promise<Heightmap | null> {
    const meta = await fetchJson<HeightmapMeta>(HEIGHTMAP_META_URL, signal);
    if (!meta) return null;
    let bitmap: ImageBitmap;
    try {
        const res = await fetch(HEIGHTMAP_URL, { signal });
        if (!res.ok) return null;
        bitmap = await createImageBitmap(await res.blob());
    } catch (err) {
        console.warn('[assets] ハイトマップを読めませんでした', err);
        return null;
    }

    const n = meta.size;
    if (bitmap.width !== n || bitmap.height !== n) {
        console.warn('[assets] ハイトマップの寸法がメタ情報と一致しません');
        bitmap.close();
        return null;
    }
    const canvas = document.createElement('canvas');
    canvas.width = n;
    canvas.height = n;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) {
        bitmap.close();
        return null;
    }
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    const rgba = ctx.getImageData(0, 0, n, n).data;

    const heights = new Float32Array(n * n);
    for (let i = 0, p = 0; i < heights.length; i++, p += 4) {
        heights[i] = meta.hMin + (rgba[p] * 256 + rgba[p + 1]) * meta.scale;
    }

    const half = meta.areaHalf || AREA_HALF;
    const step = (half * 2) / (n - 1);
    const sampleAt = (x: number, z: number): number => {
        const fx = Math.min(Math.max((x + half) / step, 0), n - 1);
        const fz = Math.min(Math.max((z + half) / step, 0), n - 1);
        const col = Math.min(Math.floor(fx), n - 2);
        const row = Math.min(Math.floor(fz), n - 2);
        const tx = fx - col;
        const tz = fz - row;
        const h00 = heights[row * n + col];
        const h10 = heights[row * n + col + 1];
        const h01 = heights[(row + 1) * n + col];
        const h11 = heights[(row + 1) * n + col + 1];
        return h00 * (1 - tx) * (1 - tz) + h10 * tx * (1 - tz) + h01 * (1 - tx) * tz + h11 * tx * tz;
    };
    return { size: n, sampleAt };
}

export async function loadBuildingHeights(signal?: AbortSignal): Promise<BuildingHeightMap | null> {
    const data = await fetchJson<{ heights: Record<string, [number, number]> }>(
        BUILDING_HEIGHTS_URL,
        signal,
    );
    if (!data?.heights) return null;
    return new Map(Object.entries(data.heights));
}

export async function loadTrees(signal?: AbortSignal): Promise<TreeInstance[] | null> {
    const data = await fetchJson<{ trees: [number, number, number, number][] }>(TREES_URL, signal);
    if (!data?.trees) return null;
    return data.trees.map(([x, z, height, crown]) => ({ x, z, height, crown }));
}
