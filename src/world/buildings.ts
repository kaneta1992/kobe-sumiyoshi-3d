/**
 * 建物。bvmap の BldA ポリゴンを押し出し、フットプリントのOBBから屋根を載せる。
 *
 * 高さは 兵庫県 50cmメッシュ DSM/DEM から前処理で測った実高さを使う。フットプリントの
 * 決定的ハッシュ（src/shared/geo.js の footprintKey）で引き、引けなかった建物だけ
 * 従来の階数ヒューリスティックに落とす（契約02 E12）。実測高さは「屋根の一番高い所」
 * なので、勾配屋根では棟をその高さに合わせ、軒を勾配ぶん下げる。
 *
 * 色・屋根形状・窓割りの揺らぎは座標由来の決定的ハッシュで決める（実行時乱数は禁止:
 * 全クライアントが同じ町を見る必要があるため — data-spec.md §4）。
 *
 * HLOD 3段階（追記2-1）:
 *   L0 個別ジオメトリ（軒の出・鼻隠し・軒天・ファサードのプロシージャル窓）
 *   L1 簡略統合（軒なし・壁1分割）
 *   L2 セルプロキシ（OBBの箱 + 屋根の三角柱・単一マテリアル）
 */
import {
    Color,
    Mesh,
    MeshStandardNodeMaterial,
    Object3D,
    ShapeUtils,
} from 'three/webgpu';
import {
    abs,
    attribute,
    float,
    mix,
    normalWorld,
    positionView,
    positionWorld,
    saturate,
    smoothstep,
    vec2,
    vec3,
} from 'three/tsl';
import { BLD_FIREPROOF, BLD_NO_WALL, BLD_ORDINARY } from '../config';
import { footprintKey } from '../geo';
import { hash01 } from './hash';
import { createBuf, pushQuadFacing, pushTriangleFacing, pushVertex, toGeometry, type MeshBuf } from './geom';
import { buildHlod, type Hlod } from './hlod';
import { skyHorizonNode } from './sun';
import type { QualitySettings } from '../quality';
import type { BuildingHeightMap } from '../data/terrain-assets';
import type { BuildingShape, Point2 } from '../data/vector';

/** 傾斜地で屋根を持ち上げる補正量の上限[m] */
const MAX_SLOPE_LIFT = 6;
/** 軒の出[m]（日本の戸建ての実寸レンジ） */
const EAVE_MIN = 0.3;
const EAVE_MAX = 0.6;
/** 鼻隠し（軒先の垂直な板）の見付け[m] */
const FASCIA = 0.18;
/** 屋根勾配（4寸勾配前後） */
const ROOF_PITCH_MIN = 0.34;
const ROOF_PITCH_MAX = 0.48;
/** 勾配屋根にする下限のフットプリント充填率（L字型などはOBBとズレるので陸屋根に落とす・E20） */
const FILL_RATIO_FOR_PITCHED = 0.74;

type RoofKind = 'flat' | 'hip' | 'gable';

interface Obb {
    cx: number;
    cz: number;
    /** 長辺方向の単位ベクトル */
    ux: number;
    uz: number;
    halfU: number;
    halfV: number;
}

interface BuildingPlan {
    shape: BuildingShape;
    center: Point2;
    area: number;
    obb: Obb;
    /** 壁の下端（地面に埋める） */
    base: number;
    /** 建物の最高点（棟 or 陸屋根の天端） */
    top: number;
    /** 壁の上端 = 軒の高さ */
    wallTop: number;
    roof: RoofKind;
    eave: number;
    wall: Color;
    roofColor: Color;
    /** シェーダーへ渡す種別+ゆらぎ（整数部=種別 / 小数部=乱数） */
    seed: number;
}

function ringArea(ring: readonly Point2[]): number {
    let a = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        a += ring[j].x * ring[i].z - ring[i].x * ring[j].z;
    }
    return a / 2;
}

function centroidOf(ring: readonly Point2[]): Point2 {
    let x = 0;
    let z = 0;
    for (const p of ring) {
        x += p.x;
        z += p.z;
    }
    return { x: x / ring.length, z: z / ring.length };
}

/** 最小面積の外接矩形（辺方向を総当たり）。長辺を u 軸にして返す */
function minAreaRect(ring: readonly Point2[]): Obb {
    let best: Obb | null = null;
    let bestArea = Infinity;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        let dx = ring[i].x - ring[j].x;
        let dz = ring[i].z - ring[j].z;
        const len = Math.hypot(dx, dz);
        if (len < 0.2) continue;
        dx /= len;
        dz /= len;
        let minU = Infinity;
        let maxU = -Infinity;
        let minV = Infinity;
        let maxV = -Infinity;
        for (const p of ring) {
            const u = p.x * dx + p.z * dz;
            const v = -p.x * dz + p.z * dx;
            if (u < minU) minU = u;
            if (u > maxU) maxU = u;
            if (v < minV) minV = v;
            if (v > maxV) maxV = v;
        }
        const area = (maxU - minU) * (maxV - minV);
        if (area < bestArea) {
            bestArea = area;
            const mu = (minU + maxU) / 2;
            const mv = (minV + maxV) / 2;
            best = {
                cx: mu * dx - mv * dz,
                cz: mu * dz + mv * dx,
                ux: dx,
                uz: dz,
                halfU: (maxU - minU) / 2,
                halfV: (maxV - minV) / 2,
            };
        }
    }
    if (!best) {
        const c = centroidOf(ring);
        return { cx: c.x, cz: c.z, ux: 1, uz: 0, halfU: 2, halfV: 2 };
    }
    if (best.halfU < best.halfV) {
        // 長辺を u にそろえる（90°回す）
        best = {
            cx: best.cx,
            cz: best.cz,
            ux: -best.uz,
            uz: best.ux,
            halfU: best.halfV,
            halfV: best.halfU,
        };
    }
    return best;
}

/** 階数ヒューリスティック（data-spec.md §4）。bvmap に高さ属性は無い */
function fallbackHeight(code: number, area: number, r: number): number {
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
        wall.setHSL(0.09 + r0 * 0.03, 0.04 + r1 * 0.05, 0.56 + r0 * 0.18);
        roof.setHSL(0.58, 0.03 + r1 * 0.04, 0.34 + r1 * 0.1);
    } else if (code === BLD_NO_WALL) {
        wall.setHSL(0.09, 0.05, 0.5);
        roof.setHSL(0.55, 0.05, 0.42);
    } else {
        // 外壁: 白〜ベージュのモルタル/サイディングが多数派。
        // そこへ濃色サイディングと青灰の外壁を少数混ぜて「箱の羅列」を崩す
        const w = hash01(r0 * 1000, r1 * 1000, 0x3f21);
        if (w < 0.13) wall.setHSL(0.07 + r0 * 0.03, 0.18 + r0 * 0.14, 0.2 + r0 * 0.13);
        else if (w < 0.26) wall.setHSL(0.56 + r0 * 0.06, 0.05 + r0 * 0.08, 0.34 + r0 * 0.16);
        else wall.setHSL(0.09 + r0 * 0.05, 0.05 + r1 * 0.13, 0.5 + r0 * 0.3);
        // 屋根瓦: 青灰（いぶし）を基本に、茶（洋瓦）・黒・銀（金属板）を混ぜる
        if (r1 < 0.2) roof.setHSL(0.055 + r0 * 0.02, 0.3 + r0 * 0.12, 0.24 + r0 * 0.08);
        else if (r1 < 0.32) roof.setHSL(0.09, 0.03, 0.17 + r0 * 0.05);
        else if (r1 < 0.44) roof.setHSL(0.58, 0.02, 0.4 + r0 * 0.1);
        else roof.setHSL(0.56 + r0 * 0.05, 0.07 + r1 * 0.1, 0.22 + r1 * 0.12);
    }
    return { wall, roof };
}

// --- ジオメトリ生成 -------------------------------------------------------

/** OBB ローカル (u, v) → ワールド (x, z) */
function toWorldU(obb: Obb, u: number, v: number): [number, number] {
    return [obb.cx + obb.ux * u - obb.uz * v, obb.cz + obb.uz * u + obb.ux * v];
}

interface WallOptions {
    /** 縦分割数。近景は接地の暗部を出すため2以上 */
    segments: number;
    facade: boolean;
}

function addWalls(b: MeshBuf, plan: BuildingPlan, options: WallOptions): void {
    const { base, wallTop, wall, seed } = plan;
    const facade = b.extra['aFacade'];
    const pushWallVertex = (
        x: number,
        y: number,
        z: number,
        nx: number,
        nz: number,
        shade: number,
    ): void => {
        pushVertex(b, x, y, z, nx, 0, nz, wall.r * shade, wall.g * shade, wall.b * shade);
        if (options.facade) facade.push(base, wallTop, seed);
        else if (facade) facade.push(0, 0, 0);
    };
    // 接地部を暗く（ベイクAO）。1.2m 付近までで戻すので壁全体が濁らない
    const shadeAt = (y: number): number => {
        const t = Math.min(1, (y - base) / Math.max(1.4, (wallTop - base) * 0.18));
        return 0.5 + 0.5 * t;
    };
    const levels: number[] = [];
    for (let i = 0; i <= options.segments; i++) {
        const t = i / options.segments;
        // 下側を細かく刻む（接地の暗部をきれいに出すため）
        levels.push(base + (wallTop - base) * t * t);
    }

    for (let ri = 0; ri < plan.shape.rings.length; ri++) {
        const ring = plan.shape.rings[ri];
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
            for (let k = 0; k + 1 < levels.length; k++) {
                const y0 = levels[k];
                const y1 = levels[k + 1];
                const s0 = shadeAt(y0);
                const s1 = shadeAt(y1);
                pushWallVertex(s.x, y0, s.z, nx, nz, s0);
                pushWallVertex(e.x, y0, e.z, nx, nz, s0);
                pushWallVertex(e.x, y1, e.z, nx, nz, s1);
                pushWallVertex(s.x, y0, s.z, nx, nz, s0);
                pushWallVertex(e.x, y1, e.z, nx, nz, s1);
                pushWallVertex(s.x, y1, s.z, nx, nz, s1);
            }
        }
    }
}

/** フットプリントをそのまま塞ぐ水平面（陸屋根・パラペット天端） */
function addFootprintCap(b: MeshBuf, plan: BuildingPlan, y: number, color: Color, shade: number): void {
    const outer = plan.shape.rings[0];
    const holes = plan.shape.rings.slice(1);
    const contour = outer.map((p) => ({ x: p.x, y: p.z }));
    const holeContours = holes.map((ring) => ring.map((p) => ({ x: p.x, y: p.z })));
    const allPoints = [...outer, ...holes.flat()];
    let faces: number[][] = [];
    try {
        faces = ShapeUtils.triangulateShape(contour, holeContours);
    } catch {
        faces = [];
    }
    const facade = b.extra['aFacade'];
    for (const face of faces) {
        const a = allPoints[face[0]];
        const c = allPoints[face[1]];
        const d = allPoints[face[2]];
        if (!a || !c || !d) continue;
        // 上から見て法線が +Y になる並びに正規化する
        const ny = (c.z - a.z) * (d.x - a.x) - (c.x - a.x) * (d.z - a.z);
        const [p1, p2] = ny >= 0 ? [c, d] : [d, c];
        for (const p of [a, p1, p2]) {
            pushVertex(b, p.x, y, p.z, 0, 1, 0, color.r * shade, color.g * shade, color.b * shade);
            if (facade) facade.push(0, 0, 0);
        }
    }
}

/** 陸屋根 + パラペット（立ち上がり）+ 塔屋 */
function addFlatRoof(b: MeshBuf, plan: BuildingPlan, detailed: boolean): void {
    const { roofColor, wallTop, top } = plan;
    addFootprintCap(b, plan, top, plan.roofColor, 0.92);
    if (!detailed) return;
    // パラペット: 外周に沿った低い立ち上がり（シルエットが紙のように薄くならない）
    const outer = plan.shape.rings[0];
    const center = centroidOf(outer);
    const facade = b.extra['aFacade'];
    const blank = (count: number): void => {
        if (facade) for (let k = 0; k < count; k++) facade.push(0, 0, 0);
    };
    const parapet = Math.min(0.55, Math.max(0.25, top - wallTop || 0.45));
    for (let i = 0, j = outer.length - 1; i < outer.length; j = i++) {
        const p = outer[j];
        const q = outer[i];
        const dx = q.x - p.x;
        const dz = q.z - p.z;
        const len = Math.hypot(dx, dz);
        if (len < 0.05) continue;
        let nx = -dz / len;
        let nz = dx / len;
        if (nx * ((p.x + q.x) / 2 - center.x) + nz * ((p.z + q.z) / 2 - center.z) < 0) {
            nx = -nx;
            nz = -nz;
        }
        pushQuadFacing(
            b,
            [p.x, top, p.z],
            [q.x, top, q.z],
            [q.x, top + parapet, q.z],
            [p.x, top + parapet, p.z],
            nx,
            0,
            nz,
            roofColor.r * 0.8,
            roofColor.g * 0.8,
            roofColor.b * 0.8,
        );
        blank(6);
    }
    // 塔屋（屋上の機械室）。大きい建物だけ、決定的に置く
    if (plan.area > 240) {
        const { obb } = plan;
        const hu = Math.min(obb.halfU * 0.34, 4.5);
        const hv = Math.min(obb.halfV * 0.42, 3.5);
        const h = 2.4 + hash01(obb.cx, obb.cz, 0x77) * 1.2;
        const y0 = top;
        const y1 = top + h;
        const uv: [number, number][] = [
            [-hu, -hv],
            [hu, -hv],
            [hu, hv],
            [-hu, hv],
        ];
        for (let i = 0; i < 4; i++) {
            const a = uv[i];
            const c = uv[(i + 1) % 4];
            const mu = (a[0] + c[0]) / 2;
            const mv = (a[1] + c[1]) / 2;
            const [ox, oz] = [obb.ux * mu - obb.uz * mv, obb.uz * mu + obb.ux * mv];
            const pa = toWorldU(obb, a[0], a[1]);
            const pc = toWorldU(obb, c[0], c[1]);
            pushQuadFacing(
                b,
                [pa[0], y0, pa[1]],
                [pc[0], y0, pc[1]],
                [pc[0], y1, pc[1]],
                [pa[0], y1, pa[1]],
                ox,
                0,
                oz,
                roofColor.r * 0.78,
                roofColor.g * 0.78,
                roofColor.b * 0.78,
            );
            blank(6);
        }
        const cap = uv.map(([u, v]) => {
            const p = toWorldU(obb, u, v);
            return [p[0], y1, p[1]];
        });
        pushQuadFacing(b, cap[0], cap[1], cap[2], cap[3], 0, 1, 0, roofColor.r * 0.95, roofColor.g * 0.95, roofColor.b * 0.95);
        blank(6);
    }
}

/** 寄棟／切妻。detailed のときは軒の出・鼻隠し・軒天（見上げたときに見える面）を付ける */
function addPitchedRoof(b: MeshBuf, plan: BuildingPlan, detailed: boolean): void {
    const { obb, wallTop, top, roofColor, roof, wall } = plan;
    const eave = detailed ? plan.eave : 0;
    const HU = obb.halfU + eave;
    const HV = obb.halfV + eave;
    const eaveY = detailed ? wallTop - FASCIA * 0.5 : wallTop;
    const ridgeY = top;
    const facade = b.extra['aFacade'];
    const blank = (count: number): void => {
        if (facade) for (let k = 0; k < count; k++) facade.push(0, 0, 0);
    };
    const P = (u: number, v: number, y: number): number[] => {
        const [x, z] = toWorldU(obb, u, v);
        return [x, y, z];
    };
    // OBB ローカル軸のワールド方向（外向き指定に使う）
    const uxw = obb.ux;
    const uzw = obb.uz;
    const vxw = -obb.uz;
    const vzw = obb.ux;
    const rc: [number, number, number] = [roofColor.r, roofColor.g, roofColor.b];
    const ridgeHalf = roof === 'gable' ? HU : Math.max(0.2, HU - HV);

    // 大屋根2面（+v 側 / -v 側）。外向きは「上 + それぞれの v 方向」
    pushQuadFacing(b, P(-HU, HV, eaveY), P(HU, HV, eaveY), P(ridgeHalf, 0, ridgeY), P(-ridgeHalf, 0, ridgeY), vxw, 1, vzw, rc[0], rc[1], rc[2]);
    pushQuadFacing(b, P(HU, -HV, eaveY), P(-HU, -HV, eaveY), P(-ridgeHalf, 0, ridgeY), P(ridgeHalf, 0, ridgeY), -vxw, 1, -vzw, rc[0] * 0.87, rc[1] * 0.87, rc[2] * 0.87);
    blank(12);

    if (roof === 'gable') {
        // 妻壁（三角）は壁色。軒の出のぶんは張り出さない
        const wu = obb.halfU;
        pushTriangleFacing(b, P(wu, -obb.halfV, wallTop), P(wu, obb.halfV, wallTop), P(wu, 0, ridgeY), uxw, 0, uzw, wall.r * 0.92, wall.g * 0.92, wall.b * 0.92);
        pushTriangleFacing(b, P(-wu, obb.halfV, wallTop), P(-wu, -obb.halfV, wallTop), P(-wu, 0, ridgeY), -uxw, 0, -uzw, wall.r * 0.92, wall.g * 0.92, wall.b * 0.92);
        blank(6);
    } else {
        // 寄棟の妻側（三角の屋根面）
        pushTriangleFacing(b, P(HU, HV, eaveY), P(HU, -HV, eaveY), P(ridgeHalf, 0, ridgeY), uxw, 1, uzw, rc[0] * 0.93, rc[1] * 0.93, rc[2] * 0.93);
        pushTriangleFacing(b, P(-HU, -HV, eaveY), P(-HU, HV, eaveY), P(-ridgeHalf, 0, ridgeY), -uxw, 1, -uzw, rc[0] * 0.93, rc[1] * 0.93, rc[2] * 0.93);
        blank(6);
    }

    if (!detailed) return;

    // 鼻隠し（軒先の垂直板）と軒天（下から見える面）。1.6m 視点ではここが効く
    const soffitY = eaveY - FASCIA;
    const iu = obb.halfU;
    const iv = obb.halfV;
    const fascia: [number[], number[], number[], number[], number, number][] = [
        [P(-HU, HV, eaveY), P(HU, HV, eaveY), P(HU, HV, soffitY), P(-HU, HV, soffitY), vxw, vzw],
        [P(HU, -HV, eaveY), P(-HU, -HV, eaveY), P(-HU, -HV, soffitY), P(HU, -HV, soffitY), -vxw, -vzw],
        [P(HU, HV, eaveY), P(HU, -HV, eaveY), P(HU, -HV, soffitY), P(HU, HV, soffitY), uxw, uzw],
        [P(-HU, -HV, eaveY), P(-HU, HV, eaveY), P(-HU, HV, soffitY), P(-HU, -HV, soffitY), -uxw, -uzw],
    ];
    for (const [a, c, d, e, ox, oz] of fascia) {
        pushQuadFacing(b, a, c, d, e, ox, 0, oz, rc[0] * 0.62, rc[1] * 0.62, rc[2] * 0.62);
        blank(6);
    }
    const soffits: [number[], number[], number[], number[]][] = [
        [P(HU, HV, soffitY), P(-HU, HV, soffitY), P(-iu, iv, soffitY), P(iu, iv, soffitY)],
        [P(-HU, -HV, soffitY), P(HU, -HV, soffitY), P(iu, -iv, soffitY), P(-iu, -iv, soffitY)],
        [P(HU, -HV, soffitY), P(HU, HV, soffitY), P(iu, iv, soffitY), P(iu, -iv, soffitY)],
        [P(-HU, HV, soffitY), P(-HU, -HV, soffitY), P(-iu, -iv, soffitY), P(-iu, iv, soffitY)],
    ];
    for (const [a, c, d, e] of soffits) {
        pushQuadFacing(b, a, c, d, e, 0, -1, 0, wall.r * 0.42, wall.g * 0.42, wall.b * 0.42);
        blank(6);
    }
}

/** 遠景プロキシ: OBB の箱 + 屋根の稜線だけ。壁と屋根の色は1色に潰す */
function addProxy(b: MeshBuf, plan: BuildingPlan): void {
    const { obb, base, wallTop, top, wall, roofColor, roof } = plan;
    const hu = obb.halfU;
    const hv = obb.halfV;
    const P = (u: number, v: number, y: number): number[] => {
        const [x, z] = toWorldU(obb, u, v);
        return [x, y, z];
    };
    const uxw = obb.ux;
    const uzw = obb.uz;
    const vxw = -obb.uz;
    const vzw = obb.ux;
    const corners: [number, number][] = [
        [-hu, -hv],
        [hu, -hv],
        [hu, hv],
        [-hu, hv],
    ];
    for (let i = 0; i < 4; i++) {
        const a = corners[i];
        const c = corners[(i + 1) % 4];
        const mu = (a[0] + c[0]) / 2;
        const mv = (a[1] + c[1]) / 2;
        pushQuadFacing(
            b,
            P(a[0], a[1], base),
            P(c[0], c[1], base),
            P(c[0], c[1], wallTop),
            P(a[0], a[1], wallTop),
            uxw * mu + vxw * mv,
            0,
            uzw * mu + vzw * mv,
            wall.r * 0.86,
            wall.g * 0.86,
            wall.b * 0.86,
        );
    }
    if (roof === 'flat') {
        pushQuadFacing(b, P(-hu, -hv, top), P(-hu, hv, top), P(hu, hv, top), P(hu, -hv, top), 0, 1, 0, roofColor.r, roofColor.g, roofColor.b);
        return;
    }
    const ridgeHalf = roof === 'gable' ? hu : Math.max(0.2, hu - hv);
    pushQuadFacing(b, P(-hu, hv, wallTop), P(hu, hv, wallTop), P(ridgeHalf, 0, top), P(-ridgeHalf, 0, top), vxw, 1, vzw, roofColor.r, roofColor.g, roofColor.b);
    pushQuadFacing(b, P(hu, -hv, wallTop), P(-hu, -hv, wallTop), P(-ridgeHalf, 0, top), P(ridgeHalf, 0, top), -vxw, 1, -vzw, roofColor.r * 0.86, roofColor.g * 0.86, roofColor.b * 0.86);
    if (roof === 'gable') {
        pushTriangleFacing(b, P(hu, -hv, wallTop), P(hu, hv, wallTop), P(hu, 0, top), uxw, 0, uzw, wall.r * 0.9, wall.g * 0.9, wall.b * 0.9);
        pushTriangleFacing(b, P(-hu, hv, wallTop), P(-hu, -hv, wallTop), P(-hu, 0, top), -uxw, 0, -uzw, wall.r * 0.9, wall.g * 0.9, wall.b * 0.9);
    } else {
        pushTriangleFacing(b, P(hu, hv, wallTop), P(hu, -hv, wallTop), P(ridgeHalf, 0, top), uxw, 1, uzw, roofColor.r * 0.93, roofColor.g * 0.93, roofColor.b * 0.93);
        pushTriangleFacing(b, P(-hu, -hv, wallTop), P(-hu, hv, wallTop), P(-ridgeHalf, 0, top), -uxw, 1, -uzw, roofColor.r * 0.93, roofColor.g * 0.93, roofColor.b * 0.93);
    }
}

// --- マテリアル -----------------------------------------------------------

/**
 * ファサード（窓・バルコニー帯・玄関）をプロシージャルに描くマテリアル。
 * テクスチャは使わず、壁面上の座標から窓割りを作る。距離でフェードして
 * 遠景ではモアレにならないようにする。
 */
function createFacadeMaterial(): MeshStandardNodeMaterial {
    // vertexColors は使わない: colorNode は頂点色に乗算されてしまうため、
    // 窓ガラスへ「差し替える」mix ができない。属性を自前で読んで合成する
    const material = new MeshStandardNodeMaterial({ roughness: 0.86, metalness: 0 });
    const fac = attribute<'vec3'>('aFacade', 'vec3');
    const baseY = fac.x;
    const topY = fac.y;
    const seed = fac.z;
    const kind = seed.floor();
    const r = seed.fract();

    // 壁面（垂直な面）だけを対象にする。遠景では窓割りを消してモアレを防ぐ
    const isWall = saturate(float(1).sub(abs(normalWorld.y).mul(4)));
    const detail = smoothstep(55, 190, positionView.length()).oneMinus().mul(isWall);

    const tangent = vec2(normalWorld.z.negate(), normalWorld.x).normalize();
    const u = positionWorld.xz.dot(tangent);
    const h = positionWorld.y.sub(baseY);

    const isBlock = kind.equal(1);
    const floorH = isBlock.select(mix(2.95, 3.2, r), mix(2.72, 2.98, r));
    const bay = isBlock.select(mix(3.1, 3.9, r), mix(2.9, 3.8, r));

    const fy = h.div(floorH);
    const fx = u.div(bay).add(r.mul(3.7));
    const cy = fy.fract();
    const cx = fx.fract();

    // 窓（縦横の帯の交差）。マンションは横長の連窓、戸建ては小さめ
    const winW = isBlock.select(float(0.72), float(0.46));
    const winH = isBlock.select(float(0.42), float(0.38));
    const edge = float(0.06);
    const maskX = smoothstep(float(0.5).sub(winW.mul(0.5)).sub(edge), float(0.5).sub(winW.mul(0.5)), cx).mul(
        smoothstep(float(0.5).add(winW.mul(0.5)), float(0.5).add(winW.mul(0.5)).add(edge), cx).oneMinus(),
    );
    const maskY = smoothstep(float(0.34).sub(edge), float(0.34), cy).mul(
        smoothstep(float(0.34).add(winH), float(0.34).add(winH).add(edge), cy).oneMinus(),
    );
    // 建物の上下端では窓を出さない（軒・基礎に食い込むのを防ぐ）
    const vertical = smoothstep(0.55, 1.1, h).mul(smoothstep(0.1, 0.7, topY.sub(positionWorld.y)));
    const windows = maskX.mul(maskY).mul(vertical);

    // マンションのバルコニー帯（各階の腰から下に横一直線の影）
    const balcony = isBlock
        .select(smoothstep(0.02, 0.08, cy).mul(smoothstep(0.24, 0.3, cy).oneMinus()), float(0))
        .mul(vertical);
    // 階の見切り線
    const floorLine = smoothstep(0.0, 0.02, cy).mul(smoothstep(0.04, 0.06, cy).oneMinus()).mul(vertical);

    // 玄関（1階の1ベイだけ）
    const door = isBlock
        .select(float(0), smoothstep(0.28, 0.32, cx).mul(smoothstep(0.68, 0.72, cx).oneMinus()))
        .mul(smoothstep(0.06, 0.12, h))
        .mul(smoothstep(2.1, 2.35, h).oneMinus())
        .mul(saturate(r.mul(11).fract().sub(0.55).mul(9)));

    // ガラス: 空の色をうっすら映しつつ、奥は暗い
    // ガラス: 空をうっすら映す。真っ黒な穴にならない程度に反射を効かせる
    const glass = mix(vec3(0.05, 0.058, 0.072), skyHorizonNode.mul(0.75), saturate(normalWorld.y.add(0.75)).mul(0.62));
    const doorColor = vec3(0.16, 0.12, 0.1);

    const vcol = attribute<'vec3'>('color', 'vec3');
    const shaded = mix(vcol, vcol.mul(0.7), balcony.add(floorLine).mul(detail));
    const glazed = mix(shaded, glass, windows.mul(detail));
    material.colorNode = mix(glazed, doorColor, door.mul(detail));
    material.roughnessNode = mix(float(0.86), float(0.16), windows.mul(detail));
    material.metalnessNode = windows.mul(detail).mul(0.35);
    return material;
}

export interface BuildingsResult {
    hlod: Hlod;
    /** 実測高さを適用できた建物数 */
    measured: number;
    total: number;
}

export function createBuildings(
    shapes: readonly BuildingShape[],
    getElevationAt: (x: number, z: number) => number,
    measuredHeights: BuildingHeightMap | null,
    quality: QualitySettings,
): BuildingsResult {
    const plans: BuildingPlan[] = [];
    let measured = 0;

    for (const shape of shapes) {
        const outer = shape.rings[0];
        const area = Math.abs(ringArea(outer));
        if (area < 3 || outer.length < 3) continue;

        const seedPoint = outer[0];
        const r0 = hash01(seedPoint.x, seedPoint.z, 0x1234);
        const r1 = hash01(seedPoint.x, seedPoint.z, 0x9abc);
        const r2 = hash01(seedPoint.x, seedPoint.z, 0x5e17);

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

        // 実測値があれば「測ったときの地面 + 高さ」が屋根の絶対標高そのもの
        const entry = measuredHeights?.get(footprintKey(outer, shape.code));
        let top: number;
        if (entry) {
            top = entry[1] + entry[0];
            measured++;
        } else {
            const slope = Math.min(gmax - gmin, MAX_SLOPE_LIFT);
            top = gmin + slope + fallbackHeight(shape.code, area, r0);
        }
        if (top < gmin + 2.5) top = gmin + 2.5;
        const base = gmin - 1;

        const obb = minAreaRect(outer);
        const obbArea = obb.halfU * obb.halfV * 4;
        const fill = obbArea > 0 ? area / obbArea : 0;
        const aspect = obb.halfV > 0.05 ? obb.halfU / obb.halfV : 4;

        // 屋根形状: 堅ろう建物は陸屋根、普通建物は寄棟/切妻。
        // OBB とフットプリントがズレる（L字など）ものは陸屋根に落とす（E20）
        let roof: RoofKind = 'flat';
        if (shape.code !== BLD_FIREPROOF && fill >= FILL_RATIO_FOR_PITCHED && obb.halfV >= 1.4) {
            roof = aspect > 1.65 || r2 > 0.62 ? 'gable' : 'hip';
        }

        const pitch = ROOF_PITCH_MIN + r2 * (ROOF_PITCH_MAX - ROOF_PITCH_MIN);
        let wallTop = top;
        if (roof !== 'flat') {
            const rise = Math.min(3.6, Math.min(obb.halfV, 5.5) * pitch);
            wallTop = Math.max(base + 2.3, top - rise);
        } else if (shape.code === BLD_FIREPROOF) {
            wallTop = top;
        }

        const { wall, roof: roofColor } = buildingColors(shape.code, r0, r1);
        const kindIndex = shape.code === BLD_FIREPROOF ? 1 : shape.code === BLD_NO_WALL ? 2 : 0;
        plans.push({
            shape,
            center: centroidOf(outer),
            area,
            obb,
            base,
            top,
            wallTop,
            roof,
            eave: EAVE_MIN + r1 * (EAVE_MAX - EAVE_MIN),
            wall,
            roofColor,
            seed: kindIndex + Math.min(0.999, r0),
        });
    }

    const detailMaterial = createFacadeMaterial();
    const midMaterial = new MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.88, metalness: 0 });
    const proxyMaterial = new MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.92, metalness: 0 });

    const hlod = buildHlod(
        plans.map((p) => p.center),
        (level, indices): Object3D | null => {
            const detailed = level === 0;
            const buf = createBuf(detailed ? ['aFacade'] : []);
            for (const index of indices) {
                const plan = plans[index];
                if (level === 2) {
                    addProxy(buf, plan);
                    continue;
                }
                addWalls(buf, plan, { segments: detailed ? 3 : 1, facade: detailed });
                if (plan.roof === 'flat') addFlatRoof(buf, plan, detailed);
                else addPitchedRoof(buf, plan, detailed);
            }
            if (buf.pos.length === 0) return null;
            const geometry = toGeometry(buf, { aFacade: 3 });
            const material = level === 0 ? detailMaterial : level === 1 ? midMaterial : proxyMaterial;
            const mesh = new Mesh(geometry, material);
            mesh.name = `buildings-L${level}`;
            mesh.castShadow = quality.shadows;
            mesh.receiveShadow = true;
            mesh.matrixAutoUpdate = false;
            return mesh;
        },
    );
    hlod.group.name = 'buildings';

    return { hlod, measured, total: plans.length };
}
