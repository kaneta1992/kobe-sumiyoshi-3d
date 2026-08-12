/**
 * 1mグリッドの DSM/DEM から配信アセットを作る。
 *   - 高精細ハイトマップ（16bit相当を R=上位/G=下位 に分けた PNG）
 *   - 建物ごとの実高さ（フットプリント内 nDSM の上位パーセンタイル）
 *   - 樹木（建物外の nDSM 極大点）
 * 生成物はすべて決定的。Math.random() は使わない（契約02 負の制約）。
 */
import { AREA_HALF, footprintKey, xToLon, zToLat } from '../../src/shared/geo.js';
import { CELL, GN, GRID_HALF, NO_DATA } from './xyz-raster.mjs';

/** ハイトマップの一辺ピクセル数 */
export const HEIGHTMAP_SIZE = 2048;

/** 建物高さの下限・上限[m]（E11: 負値・電線やクレーンなどの外れ値を抑える） */
const BLD_MIN_H = 3;
const BLD_MAX_H = 60;
/** フットプリント内 nDSM のどこを屋根とみなすか */
const BLD_PERCENTILE = 0.85;

/**
 * 樹木とみなす nDSM の範囲[m] と、出力の上限本数。
 * 上限を超える突起は樹木ではない（鉄塔・崖の際・未登録の建物）ので落とす。
 */
const TREE_MIN_H = 3;
const TREE_MAX_H = 35;
const TREE_MAX_COUNT = 40000;

export const gridX = (col) => -GRID_HALF + col * CELL;
export const gridZ = (row) => -GRID_HALF + row * CELL;

/**
 * 地面グリッドを作り、欠損を近傍→地理院標高で埋める（E1）。
 * @param {Float32Array} demMax
 * @param {(lon: number, lat: number) => number} gsi
 * @returns {{ ground: Float32Array, filledNeighbour: number, filledGsi: number, native: number }}
 */
export function buildGround(demMax, gsi) {
    const ground = new Float32Array(GN * GN);
    let native = 0;
    for (let i = 0; i < ground.length; i++) {
        if (demMax[i] !== NO_DATA) {
            ground[i] = demMax[i];
            native++;
        } else {
            ground[i] = NaN;
        }
    }

    // 1) 小さな穴は周囲8近傍の平均で埋める（数回まわす）。継ぎ目に段差を作らないため
    let filledNeighbour = 0;
    for (let pass = 0; pass < 4; pass++) {
        const patch = [];
        for (let row = 0; row < GN; row++) {
            for (let col = 0; col < GN; col++) {
                const i = row * GN + col;
                if (!Number.isNaN(ground[i])) continue;
                let sum = 0;
                let n = 0;
                for (let dr = -1; dr <= 1; dr++) {
                    for (let dc = -1; dc <= 1; dc++) {
                        const r = row + dr;
                        const c = col + dc;
                        if (r < 0 || r >= GN || c < 0 || c >= GN) continue;
                        const v = ground[r * GN + c];
                        if (!Number.isNaN(v)) {
                            sum += v;
                            n++;
                        }
                    }
                }
                if (n >= 3) patch.push(i, sum / n);
            }
        }
        if (patch.length === 0) break;
        for (let k = 0; k < patch.length; k += 2) {
            ground[patch[k]] = patch[k + 1];
            filledNeighbour++;
        }
    }

    // 2) 残った広い欠損（エリア外周など）は地理院 DEM5A で埋める
    let filledGsi = 0;
    for (let row = 0; row < GN; row++) {
        for (let col = 0; col < GN; col++) {
            const i = row * GN + col;
            if (!Number.isNaN(ground[i])) continue;
            const h = gsi(xToLon(gridX(col)), zToLat(gridZ(row)));
            ground[i] = Number.isNaN(h) ? 0 : h;
            filledGsi++;
        }
    }
    return { ground, filledNeighbour, filledGsi, native };
}

/**
 * nDSM = DSM − 地面。DSM 欠損セルは NaN、負値は 0 に寄せる（E11）。
 * @param {Float32Array} dsmMax @param {Float32Array} ground
 */
export function buildNdsm(dsmMax, ground) {
    const ndsm = new Float32Array(GN * GN);
    let valid = 0;
    for (let i = 0; i < ndsm.length; i++) {
        const d = dsmMax[i];
        if (d === NO_DATA) {
            ndsm[i] = NaN;
            continue;
        }
        const v = d - ground[i];
        ndsm[i] = v < 0 ? 0 : v;
        valid++;
    }
    return { ndsm, valid };
}

/** グリッドを双線形補間して読む（エリア外は端にクランプ） */
function sampleGrid(grid, x, z) {
    const fx = Math.min(Math.max((x + GRID_HALF) / CELL, 0), GN - 1);
    const fz = Math.min(Math.max((z + GRID_HALF) / CELL, 0), GN - 1);
    const col = Math.min(Math.floor(fx), GN - 2);
    const row = Math.min(Math.floor(fz), GN - 2);
    const tx = fx - col;
    const tz = fz - row;
    const h00 = grid[row * GN + col];
    const h10 = grid[row * GN + col + 1];
    const h01 = grid[(row + 1) * GN + col];
    const h11 = grid[(row + 1) * GN + col + 1];
    return h00 * (1 - tx) * (1 - tz) + h10 * tx * (1 - tz) + h01 * (1 - tx) * tz + h11 * tx * tz;
}

/**
 * ハイトマップ画素値（Uint16）を作る。
 * @param {Float32Array} ground
 * @returns {{ rgb: Uint8Array, meta: object }}
 */
export function buildHeightmap(ground) {
    const N = HEIGHTMAP_SIZE;
    const step = (AREA_HALF * 2) / (N - 1);
    const values = new Float32Array(N * N);
    let hMin = Infinity;
    let hMax = -Infinity;
    for (let row = 0; row < N; row++) {
        const z = -AREA_HALF + row * step;
        for (let col = 0; col < N; col++) {
            const h = sampleGrid(ground, -AREA_HALF + col * step, z);
            values[row * N + col] = h;
            if (h < hMin) hMin = h;
            if (h > hMax) hMax = h;
        }
    }
    // 量子化幅は 1cm 未満に収まる（標高レンジ 400m 程度 / 65535）
    const scale = (hMax - hMin) / 65535 || 1e-6;
    const rgb = new Uint8Array(N * N * 3);
    for (let i = 0; i < values.length; i++) {
        const v = Math.max(0, Math.min(65535, Math.round((values[i] - hMin) / scale)));
        rgb[i * 3] = v >> 8;
        rgb[i * 3 + 1] = v & 0xff;
    }
    return {
        rgb,
        meta: {
            version: 1,
            size: N,
            areaHalf: AREA_HALF,
            /** h = hMin + (R*256 + G) * scale */
            hMin,
            scale,
            hMax,
            source: '兵庫県 50cmメッシュ DEM（2021〜2022年度） / 欠損は地理院 DEM5A',
        },
    };
}

/**
 * 多角形（穴つき）を 1m グリッドへ走査変換する。even-odd 規則。
 * @param {{x: number, z: number}[][]} rings
 * @returns {{ col0: number, row0: number, w: number, h: number, mask: Uint8Array } | null}
 */
function rasterizePolygon(rings) {
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const ring of rings) {
        for (const p of ring) {
            if (p.x < minX) minX = p.x;
            if (p.x > maxX) maxX = p.x;
            if (p.z < minZ) minZ = p.z;
            if (p.z > maxZ) maxZ = p.z;
        }
    }
    const col0 = Math.max(0, Math.floor((minX + GRID_HALF) / CELL) - 1);
    const col1 = Math.min(GN - 1, Math.ceil((maxX + GRID_HALF) / CELL) + 1);
    const row0 = Math.max(0, Math.floor((minZ + GRID_HALF) / CELL) - 1);
    const row1 = Math.min(GN - 1, Math.ceil((maxZ + GRID_HALF) / CELL) + 1);
    if (col1 < col0 || row1 < row0) return null;

    const w = col1 - col0 + 1;
    const h = row1 - row0 + 1;
    const mask = new Uint8Array(w * h);
    const xs = [];
    for (let r = 0; r < h; r++) {
        const z = gridZ(row0 + r);
        xs.length = 0;
        for (const ring of rings) {
            for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
                const a = ring[j];
                const b = ring[i];
                if (a.z === b.z) continue;
                if (z < Math.min(a.z, b.z) || z >= Math.max(a.z, b.z)) continue;
                xs.push(a.x + ((z - a.z) / (b.z - a.z)) * (b.x - a.x));
            }
        }
        if (xs.length < 2) continue;
        xs.sort((p, q) => p - q);
        for (let k = 0; k + 1 < xs.length; k += 2) {
            const cs = Math.max(col0, Math.ceil((xs[k] + GRID_HALF) / CELL));
            const ce = Math.min(col1, Math.floor((xs[k + 1] + GRID_HALF) / CELL));
            for (let c = cs; c <= ce; c++) mask[r * w + (c - col0)] = 1;
        }
    }
    return { col0, row0, w, h, mask };
}

function percentile(sorted, p) {
    if (sorted.length === 0) return NaN;
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * p)));
    return sorted[idx];
}

/**
 * 建物ごとの実高さを算出する。
 *
 * 出力は [高さ, 屋根の基準地表標高] の2値。高さだけだと斜面で屋根の絶対高が決まらず
 * （どの地面から測った高さなのかが曖昧）、クライアントで浮き・埋まりが出るため、
 * 測った地面の高さも一緒に渡す（契約02 E5-a）。
 *
 * @param {{rings: {x:number,z:number}[][], code: number}[]} shapes
 * @param {Float32Array} ndsm @param {Float32Array} ground
 * @returns {{ heights: Record<string, [number, number]>, buildingMask: Uint8Array, stats: object }}
 */
export function buildBuildingHeights(shapes, ndsm, ground) {
    /** @type {Record<string, [number, number]>} */
    const heights = {};
    const buildingMask = new Uint8Array(GN * GN);
    const rawHeights = [];
    let measured = 0;
    let noCoverage = 0;
    let clampedLow = 0;
    let clampedHigh = 0;

    for (const shape of shapes) {
        const raster = rasterizePolygon(shape.rings);
        if (!raster) {
            noCoverage++;
            continue;
        }
        const { col0, row0, w, h, mask } = raster;
        for (let r = 0; r < h; r++) {
            for (let c = 0; c < w; c++) {
                if (mask[r * w + c]) buildingMask[(row0 + r) * GN + (col0 + c)] = 1;
            }
        }

        // 輪郭1m侵食: 4近傍がすべて内側のセルだけ屋根とみなす（壁面・地面の混入を防ぐ）
        const collect = (eroded) => {
            const vals = [];
            const bases = [];
            for (let r = 0; r < h; r++) {
                for (let c = 0; c < w; c++) {
                    if (!mask[r * w + c]) continue;
                    if (eroded) {
                        if (r === 0 || r === h - 1 || c === 0 || c === w - 1) continue;
                        if (
                            !mask[(r - 1) * w + c] ||
                            !mask[(r + 1) * w + c] ||
                            !mask[r * w + c - 1] ||
                            !mask[r * w + c + 1]
                        )
                            continue;
                    }
                    const idx = (row0 + r) * GN + (col0 + c);
                    const v = ndsm[idx];
                    if (!Number.isNaN(v)) {
                        vals.push(v);
                        bases.push(ground[idx]);
                    }
                }
            }
            return { vals, bases };
        };

        // 侵食後に点が少なすぎる小さな建物は、侵食なしで測る（E15）
        let got = collect(true);
        if (got.vals.length < 4) got = collect(false);
        const { vals, bases } = got;
        if (vals.length === 0) {
            noCoverage++;
            continue;
        }
        vals.sort((a, b) => a - b);
        bases.sort((a, b) => a - b);
        const base = percentile(bases, 0.5);
        const raw = percentile(vals, BLD_PERCENTILE);
        rawHeights.push(raw);
        let hgt = raw;
        if (hgt < BLD_MIN_H) {
            hgt = BLD_MIN_H;
            clampedLow++;
        } else if (hgt > BLD_MAX_H) {
            hgt = BLD_MAX_H;
            clampedHigh++;
        }
        heights[footprintKey(shape.rings[0], shape.code)] = [
            Math.round(hgt * 10) / 10,
            Math.round(base * 10) / 10,
        ];
        measured++;
    }

    rawHeights.sort((a, b) => a - b);
    const inRange = rawHeights.filter((v) => v >= BLD_MIN_H && v <= BLD_MAX_H).length;
    const stats = {
        shapes: shapes.length,
        measured,
        keys: Object.keys(heights).length,
        noCoverage,
        clampedLow,
        clampedHigh,
        rawInRangeRatio: rawHeights.length ? inRange / rawHeights.length : 0,
        p01: percentile(rawHeights, 0.01),
        median: percentile(rawHeights, 0.5),
        p95: percentile(rawHeights, 0.95),
        p99: percentile(rawHeights, 0.99),
        max: rawHeights.length ? rawHeights[rawHeights.length - 1] : NaN,
    };
    return { heights, buildingMask, stats };
}

/**
 * 樹木点を抽出する。建物外・nDSM≥3m の局所極大を、樹高に応じた最小間隔で間引く。
 * @param {Float32Array} ndsm @param {Uint8Array} buildingMask
 * @returns {{ trees: number[][], stats: object }}
 */
export function buildTrees(ndsm, buildingMask) {
    // 建物マスクを 2m 膨張させ、屋根の縁を樹木と誤認しないようにする
    const blocked = new Uint8Array(GN * GN);
    const R = 2;
    for (let row = 0; row < GN; row++) {
        for (let col = 0; col < GN; col++) {
            if (!buildingMask[row * GN + col]) continue;
            for (let dr = -R; dr <= R; dr++) {
                const r = row + dr;
                if (r < 0 || r >= GN) continue;
                for (let dc = -R; dc <= R; dc++) {
                    const c = col + dc;
                    if (c < 0 || c >= GN) continue;
                    blocked[r * GN + c] = 1;
                }
            }
        }
    }

    // 5×5 の局所極大だけを候補にする（同値は左上を優先して重複を避ける）
    const cand = [];
    let tooTall = 0;
    let thin = 0;
    const limit = AREA_HALF; // 出力はエリア内だけ
    for (let row = 2; row < GN - 2; row++) {
        const z = gridZ(row);
        if (Math.abs(z) > limit) continue;
        for (let col = 2; col < GN - 2; col++) {
            const i = row * GN + col;
            const v = ndsm[i];
            if (!(v >= TREE_MIN_H) || blocked[i]) continue;
            if (v > TREE_MAX_H) {
                tooTall++;
                continue;
            }
            const x = gridX(col);
            if (Math.abs(x) > limit) continue;
            // 5×5 の極大であること（同値は左上を優先）に加えて、まわりにも高さが
            // 続いていること = 樹冠の広がりを要求する。送電線や単発の異常反射は
            // 幅を持たないのでここで落ちる（E11）
            let isMax = true;
            let support = 0;
            for (let dr = -2; dr <= 2 && isMax; dr++) {
                for (let dc = -2; dc <= 2; dc++) {
                    if (dr === 0 && dc === 0) continue;
                    const u = ndsm[(row + dr) * GN + col + dc];
                    if (!(u <= v) || (u === v && (dr < 0 || (dr === 0 && dc < 0)))) {
                        isMax = false;
                        break;
                    }
                    if (u >= v * 0.5) support++;
                }
            }
            if (isMax && support >= 12) cand.push(i);
            else if (isMax) thin++;
        }
    }

    // 高い順（同高なら格子順）に採用。決定的に並べるので実行ごとに結果が変わらない
    cand.sort((a, b) => ndsm[b] - ndsm[a] || a - b);

    const pick = (radiusScale) => {
        const CELLSZ = 8;
        const buckets = new Map();
        const out = [];
        for (const i of cand) {
            const row = (i / GN) | 0;
            const col = i - row * GN;
            const x = gridX(col);
            const z = gridZ(row);
            const hgt = ndsm[i];
            const crown = Math.min(6, Math.max(1.5, hgt * 0.28)) * radiusScale;
            const bx = Math.floor(x / CELLSZ);
            const bz = Math.floor(z / CELLSZ);
            let ok = true;
            const reach = Math.ceil((crown + 6) / CELLSZ);
            for (let dz = -reach; dz <= reach && ok; dz++) {
                for (let dx = -reach; dx <= reach; dx++) {
                    const list = buckets.get(`${bx + dx}/${bz + dz}`);
                    if (!list) continue;
                    for (const t of list) {
                        const rr = Math.max(crown, t[3]);
                        if ((t[0] - x) ** 2 + (t[1] - z) ** 2 < rr * rr) {
                            ok = false;
                            break;
                        }
                    }
                    if (!ok) break;
                }
            }
            if (!ok) continue;
            const tree = [x, z, hgt, crown];
            out.push(tree);
            const key = `${bx}/${bz}`;
            const list = buckets.get(key);
            if (list) list.push(tree);
            else buckets.set(key, [tree]);
        }
        return out;
    };

    let scale = 1;
    let picked = pick(scale);
    while (picked.length > TREE_MAX_COUNT && scale < 8) {
        scale *= 1.25;
        picked = pick(scale);
    }

    const trees = picked.map((t) => [
        Math.round(t[0] * 10) / 10,
        Math.round(t[1] * 10) / 10,
        Math.round(t[2] * 10) / 10,
        Math.round(t[3] * 10) / 10,
    ]);
    trees.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
    return {
        trees,
        stats: { candidates: cand.length, count: trees.length, radiusScale: scale, tooTall, thin },
    };
}

export { sampleGrid };
