/**
 * アイテム・ディレクターの3Dオブジェクト（契約11）。
 *
 * 描画コールの規律（予算 mobile draw ≤ 100）は契約10 の objects.ts と同じ:
 *   - 種類ごとに **InstancedMesh 1本**。アイテムが何個あっても draw call は1
 *   - 色はインスタンス属性（aColor）で渡す。TSL の attribute() がそのまま読む
 *   - 出番が無いフレームは count=0 + visible=false（draw call に乗らない）
 *   - フレームループで new を作らない（詰め込みは使い回しの Object3D 経由）
 *
 * 使い方は毎フレーム begin() → push() を必要な数だけ → end()。
 * 取られたアイテムは push しなければ消える（配列の詰め直しは pool 側が持つ）。
 */
import {
    AdditiveBlending,
    BoxGeometry,
    BufferGeometry,
    CylinderGeometry,
    DoubleSide,
    Group,
    InstancedBufferAttribute,
    InstancedMesh,
    Matrix4,
    MeshBasicNodeMaterial,
    MeshStandardNodeMaterial,
    Object3D,
    OctahedronGeometry,
    SphereGeometry,
    TorusGeometry,
    type Scene,
} from 'three/webgpu';
import { attribute, float, mix, uv, vec3 } from 'three/tsl';
import { createBoarGeometry } from '../game/avatar';
import type { QualitySettings } from '../quality';
import { mergeParts, partMatrix, type GeometryPart } from '../world/geom';
import { createChestGeometry } from './objects';

const TAU = Math.PI * 2;

/** インスタンス上限（超えたぶんは描かない。配置がこれを超えない設計にしてある） */
const MAX_PICKUPS = 32;
/** POI 8 + 補給2 + 見晴らしスポット4 ぶん（契約12） */
const MAX_BEACONS = 16;
const MAX_COINS = 192;
const MAX_CRATES = 4;
const MAX_CANOPIES = 10;
const MAX_WINGS = 10;
/** イノシシ（群れ・逃げる個体）・偽宝箱・見晴らしスポット（契約12） */
const MAX_BOARS = 8;
const MAX_MIMICS = 4;
const MAX_LOOKOUTS = 4;

/** ルートビーコン（光の柱）の高さ[m]・半径[m] */
const BEACON_HEIGHT = 120;
const BEACON_RADIUS = 1.9;

/**
 * 1種類ぶんの詰め込み口。begin → push… → end で1フレームぶんを確定する。
 * color を持たないプール（頂点色で塗るもの）では color 引数は無視される
 */
export interface InstancePool {
    begin(): void;
    push(x: number, y: number, z: number, yaw: number, scale: number, color?: number): void;
    end(): void;
}

export interface MatchItemObjects {
    /** 場に落ちているアイテム（宝石） */
    pickups: InstancePool;
    /** ルートビーコン（光の柱） */
    beacons: InstancePool;
    /** 道中のコイン */
    coins: InstancePool;
    /** 補給クレート */
    crates: InstancePool;
    /** パラシュート・傘（クレート / 自分の傘 / 遠隔プレイヤーの傘） */
    canopies: InstancePool;
    /** 六甲おろしのマントの翼（自分と遠隔プレイヤーの滑空表示・E77） */
    wings: InstancePool;
    /** 野生のイノシシ（群れ・ミミックから逃げる個体・契約12） */
    boars: InstancePool;
    /** 偽宝箱（ミミック）。本物と同じジオメトリ・契約12 */
    mimics: InstancePool;
    /** 見晴らしスポットの目印（展望デッキ・契約12） */
    lookouts: InstancePool;
    /** 全部隠す（ロビー・リマッチ・E76） */
    reset(): void;
    dispose(): void;
}

/** 色をインスタンス属性で持つ InstancedMesh を作る */
function withInstanceColor(geometry: BufferGeometry, max: number): Float32Array {
    const data = new Float32Array(max * 3);
    const attributeData = new InstancedBufferAttribute(data, 3);
    attributeData.setUsage(35048 /* DynamicDrawUsage */);
    geometry.setAttribute('aColor', attributeData);
    return data;
}

/** 宝石型のアイテム（八面体 + 台座リング）。色はインスタンスごと */
function createPickupGeometry(): BufferGeometry {
    const parts: GeometryPart[] = [
        { geometry: new OctahedronGeometry(0.42, 0), matrix: partMatrix(0, 0, 0) },
        { geometry: new TorusGeometry(0.5, 0.07, 6, 14), matrix: partMatrix(0, -0.34, 0, 1, 1, 1, Math.PI / 2, 0, 0) },
    ];
    return mergeParts(parts);
}

/** コイン（立てた薄い円盤）。頂点色は使わず金色一色 */
function createCoinGeometry(): BufferGeometry {
    const parts: GeometryPart[] = [
        {
            geometry: new CylinderGeometry(0.33, 0.33, 0.07, 12),
            matrix: partMatrix(0, 0, 0, 1, 1, 1, Math.PI / 2, 0, 0),
        },
    ];
    return mergeParts(parts);
}

/** 補給クレート（木箱 + 帯 + 角金具）。1ジオメトリに頂点色で焼き込む */
function createCrateGeometry(): BufferGeometry {
    const wood = 0xc98b4b;
    const strap = 0x3f7ad6;
    const metal = 0xe9eef5;
    const parts: GeometryPart[] = [
        { geometry: new BoxGeometry(1.5, 1.3, 1.5), matrix: partMatrix(0, 0.65, 0), color: wood },
        { geometry: new BoxGeometry(1.56, 0.24, 1.56), matrix: partMatrix(0, 0.95, 0), color: strap },
        { geometry: new BoxGeometry(1.56, 0.24, 1.56), matrix: partMatrix(0, 0.35, 0), color: strap },
        { geometry: new BoxGeometry(1.62, 0.16, 1.62), matrix: partMatrix(0, 1.3, 0), color: metal },
    ];
    return mergeParts(parts);
}

/** ポップな傘（8枚のゴア + 吊り紐）。objects.ts の傘と同じ意匠 */
function createCanopyGeometry(): BufferGeometry {
    const colors = [0xff7a45, 0xfff2d8];
    const parts: GeometryPart[] = [];
    for (let i = 0; i < 8; i++) {
        parts.push({
            geometry: new SphereGeometry(2, 5, 6, (i / 8) * TAU, TAU / 8, 0, Math.PI * 0.5),
            matrix: partMatrix(0, 0, 0, 1, 0.6, 1),
            color: colors[i % 2],
        });
    }
    for (let i = 0; i < 4; i++) {
        const angle = (i / 4) * TAU + Math.PI / 4;
        parts.push({
            geometry: new CylinderGeometry(0.03, 0.03, 1.9, 4),
            matrix: partMatrix(Math.cos(angle) * 1.35, -0.95, Math.sin(angle) * 1.35),
            color: 0xdfe6ee,
        });
    }
    return mergeParts(parts);
}

/** 六甲おろしのマント（後ろへ広がる翼）。滑空しているのが遠くからでも分かる形にする */
function createWingGeometry(): BufferGeometry {
    const cloth = 0x2ecc71;
    const edge = 0x1b7f47;
    const parts: GeometryPart[] = [];
    for (const side of [-1, 1]) {
        parts.push({
            geometry: new BoxGeometry(1.5, 0.06, 1.0),
            matrix: partMatrix(side * 0.9, 0.1, 0.35, 1, 1, 1, 0, 0, side * 0.22),
            color: cloth,
        });
        parts.push({
            geometry: new BoxGeometry(0.9, 0.06, 0.7),
            matrix: partMatrix(side * 1.85, 0.28, 0.6, 1, 1, 1, 0, 0, side * 0.42),
            color: edge,
        });
    }
    parts.push({ geometry: new BoxGeometry(0.42, 0.1, 0.9), matrix: partMatrix(0, 0.06, 0.4), color: edge });
    return mergeParts(parts);
}

/**
 * 見晴らしスポットの目印（契約12）。展望デッキ風の柱＋手すり。
 * 「ここで千里眼が使える」ことが遠くから分かればよいので小さく作る
 */
function createLookoutGeometry(): BufferGeometry {
    const wood = 0x9a6b45;
    const rail = 0xe3e8ee;
    const parts: GeometryPart[] = [
        { geometry: new CylinderGeometry(0.16, 0.2, 2.4, 8), matrix: partMatrix(0, 1.2, 0), color: wood },
        { geometry: new CylinderGeometry(1.5, 1.5, 0.16, 14), matrix: partMatrix(0, 2.4, 0), color: wood },
        { geometry: new TorusGeometry(1.45, 0.06, 6, 18), matrix: partMatrix(0, 3, 0, 1, 1, 1, Math.PI / 2, 0, 0), color: rail },
        { geometry: new CylinderGeometry(0.05, 0.05, 0.62, 6), matrix: partMatrix(1.45, 2.7, 0), color: rail },
        { geometry: new CylinderGeometry(0.05, 0.05, 0.62, 6), matrix: partMatrix(-1.45, 2.7, 0), color: rail },
        { geometry: new CylinderGeometry(0.05, 0.05, 0.62, 6), matrix: partMatrix(0, 2.7, 1.45), color: rail },
        { geometry: new CylinderGeometry(0.05, 0.05, 0.62, 6), matrix: partMatrix(0, 2.7, -1.45), color: rail },
    ];
    return mergeParts(parts);
}

/** 光の柱（加算合成・上へ薄くなる）。色はインスタンスごと */
function createBeaconGeometry(): BufferGeometry {
    const geometry = new CylinderGeometry(BEACON_RADIUS, BEACON_RADIUS * 0.5, BEACON_HEIGHT, 10, 1, true);
    geometry.translate(0, BEACON_HEIGHT / 2, 0);
    return geometry;
}

export function createMatchItemObjects(scene: Scene, quality: QualitySettings): MatchItemObjects {
    const group = new Group();
    group.name = 'match-items';
    const pivot = new Object3D();
    const matrix = new Matrix4();
    const disposables: { dispose(): void }[] = [];

    /**
     * InstancedMesh 1本ぶんの詰め込み口を作る。colors が渡されたら
     * push の color 引数をインスタンス属性へ書く
     */
    const makePool = (mesh: InstancedMesh, colors: Float32Array | null): InstancePool => {
        const max = mesh.instanceMatrix.count;
        let n = 0;
        return {
            begin() {
                n = 0;
            },
            push(x, y, z, yaw, scale, color) {
                if (n >= max) return;
                pivot.position.set(x, y, z);
                pivot.rotation.set(0, yaw, 0);
                pivot.scale.setScalar(scale);
                pivot.updateMatrix();
                matrix.copy(pivot.matrix);
                mesh.setMatrixAt(n, matrix);
                if (colors) {
                    const c = color ?? 0xffffff;
                    // 頂点色と同じくリニアで書く（sRGB からの近似変換）
                    colors[n * 3] = (((c >> 16) & 255) / 255) ** 2.2;
                    colors[n * 3 + 1] = (((c >> 8) & 255) / 255) ** 2.2;
                    colors[n * 3 + 2] = ((c & 255) / 255) ** 2.2;
                }
                n++;
            },
            end() {
                mesh.count = n;
                mesh.visible = n > 0;
                mesh.instanceMatrix.needsUpdate = true;
                if (colors) {
                    const attributeData = mesh.geometry.getAttribute('aColor');
                    attributeData.needsUpdate = true;
                }
            },
        };
    };

    const build = (
        geometry: BufferGeometry,
        material: MeshStandardNodeMaterial | MeshBasicNodeMaterial,
        max: number,
        instancedColor: boolean,
        shadows = false,
    ): InstancePool => {
        const colors = instancedColor ? withInstanceColor(geometry, max) : null;
        const mesh = new InstancedMesh(geometry, material, max);
        mesh.count = 0;
        mesh.visible = false;
        mesh.frustumCulled = false;
        mesh.castShadow = shadows && quality.shadows;
        group.add(mesh);
        disposables.push(geometry, material);
        return makePool(mesh, colors);
    };

    // --- アイテム（宝石）---
    const pickupMaterial = new MeshStandardNodeMaterial({ roughness: 0.28, metalness: 0.25 });
    pickupMaterial.colorNode = attribute<'vec3'>('aColor', 'vec3');
    // 拾える物だと分かるよう、色そのままで軽く自己発光させる
    pickupMaterial.emissiveNode = vec3(attribute<'vec3'>('aColor', 'vec3')).mul(0.45);
    const pickups = build(createPickupGeometry(), pickupMaterial, MAX_PICKUPS, true);

    // --- ルートビーコン ---
    const beaconMaterial = new MeshBasicNodeMaterial();
    beaconMaterial.colorNode = attribute<'vec3'>('aColor', 'vec3');
    beaconMaterial.opacityNode = mix(float(0.4), float(0), uv().y.pow(0.6));
    beaconMaterial.transparent = true;
    beaconMaterial.depthWrite = false;
    beaconMaterial.blending = AdditiveBlending;
    beaconMaterial.side = DoubleSide;
    beaconMaterial.toneMapped = false;
    const beacons = build(createBeaconGeometry(), beaconMaterial, MAX_BEACONS, true);

    // --- コイン ---
    const coinMaterial = new MeshStandardNodeMaterial({
        color: 0xffcc3d,
        roughness: 0.3,
        metalness: 0.75,
        emissive: 0x4a3200,
    });
    const coins = build(createCoinGeometry(), coinMaterial, MAX_COINS, false);

    // --- 補給クレート ---
    const crateMaterial = new MeshStandardNodeMaterial({
        vertexColors: true,
        roughness: 0.62,
        metalness: 0.12,
    });
    const crates = build(createCrateGeometry(), crateMaterial, MAX_CRATES, false, true);

    // --- 傘・パラシュート ---
    const canopyMaterial = new MeshStandardNodeMaterial({
        vertexColors: true,
        roughness: 0.85,
        side: DoubleSide,
    });
    const canopies = build(createCanopyGeometry(), canopyMaterial, MAX_CANOPIES, false);

    // --- マントの翼 ---
    const wingMaterial = new MeshStandardNodeMaterial({
        vertexColors: true,
        roughness: 0.7,
        side: DoubleSide,
    });
    const wings = build(createWingGeometry(), wingMaterial, MAX_WINGS, false);

    // --- 野生のイノシシ（契約12）---
    const boarMaterial = new MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.85 });
    const boars = build(createBoarGeometry(), boarMaterial, MAX_BOARS, false, true);

    // --- 偽宝箱（本物と同じ材質・同じ形。見分けはつかない・契約12）---
    const mimicMaterial = new MeshStandardNodeMaterial({
        vertexColors: true,
        roughness: 0.62,
        metalness: 0.12,
    });
    const mimics = build(createChestGeometry(), mimicMaterial, MAX_MIMICS, false, true);

    // --- 見晴らしスポットの目印（契約12）---
    const lookoutMaterial = new MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.7 });
    const lookouts = build(createLookoutGeometry(), lookoutMaterial, MAX_LOOKOUTS, false);

    scene.add(group);

    return {
        pickups,
        beacons,
        coins,
        crates,
        canopies,
        wings,
        boars,
        mimics,
        lookouts,
        reset() {
            for (const pool of [
                pickups,
                beacons,
                coins,
                crates,
                canopies,
                wings,
                boars,
                mimics,
                lookouts,
            ]) {
                pool.begin();
                pool.end();
            }
        },
        dispose() {
            scene.remove(group);
            for (const item of disposables) item.dispose();
        },
    };
}
