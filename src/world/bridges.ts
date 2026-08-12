/**
 * 橋・高架部（RdCL vt_code 2703/2713 = docs/data-spec.md §4）。
 *
 * 谷を渡る道路は地形に沿って沈めず、桁を架けて渡す。地形カービングは橋区間を
 * 除外してあるので谷は谷のまま残っており、縦断プロファイルだけが両端の取付点を
 * 直線で結んでいる（src/shared/road-profile.js）。ここではその縦断に沿って
 * コンクリート道路橋の躯体を組む:
 *
 *   桁（厚みのあるデッキ）+ 高欄 + 橋台（両端の壁）+ 谷が深い所は等間隔の橋脚
 *
 * この地域の実橋（渦森橋ほか）はいずれもコンクリート桁橋なので、
 * トラスやアーチは作らない。
 *
 * デッキ上面の物理コライダーは src/game/physics.ts が同じ寸法定数から作る。
 * 橋は数本しかないので HLOD には載せず、1メッシュにまとめて常時描画する。
 */
import { Group, Mesh, MeshStandardNodeMaterial } from 'three/webgpu';
import { attribute, float, mix, mx_noise_float, positionWorld } from 'three/tsl';
import { createBuf, pushQuadFacing, toGeometry, type MeshBuf } from './geom';
import { DRAPE_OFFSET } from './roads';
import type { QualitySettings } from '../quality';
import type { Point2 } from '../data/vector';
import type { RoadPath } from '../shared/road-profile.js';

/** 桁の厚み[m]（路面から桁下まで） */
export const DECK_THICKNESS = 1.1;
/** 車道の半幅から張り出す桁の余裕[m]（地覆・高欄のぶん） */
export const DECK_OVERHANG = 0.55;
/** 高欄の高さ[m]と見付け幅[m] */
export const PARAPET_HEIGHT = 1.05;
export const PARAPET_WIDTH = 0.28;
/** 橋脚の最大間隔[m] */
const PIER_SPACING = 22;
/** 橋脚を立てる最小の桁下高さ[m]（これより浅ければ橋台だけで持たせる） */
const PIER_MIN_CLEARANCE = 3;
/** 橋脚の断面（径間方向の半分 / 幅方向は桁幅に対する比） */
const PIER_HALF_ALONG = 0.7;
const PIER_WIDTH_RATIO = 0.34;
/**
 * 床版上面を路面より下げる量[m]。走行面（白線つきアスファルト）は roads.ts の
 * リボンが橋の上まで敷いてくれるので、桁の天端はその 2cm 下に置いて重ねない
 */
const DECK_TOP_INSET = 0.02;
/** 橋台が取付部へ食い込む長さ[m]（E44: 取付部に穴を残さない） */
const ABUTMENT_LENGTH = 1.4;
/** 躯体を地面へ埋める深さ[m] */
const FOOTING_DEPTH = 1.2;

const CONCRETE: readonly [number, number, number] = [0.3, 0.297, 0.283];
const CONCRETE_DARK: readonly [number, number, number] = [0.2, 0.198, 0.19];

/** 橋1本ぶんの断面情報。描画と物理コライダーで共有する */
export interface BridgeSpan {
    points: readonly Point2[];
    /** points と同じ長さの路面標高[m] */
    heights: readonly number[];
    /** 車道の半幅[m] */
    half: number;
    /** 桁の半幅[m] */
    deckHalf: number;
    length: number;
}

/**
 * 橋の縦断プロファイルから断面情報を作る。
 *
 * E46: 同じ橋がタイル境界で2本のポリラインに割れていることがある（実データで1件）。
 * 端点が一致するものは1本の桁につなぐ。つながないと継ぎ目に橋台の壁が生えてしまう。
 */
export function buildBridgeSpans(paths: readonly RoadPath[]): BridgeSpan[] {
    const bridges = paths.filter((p) => p.bridge && p.points.length >= 2);
    const key = (p: Point2): string => `${Math.round(p.x * 2)},${Math.round(p.z * 2)}`;
    const ends = new Map<string, number[]>();
    bridges.forEach((b, i) => {
        for (const p of [b.points[0], b.points[b.points.length - 1]]) {
            const list = ends.get(key(p));
            if (list) list.push(i);
            else ends.set(key(p), [i]);
        }
    });

    const used = new Uint8Array(bridges.length);
    const spans: BridgeSpan[] = [];
    for (let start = 0; start < bridges.length; start++) {
        if (used[start]) continue;
        used[start] = 1;
        const points: Point2[] = [...bridges[start].points];
        const heights: number[] = Array.from(bridges[start].heights);
        let width = bridges[start].width;
        // 前後どちらへも、端点を共有する未使用の橋がある限りつなぐ
        for (const atEnd of [true, false]) {
            for (;;) {
                const tip = atEnd ? points[points.length - 1] : points[0];
                const next = (ends.get(key(tip)) ?? []).find((i) => !used[i]);
                if (next === undefined) break;
                used[next] = 1;
                const nb = bridges[next];
                const forward = key(nb.points[0]) === key(tip);
                const pts = forward ? [...nb.points] : [...nb.points].reverse();
                const hs = forward ? Array.from(nb.heights) : Array.from(nb.heights).reverse();
                pts.shift(); // 共有している端点は捨てる
                hs.shift();
                if (atEnd) {
                    points.push(...pts);
                    heights.push(...hs);
                } else {
                    points.unshift(...pts.reverse());
                    heights.unshift(...hs.reverse());
                }
                width = Math.max(width, nb.width);
            }
        }
        let length = 0;
        for (let i = 1; i < points.length; i++) {
            length += Math.hypot(points[i].x - points[i - 1].x, points[i].z - points[i - 1].z);
        }
        const half = width / 2;
        spans.push({ points, heights, half, deckHalf: half + DECK_OVERHANG, length });
    }
    return spans;
}

/** station i における進行方向（前後の点から）。out に単位ベクトルを書く */
function direction(points: readonly Point2[], i: number, out: [number, number]): void {
    const prev = points[Math.max(0, i - 1)];
    const next = points[Math.min(points.length - 1, i + 1)];
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
    out[0] = dx;
    out[1] = dz;
}

/** 軸に沿った箱（橋脚・橋台）。ux,uz = 長手方向の単位ベクトル */
function addBox(
    b: MeshBuf,
    cx: number,
    cz: number,
    ux: number,
    uz: number,
    halfAlong: number,
    halfAcross: number,
    yBottom: number,
    yTop: number,
    color: readonly [number, number, number],
): void {
    const px = -uz;
    const pz = ux;
    const corner = (sa: number, sc: number): [number, number] => [
        cx + ux * halfAlong * sa + px * halfAcross * sc,
        cz + uz * halfAlong * sa + pz * halfAcross * sc,
    ];
    const c00 = corner(-1, -1);
    const c01 = corner(-1, 1);
    const c11 = corner(1, 1);
    const c10 = corner(1, -1);
    const at = (c: [number, number], y: number): number[] => [c[0], y, c[1]];
    // 側面4枚
    const faces: [[number, number], [number, number], number, number][] = [
        [c00, c01, -ux, -uz],
        [c11, c10, ux, uz],
        [c01, c11, px, pz],
        [c10, c00, -px, -pz],
    ];
    for (const [a, c, nx, nz] of faces) {
        pushQuadFacing(
            b,
            at(a, yBottom),
            at(c, yBottom),
            at(c, yTop),
            at(a, yTop),
            nx,
            0,
            nz,
            color[0],
            color[1],
            color[2],
        );
    }
    // 天端
    pushQuadFacing(b, at(c00, yTop), at(c01, yTop), at(c11, yTop), at(c10, yTop), 0, 1, 0, color[0], color[1], color[2]);
}

function createBridgeMaterial(quality: QualitySettings): MeshStandardNodeMaterial {
    const material = new MeshStandardNodeMaterial({ metalness: 0, roughness: 0.88 });
    const base = attribute<'vec3'>('color', 'vec3');
    if (quality.preset === 'desktop') {
        // 打ち放しコンクリートの汚れ・型枠跡くらいのムラ
        const grain = mx_noise_float(positionWorld.mul(1.1)).mul(0.5).add(0.5);
        const stain = mx_noise_float(positionWorld.mul(0.17)).mul(0.5).add(0.5);
        material.colorNode = base.mul(mix(float(0.84), float(1.14), grain.mul(0.4).add(stain.mul(0.6))));
    } else {
        material.colorNode = base;
    }
    return material;
}

export interface Bridges {
    group: Group;
    /** 橋の本数（タイル境界で割れたセグメントは連結済み） */
    count: number;
    /** 橋脚の本数（検証用） */
    piers: number;
    triangles: number;
}

export function createBridges(
    spans: readonly BridgeSpan[],
    getElevationAt: (x: number, z: number) => number,
    quality: QualitySettings,
): Bridges {
    const buf = createBuf();
    const dir: [number, number] = [1, 0];
    let piers = 0;

    for (const span of spans) {
        const { points, heights, deckHalf } = span;
        const n = points.length;
        // --- 断面の左右端（桁 / 高欄の内外） ---
        const edge = (i: number, offset: number): [number, number] => {
            direction(points, i, dir);
            return [points[i].x - dir[1] * offset, points[i].z + dir[0] * offset];
        };
        const topY = (i: number): number => heights[i] + DRAPE_OFFSET - DECK_TOP_INSET;
        const botY = (i: number): number => heights[i] + DRAPE_OFFSET - DECK_THICKNESS;

        for (let i = 0; i + 1 < n; i++) {
            const lA = edge(i, -deckHalf);
            const rA = edge(i, deckHalf);
            const lB = edge(i + 1, -deckHalf);
            const rB = edge(i + 1, deckHalf);
            const tA = topY(i);
            const tB = topY(i + 1);
            const bA = botY(i);
            const bB = botY(i + 1);
            const P = (c: [number, number], y: number): number[] => [c[0], y, c[1]];
            // 床版上面（走行面）
            pushQuadFacing(buf, P(lA, tA), P(rA, tA), P(rB, tB), P(lB, tB), 0, 1, 0, CONCRETE[0], CONCRETE[1], CONCRETE[2]);
            // 桁下面
            pushQuadFacing(buf, P(lA, bA), P(rA, bA), P(rB, bB), P(lB, bB), 0, -1, 0, CONCRETE_DARK[0], CONCRETE_DARK[1], CONCRETE_DARK[2]);
            // 桁側面（左右）
            direction(points, i, dir);
            for (const [a, b2, ta, tb, ba, bb, sx, sz] of [
                [lA, lB, tA, tB, bA, bB, dir[1], -dir[0]],
                [rA, rB, tA, tB, bA, bB, -dir[1], dir[0]],
            ] as [[number, number], [number, number], number, number, number, number, number, number][]) {
                pushQuadFacing(buf, P(a, ba), P(b2, bb), P(b2, tb), P(a, ta), sx, 0, sz, CONCRETE[0], CONCRETE[1], CONCRETE[2]);
            }
            // 高欄（左右）: 外面・内面・天端
            for (const side of [-1, 1]) {
                const outA = edge(i, side * deckHalf);
                const outB = edge(i + 1, side * deckHalf);
                const inA = edge(i, side * (deckHalf - PARAPET_WIDTH));
                const inB = edge(i + 1, side * (deckHalf - PARAPET_WIDTH));
                const hA = tA + PARAPET_HEIGHT;
                const hB = tB + PARAPET_HEIGHT;
                direction(points, i, dir);
                const nx = -dir[1] * side;
                const nz = dir[0] * side;
                pushQuadFacing(buf, P(outA, tA), P(outB, tB), P(outB, hB), P(outA, hA), nx, 0, nz, CONCRETE[0], CONCRETE[1], CONCRETE[2]);
                pushQuadFacing(buf, P(inA, tA), P(inB, tB), P(inB, hB), P(inA, hA), -nx, 0, -nz, CONCRETE[0], CONCRETE[1], CONCRETE[2]);
                pushQuadFacing(buf, P(outA, hA), P(inA, hA), P(inB, hB), P(outB, hB), 0, 1, 0, CONCRETE[0], CONCRETE[1], CONCRETE[2]);
            }
        }

        // --- 橋台（両端）------------------------------------------------------
        for (const end of [0, n - 1]) {
            direction(points, end, dir);
            const outward = end === 0 ? -1 : 1;
            const cx = points[end].x + dir[0] * outward * (ABUTMENT_LENGTH / 2);
            const cz = points[end].z + dir[1] * outward * (ABUTMENT_LENGTH / 2);
            const groundY = getElevationAt(cx, cz);
            const top = botY(end);
            addBox(
                buf,
                cx,
                cz,
                dir[0],
                dir[1],
                ABUTMENT_LENGTH / 2,
                deckHalf,
                Math.min(groundY, top) - FOOTING_DEPTH,
                top,
                CONCRETE,
            );
        }

        // --- 橋脚 -------------------------------------------------------------
        const interior = Math.max(0, Math.ceil(span.length / PIER_SPACING) - 1);
        for (let k = 1; k <= interior; k++) {
            const t = k / (interior + 1);
            const fi = t * (n - 1);
            const i0 = Math.min(n - 2, Math.floor(fi));
            const f = fi - i0;
            const cx = points[i0].x + (points[i0 + 1].x - points[i0].x) * f;
            const cz = points[i0].z + (points[i0 + 1].z - points[i0].z) * f;
            const deckBottom = botY(i0) + (botY(i0 + 1) - botY(i0)) * f;
            const groundY = getElevationAt(cx, cz);
            if (deckBottom - groundY < PIER_MIN_CLEARANCE) continue;
            direction(points, i0, dir);
            // 柱
            addBox(buf, cx, cz, dir[0], dir[1], PIER_HALF_ALONG, deckHalf * PIER_WIDTH_RATIO, groundY - FOOTING_DEPTH, deckBottom - 0.45, CONCRETE);
            // 柱頭（梁）
            addBox(buf, cx, cz, dir[0], dir[1], PIER_HALF_ALONG * 1.25, deckHalf * 0.92, deckBottom - 0.45, deckBottom, CONCRETE);
            piers++;
        }
    }

    const group = new Group();
    group.name = 'bridges';
    if (buf.pos.length > 0) {
        const mesh = new Mesh(toGeometry(buf), createBridgeMaterial(quality));
        mesh.name = 'bridges-mesh';
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.matrixAutoUpdate = false;
        group.add(mesh);
    }
    return { group, count: spans.length, piers, triangles: buf.pos.length / 9 };
}
