/**
 * 占有グリッド（2m格子）。道路面・建物フットプリント・道路の路肩帯を焼いておき、
 * 樹木・電柱・生け垣・下草の配置がそれらに重ならないようにする（E14）。
 *
 * 参照は毎フレームではなく構築時だけなので、素直な Uint8Array で持つ。
 */
import { AREA_HALF, CULL_MARGIN } from '../config';
import type { BuildingShape, Point2, RoadLine } from '../data/vector';

export const OCC_ROAD = 1;
export const OCC_BUILDING = 2;
/** 道路の外側にとった路肩帯。電柱・生け垣はここに並べる */
export const OCC_ROADSIDE = 4;

const CELL = 2;
const LIMIT = AREA_HALF + CULL_MARGIN;
const SIDE = Math.ceil((LIMIT * 2) / CELL);

export interface Occupancy {
    at(x: number, z: number): number;
    /** 樹木・小物を置いてはいけない場所か */
    blocked(x: number, z: number): boolean;
}

function pointInRing(ring: readonly Point2[], x: number, z: number): boolean {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const a = ring[i];
        const b = ring[j];
        if (a.z > z !== b.z > z && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) {
            inside = !inside;
        }
    }
    return inside;
}

export function buildOccupancy(
    buildings: readonly BuildingShape[],
    roads: readonly RoadLine[],
): Occupancy {
    const cells = new Uint8Array(SIDE * SIDE);

    const idx = (cx: number, cz: number): number => cz * SIDE + cx;
    const toCell = (v: number): number => Math.floor((v + LIMIT) / CELL);
    const inGrid = (c: number): boolean => c >= 0 && c < SIDE;

    // --- 道路: 中心線に沿って幅員ぶんの円盤を並べる ---
    for (const road of roads) {
        const half = Math.max(1.2, Math.min(road.width, 30)) / 2;
        const shoulder = half + 3.2;
        for (let i = 1; i < road.points.length; i++) {
            const a = road.points[i - 1];
            const b = road.points[i];
            const len = Math.hypot(b.x - a.x, b.z - a.z);
            const steps = Math.max(1, Math.ceil(len / CELL));
            for (let s = 0; s <= steps; s++) {
                const t = s / steps;
                const px = a.x + (b.x - a.x) * t;
                const pz = a.z + (b.z - a.z) * t;
                const r = Math.ceil(shoulder / CELL);
                const cx0 = toCell(px);
                const cz0 = toCell(pz);
                for (let dz = -r; dz <= r; dz++) {
                    for (let dx = -r; dx <= r; dx++) {
                        const cx = cx0 + dx;
                        const cz = cz0 + dz;
                        if (!inGrid(cx) || !inGrid(cz)) continue;
                        const d = Math.hypot(dx * CELL, dz * CELL);
                        if (d <= half + 0.8) cells[idx(cx, cz)] |= OCC_ROAD;
                        else if (d <= shoulder) cells[idx(cx, cz)] |= OCC_ROADSIDE;
                    }
                }
            }
        }
    }

    // --- 建物: 外周リングを走査線で塗る ---
    for (const shape of buildings) {
        const ring = shape.rings[0];
        let minX = Infinity;
        let maxX = -Infinity;
        let minZ = Infinity;
        let maxZ = -Infinity;
        for (const p of ring) {
            if (p.x < minX) minX = p.x;
            if (p.x > maxX) maxX = p.x;
            if (p.z < minZ) minZ = p.z;
            if (p.z > maxZ) maxZ = p.z;
        }
        const cx0 = Math.max(0, toCell(minX - 1));
        const cx1 = Math.min(SIDE - 1, toCell(maxX + 1));
        const cz0 = Math.max(0, toCell(minZ - 1));
        const cz1 = Math.min(SIDE - 1, toCell(maxZ + 1));
        for (let cz = cz0; cz <= cz1; cz++) {
            const z = -LIMIT + (cz + 0.5) * CELL;
            for (let cx = cx0; cx <= cx1; cx++) {
                const x = -LIMIT + (cx + 0.5) * CELL;
                if (pointInRing(ring, x, z)) cells[idx(cx, cz)] |= OCC_BUILDING;
            }
        }
    }

    const at = (x: number, z: number): number => {
        const cx = toCell(x);
        const cz = toCell(z);
        if (!inGrid(cx) || !inGrid(cz)) return 0;
        return cells[idx(cx, cz)];
    };

    return {
        at,
        blocked(x, z) {
            return (at(x, z) & (OCC_ROAD | OCC_BUILDING)) !== 0;
        },
    };
}
