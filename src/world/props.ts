/**
 * 街路の小物。日本の住宅街の実在感は電柱・電線とガードレールで決まるので、
 * 道路中心線から決定的な間隔で生成する。
 *
 * 配置は占有グリッドで建物・路面を避ける（E14）。電柱の足元標高は個別に取り、
 * 急斜面でも埋まらないようにする（E21）。
 *
 * HLOD: L0 = 電柱 + 腕金 + 変圧器 + 電線 / L1 = 電柱の柱だけ / L2 = 描かない。
 */
import { Mesh, MeshStandardNodeMaterial, Object3D } from 'three/webgpu';
import { createBuf, pushVertex, toGeometry, type MeshBuf } from './geom';
import { buildHlod, type Hlod } from './hlod';
import { hash01 } from './hash';
import { OCC_BUILDING, OCC_ROAD, type Occupancy } from './occupancy';
import type { QualitySettings } from '../quality';
import type { RoadLine } from '../data/vector';

/** 電柱の間隔[m] */
const POLE_SPACING = 31;
/** 電柱の高さレンジ[m] */
const POLE_HEIGHT_MIN = 8.2;
const POLE_HEIGHT_MAX = 10.5;
/** 電線の垂れ[m] */
const WIRE_SAG = 0.55;
/** ガードレールを立てる法面の落差[m]（横 3m あたり） */
const RAIL_DROP = 1.6;

const CONCRETE: readonly [number, number, number] = [0.31, 0.3, 0.285];
const STEEL: readonly [number, number, number] = [0.2, 0.205, 0.21];
const WIRE: readonly [number, number, number] = [0.02, 0.02, 0.022];

/** テーパー付き角柱。法線は側面方向 */
function addPost(
    b: MeshBuf,
    x0: number,
    y0: number,
    z0: number,
    x1: number,
    y1: number,
    z1: number,
    r0: number,
    r1: number,
    sides: number,
    color: readonly [number, number, number],
): void {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const dz = z1 - z0;
    const len = Math.hypot(dx, dy, dz) || 1;
    const ax = dx / len;
    const ay = dy / len;
    const az = dz / len;
    let ux = -ay;
    let uy = ax;
    let uz = 0;
    if (Math.hypot(ux, uy, uz) < 1e-4) {
        ux = 1;
        uy = 0;
        uz = 0;
    }
    const ul = Math.hypot(ux, uy, uz);
    ux /= ul;
    uy /= ul;
    uz /= ul;
    const vx = ay * uz - az * uy;
    const vy = az * ux - ax * uz;
    const vz = ax * uy - ay * ux;
    for (let i = 0; i < sides; i++) {
        const a0 = (i / sides) * Math.PI * 2;
        const a1 = ((i + 1) / sides) * Math.PI * 2;
        const d0: [number, number, number] = [
            ux * Math.cos(a0) + vx * Math.sin(a0),
            uy * Math.cos(a0) + vy * Math.sin(a0),
            uz * Math.cos(a0) + vz * Math.sin(a0),
        ];
        const d1: [number, number, number] = [
            ux * Math.cos(a1) + vx * Math.sin(a1),
            uy * Math.cos(a1) + vy * Math.sin(a1),
            uz * Math.cos(a1) + vz * Math.sin(a1),
        ];
        const quad: [number[], [number, number, number]][] = [
            [[x0 + d0[0] * r0, y0 + d0[1] * r0, z0 + d0[2] * r0], d0],
            [[x0 + d1[0] * r0, y0 + d1[1] * r0, z0 + d1[2] * r0], d1],
            [[x1 + d1[0] * r1, y1 + d1[1] * r1, z1 + d1[2] * r1], d1],
            [[x1 + d0[0] * r1, y1 + d0[1] * r1, z1 + d0[2] * r1], d0],
        ];
        for (const [i0, i1, i2] of [
            [0, 1, 2],
            [0, 2, 3],
        ]) {
            for (const k of [i0, i1, i2]) {
                const [p, n] = quad[k];
                const shade = 0.74 + 0.34 * (n[0] * 0.5 + 0.5);
                pushVertex(b, p[0], p[1], p[2], n[0], n[1], n[2], color[0] * shade, color[1] * shade, color[2] * shade);
            }
        }
    }
}

function addBox(
    b: MeshBuf,
    cx: number,
    cy: number,
    cz: number,
    hx: number,
    hy: number,
    hz: number,
    color: readonly [number, number, number],
): void {
    const faces: [number, number, number][] = [
        [1, 0, 0],
        [-1, 0, 0],
        [0, 1, 0],
        [0, -1, 0],
        [0, 0, 1],
        [0, 0, -1],
    ];
    for (const n of faces) {
        // 面の4隅を法線方向から作る
        const t: [number, number, number] = n[1] !== 0 ? [1, 0, 0] : [0, 1, 0];
        const s: [number, number, number] = [
            n[1] * t[2] - n[2] * t[1],
            n[2] * t[0] - n[0] * t[2],
            n[0] * t[1] - n[1] * t[0],
        ];
        const corners: [number, number][] = [
            [-1, -1],
            [1, -1],
            [1, 1],
            [-1, 1],
        ];
        const built = corners.map(([a, c]) => {
            const ox = t[0] * a + s[0] * c;
            const oy = t[1] * a + s[1] * c;
            const oz = t[2] * a + s[2] * c;
            return [cx + n[0] * hx + ox * hx, cy + n[1] * hy + oy * hy, cz + n[2] * hz + oz * hz];
        });
        const shade = 0.7 + 0.36 * (n[1] * 0.5 + 0.5) + n[0] * 0.06;
        for (const [i0, i1, i2] of [
            [0, 1, 2],
            [0, 2, 3],
        ]) {
            for (const k of [i0, i1, i2]) {
                const p = built[k];
                pushVertex(b, p[0], p[1], p[2], n[0], n[1], n[2], color[0] * shade, color[1] * shade, color[2] * shade);
            }
        }
    }
}

interface Pole {
    kind: 'pole';
    x: number;
    y: number;
    z: number;
    height: number;
    /** 腕金の向き（道路に直交） */
    armX: number;
    armZ: number;
    transformer: boolean;
    /** 次の電柱（電線を張る先）。無ければ null */
    next: { x: number; y: number; z: number } | null;
}

interface Rail {
    kind: 'rail';
    x: number;
    y: number;
    z: number;
    /** 区間の方向 */
    dx: number;
    dz: number;
    length: number;
    groundAt(t: number): number;
}

type Prop = Pole | Rail;

/** 電線1スパン。たるみ（カテナリー近似）を付けた細い三角柱でつなぐ */
function addWire(
    b: MeshBuf,
    ax: number,
    ay: number,
    az: number,
    bx: number,
    by: number,
    bz: number,
    segments: number,
): void {
    let px = ax;
    let py = ay;
    let pz = az;
    for (let i = 1; i <= segments; i++) {
        const t = i / segments;
        const sag = WIRE_SAG * 4 * t * (1 - t);
        const qx = ax + (bx - ax) * t;
        const qy = ay + (by - ay) * t - sag;
        const qz = az + (bz - az) * t;
        addPost(b, px, py, pz, qx, qy, qz, 0.035, 0.035, 3, WIRE);
        px = qx;
        py = qy;
        pz = qz;
    }
}

function addPole(b: MeshBuf, pole: Pole, detailed: boolean): void {
    const top = pole.y + pole.height;
    addPost(b, pole.x, pole.y - 0.3, pole.z, pole.x, top, pole.z, 0.17, 0.11, detailed ? 7 : 4, CONCRETE);
    if (!detailed) return;
    // 腕金2段
    for (const [dy, half] of [
        [-0.35, 0.85],
        [-1.35, 0.7],
    ]) {
        addPost(
            b,
            pole.x - pole.armX * half,
            top + dy,
            pole.z - pole.armZ * half,
            pole.x + pole.armX * half,
            top + dy,
            pole.z + pole.armZ * half,
            0.045,
            0.045,
            4,
            STEEL,
        );
    }
    if (pole.transformer) {
        addBox(b, pole.x + pole.armX * 0.45, top - 2.5, pole.z + pole.armZ * 0.45, 0.32, 0.5, 0.32, STEEL);
    }
    if (pole.next) {
        const heights = [top - 0.35, top - 1.35, top - 2.1];
        for (let w = 0; w < heights.length; w++) {
            const off = (w - 1) * 0.28;
            addWire(
                b,
                pole.x + pole.armX * off,
                heights[w],
                pole.z + pole.armZ * off,
                pole.next.x + pole.armX * off,
                pole.next.y + (heights[w] - pole.y),
                pole.next.z + pole.armZ * off,
                3,
            );
        }
    }
}

function addRail(b: MeshBuf, rail: Rail): void {
    const posts = Math.max(2, Math.round(rail.length / 2.4));
    for (let i = 0; i <= posts; i++) {
        const t = i / posts;
        const px = rail.x + rail.dx * rail.length * t;
        const pz = rail.z + rail.dz * rail.length * t;
        const py = rail.groundAt(t);
        addPost(b, px, py - 0.2, pz, px, py + 0.72, pz, 0.045, 0.045, 4, STEEL);
    }
    // 横のビーム（波形は作らず、上下2本の帯で代替）
    for (const h of [0.66, 0.42]) {
        let px = rail.x;
        let pz = rail.z;
        let py = rail.groundAt(0) + h;
        for (let i = 1; i <= posts; i++) {
            const t = i / posts;
            const qx = rail.x + rail.dx * rail.length * t;
            const qz = rail.z + rail.dz * rail.length * t;
            const qy = rail.groundAt(t) + h;
            addPost(b, px, py, pz, qx, qy, qz, 0.055, 0.055, 4, STEEL);
            px = qx;
            py = qy;
            pz = qz;
        }
    }
}

export function createProps(
    roads: readonly RoadLine[],
    occupancy: Occupancy,
    getElevationAt: (x: number, z: number) => number,
    quality: QualitySettings,
): Hlod {
    const props: Prop[] = [];

    for (let ri = 0; ri < roads.length; ri++) {
        const road = roads[ri];
        // 橋の上には電柱もガードレールも立てない（高欄は bridges.ts が持つ。
        // 地形標高で置くと谷底に沈む）
        if (road.bridge) continue;
        const half = Math.max(1.2, Math.min(road.width, 30)) / 2;
        // 道ごとにどちら側へ電柱を立てるかを決める
        const side = hash01(road.points[0].x, road.points[0].z, 0x2c1) < 0.5 ? -1 : 1;
        const offset = half + 0.75;

        // 中心線を等間隔でサンプリングする
        const samples: { x: number; z: number; nx: number; nz: number }[] = [];
        let carry = hash01(road.points[0].x, road.points[0].z, 0x51) * POLE_SPACING;
        for (let i = 1; i < road.points.length; i++) {
            const a = road.points[i - 1];
            const b = road.points[i];
            const dx = b.x - a.x;
            const dz = b.z - a.z;
            const len = Math.hypot(dx, dz);
            if (len < 1e-4) continue;
            const ux = dx / len;
            const uz = dz / len;
            let travelled = carry;
            while (travelled < len) {
                samples.push({
                    x: a.x + ux * travelled,
                    z: a.z + uz * travelled,
                    nx: -uz,
                    nz: ux,
                });
                travelled += POLE_SPACING;
            }
            carry = travelled - len;
        }

        const placed: Pole[] = [];
        for (const s of samples) {
            const px = s.x + s.nx * offset * side;
            const pz = s.z + s.nz * offset * side;
            const flags = occupancy.at(px, pz);
            if ((flags & (OCC_ROAD | OCC_BUILDING)) !== 0) continue;
            const r = hash01(px, pz, 0x8a);
            placed.push({
                kind: 'pole',
                x: px,
                // 足元は個別に地面を取る（急斜面で浮かない・埋まらない・E21）
                y: getElevationAt(px, pz),
                z: pz,
                height: POLE_HEIGHT_MIN + r * (POLE_HEIGHT_MAX - POLE_HEIGHT_MIN),
                armX: s.nx * side,
                armZ: s.nz * side,
                transformer: hash01(px, pz, 0xd3) < 0.22,
                next: null,
            });
        }
        for (let i = 0; i < placed.length; i++) {
            const a = placed[i];
            const b = placed[i + 1];
            // 離れすぎ（間の電柱が落ちた）ときは電線を張らない
            if (b && Math.hypot(b.x - a.x, b.z - a.z) < POLE_SPACING * 1.6) {
                a.next = { x: b.x, y: b.y, z: b.z };
            }
            props.push(a);
        }

        // 路肩の外側が落ち込んでいればガードレール、立ち上がっていれば擁壁。
        // 六甲山麓の道はどちらかが必ず付くので、これが有ると無いとで実在感が大きく変わる
        for (let i = 1; i < road.points.length; i++) {
            const a = road.points[i - 1];
            const b = road.points[i];
            const dx = b.x - a.x;
            const dz = b.z - a.z;
            const len = Math.hypot(dx, dz);
            if (len < 6) continue;
            const ux = dx / len;
            const uz = dz / len;
            const nx = -uz;
            const nz = ux;
            for (const s of [-1, 1]) {
                const offset = half + 0.5;
                const startX = a.x + nx * offset * s;
                const startZ = a.z + nz * offset * s;
                const midX = startX + dx * 0.5;
                const midZ = startZ + dz * 0.5;
                if (occupancy.at(midX, midZ) & OCC_BUILDING) continue;
                const edgeY = getElevationAt(midX, midZ);
                const outY = getElevationAt(midX + nx * 3 * s, midZ + nz * 3 * s);
                const runLength = Math.min(len, 40);
                if (edgeY - outY >= RAIL_DROP) {
                    props.push({
                        kind: 'rail',
                        x: startX,
                        y: edgeY,
                        z: startZ,
                        dx: ux,
                        dz: uz,
                        length: runLength,
                        groundAt: (t: number) =>
                            getElevationAt(startX + ux * runLength * t, startZ + uz * runLength * t),
                    });
                }
            }
        }
    }

    const material = new MeshStandardNodeMaterial({
        vertexColors: true,
        roughness: 0.72,
        metalness: 0.15,
    });

    const hlod = buildHlod(props, (level, indices): Object3D | null => {
        if (level === 2) return null;
        const buf = createBuf();
        for (const index of indices) {
            const prop = props[index];
            if (prop.kind === 'pole') addPole(buf, prop, level === 0);
            else if (level === 0) addRail(buf, prop);
        }
        if (buf.pos.length === 0) return null;
        const mesh = new Mesh(toGeometry(buf), material);
        mesh.name = `props-L${level}`;
        mesh.castShadow = quality.shadows && level === 0;
        mesh.receiveShadow = true;
        mesh.matrixAutoUpdate = false;
        return mesh;
    });
    hlod.group.name = 'props';
    return hlod;
}
