/**
 * 手続きメッシュ構築の共通ヘルパー。
 *
 * 頂点属性は転送量を抑えるため量子化する（追記2-7）:
 *   position = Float32 / normal = Int16正規化 / color = Uint8正規化
 * three は 4バイト境界に満たない属性をアップロード時にパディングするので
 * itemSize=3 のまま扱ってよい（WebGPU/WebGL2 どちらのバックエンドでも同じ）。
 */
import { BufferAttribute, BufferGeometry } from 'three/webgpu';

export interface MeshBuf {
    pos: number[];
    nrm: number[];
    col: number[];
    /** 追加の float 属性。キーは属性名、値は itemSize ぶんずつ並んだ配列 */
    extra: Record<string, number[]>;
}

export function createBuf(extraNames: readonly string[] = []): MeshBuf {
    const extra: Record<string, number[]> = {};
    for (const name of extraNames) extra[name] = [];
    return { pos: [], nrm: [], col: [], extra };
}

/** 頂点1点。色は 0〜1 */
export function pushVertex(
    b: MeshBuf,
    x: number,
    y: number,
    z: number,
    nx: number,
    ny: number,
    nz: number,
    r: number,
    g: number,
    bl: number,
): void {
    b.pos.push(x, y, z);
    b.nrm.push(nx, ny, nz);
    b.col.push(r, g, bl);
}

export function vertexCount(b: MeshBuf): number {
    return b.pos.length / 3;
}

/** 三角形の面法線を求めて、その向きで3頂点を積む */
export function pushTriangle(
    b: MeshBuf,
    ax: number,
    ay: number,
    az: number,
    bx: number,
    by: number,
    bz: number,
    cx: number,
    cy: number,
    cz: number,
    r: number,
    g: number,
    bl: number,
): void {
    const ux = bx - ax;
    const uy = by - ay;
    const uz = bz - az;
    const wx = cx - ax;
    const wy = cy - ay;
    const wz = cz - az;
    let nx = uy * wz - uz * wy;
    let ny = uz * wx - ux * wz;
    let nz = ux * wy - uy * wx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len;
    ny /= len;
    nz /= len;
    pushVertex(b, ax, ay, az, nx, ny, nz, r, g, bl);
    pushVertex(b, bx, by, bz, nx, ny, nz, r, g, bl);
    pushVertex(b, cx, cy, cz, nx, ny, nz, r, g, bl);
}

/** 四角形（a→b→c→d）を2枚の三角形にして積む */
export function pushQuad(
    b: MeshBuf,
    a: readonly number[],
    q: readonly number[],
    c: readonly number[],
    d: readonly number[],
    r: number,
    g: number,
    bl: number,
): void {
    pushTriangle(b, a[0], a[1], a[2], q[0], q[1], q[2], c[0], c[1], c[2], r, g, bl);
    pushTriangle(b, a[0], a[1], a[2], c[0], c[1], c[2], d[0], d[1], d[2], r, g, bl);
}

/**
 * 外向き方向を指定して四角形を積む。巻き方向を間違えても法線が指定方向を向くよう
 * 自動で反転するので、OBB ローカル座標から生成する屋根・軒まわりで裏返りが起きない。
 */
export function pushQuadFacing(
    b: MeshBuf,
    a: readonly number[],
    q: readonly number[],
    c: readonly number[],
    d: readonly number[],
    ox: number,
    oy: number,
    oz: number,
    r: number,
    g: number,
    bl: number,
): void {
    const nx = (q[1] - a[1]) * (c[2] - a[2]) - (q[2] - a[2]) * (c[1] - a[1]);
    const ny = (q[2] - a[2]) * (c[0] - a[0]) - (q[0] - a[0]) * (c[2] - a[2]);
    const nz = (q[0] - a[0]) * (c[1] - a[1]) - (q[1] - a[1]) * (c[0] - a[0]);
    if (nx * ox + ny * oy + nz * oz >= 0) pushQuad(b, a, q, c, d, r, g, bl);
    else pushQuad(b, a, d, c, q, r, g, bl);
}

export function pushTriangleFacing(
    b: MeshBuf,
    a: readonly number[],
    q: readonly number[],
    c: readonly number[],
    ox: number,
    oy: number,
    oz: number,
    r: number,
    g: number,
    bl: number,
): void {
    const nx = (q[1] - a[1]) * (c[2] - a[2]) - (q[2] - a[2]) * (c[1] - a[1]);
    const ny = (q[2] - a[2]) * (c[0] - a[0]) - (q[0] - a[0]) * (c[2] - a[2]);
    const nz = (q[0] - a[0]) * (c[1] - a[1]) - (q[1] - a[1]) * (c[0] - a[0]);
    const [p1, p2] = nx * ox + ny * oy + nz * oz >= 0 ? [q, c] : [c, q];
    pushTriangle(b, a[0], a[1], a[2], p1[0], p1[1], p1[2], p2[0], p2[1], p2[2], r, g, bl);
}

function toInt16Normalized(values: readonly number[]): Int16Array {
    const out = new Int16Array(values.length);
    for (let i = 0; i < values.length; i++) {
        const v = values[i];
        out[i] = Math.max(-32767, Math.min(32767, Math.round(v * 32767)));
    }
    return out;
}

function toUint8Normalized(values: readonly number[]): Uint8Array {
    const out = new Uint8Array(values.length);
    for (let i = 0; i < values.length; i++) {
        out[i] = Math.max(0, Math.min(255, Math.round(values[i] * 255)));
    }
    return out;
}

/** MeshBuf を BufferGeometry へ。extraItemSize で追加属性の要素数を指定する */
export function toGeometry(
    b: MeshBuf,
    extraItemSize: Record<string, number> = {},
): BufferGeometry {
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(Float32Array.from(b.pos), 3));
    geometry.setAttribute('normal', new BufferAttribute(toInt16Normalized(b.nrm), 3, true));
    geometry.setAttribute('color', new BufferAttribute(toUint8Normalized(b.col), 3, true));
    for (const [name, data] of Object.entries(b.extra)) {
        const itemSize = extraItemSize[name] ?? 1;
        geometry.setAttribute(name, new BufferAttribute(Float32Array.from(data), itemSize));
    }
    geometry.computeBoundingSphere();
    return geometry;
}

/** 単位正二十面体（非インデックス・原点中心・半径1）。葉塊の下敷きに使う */
let icosaCache: Float32Array | null = null;
export function icosahedronTriangles(): Float32Array {
    if (icosaCache) return icosaCache;
    const t = (1 + Math.sqrt(5)) / 2;
    const v: number[][] = [
        [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0],
        [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
        [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
    ].map((p) => {
        const l = Math.hypot(p[0], p[1], p[2]);
        return [p[0] / l, p[1] / l, p[2] / l];
    });
    const f = [
        [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
        [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
        [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
        [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
    ];
    const out = new Float32Array(f.length * 9);
    let k = 0;
    for (const tri of f) {
        for (const idx of tri) {
            out[k++] = v[idx][0];
            out[k++] = v[idx][1];
            out[k++] = v[idx][2];
        }
    }
    icosaCache = out;
    return out;
}

/** 正二十面体を1回細分割した三角形列（近景LOD用・80面） */
let icosaFineCache: Float32Array | null = null;
export function icosahedronTrianglesFine(): Float32Array {
    if (icosaFineCache) return icosaFineCache;
    const base = icosahedronTriangles();
    const out = new Float32Array(base.length * 4);
    let k = 0;
    const mid = (a: number[], b: number[]): number[] => {
        const m = [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
        const l = Math.hypot(m[0], m[1], m[2]) || 1;
        return [m[0] / l, m[1] / l, m[2] / l];
    };
    for (let i = 0; i < base.length; i += 9) {
        const a = [base[i], base[i + 1], base[i + 2]];
        const b = [base[i + 3], base[i + 4], base[i + 5]];
        const c = [base[i + 6], base[i + 7], base[i + 8]];
        const ab = mid(a, b);
        const bc = mid(b, c);
        const ca = mid(c, a);
        for (const tri of [
            [a, ab, ca],
            [ab, b, bc],
            [ca, bc, c],
            [ab, bc, ca],
        ]) {
            for (const p of tri) {
                out[k++] = p[0];
                out[k++] = p[1];
                out[k++] = p[2];
            }
        }
    }
    icosaFineCache = out;
    return out;
}
