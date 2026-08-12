/**
 * 建物メッシュ。bvmap の BldA ポリゴンを押し出して1枚のジオメトリにまとめる。
 *
 * 高さは 兵庫県 50cmメッシュ DSM/DEM から前処理で測った実高さを使う。フットプリントの
 * 決定的ハッシュ（src/shared/geo.js の footprintKey）で引き、引けなかった建物だけ
 * 従来の階数ヒューリスティックに落とす（契約02 E12）。
 * 色の揺らぎは座標由来の決定的ハッシュで決める（実行時乱数の使用は禁止:
 * 全クライアントが同じ町を見る必要があるため — data-spec.md §4）。
 */
import {
    BufferAttribute,
    BufferGeometry,
    Color,
    Mesh,
    MeshStandardMaterial,
    ShapeUtils,
} from 'three/webgpu';
import { BLD_FIREPROOF, BLD_NO_WALL, BLD_ORDINARY } from '../config';
import { footprintKey } from '../geo';
import type { BuildingHeightMap } from '../data/terrain-assets';
import type { BuildingShape, Point2 } from '../data/vector';

/** 傾斜地で屋根を持ち上げる補正量の上限[m] */
const MAX_SLOPE_LIFT = 6;

/** 座標から決まる 0〜1 の決定的な擬似乱数。同じ座標なら常に同じ値を返す */
function hash01(x: number, z: number, salt: number): number {
    let h = Math.imul((Math.round(x * 100) | 0) ^ 0x9e3779b9, 0x85ebca6b);
    h ^= Math.imul((Math.round(z * 100) | 0) + 0x165667b1, 0xc2b2ae35);
    h ^= Math.imul(h ^ salt, 0x27d4eb2f);
    h ^= h >>> 15;
    h = Math.imul(h, 0x2545f491);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
}

function ringArea(ring: Point2[]): number {
    let a = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        a += ring[j].x * ring[i].z - ring[i].x * ring[j].z;
    }
    return a / 2;
}

function centroidOf(ring: Point2[]): Point2 {
    let x = 0;
    let z = 0;
    for (const p of ring) {
        x += p.x;
        z += p.z;
    }
    return { x: x / ring.length, z: z / ring.length };
}

/** 階数ヒューリスティック（data-spec.md §4）。bvmap に高さ属性は無い */
function buildingHeight(code: number, area: number, r: number): number {
    switch (code) {
        case BLD_NO_WALL:
            return 3;
        case BLD_FIREPROOF: {
            const byArea = 12 + Math.min(area, 4000) / 200;
            return Math.min(30, byArea + r * 6 - 2);
        }
        case BLD_ORDINARY:
        default:
            return 5 + r * 3;
    }
}

function buildingColors(code: number, r0: number, r1: number): { wall: Color; roof: Color } {
    const wall = new Color();
    const roof = new Color();
    if (code === BLD_FIREPROOF) {
        wall.setHSL(0.09 + r0 * 0.03, 0.04 + r1 * 0.05, 0.58 + r0 * 0.16);
        roof.setHSL(0.58, 0.03 + r1 * 0.04, 0.42 + r1 * 0.12);
    } else if (code === BLD_NO_WALL) {
        wall.setHSL(0.09, 0.05, 0.5);
        roof.setHSL(0.55, 0.05, 0.45);
    } else {
        wall.setHSL(0.09 + r0 * 0.05, 0.08 + r1 * 0.14, 0.62 + r0 * 0.18);
        // 屋根は青灰色の瓦を基本に、一部を茶系にする
        if (r1 < 0.25) roof.setHSL(0.05 + r0 * 0.02, 0.28, 0.26 + r0 * 0.1);
        else roof.setHSL(0.57 + r0 * 0.04, 0.08 + r1 * 0.12, 0.26 + r1 * 0.14);
    }
    return { wall, roof };
}

export interface BuildingsResult {
    mesh: Mesh;
    /** 実測高さを適用できた建物数 */
    measured: number;
    total: number;
}

export function createBuildings(
    shapes: readonly BuildingShape[],
    getElevationAt: (x: number, z: number) => number,
    measuredHeights: BuildingHeightMap | null,
): BuildingsResult {
    const positions: number[] = [];
    const normals: number[] = [];
    const colors: number[] = [];
    let measured = 0;
    let total = 0;

    const pushVertex = (
        x: number,
        y: number,
        z: number,
        nx: number,
        ny: number,
        nz: number,
        c: Color,
        shade: number,
    ): void => {
        positions.push(x, y, z);
        normals.push(nx, ny, nz);
        colors.push(
            Math.round(c.r * shade * 255),
            Math.round(c.g * shade * 255),
            Math.round(c.b * shade * 255),
        );
    };

    for (const shape of shapes) {
        const outer = shape.rings[0];
        const holes = shape.rings.slice(1);
        const area = Math.abs(ringArea(outer));
        if (area < 3) continue;

        const seed = outer[0];
        const r0 = hash01(seed.x, seed.z, 0x1234);
        const r1 = hash01(seed.x, seed.z, 0x9abc);

        // 斜面対策（E5-a / E6）: 足元は接地面の最低標高より1m下げて浮きを消す。
        // 屋根は傾斜分だけ持ち上げるが、六甲山麓の急斜面で塔のようにならないよう
        // 補正量に上限を設ける（超える分は山側が埋まる = 斜面に建つ実際の見え方に近い）
        let gmin = Infinity;
        let gmax = -Infinity;
        for (const ring of shape.rings) {
            for (const p of ring) {
                const e = getElevationAt(p.x, p.z);
                if (e < gmin) gmin = e;
                if (e > gmax) gmax = e;
            }
        }
        if (!Number.isFinite(gmin) || !Number.isFinite(gmax)) continue;
        total++;

        // 実測値があれば「測ったときの地面 + 高さ」が屋根の絶対標高そのもの。
        // 無ければ従来どおり、足元の最低標高から傾斜ぶんを持ち上げて推定する
        const entry = measuredHeights?.get(footprintKey(outer, shape.code));
        let top: number;
        if (entry) {
            top = entry[1] + entry[0];
            measured++;
        } else {
            const slope = Math.min(gmax - gmin, MAX_SLOPE_LIFT);
            top = gmin + slope + buildingHeight(shape.code, area, r0);
        }
        // 屋根が地面に潜ってしまう（測定値と地形がずれる）ときの保険
        if (top < gmin + 2.5) top = gmin + 2.5;
        // 足元は接地面の最低標高より1m下げて浮きを消す（E5-a / E6）
        const base = gmin - 1;

        const { wall, roof } = buildingColors(shape.code, r0, r1);

        // --- 屋根（上面キャップ） ---
        const contour = outer.map((p) => ({ x: p.x, y: p.z }));
        const holeContours = holes.map((ring) => ring.map((p) => ({ x: p.x, y: p.z })));
        const allPoints = [...outer, ...holes.flat()];
        let faces: number[][] = [];
        try {
            faces = ShapeUtils.triangulateShape(contour, holeContours);
        } catch {
            faces = [];
        }
        for (const face of faces) {
            const a = allPoints[face[0]];
            const b = allPoints[face[1]];
            const c = allPoints[face[2]];
            if (!a || !b || !c) continue;
            // 上から見て法線が +Y になる並びに正規化する
            const ny = (b.z - a.z) * (c.x - a.x) - (b.x - a.x) * (c.z - a.z);
            const [p1, p2] = ny >= 0 ? [b, c] : [c, b];
            pushVertex(a.x, top, a.z, 0, 1, 0, roof, 1);
            pushVertex(p1.x, top, p1.z, 0, 1, 0, roof, 1);
            pushVertex(p2.x, top, p2.z, 0, 1, 0, roof, 1);
        }

        // --- 壁 ---
        for (let ri = 0; ri < shape.rings.length; ri++) {
            const ring = shape.rings[ri];
            const center = centroidOf(ring);
            const outward = ri === 0 ? 1 : -1;
            for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
                const p = ring[j];
                const q = ring[i];
                const dx = q.x - p.x;
                const dz = q.z - p.z;
                const len = Math.hypot(dx, dz);
                if (len < 0.05) continue;
                let nx = -dz / len;
                let nz = dx / len;
                const mx = (p.x + q.x) / 2 - center.x;
                const mz = (p.z + q.z) / 2 - center.z;
                const flip = (nx * mx + nz * mz) * outward < 0;
                if (flip) {
                    nx = -nx;
                    nz = -nz;
                }
                const [s, e] = flip ? [q, p] : [p, q];
                // (s,base) → (e,base) → (e,top) → (s,top)
                pushVertex(s.x, base, s.z, nx, 0, nz, wall, 0.7);
                pushVertex(e.x, base, e.z, nx, 0, nz, wall, 0.7);
                pushVertex(e.x, top, e.z, nx, 0, nz, wall, 1);
                pushVertex(s.x, base, s.z, nx, 0, nz, wall, 0.7);
                pushVertex(e.x, top, e.z, nx, 0, nz, wall, 1);
                pushVertex(s.x, top, s.z, nx, 0, nz, wall, 1);
            }
        }
    }

    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(Float32Array.from(positions), 3));
    geometry.setAttribute('normal', new BufferAttribute(Float32Array.from(normals), 3));
    geometry.setAttribute('color', new BufferAttribute(Uint8Array.from(colors), 3, true));
    geometry.computeBoundingSphere();

    const mesh = new Mesh(
        geometry,
        new MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0 }),
    );
    mesh.name = 'buildings';
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return { mesh, measured, total };
}
