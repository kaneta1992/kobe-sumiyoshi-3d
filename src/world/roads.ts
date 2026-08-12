/**
 * 道路メッシュ。RdCL（道路中心線）を幅員に応じたリボンにし、
 * 地形に沿わせて少し浮かせる（z-fighting 回避）。
 */
import { BufferAttribute, BufferGeometry, Color, Mesh, MeshStandardMaterial } from 'three/webgpu';
import type { Point2, RoadLine } from '../data/vector';

/** 地形起伏に追従させるための再サンプリング間隔[m] */
const SEGMENT_LENGTH = 6;
/** 地表からの浮かせ量[m] */
const DRAPE_OFFSET = 0.35;

const ASPHALT = new Color().setHSL(0.08, 0.02, 0.3);

/** 長い区間を分割し、地形に追従する頂点列にする */
function resample(points: readonly Point2[]): Point2[] {
    const out: Point2[] = [points[0]];
    for (let i = 1; i < points.length; i++) {
        const a = points[i - 1];
        const b = points[i];
        const len = Math.hypot(b.x - a.x, b.z - a.z);
        const steps = Math.max(1, Math.ceil(len / SEGMENT_LENGTH));
        for (let s = 1; s <= steps; s++) {
            const t = s / steps;
            out.push({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t });
        }
    }
    return out;
}

export function createRoads(
    lines: readonly RoadLine[],
    getElevationAt: (x: number, z: number) => number,
): Mesh {
    const positions: number[] = [];
    const normals: number[] = [];

    for (const line of lines) {
        const pts = resample(line.points);
        if (pts.length < 2) continue;
        const half = Math.max(1.2, Math.min(line.width, 30)) / 2;

        // 各頂点の左右オフセット点を作る（角は前後セグメントの平均方向で丸める）
        const left: number[] = [];
        const right: number[] = [];
        for (let i = 0; i < pts.length; i++) {
            const prev = pts[Math.max(0, i - 1)];
            const next = pts[Math.min(pts.length - 1, i + 1)];
            let dx = next.x - prev.x;
            let dz = next.z - prev.z;
            const len = Math.hypot(dx, dz);
            if (len < 1e-6) {
                dx = 1;
                dz = 0;
            } else {
                dx /= len;
                dz /= len;
            }
            const px = -dz * half;
            const pz = dx * half;
            const lx = pts[i].x + px;
            const lz = pts[i].z + pz;
            const rx = pts[i].x - px;
            const rz = pts[i].z - pz;
            left.push(lx, getElevationAt(lx, lz) + DRAPE_OFFSET, lz);
            right.push(rx, getElevationAt(rx, rz) + DRAPE_OFFSET, rz);
        }

        for (let i = 0; i + 1 < pts.length; i++) {
            const a = i * 3;
            const b = (i + 1) * 3;
            const quad = [
                [left[a], left[a + 1], left[a + 2]],
                [right[a], right[a + 1], right[a + 2]],
                [right[b], right[b + 1], right[b + 2]],
                [left[b], left[b + 1], left[b + 2]],
            ];
            for (const [i0, i1, i2] of [
                [0, 1, 2],
                [0, 2, 3],
            ]) {
                const v0 = quad[i0];
                const v1 = quad[i1];
                const v2 = quad[i2];
                const ux = v1[0] - v0[0];
                const uy = v1[1] - v0[1];
                const uz = v1[2] - v0[2];
                const wx = v2[0] - v0[0];
                const wy = v2[1] - v0[1];
                const wz = v2[2] - v0[2];
                let nx = uy * wz - uz * wy;
                let ny = uz * wx - ux * wz;
                let nz = ux * wy - uy * wx;
                const nl = Math.hypot(nx, ny, nz) || 1;
                nx /= nl;
                ny /= nl;
                nz /= nl;
                // 上向きに揃える（リボンの巻き方向に依存しないようにする）
                const sign = ny < 0 ? -1 : 1;
                const tri = sign < 0 ? [v0, v2, v1] : [v0, v1, v2];
                for (const v of tri) {
                    positions.push(v[0], v[1], v[2]);
                    normals.push(nx * sign, ny * sign, nz * sign);
                }
            }
        }
    }

    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(Float32Array.from(positions), 3));
    geometry.setAttribute('normal', new BufferAttribute(Float32Array.from(normals), 3));
    geometry.computeBoundingSphere();

    const mesh = new Mesh(
        geometry,
        new MeshStandardMaterial({ color: ASPHALT, roughness: 0.95, metalness: 0 }),
    );
    mesh.name = 'roads';
    mesh.receiveShadow = true;
    return mesh;
}
