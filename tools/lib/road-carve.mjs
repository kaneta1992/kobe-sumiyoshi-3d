/**
 * 地形カービング（契約08）。道路コリドーの地面を縦断プロファイル標高へ吸着させ、
 * 外側へ滑らかに元地形へ戻す。ハイトマップを焼く前の 1m グリッドに対して行う。
 *
 * これで同時に2つ片づく:
 *   (a) 路面と地形の段差が消える（道路メッシュのドレープを 3〜5cm まで下げられる）
 *   (b) 路面上の細かな凹凸が消える（車の突き上げが無くなる）
 *
 * カービングは **建物高さ・nDSM・樹木を測る前** に行う。測定の基準地面が
 * カービング後の地面になるので、建物が浮いたり沈んだりしない（E43）。
 *
 * 橋（bridge）は対象外。谷は谷のまま残し、上を橋の桁が渡る（契約08 実装ガイド4）。
 */
import { AREA_HALF, TERRAIN_VERTS } from '../../src/shared/geo.js';
import { buildRoadProfiles } from '../../src/shared/road-profile.js';
import { CELL, GN, GRID_HALF } from './xyz-raster.mjs';

/** 路肩ぶんの余裕[m]。幅員の半分にこれを足した範囲を完全に平らにする */
const SHOULDER = 1.5;
/** どんなに細い道でも確保する平坦部の半幅[m]（地形グリッドの解像度に負けないため） */
const MIN_FLAT_HALF = 3.5;
/** 平坦部の外側で元地形へ戻すまでの距離[m] */
const FALLOFF = 4;
/**
 * 路面標高と元地形の差がこれを超えるセルは触らない[m]（崖・擁壁の上を走る道で
 * 法面や段々の宅地を大きく削り取らないための安全弁）。LO〜HI の間で滑らかに効きを落とす
 */
const DELTA_SOFT_LO = 3;
const DELTA_SOFT_HI = 6;

function smoothstep(edge0, edge1, x) {
    const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
    return t * t * (3 - 2 * t);
}

/**
 * @param {Float32Array} ground 1mグリッドの地面標高（破壊的に更新する）
 * @param {readonly {points: {x:number,z:number}[], heights: Float64Array, width: number, bridge: boolean, length: number}[]} paths
 * @returns {{ carvedLength: number, cells: number, maxDrop: number, maxRaise: number, skippedBySlope: number }}
 */
export function carveGround(ground, paths) {
    const size = GN * GN;
    const sumW = new Float32Array(size);
    const sumWH = new Float32Array(size);
    const maxW = new Float32Array(size);

    let carvedLength = 0;

    for (const path of paths) {
        if (path.bridge) continue;
        carvedLength += path.length;
        const flatHalf = Math.max(MIN_FLAT_HALF, path.width / 2 + SHOULDER);
        const reach = flatHalf + FALLOFF;
        for (let i = 0; i + 1 < path.points.length; i++) {
            const ax = path.points[i].x;
            const az = path.points[i].z;
            const bx = path.points[i + 1].x;
            const bz = path.points[i + 1].z;
            const ah = path.heights[i];
            const bh = path.heights[i + 1];
            const dx = bx - ax;
            const dz = bz - az;
            const segLenSq = dx * dx + dz * dz;
            if (segLenSq < 1e-8) continue;

            const col0 = Math.max(0, Math.floor((Math.min(ax, bx) - reach + GRID_HALF) / CELL));
            const col1 = Math.min(GN - 1, Math.ceil((Math.max(ax, bx) + reach + GRID_HALF) / CELL));
            const row0 = Math.max(0, Math.floor((Math.min(az, bz) - reach + GRID_HALF) / CELL));
            const row1 = Math.min(GN - 1, Math.ceil((Math.max(az, bz) + reach + GRID_HALF) / CELL));

            for (let row = row0; row <= row1; row++) {
                const z = -GRID_HALF + row * CELL;
                for (let col = col0; col <= col1; col++) {
                    const x = -GRID_HALF + col * CELL;
                    // 線分への最近点（t は 0..1 にクランプ）
                    let t = ((x - ax) * dx + (z - az) * dz) / segLenSq;
                    if (t < 0) t = 0;
                    else if (t > 1) t = 1;
                    const px = ax + dx * t;
                    const pz = az + dz * t;
                    const d = Math.hypot(x - px, z - pz);
                    if (d >= reach) continue;
                    const w = 1 - smoothstep(flatHalf, reach, d);
                    if (w <= 0) continue;
                    const h = ah + (bh - ah) * t;
                    const k = row * GN + col;
                    // 値は逆距離重み（Shepard）で混ぜる。近くを別の道が違う高さで
                    // 通っていても中心線の高さが引きずられない。谷間の宅地に多い
                    // 「6m隣を3m高い道が走る」配置で効く
                    const u = w / ((d + 0.35) * (d + 0.35));
                    sumW[k] += u;
                    sumWH[k] += u * h;
                    if (w > maxW[k]) maxW[k] = w;
                }
            }
        }
    }

    let cells = 0;
    let maxDrop = 0;
    let maxRaise = 0;
    let skippedBySlope = 0;
    for (let k = 0; k < size; k++) {
        const w = maxW[k];
        if (w <= 0) continue;
        const road = sumWH[k] / sumW[k];
        const delta = road - ground[k];
        const soft = 1 - smoothstep(DELTA_SOFT_LO, DELTA_SOFT_HI, Math.abs(delta));
        if (soft <= 0) {
            skippedBySlope++;
            continue;
        }
        const applied = delta * w * soft;
        ground[k] += applied;
        cells++;
        if (applied < -maxDrop) maxDrop = -applied;
        if (applied > maxRaise) maxRaise = applied;
    }

    return { carvedLength, cells, maxDrop, maxRaise, skippedBySlope };
}

/**
 * E47 / 段差・乗り心地の検証。**クライアントが実際に見る地表** を再現して測る:
 *   カービング済み1mグリッド → 2048pxハイトマップ（16bit量子化つき）
 *   → 1025点の地形グリッド（描画メッシュ = 物理ハイトフィールドと同じ刻み）
 *   → 双線形補間
 * その地表でクライアントと同じ手順（pinned）で縦断を解き、
 *   - gap  : 路面標高と地表の差 = 道路から降りる／戻るときの段差
 *   - grade: station 間の勾配変化[%] = 走ったときの突き上げ（カービング前後で比較）
 * を出す。
 *
 * @param {{rgb: Uint8Array, meta: {size:number, hMin:number, scale:number, areaHalf:number}}} heightmap
 * @param {readonly object[]} roads 元の道路中心線（bvmap 由来）
 * @param {(x: number, z: number) => number} beforeSample カービング前の地表
 */
export function verifyClientSurface(heightmap, roads, beforeSample) {
    const { rgb, meta } = heightmap;
    const n = meta.size;
    const hmStep = (meta.areaHalf * 2) / (n - 1);
    const hm = new Float32Array(n * n);
    for (let i = 0; i < hm.length; i++) {
        hm[i] = meta.hMin + (rgb[i * 3] * 256 + rgb[i * 3 + 1]) * meta.scale;
    }
    const bilinear = (grid, size, step, half, x, z) => {
        const fx = Math.min(Math.max((x + half) / step, 0), size - 1);
        const fz = Math.min(Math.max((z + half) / step, 0), size - 1);
        const col = Math.min(Math.floor(fx), size - 2);
        const row = Math.min(Math.floor(fz), size - 2);
        const tx = fx - col;
        const tz = fz - row;
        return (
            grid[row * size + col] * (1 - tx) * (1 - tz) +
            grid[row * size + col + 1] * tx * (1 - tz) +
            grid[(row + 1) * size + col] * (1 - tx) * tz +
            grid[(row + 1) * size + col + 1] * tx * tz
        );
    };

    // 描画地形（1025点）を作る。物理ハイトフィールドも同じ点を取る
    const N = TERRAIN_VERTS;
    const step = (AREA_HALF * 2) / (N - 1);
    const terrain = new Float32Array(N * N);
    for (let row = 0; row < N; row++) {
        const z = -AREA_HALF + row * step;
        for (let col = 0; col < N; col++) {
            terrain[row * N + col] = bilinear(hm, n, hmStep, meta.areaHalf, -AREA_HALF + col * step, z);
        }
    }
    const elevationAt = (x, z) => bilinear(terrain, N, step, AREA_HALF, x, z);

    const client = buildRoadProfiles(roads, elevationAt, { pinned: true });
    const gaps = [];
    const gradeAfter = [];
    const gradeBefore = [];
    let worst = { gap: 0, x: 0, z: 0 };
    /** station 間の勾配変化[%]（車が受ける突き上げの目安） */
    const gradeChange = (path, sample, out) => {
        for (let i = 1; i + 1 < path.points.length; i++) {
            const d0 = path.dists[i] - path.dists[i - 1];
            const d1 = path.dists[i + 1] - path.dists[i];
            if (d0 < 0.5 || d1 < 0.5) continue;
            const a = (sample(path, i) - sample(path, i - 1)) / d0;
            const b = (sample(path, i + 1) - sample(path, i)) / d1;
            out.push(Math.abs(b - a) * 100);
        }
    };
    for (const path of client.paths) {
        if (path.bridge) continue;
        // エリア外（見えない外周の余白）は地形がクランプされるので測らない
        const inside = path.points.every(
            (p) => Math.abs(p.x) < AREA_HALF - 20 && Math.abs(p.z) < AREA_HALF - 20,
        );
        if (!inside) continue;
        for (let i = 0; i < path.points.length; i++) {
            const p = path.points[i];
            const gap = Math.abs(path.heights[i] - elevationAt(p.x, p.z));
            gaps.push(gap);
            if (gap > worst.gap) worst = { gap, x: p.x, z: p.z };
        }
        gradeChange(path, (pt, i) => pt.heights[i], gradeAfter);
        gradeChange(path, (pt, i) => beforeSample(pt.points[i].x, pt.points[i].z), gradeBefore);
    }
    const summarize = (values) => {
        values.sort((a, b) => a - b);
        const at = (p) => (values.length ? values[Math.min(values.length - 1, Math.floor(values.length * p))] : 0);
        return { p50: at(0.5), p90: at(0.9), p99: at(0.99), max: at(1), count: values.length };
    };
    return {
        gap: { ...summarize(gaps), worst },
        gradeAfter: summarize(gradeAfter),
        gradeBefore: summarize(gradeBefore),
    };
}

/**
 * E43 の検証: 建物フットプリント直下でカービングがどれだけ地面を動かしたか。
 * @param {Float32Array} before @param {Float32Array} after
 * @param {{rings: {x:number,z:number}[][]}[]} shapes
 * @returns {{ buildings: number, moved: number, over30cm: number, over100cm: number, max: number }}
 */
export function measureBuildingImpact(before, after, shapes) {
    let moved = 0;
    let over30cm = 0;
    let over100cm = 0;
    let max = 0;
    let counted = 0;
    for (const shape of shapes) {
        const ring = shape.rings[0];
        if (!ring || ring.length < 3) continue;
        counted++;
        let worst = 0;
        for (const p of ring) {
            const col = Math.round((p.x + GRID_HALF) / CELL);
            const row = Math.round((p.z + GRID_HALF) / CELL);
            if (col < 0 || col >= GN || row < 0 || row >= GN) continue;
            const d = Math.abs(after[row * GN + col] - before[row * GN + col]);
            if (d > worst) worst = d;
        }
        if (worst > 0.02) moved++;
        if (worst > 0.3) over30cm++;
        if (worst > 1) over100cm++;
        if (worst > max) max = worst;
    }
    return { buildings: counted, moved, over30cm, over100cm, max };
}
