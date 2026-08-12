/**
 * 植生。契約02が nDSM から抽出した実在の樹木点（位置・実高さ・冠幅）を、
 * 樹種ぶんの手続き樹形でインスタンス描画する。
 *
 * 設計の要点:
 *  - 単一形状の複製にしない。針葉樹（スギ・ヒノキ）／広葉樹（丸い樹冠・盃状に広がる樹冠）／
 *    庭木 の4樹種を、標高・冠高比・道路との距離から決定的に割り当てる。
 *    六甲山麓は広葉樹二次林 + 植林、住宅地は庭木・街路樹になる。
 *  - 樹形はローポリでも「幹 + 枝ぶり + 葉塊の重なり」の多層構造にして、
 *    シルエットに凹凸を出す。葉塊は位置だけノイズで崩し、法線は球状のまま残すので
 *    輪郭はざらつき、陰影は柔らかい。
 *  - 葉のシェーディングは裏面透過（サブサーフェス風）と包み込みライティング。
 *    風は階層的（幹はゆっくり大きく・葉先は細かく速く）。
 *  - LOD3段（近=フル / 中=簡略 / 遠=クロスカード）。セル単位で段階を選び、
 *    描画するインスタンスは毎回マスタ配列からの memcpy で詰め直す。
 *    ドローコールは「樹種 × LOD段」の固定数（最大14）に収まる。
 *
 * 生け垣・下草も同じ仕組みに相乗りさせる（住宅街の実在感）。配置は占有グリッドで
 * 道路・建物を避ける（E14）。乱数は使わない（決定的ハッシュのみ）。
 */
import {
    CanvasTexture,
    DoubleSide,
    DynamicDrawUsage,
    Frustum,
    Group,
    InstancedBufferAttribute,
    InstancedMesh,
    LinearFilter,
    LinearMipmapLinearFilter,
    MeshStandardNodeMaterial,
    SRGBColorSpace,
    Sphere,
    Vector3,
    type BufferGeometry,
    type Texture,
} from 'three/webgpu';
import {
    attribute,
    cameraPosition,
    float,
    mix,
    normalWorld,
    positionLocal,
    positionWorld,
    saturate,
    sin,
    time,
    texture as textureNode,
    uv,
    vec3,
} from 'three/tsl';
import { AREA_HALF, CULL_MARGIN } from '../config';
import type { QualitySettings } from '../quality';
import type { TreeInstance } from '../data/terrain-assets';
import type { BuildingShape, RoadLine } from '../data/vector';
import { hash01, hashDir01, hashIndex01 } from './hash';
import {
    createBuf,
    icosahedronTriangles,
    icosahedronTrianglesFine,
    pushVertex,
    toGeometry,
    type MeshBuf,
} from './geom';
import { OCC_BUILDING, OCC_ROAD, OCC_ROADSIDE, type Occupancy } from './occupancy';
import { sunColorNode, sunDirNode, windDirNode, windStrengthNode } from './sun';

/** 樹種 */
const SP_CONIFER = 0;
const SP_ROUND = 1;
const SP_SPREAD = 2;
const SP_GARDEN = 3;
const SP_HEDGE = 4;
const SP_GRASS = 5;
const SPECIES_COUNT = 6;
/** 樹木として3段LODを持つ樹種の数（生け垣・下草は近距離1段のみ） */
const TREE_SPECIES = 4;
const LOD_COUNT = 3;

/** インスタンスを詰め直すカメラ移動量[m] */
const REBUILD_DISTANCE = 11;
/** 空間セルの一辺[m] */
const CELL = 96;
const LIMIT = AREA_HALF + CULL_MARGIN;
const CELLS = Math.ceil((LIMIT * 2) / CELL);

// --- 樹形の生成 -----------------------------------------------------------

/** 幹・枝。半径 r0 → r1 のテーパー付き角柱 */
function addTube(
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
    wind0: number,
    wind1: number,
): void {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const dz = z1 - z0;
    const len = Math.hypot(dx, dy, dz) || 1;
    const ax = dx / len;
    const ay = dy / len;
    const az = dz / len;
    // 軸に直交する基底
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
    const wind = b.extra['aWind'];
    const texcoord = b.extra['uv'];

    for (let i = 0; i < sides; i++) {
        const a0 = (i / sides) * Math.PI * 2;
        const a1 = ((i + 1) / sides) * Math.PI * 2;
        const dirs: [number, number, number][] = [];
        for (const a of [a0, a1]) {
            dirs.push([
                ux * Math.cos(a) + vx * Math.sin(a),
                uy * Math.cos(a) + vy * Math.sin(a),
                uz * Math.cos(a) + vz * Math.sin(a),
            ]);
        }
        // 幹は光が回り込まないので側面を少し暗くしてボリューム感を出す
        const shades = [0.72 + 0.4 * (0.5 + dirs[0][0] * 0.5), 0.72 + 0.4 * (0.5 + dirs[1][0] * 0.5)];
        const quad: [number, number, number, number, number, number, number][] = [
            [x0 + dirs[0][0] * r0, y0 + dirs[0][1] * r0, z0 + dirs[0][2] * r0, 0, 0, wind0, shades[0]],
            [x0 + dirs[1][0] * r0, y0 + dirs[1][1] * r0, z0 + dirs[1][2] * r0, 1, 0, wind0, shades[1]],
            [x1 + dirs[1][0] * r1, y1 + dirs[1][1] * r1, z1 + dirs[1][2] * r1, 1, 1, wind1, shades[1]],
            [x1 + dirs[0][0] * r1, y1 + dirs[0][1] * r1, z1 + dirs[0][2] * r1, 0, 1, wind1, shades[0]],
        ];
        for (const [i0, i1, i2] of [
            [0, 1, 2],
            [0, 2, 3],
        ]) {
            for (const k of [i0, i1, i2]) {
                const v = quad[k];
                const d = dirs[k === 1 || k === 2 ? 1 : 0];
                pushVertex(b, v[0], v[1], v[2], d[0], d[1], d[2], color[0] * v[6], color[1] * v[6], color[2] * v[6]);
                wind.push(v[5], 0);
                if (texcoord) texcoord.push(v[3], v[4]);
            }
        }
    }
}

/**
 * 葉塊。位置だけノイズで崩し、法線は球状のまま残す。
 * 輪郭はざらつくのに陰影は柔らかい = 少ないポリゴンで「葉の塊」に見える。
 */
function addBlob(
    b: MeshBuf,
    cx: number,
    cy: number,
    cz: number,
    rx: number,
    ry: number,
    rz: number,
    fine: boolean,
    color: readonly [number, number, number],
    trunkWind: number,
    seed: number,
    /** 樹冠内部の暗さ（0=明るい外周 / 1=内側） */
    depth: number,
): void {
    const tris = fine ? icosahedronTrianglesFine() : icosahedronTriangles();
    const wind = b.extra['aWind'];
    const texcoord = b.extra['uv'];
    for (let i = 0; i < tris.length; i += 3) {
        const dx = tris[i];
        const dy = tris[i + 1];
        const dz = tris[i + 2];
        const bump = 0.72 + hashDir01(dx, dy, dz, seed) * 0.56;
        // 下側は少し垂れる（葉が重力で下がる感じ）
        const droop = dy < 0 ? 1.1 : 1;
        const px = cx + dx * rx * bump;
        const py = cy + dy * ry * bump * droop;
        const pz = cz + dz * rz * bump;
        // ベイクAO: 樹冠の下側・内側を暗く（追記2-5 の頂点AO）
        const shade = (0.42 + 0.58 * (dy * 0.5 + 0.5)) * (1 - depth * 0.34);
        pushVertex(b, px, py, pz, dx, dy, dz, color[0] * shade, color[1] * shade, color[2] * shade);
        wind.push(trunkWind, 1);
        if (texcoord) texcoord.push(dx * 0.5 + 0.5, dy * 0.5 + 0.5);
    }
}

/** 樹種ごとの葉色（線形空間の概算値。実際の見えはライティングで作る） */
const FOLIAGE: Record<number, readonly [number, number, number]> = {
    [SP_CONIFER]: [0.052, 0.093, 0.048],
    [SP_ROUND]: [0.082, 0.132, 0.052],
    [SP_SPREAD]: [0.094, 0.146, 0.058],
    [SP_GARDEN]: [0.068, 0.125, 0.05],
    [SP_HEDGE]: [0.038, 0.076, 0.03],
    [SP_GRASS]: [0.12, 0.165, 0.062],
};
const BARK: readonly [number, number, number] = [0.055, 0.045, 0.036];

/** 単位樹形（高さ1・冠幅1）を作る。lod 0=フル / 1=簡略 / 2=クロスカード */
function buildTreeGeometry(species: number, lod: number): BufferGeometry {
    const buf = createBuf(['aWind', 'uv']);
    const leaf = FOLIAGE[species];

    if (lod === 2) {
        // 遠景: 交差カード3枚（1枚板ではなく立体感が出る最小構成）
        const r = 0.5;
        const y0 = species === SP_CONIFER ? 0.1 : 0.22;
        const y1 = 1.0;
        const cards: [number, number, number, number][] = [
            [-r, 0, r, 0],
            [0, -r, 0, r],
        ];
        for (const [ax, az, bx, bz] of cards) {
            const quad: [number, number, number, number, number][] = [
                [ax, y0, az, 0, 0],
                [bx, y0, bz, 1, 0],
                [bx, y1, bz, 1, 1],
                [ax, y1, az, 0, 1],
            ];
            for (const [i0, i1, i2] of [
                [0, 1, 2],
                [0, 2, 3],
            ]) {
                for (const k of [i0, i1, i2]) {
                    const v = quad[k];
                    pushVertex(buf, v[0], v[1], v[2], 0, 0.55, 0, leaf[0], leaf[1], leaf[2]);
                    buf.extra['aWind'].push(0.85, 1);
                    buf.extra['uv'].push(v[3], v[4]);
                }
            }
        }
        // 水平の1枚（上から見たときに板に見えないように）
        const yh = species === SP_CONIFER ? 0.55 : 0.68;
        const horiz: [number, number, number, number, number][] = [
            [-r, yh, -r, 0, 0],
            [r, yh, -r, 1, 0],
            [r, yh, r, 1, 1],
            [-r, yh, r, 0, 1],
        ];
        for (const [i0, i1, i2] of [
            [0, 1, 2],
            [0, 2, 3],
        ]) {
            for (const k of [i0, i1, i2]) {
                const v = horiz[k];
                pushVertex(buf, v[0], v[1], v[2], 0, 1, 0, leaf[0] * 0.9, leaf[1] * 0.9, leaf[2] * 0.9);
                buf.extra['aWind'].push(0.85, 1);
                buf.extra['uv'].push(v[3], v[4]);
            }
        }
        return toGeometry(buf, { aWind: 2, uv: 2 });
    }

    const fine = lod === 0;
    const sides = lod === 0 ? 6 : 4;
    const salt = species * 977 + lod * 31;

    if (species === SP_GRASS) {
        // 下草: 交差カード3枚（根本は暗く）
        const r = 0.5;
        const angles = [0, Math.PI / 3, (Math.PI * 2) / 3];
        for (let ai = 0; ai < angles.length; ai++) {
            const a = angles[ai];
            const ax = Math.cos(a) * r;
            const az = Math.sin(a) * r;
            const quad: [number, number, number, number, number][] = [
                [-ax, 0, -az, 0, 0],
                [ax, 0, az, 1, 0],
                [ax, 1, az, 1, 1],
                [-ax, 1, -az, 0, 1],
            ];
            for (const [i0, i1, i2] of [
                [0, 1, 2],
                [0, 2, 3],
            ]) {
                for (const k of [i0, i1, i2]) {
                    const v = quad[k];
                    const shade = 0.55 + 0.55 * v[1];
                    pushVertex(buf, v[0], v[1], v[2], 0, 1, 0, leaf[0] * shade, leaf[1] * shade, leaf[2] * shade);
                    buf.extra['aWind'].push(v[1] * 0.4, v[1]);
                    buf.extra['uv'].push(v[3], v[4]);
                }
            }
        }
        return toGeometry(buf, { aWind: 2, uv: 2 });
    }

    if (species === SP_HEDGE) {
        // 生け垣: 天端を崩した箱。刈り込まれた面なので葉塊より整った形にする
        const nx = 6;
        const nz = 3;
        const cells: number[][] = [];
        for (let iz = 0; iz <= nz; iz++) {
            for (let ix = 0; ix <= nx; ix++) {
                // 刈り込みの甘さ: 天端は波打ち、幅も少しゆらぐ
                const wobble = 0.86 + hash01(ix, iz, salt + 5) * 0.28;
                const x = (ix / nx - 0.5) * wobble;
                const z = (iz / nz - 0.5) * 0.9 * wobble;
                const h = 0.8 + hash01(ix, iz, salt) * 0.26;
                cells.push([x, h, z]);
            }
        }
        const at = (ix: number, iz: number): number[] => cells[iz * (nx + 1) + ix];
        const push = (p: number[], nyv: number, shade: number, u: number, v: number): void => {
            pushVertex(buf, p[0], p[1], p[2], 0, nyv, 0, leaf[0] * shade, leaf[1] * shade, leaf[2] * shade);
            buf.extra['aWind'].push(0.25, 0.7);
            buf.extra['uv'].push(u, v);
        };
        for (let iz = 0; iz < nz; iz++) {
            for (let ix = 0; ix < nx; ix++) {
                const a = at(ix, iz);
                const c = at(ix + 1, iz);
                const d = at(ix + 1, iz + 1);
                const e = at(ix, iz + 1);
                for (const p of [a, d, c]) push(p, 1, 1, 0, 0);
                for (const p of [a, e, d]) push(p, 1, 1, 0, 0);
            }
        }
        // 側面（4面）。下ほど暗い
        const sidesDef: [number, number, number, number][] = [
            [0.5, -0.45, -0.5, -0.45],
            [-0.5, 0.45, 0.5, 0.45],
            [0.5, 0.45, 0.5, -0.45],
            [-0.5, -0.45, -0.5, 0.45],
        ];
        for (const [x0, z0, x1, z1] of sidesDef) {
            const h0 = 0.9;
            const quad = [
                // 足元は葉が届かず暗い。上に向かって明るくする（ベイクAO）
                [x0 * 0.92, 0, z0 * 0.92, 0.24],
                [x1 * 0.92, 0, z1 * 0.92, 0.24],
                [x1, h0, z1, 1],
                [x0, h0, z0, 1],
            ];
            for (const [i0, i1, i2] of [
                [0, 1, 2],
                [0, 2, 3],
            ]) {
                for (const k of [i0, i1, i2]) {
                    const v = quad[k];
                    const nrx = x0 === x1 ? Math.sign(x0) : 0;
                    const nrz = z0 === z1 ? Math.sign(z0) : 0;
                    pushVertex(buf, v[0], v[1], v[2], nrx, 0.25, nrz, leaf[0] * v[3], leaf[1] * v[3], leaf[2] * v[3]);
                    buf.extra['aWind'].push(0.2, 0.55);
                    buf.extra['uv'].push(0, 0);
                }
            }
        }
        return toGeometry(buf, { aWind: 2, uv: 2 });
    }

    // --- 樹木本体 ---
    if (species === SP_CONIFER) {
        const trunkTop = 0.97;
        addTube(buf, 0, 0, 0, 0, trunkTop, 0, 0.042, 0.008, sides, BARK, 0, 1);
        const layers = lod === 0 ? 7 : 4;
        for (let i = 0; i < layers; i++) {
            const t = i / (layers - 1);
            const y = 0.2 + t * 0.72;
            const r = 0.5 * Math.pow(1 - t, 0.72) * (0.88 + hash01(i, species, salt) * 0.24) + 0.045;
            const ox = (hash01(i, 3, salt) - 0.5) * 0.06;
            const oz = (hash01(i, 7, salt) - 0.5) * 0.06;
            addBlob(buf, ox, y, oz, r, r * 0.5, r, fine && i < 4, FOLIAGE[species], 0.25 + t * 0.75, salt + i, 1 - t * 0.75);
        }
        return toGeometry(buf, { aWind: 2, uv: 2 });
    }

    const spread = species === SP_SPREAD;
    const garden = species === SP_GARDEN;
    const trunkTop = garden ? 0.2 : spread ? 0.3 : 0.4;
    const trunkR = garden ? 0.03 : spread ? 0.055 : 0.05;
    addTube(buf, 0, 0, 0, 0, trunkTop, 0, trunkR, trunkR * 0.6, sides, BARK, 0, trunkTop);

    const branches = lod === 0 ? (garden ? 3 : spread ? 5 : 4) : 0;
    const crownY = garden ? 0.62 : spread ? 0.72 : 0.68;
    const crownR = spread ? 0.5 : garden ? 0.46 : 0.44;
    const crownFlat = spread ? 0.62 : garden ? 0.8 : 0.86;

    for (let i = 0; i < branches; i++) {
        const a = (i / branches) * Math.PI * 2 + hash01(i, species, salt) * 0.9;
        const reach = crownR * (0.5 + hash01(i, 11, salt) * 0.42);
        const tip = crownY - 0.06 + hash01(i, 13, salt) * 0.16;
        addTube(
            buf,
            0,
            trunkTop * 0.82,
            0,
            Math.cos(a) * reach,
            tip,
            Math.sin(a) * reach,
            trunkR * 0.55,
            trunkR * 0.24,
            4,
            BARK,
            trunkTop * 0.82,
            tip,
        );
    }

    const blobs = lod === 0 ? (garden ? 5 : spread ? 7 : 6) : garden ? 2 : 3;
    for (let i = 0; i < blobs; i++) {
        const a = (i / blobs) * Math.PI * 2 + hash01(i, 17, salt) * 1.3;
        const ring = i === 0 ? 0 : crownR * (0.34 + hash01(i, 19, salt) * 0.4);
        const y = crownY + (hash01(i, 23, salt) - 0.42) * (spread ? 0.2 : 0.3);
        const r = crownR * (spread ? 0.44 : 0.5) * (0.78 + hash01(i, 29, salt) * 0.5);
        addBlob(
            buf,
            Math.cos(a) * ring,
            y,
            Math.sin(a) * ring,
            r,
            r * crownFlat,
            r,
            fine,
            FOLIAGE[species],
            0.55 + (y - trunkTop) * 0.5,
            salt + i * 7,
            i === 0 ? 1 : 0.25,
        );
    }
    return toGeometry(buf, { aWind: 2, uv: 2 });
}

// --- テクスチャ（手続き生成・外部アセット不要） ---------------------------

function createLeafCardTexture(): Texture {
    const size = 128;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (ctx) {
        ctx.clearRect(0, 0, size, size);
        for (let i = 0; i < 150; i++) {
            const a = hashIndex01(i, 0x11) * Math.PI * 2;
            const rad = Math.sqrt(hashIndex01(i, 0x22)) * 0.46;
            const x = (0.5 + Math.cos(a) * rad) * size;
            const y = (0.52 + Math.sin(a) * rad * 0.94) * size;
            const r = (5 + hashIndex01(i, 0x33) * 7) * (1 - rad * 0.6);
            const g = 92 + hashIndex01(i, 0x44) * 70;
            ctx.fillStyle = `rgb(${Math.round(g * 0.55)}, ${Math.round(g)}, ${Math.round(g * 0.42)})`;
            ctx.beginPath();
            ctx.ellipse(x, y, r, r * 0.72, a, 0, Math.PI * 2);
            ctx.fill();
        }
    }
    const tex = new CanvasTexture(canvas);
    tex.colorSpace = SRGBColorSpace;
    tex.minFilter = LinearMipmapLinearFilter;
    tex.magFilter = LinearFilter;
    tex.generateMipmaps = true;
    tex.anisotropy = 4;
    return tex;
}

function createGrassTexture(): Texture {
    const w = 64;
    const h = 64;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (ctx) {
        ctx.clearRect(0, 0, w, h);
        for (let i = 0; i < 22; i++) {
            const x = hashIndex01(i, 0x55) * w;
            const lean = (hashIndex01(i, 0x66) - 0.5) * 18;
            const top = h * (0.25 + hashIndex01(i, 0x77) * 0.6);
            const g = 88 + hashIndex01(i, 0x88) * 66;
            ctx.strokeStyle = `rgb(${Math.round(g * 0.6)}, ${Math.round(g)}, ${Math.round(g * 0.4)})`;
            ctx.lineWidth = 1.6 + hashIndex01(i, 0x99) * 1.6;
            ctx.beginPath();
            // canvas は上が0なので、根本 = 下端
            ctx.moveTo(x, h);
            ctx.quadraticCurveTo(x + lean * 0.4, (h + top) / 2, x + lean, top);
            ctx.stroke();
        }
    }
    const tex = new CanvasTexture(canvas);
    tex.colorSpace = SRGBColorSpace;
    tex.minFilter = LinearMipmapLinearFilter;
    tex.magFilter = LinearFilter;
    tex.generateMipmaps = true;
    tex.anisotropy = 4;
    return tex;
}

// --- マテリアル -----------------------------------------------------------

/**
 * 葉のマテリアル。
 *  - 風: 幹はゆっくり大きく（aWind.x = 幹の高さ比の2乗で効かせる）、
 *        葉先は細かく速く（aWind.y = 葉らしさ）
 *  - 透過感: 太陽を背にした葉が明るく抜ける（サブサーフェス風のバックライト）
 *  - 包み込み: 法線が太陽から外れても急に真っ黒にならないラップ項
 */
function createFoliageMaterial(alphaMap: Texture | null): MeshStandardNodeMaterial {
    const material = new MeshStandardNodeMaterial({ metalness: 0 });
    const wind = attribute<'vec2'>('aWind', 'vec2');
    const variation = attribute<'vec2'>('aVar', 'vec2');
    const phase = variation.x.mul(6.2831853);
    const tint = variation.y;

    const slow = sin(time.mul(0.42).add(phase))
        .mul(0.62)
        .add(sin(time.mul(0.17).add(phase.mul(1.7))).mul(0.38));
    const fast = sin(time.mul(2.7).add(phase).add(positionLocal.x.add(positionLocal.z).mul(9)))
        .mul(0.55)
        .add(sin(time.mul(4.6).add(positionLocal.y.mul(11))).mul(0.45));
    const sway = slow.mul(wind.x.mul(wind.x)).mul(windStrengthNode).mul(0.038);
    const flutter = fast.mul(wind.y).mul(windStrengthNode).mul(0.013);
    const offset = windDirNode.mul(sway.add(flutter));
    material.positionNode = positionLocal.add(vec3(offset.x, flutter.mul(-0.3), offset.y));

    const vcol = attribute<'vec3'>('color', 'vec3');
    // 個体差: わずかな黄緑〜深緑のふり幅（季節感を壊さない範囲）
    const hue = mix(vec3(0.84, 1.08, 0.82), vec3(1.18, 0.95, 0.66), tint);
    // カード系はテクスチャの明暗だけ拾う（色そのものは葉色で決める）
    const base = alphaMap
        ? vcol.mul(hue).mul(mix(float(0.78), float(1.32), saturate(textureNode(alphaMap, uv()).g.mul(3))))
        : vcol.mul(hue);
    material.colorNode = base;

    // 逆光の抜け（視線が太陽方向に近いほど葉が明るく透ける）
    const view = positionWorld.sub(cameraPosition).normalize();
    const back = saturate(view.dot(sunDirNode)).pow(3.2);
    const wrap = saturate(normalWorld.dot(sunDirNode).mul(0.5).add(0.5)).pow(2);
    material.emissiveNode = base
        .mul(sunColorNode)
        .mul(back.mul(wind.y).mul(0.85).add(wrap.mul(wind.y).mul(0.16)));
    material.roughnessNode = mix(float(0.92), float(0.66), wind.y);

    if (alphaMap) {
        material.opacityNode = textureNode(alphaMap, uv()).a;
        // ブレンド禁止・アルファテストのみ（追記2-5 オーバードロー抑制）。
        // ミップで葉が痩せすぎないよう閾値は低め
        material.alphaTest = 0.28;
        material.side = DoubleSide;
    }
    return material;
}

// --- インスタンス管理 -----------------------------------------------------

interface VegItem {
    x: number;
    y: number;
    z: number;
    species: number;
    sx: number;
    sy: number;
    sz: number;
    rot: number;
    phase: number;
    tint: number;
}

interface CellRange {
    matrices: Float32Array;
    variation: Float32Array;
    count: number;
}

interface Cell {
    cx: number;
    cz: number;
    sphere: Sphere;
    ranges: (CellRange | null)[];
    total: number;
}

export interface Vegetation {
    group: Group;
    /** LOD段ごとの描画インスタンス数（stats 用） */
    readonly drawn: Int32Array;
    itemCount: number;
    update(
        cameraPos: Vector3,
        cameraDir: Vector3,
        frustum: Frustum,
        quality: QualitySettings,
        force: boolean,
    ): void;
}

function speciesForTree(tree: TreeInstance, elevation: number, flags: number, r: number): number {
    const ratio = tree.crown / Math.max(1, tree.height);
    if (tree.height < 5) return SP_GARDEN;
    // 六甲山麓: スギ・ヒノキの植林と広葉樹二次林が混じる
    if (elevation > 165) return r < 0.4 ? SP_CONIFER : SP_ROUND;
    // 道路際は街路樹・庭木
    if ((flags & OCC_ROADSIDE) !== 0) return r < 0.55 ? SP_SPREAD : SP_GARDEN;
    if (ratio > 0.85) return SP_SPREAD;
    return r < 0.18 ? SP_CONIFER : SP_ROUND;
}

/** 建物の前面と道路際に生け垣を並べる（住宅街の実在感） */
function collectHedges(
    buildings: readonly BuildingShape[],
    occupancy: Occupancy,
    getElevationAt: (x: number, z: number) => number,
    out: VegItem[],
): void {
    for (const shape of buildings) {
        const ring = shape.rings[0];
        if (ring.length < 3) continue;
        const seed = ring[0];
        if (hash01(seed.x, seed.z, 0x4ed6) > 0.55) continue; // 半分弱の敷地だけ
        const height = 0.85 + hash01(seed.x, seed.z, 0x71) * 0.75;
        // 外側へ 1.1m オフセットした位置に 2m 間隔で並べる
        let cx = 0;
        let cz = 0;
        for (const p of ring) {
            cx += p.x;
            cz += p.z;
        }
        cx /= ring.length;
        cz /= ring.length;
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            const a = ring[j];
            const b = ring[i];
            const dx = b.x - a.x;
            const dz = b.z - a.z;
            const len = Math.hypot(dx, dz);
            if (len < 2.4) continue;
            let nx = -dz / len;
            let nz = dx / len;
            if (nx * ((a.x + b.x) / 2 - cx) + nz * ((a.z + b.z) / 2 - cz) < 0) {
                nx = -nx;
                nz = -nz;
            }
            // 単位生け垣の長辺は +X。インスタンス回転で辺方向に合わせる
            const rot = Math.atan2(-dz, dx);
            const steps = Math.floor(len / 2);
            for (let s = 0; s < steps; s++) {
                const t = (s + 0.5) / steps;
                const px = a.x + dx * t + nx * 1.15;
                const pz = a.z + dz * t + nz * 1.15;
                const flags = occupancy.at(px, pz);
                if ((flags & (OCC_BUILDING | OCC_ROAD)) !== 0) continue;
                // 道路に面した辺だけ（前庭の生け垣）
                if ((flags & OCC_ROADSIDE) === 0) continue;
                out.push({
                    x: px,
                    y: getElevationAt(px, pz) - 0.1,
                    z: pz,
                    species: SP_HEDGE,
                    sx: 2.05,
                    sy: height,
                    sz: 0.85,
                    rot,
                    phase: hash01(px, pz, 0x9a),
                    tint: hash01(px, pz, 0xb3),
                });
            }
        }
    }
}

/** 道路際・法面の下草 */
function collectGroundCover(
    roads: readonly RoadLine[],
    occupancy: Occupancy,
    getElevationAt: (x: number, z: number) => number,
    out: VegItem[],
): void {
    for (const road of roads) {
        const half = Math.max(1.2, Math.min(road.width, 30)) / 2;
        for (let i = 1; i < road.points.length; i++) {
            const a = road.points[i - 1];
            const b = road.points[i];
            const dx = b.x - a.x;
            const dz = b.z - a.z;
            const len = Math.hypot(dx, dz);
            if (len < 0.5) continue;
            const nx = -dz / len;
            const nz = dx / len;
            const steps = Math.max(1, Math.floor(len / 2.4));
            for (let s = 0; s < steps; s++) {
                const t = (s + 0.5) / steps;
                for (const side of [-1, 1]) {
                    const lateral = half + 1.1 + hash01(s, side * (i + 1), 0x31) * 1.5;
                    const px = a.x + dx * t + nx * lateral * side;
                    const pz = a.z + dz * t + nz * lateral * side;
                    if (occupancy.blocked(px, pz)) continue;
                    const y = getElevationAt(px, pz);
                    // 法面（急斜面）は密に、平地はまばらに
                    const slope = Math.abs(getElevationAt(px + 1.5, pz) - getElevationAt(px - 1.5, pz)) / 3;
                    const gate = slope > 0.35 ? 0.82 : 0.3;
                    if (hash01(px, pz, 0x6cc1) > gate) continue;
                    const size = 0.5 + hash01(px, pz, 0x77) * 0.55;
                    out.push({
                        x: px,
                        y: y - 0.06,
                        z: pz,
                        species: SP_GRASS,
                        sx: size * 1.5,
                        sy: size,
                        sz: size * 1.5,
                        rot: hash01(px, pz, 0x1f) * Math.PI,
                        phase: hash01(px, pz, 0x2f),
                        tint: hash01(px, pz, 0x3f),
                    });
                }
            }
        }
    }
}

export function createVegetation(
    trees: readonly TreeInstance[],
    buildings: readonly BuildingShape[],
    roads: readonly RoadLine[],
    occupancy: Occupancy,
    getElevationAt: (x: number, z: number) => number,
    quality: QualitySettings,
): Vegetation {
    const items: VegItem[] = [];

    for (const tree of trees) {
        const flags = occupancy.at(tree.x, tree.z);
        // 道路面・建物フットプリントに重なる点は落とす（E14）
        if ((flags & (OCC_ROAD | OCC_BUILDING)) !== 0) continue;
        const ground = getElevationAt(tree.x, tree.z);
        const r = hash01(tree.x, tree.z, 0x5ee1);
        const species = speciesForTree(tree, ground, flags, r);
        const crown = Math.max(1.2, tree.crown);
        items.push({
            x: tree.x,
            y: ground - Math.min(0.4, tree.height * 0.03),
            z: tree.z,
            species,
            sx: crown,
            sy: Math.max(1.5, tree.height),
            sz: crown * (0.86 + hash01(tree.x, tree.z, 0x13) * 0.28),
            rot: hash01(tree.x, tree.z, 0x27) * Math.PI * 2,
            phase: hash01(tree.x, tree.z, 0x39),
            tint: hash01(tree.x, tree.z, 0x4b),
        });
    }
    collectHedges(buildings, occupancy, getElevationAt, items);
    if (quality.groundCover) collectGroundCover(roads, occupancy, getElevationAt, items);

    // セル → 樹種 の順に並べ替え、セル×樹種のインスタンスが連続領域になるようにする
    const cellIndexOf = (x: number, z: number): number => {
        const cx = Math.min(CELLS - 1, Math.max(0, Math.floor((x + LIMIT) / CELL)));
        const cz = Math.min(CELLS - 1, Math.max(0, Math.floor((z + LIMIT) / CELL)));
        return cz * CELLS + cx;
    };
    items.sort((a, b) => {
        const ca = cellIndexOf(a.x, a.z);
        const cb = cellIndexOf(b.x, b.z);
        return ca !== cb ? ca - cb : a.species - b.species;
    });

    const matrices = new Float32Array(items.length * 16);
    const variations = new Float32Array(items.length * 2);
    for (let i = 0; i < items.length; i++) {
        const it = items[i];
        const c = Math.cos(it.rot);
        const s = Math.sin(it.rot);
        const m = i * 16;
        matrices[m] = c * it.sx;
        matrices[m + 1] = 0;
        matrices[m + 2] = -s * it.sx;
        matrices[m + 3] = 0;
        matrices[m + 4] = 0;
        matrices[m + 5] = it.sy;
        matrices[m + 6] = 0;
        matrices[m + 7] = 0;
        matrices[m + 8] = s * it.sz;
        matrices[m + 9] = 0;
        matrices[m + 10] = c * it.sz;
        matrices[m + 11] = 0;
        matrices[m + 12] = it.x;
        matrices[m + 13] = it.y;
        matrices[m + 14] = it.z;
        matrices[m + 15] = 1;
        variations[i * 2] = it.phase;
        variations[i * 2 + 1] = it.tint;
    }

    // セルごとの連続レンジ（ビューは構築時に作り、実行時は set() するだけ）
    const cells: Cell[] = [];
    let i = 0;
    while (i < items.length) {
        const cellId = cellIndexOf(items[i].x, items[i].z);
        const start = i;
        let maxY = -Infinity;
        let minY = Infinity;
        while (i < items.length && cellIndexOf(items[i].x, items[i].z) === cellId) {
            const it = items[i];
            if (it.y < minY) minY = it.y;
            if (it.y + it.sy > maxY) maxY = it.y + it.sy;
            i++;
        }
        const ranges: (CellRange | null)[] = new Array(SPECIES_COUNT).fill(null);
        let k = start;
        while (k < i) {
            const sp = items[k].species;
            const s0 = k;
            while (k < i && items[k].species === sp) k++;
            ranges[sp] = {
                matrices: matrices.subarray(s0 * 16, k * 16),
                variation: variations.subarray(s0 * 2, k * 2),
                count: k - s0,
            };
        }
        const cx = (cellId % CELLS) * CELL - LIMIT + CELL / 2;
        const cz = Math.floor(cellId / CELLS) * CELL - LIMIT + CELL / 2;
        cells.push({
            cx,
            cz,
            sphere: new Sphere(
                new Vector3(cx, (minY + maxY) / 2, cz),
                Math.hypot(CELL * 0.71, (maxY - minY) / 2 + 12),
            ),
            ranges,
            total: i - start,
        });
    }

    // --- 描画メッシュ（樹種 × LOD段） ---
    const group = new Group();
    group.name = 'vegetation';
    const cardTexture = createLeafCardTexture();
    const grassTexture = createGrassTexture();
    const solidMaterial = createFoliageMaterial(null);
    const cardMaterial = createFoliageMaterial(cardTexture);
    const grassMaterial = createFoliageMaterial(grassTexture);

    const capacityFor = (species: number, lod: number): number => {
        if (species === SP_HEDGE) return quality.preset === 'mobile' ? 900 : 2600;
        if (species === SP_GRASS) return quality.preset === 'mobile' ? 1200 : 4200;
        return Math.ceil(quality.treeBudget[lod] / TREE_SPECIES) + 64;
    };

    const meshes: (InstancedMesh | null)[][] = [];
    const varAttributes: (InstancedBufferAttribute | null)[][] = [];
    for (let sp = 0; sp < SPECIES_COUNT; sp++) {
        meshes.push([]);
        varAttributes.push([]);
        const lods = sp < TREE_SPECIES ? LOD_COUNT : 1;
        for (let lod = 0; lod < LOD_COUNT; lod++) {
            if (lod >= lods) {
                meshes[sp].push(null);
                varAttributes[sp].push(null);
                continue;
            }
            const capacity = capacityFor(sp, lod);
            const geometry = buildTreeGeometry(sp, sp < TREE_SPECIES ? lod : 0);
            const material = sp === SP_GRASS ? grassMaterial : lod === 2 ? cardMaterial : solidMaterial;
            const mesh = new InstancedMesh(geometry, material, capacity);
            mesh.name = `veg-${sp}-${lod}`;
            mesh.instanceMatrix.setUsage(DynamicDrawUsage);
            mesh.frustumCulled = false; // セル単位で自前カリング済み
            mesh.castShadow = quality.shadows && lod === 0 && sp !== SP_GRASS;
            mesh.receiveShadow = sp !== SP_GRASS;
            mesh.count = 0;
            mesh.visible = false;
            const varAttr = new InstancedBufferAttribute(new Float32Array(capacity * 2), 2);
            varAttr.setUsage(DynamicDrawUsage);
            geometry.setAttribute('aVar', varAttr);
            meshes[sp].push(mesh);
            varAttributes[sp].push(varAttr);
            group.add(mesh);
        }
    }

    // --- 毎フレーム（実際にはカメラが動いたときだけ）詰め直す ---
    const drawn = new Int32Array(LOD_COUNT);
    const order = new Int32Array(cells.length);
    const cellDistance = new Float32Array(cells.length);
    const writeHead: number[][] = [];
    for (let sp = 0; sp < SPECIES_COUNT; sp++) writeHead.push([0, 0, 0]);
    const lastAnchor = new Vector3(Infinity, 0, 0);

    const rebuild = (cameraPos: Vector3, frustum: Frustum, q: QualitySettings): void => {
        for (const heads of writeHead) heads[0] = heads[1] = heads[2] = 0;
        drawn.fill(0);

        let visible = 0;
        for (let ci = 0; ci < cells.length; ci++) {
            const cell = cells[ci];
            const dx = cell.cx - cameraPos.x;
            const dz = cell.cz - cameraPos.z;
            const dist = Math.max(0, Math.hypot(dx, dz) - CELL * 0.71);
            if (dist > q.treeFar) continue;
            if (!frustum.intersectsSphere(cell.sphere)) continue;
            order[visible] = ci;
            cellDistance[ci] = dist;
            visible++;
        }
        // 近いセルから詰めるので、上限に当たったときに切り捨てられるのは遠いセル
        const slice = order.subarray(0, visible);
        slice.sort((a, b) => cellDistance[a] - cellDistance[b]);

        for (let vi = 0; vi < visible; vi++) {
            const cell = cells[slice[vi]];
            const dist = cellDistance[slice[vi]];
            const treeLod = dist < q.treeNear ? 0 : dist < q.treeMid ? 1 : 2;
            for (let sp = 0; sp < SPECIES_COUNT; sp++) {
                const range = cell.ranges[sp];
                if (!range) continue;
                const isTree = sp < TREE_SPECIES;
                if (!isTree && dist > (sp === SP_GRASS ? q.groundCoverDistance : q.propDistance)) continue;
                let lod = isTree ? treeLod : 0;
                let mesh = meshes[sp][lod];
                if (!mesh) continue;
                let head = writeHead[sp][lod];
                // 段の上限に当たったら一番粗い段へ落とす（それも満杯なら捨てる）
                if (head + range.count > mesh.instanceMatrix.count) {
                    if (!isTree || lod >= LOD_COUNT - 1) continue;
                    lod = LOD_COUNT - 1;
                    mesh = meshes[sp][lod];
                    if (!mesh) continue;
                    head = writeHead[sp][lod];
                    if (head + range.count > mesh.instanceMatrix.count) continue;
                }
                (mesh.instanceMatrix.array as Float32Array).set(range.matrices, head * 16);
                (varAttributes[sp][lod] as InstancedBufferAttribute).array.set(range.variation, head * 2);
                writeHead[sp][lod] = head + range.count;
                if (isTree) drawn[lod] += range.count;
            }
        }

        for (let sp = 0; sp < SPECIES_COUNT; sp++) {
            for (let lod = 0; lod < LOD_COUNT; lod++) {
                const mesh = meshes[sp][lod];
                if (!mesh) continue;
                const count = writeHead[sp][lod];
                mesh.count = count;
                mesh.visible = count > 0;
                if (count > 0) {
                    mesh.instanceMatrix.needsUpdate = true;
                    const attr = varAttributes[sp][lod];
                    if (attr) attr.needsUpdate = true;
                }
            }
        }
    };

    const lastForward = new Vector3(0, 0, 1);
    return {
        group,
        drawn,
        itemCount: items.length,
        update(cameraPos, cameraDir, frustum, q, force) {
            // 平行移動だけでなく回転でも見えるセルが変わるので、向きの変化も見る
            const moved = cameraPos.distanceTo(lastAnchor) >= REBUILD_DISTANCE;
            const turned = cameraDir.dot(lastForward) < 0.985;
            if (!force && !moved && !turned) return;
            lastAnchor.copy(cameraPos);
            lastForward.copy(cameraDir);
            rebuild(cameraPos, frustum, q);
        },
    };
}
