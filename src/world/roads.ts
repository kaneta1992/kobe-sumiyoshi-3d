/**
 * 道路。RdCL（道路中心線）を幅員に応じたリボンにする。
 *
 * 高さは縦断プロファイル（src/shared/road-profile.js）が決める。前処理はこの同じ
 * プロファイルへ地形を吸着させてある（カービング）ので、路面は地形とほぼ同一面に載る。
 * したがってドレープは z-fighting を避ける最小限（3cm）でよい（契約08）。
 *
 * 近景（1.6m 視点）で効くのは路面そのものより「白線・縁石・歩道」の存在なので、
 * 車道リボンに加えて幅員 5.5m 以上の道には縁石と歩道を生成する。
 * 白線とアスファルトのムラは頂点属性（横断位置・幅員・進行距離）からシェーダーで描く。
 *
 * 橋・高架部（bridge）はここでは扱わない。桁・高欄・橋脚を持つ別ジオメトリ（bridges.ts）。
 *
 * HLOD セルに割ってフラスタム/距離カリングする（追記2-1）。遠景セルは白線を持たない
 * 簡略メッシュにしてモアレとドローコールを減らす。
 */
import { Mesh, MeshStandardNodeMaterial, Object3D } from 'three/webgpu';
import { abs, attribute, float, mix, mx_noise_float, positionView, positionWorld, saturate, smoothstep, vec3 } from 'three/tsl';
import { createBuf, pushVertex, toGeometry, type MeshBuf } from './geom';
import { buildHlod, type Hlod } from './hlod';
import type { QualitySettings } from '../quality';
import type { Point2 } from '../data/vector';
import type { RoadPath } from '../shared/road-profile.js';

/**
 * 路面の寸法。物理コライダー（src/game/physics.ts）も同じ値で帯を作るので、
 * ここを変えると路面と足元がずれる。二重定義を作らないこと。
 */
/** 路面標高からの浮かせ量[m]。地形はこの標高へカービング済みなので z-fighting 回避ぶんだけ */
export const DRAPE_OFFSET = 0.03;
/** 縁石の高さ[m] と 見付け幅[m] */
export const CURB_HEIGHT = 0.15;
export const CURB_WIDTH = 0.22;
/** 歩道の幅[m] */
export const SIDEWALK_WIDTH = 1.6;
/** 歩道を付ける最小幅員[m] */
export const SIDEWALK_MIN_WIDTH = 5.5;

/** 路面の種別（aRoad.w） */
const SURFACE_ASPHALT = 0;
const SURFACE_CURB = 1;
const SURFACE_SIDEWALK = 2;

const ASPHALT: readonly [number, number, number] = [0.052, 0.052, 0.055];
const CONCRETE: readonly [number, number, number] = [0.29, 0.285, 0.27];

/**
 * 路面マテリアル。
 *  aRoad = (横断位置[-1..1], 半幅[m], 進行距離[m], 種別)
 */
function createRoadMaterial(quality: QualitySettings): MeshStandardNodeMaterial {
    const material = new MeshStandardNodeMaterial({ metalness: 0 });
    const road = attribute<'vec4'>('aRoad', 'vec4');
    const lateral = road.x;
    const half = road.y;
    const along = road.z;
    const kind = road.w;

    const near = smoothstep(30, 210, positionView.length()).oneMinus();
    const base = attribute<'vec3'>('color', 'vec3');

    // アスファルトの色むら（補修跡・轍）。低周波 + 中周波の重ね
    const blotch = mx_noise_float(positionWorld.mul(0.11)).mul(0.5).add(0.5);
    const grain = mx_noise_float(positionWorld.mul(1.6)).mul(0.5).add(0.5);
    const wear = saturate(abs(lateral).oneMinus().mul(1.4)); // 中央ほど摩耗して明るい
    const asphalt = base.mul(
        mix(float(0.78), float(1.34), blotch.mul(0.55).add(grain.mul(0.25)).add(wear.mul(0.2))),
    );

    // --- 白線 ---
    // 外側線: 路肩から 12cm 幅。横断比に直すと幅員で変わる
    const lat = abs(lateral);
    const edge = float(0.12).div(half);
    const outerLo = float(1).sub(edge.mul(2.4));
    const outerHi = float(1).sub(edge.mul(1.2));
    const outer = smoothstep(outerLo.sub(0.008), outerLo, lat).mul(
        smoothstep(outerHi, outerHi.add(0.008), lat).oneMinus(),
    );
    // 中央線は幅員 5.5m 以上の道だけ。破線（8m 実線 + 4m 空き = 12m 周期）
    const cycle = along.div(12).fract();
    const dash = smoothstep(0.62, 0.66, cycle).oneMinus();
    const centerHalf = float(0.08).div(half);
    const centerBand = smoothstep(centerHalf, centerHalf.add(0.006), lat).oneMinus();
    const center = centerBand.mul(dash).mul(smoothstep(2.5, 2.9, half));

    const paint = saturate(outer.add(center)).mul(near);
    const isAsphalt = smoothstep(0.1, 0.5, kind).oneMinus();
    const surface = mix(base, asphalt, isAsphalt);
    const withPaint = mix(surface, vec3(0.62, 0.6, 0.55), paint.mul(isAsphalt));

    // 歩道: 目地とわずかな色むら
    const jointCycle = along.div(0.9).fract();
    const joint = smoothstep(0.0, 0.03, jointCycle).mul(smoothstep(0.06, 0.09, jointCycle).oneMinus());
    const isWalk = smoothstep(1.5, 1.9, kind);
    const walk = withPaint.mul(mix(float(1), float(0.74), joint.mul(near).mul(isWalk)));

    material.colorNode = quality.preset === 'desktop' ? walk : mix(base, base.mul(mix(float(0.85), float(1.2), blotch)), isAsphalt);
    material.roughnessNode = mix(float(0.94), float(0.55), paint);
    return material;
}

export interface RoadsResult {
    hlod: Hlod;
}

export function createRoads(paths: readonly RoadPath[], quality: QualitySettings): RoadsResult {
    // HLOD セルへ配るための代表点（線分ごとに分割して細かく配る）
    interface Piece {
        points: Point2[];
        /** points と同じ長さの路面標高[m] */
        heights: number[];
        width: number;
        /** 線の先頭からの距離（白線の破線を連続させるため） */
        startDistance: number;
        center: Point2;
        /** 橋の上（車道だけ敷く。縁石・歩道は高欄と干渉するので付けない） */
        bridge: boolean;
    }
    const pieces: Piece[] = [];
    for (const path of paths) {
        const pts = path.points;
        if (pts.length < 2) continue;
        // 60m 程度ずつに切って、セルをまたぐ長い帯を作らない
        const chunk = 10;
        for (let i = 0; i < pts.length - 1; i += chunk) {
            const end = Math.min(pts.length, i + chunk + 1);
            if (end - i < 2) break;
            const mid = pts[Math.floor((i + end) / 2)];
            pieces.push({
                points: pts.slice(i, end),
                heights: Array.from(path.heights.slice(i, end)),
                width: path.width,
                startDistance: path.dists[i],
                center: { x: mid.x, z: mid.z },
                bridge: path.bridge,
            });
        }
    }

    const material = createRoadMaterial(quality);

    /** リボン1本を積む。offsets は中心線からの左右オフセット[m] のペア */
    const addRibbon = (
        b: MeshBuf,
        piece: Piece,
        innerOffset: number,
        outerOffset: number,
        yOffset: number,
        outerYOffset: number,
        color: readonly [number, number, number],
        kind: number,
        shade: number,
    ): void => {
        const pts = piece.points;
        const half = piece.width / 2;
        const roadAttr = b.extra['aRoad'];
        let distance = piece.startDistance;
        const left: number[] = [];
        const right: number[] = [];
        const lateralL: number[] = [];
        const lateralR: number[] = [];
        const dists: number[] = [];
        for (let i = 0; i < pts.length; i++) {
            if (i > 0) distance += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
            dists.push(distance);
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
            const px = -dz;
            const pz = dx;
            const ax = pts[i].x + px * innerOffset;
            const az = pts[i].z + pz * innerOffset;
            const bx = pts[i].x + px * outerOffset;
            const bz = pts[i].z + pz * outerOffset;
            // 断面は水平（路面は縦断プロファイルの高さ）。地形はそこへカービング済み
            const y = piece.heights[i];
            left.push(ax, y + yOffset, az);
            right.push(bx, y + outerYOffset, bz);
            lateralL.push(innerOffset / half);
            lateralR.push(outerOffset / half);
        }
        for (let i = 0; i + 1 < pts.length; i++) {
            const a = i * 3;
            const c = (i + 1) * 3;
            const quad: [number[], number, number][] = [
                [[left[a], left[a + 1], left[a + 2]], lateralL[i], dists[i]],
                [[right[a], right[a + 1], right[a + 2]], lateralR[i], dists[i]],
                [[right[c], right[c + 1], right[c + 2]], lateralR[i + 1], dists[i + 1]],
                [[left[c], left[c + 1], left[c + 2]], lateralL[i + 1], dists[i + 1]],
            ];
            for (const [i0, i1, i2] of [
                [0, 1, 2],
                [0, 2, 3],
            ]) {
                const v0 = quad[i0][0];
                const v1 = quad[i1][0];
                const v2 = quad[i2][0];
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
                const tri = sign < 0 ? [i0, i2, i1] : [i0, i1, i2];
                for (const k of tri) {
                    const v = quad[k];
                    pushVertex(
                        b,
                        v[0][0],
                        v[0][1],
                        v[0][2],
                        nx * sign,
                        ny * sign,
                        nz * sign,
                        color[0] * shade,
                        color[1] * shade,
                        color[2] * shade,
                    );
                    roadAttr.push(v[1], half, v[2], kind);
                }
            }
        }
    };

    const hlod = buildHlod(
        pieces.map((p) => p.center),
        (level, indices): Object3D | null => {
            const buf = createBuf(['aRoad']);
            for (const index of indices) {
                const piece = pieces[index];
                const half = piece.width / 2;
                addRibbon(buf, piece, -half, half, DRAPE_OFFSET, DRAPE_OFFSET, ASPHALT, SURFACE_ASPHALT, 1);
                // 縁石と歩道は近距離セルだけ（遠景では見えないうえドローコールの無駄）
                if (level > 0 || piece.bridge || piece.width < SIDEWALK_MIN_WIDTH) continue;
                for (const side of [-1, 1]) {
                    const inner = side * half;
                    const curbOuter = side * (half + CURB_WIDTH);
                    const walkOuter = side * (half + CURB_WIDTH + SIDEWALK_WIDTH);
                    // 縁石の立ち上がり
                    addRibbon(buf, piece, inner, curbOuter, DRAPE_OFFSET, DRAPE_OFFSET + CURB_HEIGHT, CONCRETE, SURFACE_CURB, 0.82);
                    // 歩道面
                    addRibbon(
                        buf,
                        piece,
                        curbOuter,
                        walkOuter,
                        DRAPE_OFFSET + CURB_HEIGHT,
                        DRAPE_OFFSET + CURB_HEIGHT * 0.6,
                        CONCRETE,
                        SURFACE_SIDEWALK,
                        1,
                    );
                }
            }
            if (buf.pos.length === 0) return null;
            const mesh = new Mesh(toGeometry(buf, { aRoad: 4 }), material);
            mesh.name = `roads-L${level}`;
            mesh.receiveShadow = true;
            mesh.matrixAutoUpdate = false;
            return mesh;
        },
    );
    hlod.group.name = 'roads';
    return { hlod };
}
