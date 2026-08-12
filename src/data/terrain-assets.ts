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
    GI_META_URL,
    GI_URL,
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

/** PNG を取って RGBA バイト列にする。寸法が合わなければ null（E58） */
async function fetchPixels(
    url: string,
    size: number,
    signal?: AbortSignal,
): Promise<Uint8ClampedArray | null> {
    let bitmap: ImageBitmap;
    try {
        const res = await fetch(url, { signal });
        if (!res.ok) return null;
        bitmap = await createImageBitmap(await res.blob());
    } catch (err) {
        console.warn(`[assets] ${url} を読めませんでした`, err);
        return null;
    }
    try {
        if (bitmap.width !== size || bitmap.height !== size) {
            console.warn(`[assets] ${url} の寸法がメタ情報と一致しません`);
            return null;
        }
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) return null;
        ctx.drawImage(bitmap, 0, 0);
        return ctx.getImageData(0, 0, size, size).data;
    } finally {
        bitmap.close();
    }
}

/**
 * ハイトマップ PNG を読む。値は R=上位バイト / G=下位バイトの 16bit
 * （canvas は 16bit PNG を 8bit に落としてしまうため、前処理側でこの形にしてある）。
 */
export async function loadHeightmap(signal?: AbortSignal): Promise<Heightmap | null> {
    const meta = await fetchJson<HeightmapMeta>(HEIGHTMAP_META_URL, signal);
    if (!meta) return null;
    const n = meta.size;
    const rgba = await fetchPixels(HEIGHTMAP_URL, n, signal);
    if (!rgba) return null;

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

/**
 * ベイクGI（契約07 追記1 / tools/lib/gi.mjs）。前処理で焼いた
 * 「空の可視率」と「1バウンス相当の間接光」をワールド座標で引く。
 *
 * 時刻には依存しない量だけが入っている。実行時は環境光・太陽色で変調して使う
 * （src/world/sun.ts の ambientColor / bounceColor）。
 */
export interface GiMap {
    size: number;
    /** 高い方のサンプルを取った高さ[m]（地表からの相対） */
    eyeHigh: number;
    /**
     * 地表からの相対高さ h[m] における空の可視率（0=完全に塞がれている）。
     * 焼いてあるのは地表付近と +eyeHigh の2枚で、そのあいだは補間、
     * それより上は開けている側へ寄せる
     */
    skyAt(x: number, z: number, h: number): number;
    /** 1バウンス相当の間接光の受光量（0..bounceScale 相当を 0..1 で返す） */
    bounceAt(x: number, z: number): number;
}

interface GiMeta {
    version: number;
    size: number;
    areaHalf: number;
    eyeHigh: number;
    bounceScale: number;
}

export async function loadGi(signal?: AbortSignal): Promise<GiMap | null> {
    const meta = await fetchJson<GiMeta>(GI_META_URL, signal);
    if (!meta) return null;
    const n = meta.size;
    const rgba = await fetchPixels(GI_URL, n, signal);
    if (!rgba) return null;

    // sqrt 圧縮で焼いてあるので二乗で戻す（暗部の分解能を確保するため）
    const decode = new Float32Array(256);
    for (let i = 0; i < 256; i++) decode[i] = (i / 255) ** 2;

    const half = meta.areaHalf || AREA_HALF;
    const step = (half * 2) / (n - 1);
    /** 双線形補間して channel（0=空/1=バウンス/2=空+eyeHigh）を読む */
    const sample = (x: number, z: number, channel: number): number => {
        const fx = Math.min(Math.max((x + half) / step, 0), n - 1);
        const fz = Math.min(Math.max((z + half) / step, 0), n - 1);
        const col = Math.min(Math.floor(fx), n - 2);
        const row = Math.min(Math.floor(fz), n - 2);
        const tx = fx - col;
        const tz = fz - row;
        const p00 = (row * n + col) * 4 + channel;
        const p10 = p00 + 4;
        const p01 = p00 + n * 4;
        return (
            decode[rgba[p00]] * (1 - tx) * (1 - tz) +
            decode[rgba[p10]] * tx * (1 - tz) +
            decode[rgba[p01]] * (1 - tx) * tz +
            decode[rgba[p01 + 4]] * tx * tz
        );
    };

    const eyeHigh = meta.eyeHigh || 8;
    return {
        size: n,
        eyeHigh,
        skyAt(x, z, h) {
            const low = sample(x, z, 0);
            if (h <= 0) return low;
            const high = sample(x, z, 2);
            if (h >= eyeHigh) {
                // さらに上は空が開けていく。屋根・樹冠が真っ黒にならないための外挿
                const t = Math.min(1, (h - eyeHigh) / (eyeHigh * 2));
                return high + (1 - high) * t * 0.7;
            }
            return low + (high - low) * (h / eyeHigh);
        },
        bounceAt(x, z) {
            return sample(x, z, 1);
        },
    };
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
