/**
 * 手続きメッシュ構築の共通ヘルパー。
 *
 * 頂点属性は転送量を抑えるため量子化する（追記2-7）:
 *   position = Float32 / normal = Int16正規化 / color = Uint8正規化
 * three は 4バイト境界に満たない属性をアップロード時にパディングするので
 * itemSize=3 のまま扱ってよい（WebGPU/WebGL2 どちらのバックエンドでも同じ）。
 */
import { BufferAttribute, BufferGeometry, Color, Euler, Matrix4, Vector3 } from 'three/webgpu';

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

// --- three のプリミティブを1メッシュへ束ねる -------------------------------
// BufferGeometryUtils は addons にしかない（コア二重ロードを起こすので使えない）。
// アバター（契約06）とマッチの小物（契約10）が同じ実装を共有する。

/** merge に渡す1パーツ。matrix が置き場所、color が頂点色（省略時は白） */
export interface GeometryPart {
    geometry: BufferGeometry;
    matrix?: Matrix4;
    color?: number;
}

/** 位置・スケール・回転から行列を作る（構築時のみ使う） */
export function partMatrix(
    x: number,
    y: number,
    z: number,
    sx = 1,
    sy = 1,
    sz = 1,
    rx = 0,
    ry = 0,
    rz = 0,
): Matrix4 {
    const m = new Matrix4();
    m.makeRotationFromEuler(new Euler(rx, ry, rz));
    m.scale(new Vector3(sx, sy, sz));
    m.setPosition(x, y, z);
    return m;
}

/**
 * 複数のジオメトリを1つへ束ねる。位置と法線だけを持つ非インデックスのジオメトリにする
 * （テクスチャを使わないので uv は不要）。1つでも color を持てば color 属性が付く。
 * 渡したジオメトリは破棄する（構築時のみ使う前提）。
 */
const mergeColor = new Color();
export function mergeParts(parts: readonly GeometryPart[]): BufferGeometry {
    const pieces: BufferGeometry[] = [];
    let total = 0;
    let colored = false;
    for (const part of parts) {
        const geometry = part.geometry.index ? part.geometry.toNonIndexed() : part.geometry.clone();
        if (part.matrix) geometry.applyMatrix4(part.matrix);
        pieces.push(geometry);
        total += geometry.attributes.position.count;
        if (part.color !== undefined) colored = true;
    }
    const position = new Float32Array(total * 3);
    const normal = new Float32Array(total * 3);
    // 頂点色はリニア（three の作業色空間）で書く。Color.setHex が sRGB から変換してくれる
    const color = colored ? new Float32Array(total * 3) : null;
    let offset = 0;
    for (let i = 0; i < pieces.length; i++) {
        const piece = pieces[i];
        const pos = piece.attributes.position as BufferAttribute;
        const nrm = piece.attributes.normal as BufferAttribute;
        position.set(pos.array as Float32Array, offset);
        normal.set(nrm.array as Float32Array, offset);
        if (color) {
            mergeColor.setHex(parts[i].color ?? 0xffffff);
            for (let v = 0; v < pos.count; v++) {
                color[offset + v * 3] = mergeColor.r;
                color[offset + v * 3 + 1] = mergeColor.g;
                color[offset + v * 3 + 2] = mergeColor.b;
            }
        }
        offset += pos.count * 3;
        piece.dispose();
    }
    for (const part of parts) part.geometry.dispose();
    const out = new BufferGeometry();
    out.setAttribute('position', new BufferAttribute(position, 3));
    out.setAttribute('normal', new BufferAttribute(normal, 3));
    if (color) out.setAttribute('color', new BufferAttribute(color, 3));
    out.computeBoundingSphere();
    return out;
}
