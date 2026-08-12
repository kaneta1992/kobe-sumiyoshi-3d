/**
 * 地理院標高タイル（DEM5A z15 / dem_png z14）を Node 側で読む。
 * 用途は2つだけ:
 *   - 50cm データが届かない外周・欠損セルの穴埋め（契約02 E1）
 *   - DSM/DEM 由来の地表面高との突き合わせ検証（契約02 E10）
 * デコード式は docs/data-spec.md §2、クライアント実装（src/data/dem.ts）と同じ。
 */
import { latToTileY, lonToTileX, tileCoords, tileRange } from '../../src/shared/geo.js';
import { fetchRetry } from './net.mjs';
import { decodePng } from './png.mjs';

const TILE_PX = 256;
const INVALID = 8388608;

const LAYERS = [
    { z: 15, url: 'https://cyberjapandata.gsi.go.jp/xyz/dem5a_png/{z}/{x}/{y}.png' },
    { z: 14, url: 'https://cyberjapandata.gsi.go.jp/xyz/dem_png/{z}/{x}/{y}.png' },
];

async function loadLayer(z, template, margin) {
    const range = tileRange(z, margin);
    const tiles = new Map();
    for (const { x, y } of tileCoords(range)) {
        const url = template.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y));
        const res = await fetchRetry(url);
        if (!res) continue; // 404 は欠損として次の層に任せる
        const img = decodePng(Buffer.from(await res.arrayBuffer()));
        if (img.width !== TILE_PX || img.height !== TILE_PX) continue;
        const out = new Float32Array(TILE_PX * TILE_PX);
        const ch = img.channels;
        for (let i = 0; i < out.length; i++) {
            const p = i * ch;
            let v = img.data[p] * 65536 + img.data[p + 1] * 256 + img.data[p + 2];
            if (v === INVALID) {
                out[i] = NaN;
                continue;
            }
            if (v > INVALID) v -= 16777216;
            out[i] = v * 0.01;
        }
        tiles.set(`${x}/${y}`, out);
    }
    return { z, tiles };
}

function texel(layer, gx, gy) {
    const tx = Math.floor(gx / TILE_PX);
    const ty = Math.floor(gy / TILE_PX);
    const tile = layer.tiles.get(`${tx}/${ty}`);
    if (!tile) return NaN;
    return tile[(gy - ty * TILE_PX) * TILE_PX + (gx - tx * TILE_PX)];
}

function sampleLayer(layer, lon, lat) {
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

/**
 * 標高サンプラを作る。緯度経度 → 標高[m]（取得できなければ NaN）
 * @param {number} margin
 * @returns {Promise<(lon: number, lat: number) => number>}
 */
export async function loadGsiElevation(margin) {
    const layers = [];
    for (const l of LAYERS) layers.push(await loadLayer(l.z, l.url, margin));
    const counts = layers.map((l) => l.tiles.size).join('/');
    console.log(`[gsi] 標高タイル取得: z15/z14 = ${counts} 枚`);
    if (layers.every((l) => l.tiles.size === 0)) {
        throw new Error('地理院標高タイルを1枚も取得できませんでした（E10の検証ができません）');
    }
    return (lon, lat) => {
        for (const layer of layers) {
            const h = sampleLayer(layer, lon, lat);
            if (!Number.isNaN(h)) return h;
        }
        return NaN;
    };
}
