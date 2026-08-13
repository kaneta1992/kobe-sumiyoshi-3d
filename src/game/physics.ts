/**
 * 物理ワールド（@dimforge/rapier3d-compat）。
 *
 * 方針（契約04 / 追記）:
 *   - 固定タイムステップ 60Hz。品質プリセットに関係なく同じ刻みで進める
 *     （後続のマルチプレイ同期で挙動差を作らないため）
 *   - フレーム dt はクランプし、追いつけないぶんは捨てる（タブ復帰で爆発しない・E3）
 *   - 描画は残り時間 `alpha` で前ステップとの補間を行う（呼び出し側が使う）
 *
 * コライダーは描画と同じ素材から作る:
 *   地形 = 描画地形と同じ 1024 分割ハイトフィールド（乖離ゼロ）
 *   道路 = 描画リボンと同じ縦断プロファイル + drape 高さの三角形メッシュ
 *   橋   = デッキ上面 + 高欄の内側の壁（桁下は素通し・契約08）
 *   建物 = フットプリント外周の押し出し壁を 300m セルごとに1つの trimesh へまとめる
 *   小物（電柱・樹木・ガードレール）は省略（契約04: すり抜け許容）
 */
import * as RAPIER from '@dimforge/rapier3d-compat';
import { ShapeUtils } from 'three/webgpu';
import { AREA_HALF } from '../config';
import type { BuildingCollision } from '../world/buildings';
import { PARAPET_HEIGHT, PARAPET_WIDTH, type BridgeSpan } from '../world/bridges';
import {
    CURB_HEIGHT,
    CURB_WIDTH,
    DRAPE_OFFSET,
    SIDEWALK_MIN_WIDTH,
    SIDEWALK_WIDTH,
} from '../world/roads';
import type { RoadPath } from '../shared/road-profile.js';

/** 物理の固定タイムステップ[s] */
export const FIXED_DT = 1 / 60;
/** 1フレームで進める最大ステップ数（重い端末で物理が雪だるま式にならないように） */
const MAX_SUBSTEPS = 5;
/** フレーム dt の上限[s] */
const MAX_FRAME_DT = 0.1;
/** 物理ハイトフィールドの分割数。描画地形（TERRAIN_VERTS=1025点）と同じ刻み */
const HEIGHTFIELD_DIVISIONS = 1024;
/** trimesh コライダーを分割するセルの一辺[m] */
const COLLIDER_CELL = 300;
/** エリア外へ出られないようにする見えない壁が、地形の上下へはみ出す余裕[m]（E19） */
const BOUNDARY_MARGIN = 60;

/**
 * コライダーの所属グループ（rapier の InteractionGroups は 上位16bit = 所属 / 下位16bit = 相手）。
 *
 * rapier3d-compat 0.12 は QueryFilterFlags の TypeScript 側の値が WASM 側のビット配置と
 * ずれていて、フラグでの絞り込みは当たり判定を丸ごと落とす（実測）。
 * レイの絞り込みはフラグではなくこのグループで行うこと。
 */
export const GROUP_STATIC = 0x0001;
export const GROUP_ACTOR = 0x0002;
/** 地形・道路・建物のコライダーに設定する値（相手は全部） */
export const STATIC_GROUPS = (GROUP_STATIC << 16) | 0xffff;
/** プレイヤー・車のコライダーに設定する値 */
export const ACTOR_GROUPS = (GROUP_ACTOR << 16) | 0xffff;
/** 「静的なものだけ」を見るクエリの指定（所属は全部 / 相手は静的だけ） */
const STATIC_QUERY = (0xffff << 16) | GROUP_STATIC;

export interface PhysicsInput {
    getElevationAt(x: number, z: number): number;
    buildings: readonly BuildingCollision[];
    roads: readonly RoadPath[];
    bridges: readonly BridgeSpan[];
    minElevation: number;
    maxElevation: number;
}

export interface Physics {
    world: RAPIER.World;
    /** 固定ステップを必要回数進める。onSubstep は各ステップ直前に呼ばれる */
    step(dt: number, onSubstep: (fixedDt: number) => void): void;
    /** 描画補間の係数（0..1）。前ステップ→現ステップの間のどこか */
    readonly alpha: number;
    /** 直近フレームで物理に使った時間[ms] */
    readonly lastStepMs: number;
    /** (x,z) の足場の高さ[m]。道路・建物の上も拾う。何も無ければ地形標高 */
    surfaceHeight(x: number, z: number): number;
    /** カメラのめり込み防止用: 静的コライダーだけを見た距離[m]（当たらなければ maxDistance） */
    castStatic(
        ox: number,
        oy: number,
        oz: number,
        dx: number,
        dy: number,
        dz: number,
        maxDistance: number,
    ): number;
    stats: { colliders: number; triangles: number };
}

let initialized: Promise<void> | null = null;

/** WASM の初期化。ワールド読み込みと並行して先に走らせておく */
export function initPhysics(): Promise<void> {
    if (!initialized) initialized = RAPIER.init();
    return initialized;
}

interface MeshBuffer {
    positions: number[];
    indices: number[];
}

function cellOf(map: Map<number, MeshBuffer>, x: number, z: number): MeshBuffer {
    const cx = Math.floor((x + AREA_HALF) / COLLIDER_CELL);
    const cz = Math.floor((z + AREA_HALF) / COLLIDER_CELL);
    const key = cz * 4096 + cx;
    let buf = map.get(key);
    if (!buf) {
        buf = { positions: [], indices: [] };
        map.set(key, buf);
    }
    return buf;
}

/** 四角形（a,b,c,d の順に一周）を2枚の三角形として積む */
function pushQuad(
    buf: MeshBuffer,
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    cx: number, cy: number, cz: number,
    dx: number, dy: number, dz: number,
): void {
    const base = buf.positions.length / 3;
    buf.positions.push(ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz);
    buf.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
}

/** 建物: フットプリント外周を base→top まで押し出した壁（trimesh は両面で当たる） */
function addBuildingWalls(map: Map<number, MeshBuffer>, building: BuildingCollision): void {
    const ring = building.outer;
    if (ring.length < 3) return;
    const buf = cellOf(map, building.center.x, building.center.z);
    const { base, top } = building;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const p = ring[j];
        const q = ring[i];
        if (Math.hypot(q.x - p.x, q.z - p.z) < 0.05) continue;
        pushQuad(buf, p.x, base, p.z, q.x, base, q.z, q.x, top, q.z, p.x, top, p.z);
    }
}

/**
 * 建物: 天面（屋根）を塞ぐ。
 *
 * 壁はもともと base→top（棟の高さ）まで伸びているので、ここを塞ぐと建物が
 * **閉じた箱**になる。上から降ってきても突き抜けず、屋根に着地して歩ける。
 * 塞いでいなかったせいで、降下・マント・ジャンプで落ちると建物の中へ入り込み、
 * 壁コライダーに囲まれて出られなくなっていた（ユーザー報告 2026-08-13）。
 *
 * skydive.ts が「屋根の上に降りられるよう足場高さを使う」と書いているとおり、
 * 建物の上面は元から足場のつもりだった — コライダーだけが欠けていた（E66）。
 * 勾配屋根も棟の高さで水平に塞ぐ: 壁がすでにその高さまであるので、
 * 壁だけのときより不自然になることはない。
 */
function addBuildingRoof(map: Map<number, MeshBuffer>, building: BuildingCollision): void {
    const ring = building.outer;
    if (ring.length < 3) return;
    const buf = cellOf(map, building.center.x, building.center.z);
    // 三角形分割は描画側（buildings.ts の陸屋根）と同じ手順。穴（中庭）は入れない
    let faces: number[][] = [];
    try {
        faces = ShapeUtils.triangulateShape(
            ring.map((p) => ({ x: p.x, y: p.z })),
            [],
        );
    } catch {
        faces = [];
    }
    const y = building.top;
    for (const face of faces) {
        const a = ring[face[0]];
        const b = ring[face[1]];
        const c = ring[face[2]];
        if (!a || !b || !c) continue;
        // trimesh は両面で当たるので巻き方向は問わない
        const base = buf.positions.length / 3;
        buf.positions.push(a.x, y, a.z, b.x, y, b.z, c.x, y, c.z);
        buf.indices.push(base, base + 1, base + 2);
    }
}

/** 道路: 描画リボンと同じ位置に水平な帯を敷く（車道 + 幅員の広い道は歩道も） */
function addRoadRibbons(map: Map<number, MeshBuffer>, road: RoadPath): void {
    const pts = road.points;
    if (pts.length < 2) return;
    const half = road.width / 2;
    const walkway = half >= SIDEWALK_MIN_WIDTH / 2;
    // 帯の左右の縁（描画側 addRibbon と同じ「前後の点から法線を作る」手順）
    const a: Edge = [0, 0, 0];
    const b: Edge = [0, 0, 0];
    const c: Edge = [0, 0, 0];
    const d: Edge = [0, 0, 0];
    for (let i = 0; i + 1 < pts.length; i++) {
        const buf = cellOf(map, pts[i].x, pts[i].z);
        // side 0 = 車道 / -1 = 左歩道 / +1 = 右歩道
        for (const side of walkway ? [0, -1, 1] : [0]) {
            const inner = side === 0 ? -half : side * (half + CURB_WIDTH);
            const outer = side === 0 ? half : side * (half + CURB_WIDTH + SIDEWALK_WIDTH);
            const lift = side === 0 ? DRAPE_OFFSET : DRAPE_OFFSET + CURB_HEIGHT;
            edgePoint(pts, road.heights, i, inner, lift, a);
            edgePoint(pts, road.heights, i, outer, lift, b);
            edgePoint(pts, road.heights, i + 1, outer, lift, c);
            edgePoint(pts, road.heights, i + 1, inner, lift, d);
            pushQuad(buf, a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2], d[0], d[1], d[2]);
        }
    }
}

/**
 * 橋: デッキ上面（走行・歩行面）と高欄の内側の壁。桁下には何も置かないので
 * 橋の下は通り抜けられる（契約08）。
 */
function addBridgeDeck(map: Map<number, MeshBuffer>, span: BridgeSpan): void {
    const pts = span.points;
    if (pts.length < 2) return;
    const half = span.deckHalf - PARAPET_WIDTH;
    const a: Edge = [0, 0, 0];
    const b: Edge = [0, 0, 0];
    const c: Edge = [0, 0, 0];
    const d: Edge = [0, 0, 0];
    for (let i = 0; i + 1 < pts.length; i++) {
        const buf = cellOf(map, pts[i].x, pts[i].z);
        edgePoint(pts, span.heights, i, -half, DRAPE_OFFSET, a);
        edgePoint(pts, span.heights, i, half, DRAPE_OFFSET, b);
        edgePoint(pts, span.heights, i + 1, half, DRAPE_OFFSET, c);
        edgePoint(pts, span.heights, i + 1, -half, DRAPE_OFFSET, d);
        pushQuad(buf, a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2], d[0], d[1], d[2]);
        // 高欄（谷へ落ちないように内側の面だけ立てる）
        for (const side of [-1, 1]) {
            edgePoint(pts, span.heights, i, side * half, DRAPE_OFFSET, a);
            edgePoint(pts, span.heights, i + 1, side * half, DRAPE_OFFSET, b);
            pushQuad(
                buf,
                a[0], a[1], a[2],
                b[0], b[1], b[2],
                b[0], b[1] + PARAPET_HEIGHT, b[2],
                a[0], a[1] + PARAPET_HEIGHT, a[2],
            );
        }
    }
}

type Edge = [number, number, number];

/** 中心線 pts[i] から法線方向へ offset だけ寄せ、路面標高 + lift の高さに置いた点 */
function edgePoint(
    pts: readonly { x: number; z: number }[],
    heights: readonly number[] | Float64Array,
    i: number,
    offset: number,
    lift: number,
    out: Edge,
): void {
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
    out[0] = pts[i].x - dz * offset;
    out[2] = pts[i].z + dx * offset;
    out[1] = heights[i] + lift;
}

export function createPhysics(input: PhysicsInput): Physics {
    const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    world.timestep = FIXED_DT;

    const stats = { colliders: 0, triangles: 0 };
    const staticBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());

    // --- 地形 ---------------------------------------------------------------
    // rapier のハイトフィールドは heights[iz + ix * (分割数+1)]（列優先・行=z / 列=x）。
    // 実測で確認済み: index が +1 されると +z、+(分割数+1) されると +x へ進む
    const verts = HEIGHTFIELD_DIVISIONS + 1;
    const span = AREA_HALF * 2;
    const cell = span / HEIGHTFIELD_DIVISIONS;
    const heights = new Float32Array(verts * verts);
    for (let ix = 0; ix < verts; ix++) {
        const x = -AREA_HALF + ix * cell;
        const column = ix * verts;
        for (let iz = 0; iz < verts; iz++) {
            heights[column + iz] = input.getElevationAt(x, -AREA_HALF + iz * cell);
        }
    }
    world.createCollider(
        RAPIER.ColliderDesc.heightfield(HEIGHTFIELD_DIVISIONS, HEIGHTFIELD_DIVISIONS, heights, {
            x: span,
            y: 1,
            z: span,
        })
            .setFriction(1)
            .setCollisionGroups(STATIC_GROUPS),
        staticBody,
    );
    stats.colliders++;

    // --- 道路・建物 ---------------------------------------------------------
    const roadCells = new Map<number, MeshBuffer>();
    for (const road of input.roads) {
        if (!road.bridge) addRoadRibbons(roadCells, road);
    }
    for (const span of input.bridges) addBridgeDeck(roadCells, span);
    const buildingCells = new Map<number, MeshBuffer>();
    for (const building of input.buildings) {
        addBuildingWalls(buildingCells, building);
        addBuildingRoof(buildingCells, building);
    }

    const addTrimeshes = (cells: Map<number, MeshBuffer>, friction: number): void => {
        for (const buf of cells.values()) {
            if (buf.indices.length === 0) continue;
            try {
                world.createCollider(
                    RAPIER.ColliderDesc.trimesh(
                        new Float32Array(buf.positions),
                        new Uint32Array(buf.indices),
                    )
                        .setFriction(friction)
                        .setCollisionGroups(STATIC_GROUPS),
                    staticBody,
                );
                stats.colliders++;
                stats.triangles += buf.indices.length / 3;
            } catch (err) {
                console.warn('[physics] コライダーを作れないセルがありました', err);
            }
        }
    };
    addTrimeshes(roadCells, 1);
    addTrimeshes(buildingCells, 0.5);

    // --- エリア境界の見えない壁（E19: 端から落ちない） ------------------------
    // 標高差のある街なので、壁は地形の最低〜最高標高を包むように立てる
    const wallY = (input.minElevation + input.maxElevation) / 2;
    const halfHeight = (input.maxElevation - input.minElevation) / 2 + BOUNDARY_MARGIN;
    const edge = AREA_HALF + 1;
    // [中心x, 中心z, 半分の厚み(x), 半分の長さ(z)]
    const walls: [number, number, number, number][] = [
        [edge, 0, 1, edge],
        [-edge, 0, 1, edge],
        [0, edge, edge, 1],
        [0, -edge, edge, 1],
    ];
    for (const [x, z, hx, hz] of walls) {
        world.createCollider(
            RAPIER.ColliderDesc.cuboid(hx, halfHeight, hz)
                .setTranslation(x, wallY, z)
                .setCollisionGroups(STATIC_GROUPS),
            staticBody,
        );
        stats.colliders++;
    }

    // クエリパイプラインを有効にする（castRay は step 後でないと当たらない）
    world.step();

    // --- 固定ステップ -------------------------------------------------------
    let accumulator = 0;
    let alpha = 0;
    let lastStepMs = 0;

    // フレームループで new を作らないためのスクラッチ
    const ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
    const rayTop = input.maxElevation + 80;

    return {
        world,
        stats,
        get alpha() {
            return alpha;
        },
        get lastStepMs() {
            return lastStepMs;
        },
        step(dt, onSubstep) {
            const started = performance.now();
            accumulator += Math.min(dt, MAX_FRAME_DT);
            let steps = 0;
            while (accumulator >= FIXED_DT && steps < MAX_SUBSTEPS) {
                onSubstep(FIXED_DT);
                world.step();
                accumulator -= FIXED_DT;
                steps++;
            }
            // 追いつけなかったぶんは捨てる（次フレームへ持ち越すと発散する）
            if (steps === MAX_SUBSTEPS) accumulator = 0;
            alpha = accumulator / FIXED_DT;
            lastStepMs = performance.now() - started;
        },
        surfaceHeight(x, z) {
            ray.origin.x = x;
            ray.origin.y = rayTop;
            ray.origin.z = z;
            ray.dir.x = 0;
            ray.dir.y = -1;
            ray.dir.z = 0;
            const hit = world.castRay(ray, rayTop + 200, true, undefined, STATIC_QUERY);
            return hit ? rayTop - hit.toi : input.getElevationAt(x, z);
        },
        castStatic(ox, oy, oz, dx, dy, dz, maxDistance) {
            ray.origin.x = ox;
            ray.origin.y = oy;
            ray.origin.z = oz;
            ray.dir.x = dx;
            ray.dir.y = dy;
            ray.dir.z = dz;
            const hit = world.castRay(ray, maxDistance, true, undefined, STATIC_QUERY);
            return hit ? hit.toi : maxDistance;
        },
    };
}
