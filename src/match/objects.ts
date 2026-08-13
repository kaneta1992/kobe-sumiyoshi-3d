/**
 * マッチの3Dオブジェクト（契約10）。安置の円柱壁・宝箱・鍵・輸送機・パラシュート・花火。
 *
 * 描画コールの規律（予算 mobile draw ≤ 100）:
 *   - パーツはすべて頂点色で1メッシュへ束ねる（world/geom の mergeParts）
 *   - 出番のないものは visible=false（draw call に乗らない）
 *   - 花火は1つの InstancedMesh を使い回す
 *   - フレームループで new を作らない
 *
 * 安置の壁は「ポップな青系の半透明シェーダー」。上へ流れる縞を入れて、
 * 遠くからでも「動いている壁」だと分かるようにしてある。
 */
import {
    AdditiveBlending,
    BoxGeometry,
    ConeGeometry,
    CylinderGeometry,
    DoubleSide,
    Group,
    InstancedMesh,
    Matrix4,
    Mesh,
    MeshBasicNodeMaterial,
    MeshStandardNodeMaterial,
    Object3D,
    SphereGeometry,
    TorusGeometry,
    type Scene,
} from 'three/webgpu';
import { float, mix, sin, time, uv, vec3 } from 'three/tsl';
import type { QualitySettings } from '../quality';
import { mergeParts, partMatrix, type GeometryPart } from '../world/geom';

const TAU = Math.PI * 2;

/** 壁の分割数（円周方向）。これで十分まっすぐに見える */
const WALL_SEGMENTS = 56;
/**
 * 壁の高さ[m]。この街の標高差（450m超）を全部覆う高さにすると画面全体が青くもやるだけで
 * 「壁」に見えないので、プレイヤーの足元の高さに追従する帯として出す
 */
const WALL_HEIGHT = 260;
/** 帯の下端をプレイヤーの足元から何m下に置くか（坂を降りても足元が抜けない余裕） */
const WALL_BELOW = 60;
/** 光の柱の高さ[m] と半径[m] */
const BEAM_HEIGHT = 140;
const BEAM_RADIUS = 2.4;
/** 花火の粒の最大数 */
const SPARKS = 48;
/** 花火の粒の寿命[s] */
const SPARK_LIFE = 1.7;
/** 花火の初速[m/s] */
const SPARK_SPEED = 13;
/** 花火の重力[m/s²] */
const SPARK_GRAVITY = 7;

export interface MatchObjects {
    /** 安置の円柱壁。r <= 0 で消す。baseY はプレイヤーの足元の高さ（帯を合わせる先） */
    setZone(x: number, z: number, r: number, baseY: number): void;
    /** 宝箱。beam は光の柱（位置が開示されてから点ける） */
    setChest(x: number, y: number, z: number, visible: boolean, beam: boolean): void;
    setKey(x: number, y: number, z: number, visible: boolean): void;
    setTransport(x: number, y: number, z: number, yaw: number, visible: boolean): void;
    setCanopy(x: number, y: number, z: number, yaw: number, visible: boolean): void;
    /** 花火を1発打ち上げる（勝利演出・宝箱の気配） */
    burst(x: number, y: number, z: number, hue: number): void;
    /** 全部隠して花火も止める（ロビー・リマッチ・E67） */
    reset(): void;
    update(dt: number): void;
    dispose(): void;
}

/**
 * 半透明の円柱壁。単位円柱（半径1・高さ1）を毎フレームスケールして使う。
 * 下ほど濃く、上へ流れる横縞と円周方向の縦縞を入れて「動いている壁」だと分かるようにする
 */
function createZoneWall(): Mesh {
    const geometry = new CylinderGeometry(1, 1, 1, WALL_SEGMENTS, 1, true);
    const material = new MeshBasicNodeMaterial();
    // uv().y は下端 0 / 上端 1、uv().x は円周方向の 0〜1
    const v = uv().y;
    const fade = v.oneMinus().pow(1.7);
    const bands = sin(v.mul(26).sub(time.mul(1.8))).mul(0.5).add(0.5);
    const posts = sin(uv().x.mul(TAU * WALL_SEGMENTS * 0.5)).mul(0.5).add(0.5);
    material.colorNode = mix(
        vec3(0.18, 0.56, 1.0),
        vec3(0.92, 0.98, 1.0),
        bands.mul(0.45).add(posts.mul(0.22)),
    );
    // 帯の足元に濃い縁を置くと、地面との交線が出て「壁が立っている」ように見える
    material.opacityNode = fade
        .mul(0.46)
        .mul(bands.mul(0.35).add(0.65))
        .add(v.oneMinus().pow(18).mul(0.34));
    material.transparent = true;
    material.depthWrite = false;
    material.side = DoubleSide;
    material.toneMapped = false;
    const mesh = new Mesh(geometry, material);
    mesh.name = 'zone-wall';
    mesh.scale.y = WALL_HEIGHT;
    // 常に自分を囲んでいるので、カリング判定に時間を使わせない
    mesh.frustumCulled = false;
    mesh.visible = false;
    return mesh;
}

/** 光の柱（加算合成）。宝箱・鍵の目印 */
function createBeam(color: number): Mesh {
    const geometry = new CylinderGeometry(BEAM_RADIUS, BEAM_RADIUS * 0.55, BEAM_HEIGHT, 12, 1, true);
    geometry.translate(0, BEAM_HEIGHT / 2, 0);
    const material = new MeshBasicNodeMaterial({ color });
    const v = uv().y;
    material.opacityNode = mix(float(0.42), float(0), v.pow(0.6));
    material.transparent = true;
    material.depthWrite = false;
    material.blending = AdditiveBlending;
    material.side = DoubleSide;
    material.toneMapped = false;
    // ジオメトリを上へずらしてあるので境界球も柱と一致する。画面外では描かせない
    const mesh = new Mesh(geometry, material);
    mesh.visible = false;
    return mesh;
}

/**
 * ポップな宝箱の形（木箱 + かまぼこ蓋 + 金具）。
 * 偽宝箱（ミミック・契約12）も**同じジオメトリ**を使う — 見た目で見分けられない
 */
export function createChestGeometry(): ReturnType<typeof mergeParts> {
    const wood = 0xb9743a;
    const dark = 0x7c4520;
    const gold = 0xf5c542;
    const parts: GeometryPart[] = [
        { geometry: new BoxGeometry(1.5, 0.85, 1.05), matrix: partMatrix(0, 0.43, 0), color: wood },
        // 蓋は半円柱を横倒しに
        {
            geometry: new CylinderGeometry(0.53, 0.53, 1.5, 14, 1, false, 0, Math.PI),
            matrix: partMatrix(0, 0.86, 0, 1, 1, 1, 0, 0, -Math.PI / 2),
            color: dark,
        },
        { geometry: new BoxGeometry(1.56, 0.12, 1.1), matrix: partMatrix(0, 0.86, 0), color: gold },
        { geometry: new BoxGeometry(0.16, 0.98, 1.12), matrix: partMatrix(-0.45, 0.5, 0), color: gold },
        { geometry: new BoxGeometry(0.16, 0.98, 1.12), matrix: partMatrix(0.45, 0.5, 0), color: gold },
        { geometry: new BoxGeometry(0.3, 0.26, 0.16), matrix: partMatrix(0, 0.74, 0.55), color: gold },
    ];
    return mergeParts(parts);
}

/** 本物の宝箱（1メッシュ） */
function createChest(quality: QualitySettings): Mesh {
    const material = new MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.62, metalness: 0.12 });
    const mesh = new Mesh(createChestGeometry(), material);
    mesh.castShadow = quality.shadows;
    mesh.receiveShadow = true;
    mesh.visible = false;
    return mesh;
}

/** 鍵（輪 + 軸 + 歯）。1メッシュ */
function createKey(): Mesh {
    const gold = 0xffd257;
    const parts: GeometryPart[] = [
        { geometry: new TorusGeometry(0.34, 0.11, 8, 16), matrix: partMatrix(0, 0.5, 0), color: gold },
        { geometry: new CylinderGeometry(0.09, 0.09, 0.95, 8), matrix: partMatrix(0, -0.12, 0), color: gold },
        { geometry: new BoxGeometry(0.3, 0.12, 0.11), matrix: partMatrix(0.16, -0.42, 0), color: gold },
        { geometry: new BoxGeometry(0.22, 0.12, 0.11), matrix: partMatrix(0.12, -0.2, 0), color: gold },
    ];
    const material = new MeshStandardNodeMaterial({
        vertexColors: true,
        roughness: 0.3,
        metalness: 0.7,
        emissive: 0x3a2600,
    });
    // 光の柱が位置を示すので、鍵自体は影を落とさない（シャドウパスの描画を1本節約する）
    const mesh = new Mesh(mergeParts(parts), material);
    mesh.visible = false;
    return mesh;
}

/** 輸送機（胴体 + 主翼 + 尾翼）。yaw=0 で -z を向く。1メッシュ */
function createTransport(): Mesh {
    const body = 0xe9eef5;
    const trim = 0x3f7ad6;
    const parts: GeometryPart[] = [
        {
            geometry: new CylinderGeometry(1.9, 1.7, 17, 10),
            matrix: partMatrix(0, 0, 0, 1, 1, 1, Math.PI / 2, 0, 0),
            color: body,
        },
        {
            geometry: new ConeGeometry(1.7, 4, 10),
            matrix: partMatrix(0, 0, -10.4, 1, 1, 1, -Math.PI / 2, 0, 0),
            color: trim,
        },
        { geometry: new BoxGeometry(19, 0.4, 3.1), matrix: partMatrix(0, 0.9, 1.2), color: body },
        { geometry: new BoxGeometry(7.4, 0.34, 1.9), matrix: partMatrix(0, 1.1, 7.6), color: trim },
        { geometry: new BoxGeometry(0.34, 3.4, 2.4), matrix: partMatrix(0, 2.4, 7.8), color: trim },
        { geometry: new CylinderGeometry(0.8, 0.8, 2.6, 8), matrix: partMatrix(-4.6, 0.6, 0.4, 1, 1, 1, Math.PI / 2, 0, 0), color: trim },
        { geometry: new CylinderGeometry(0.8, 0.8, 2.6, 8), matrix: partMatrix(4.6, 0.6, 0.4, 1, 1, 1, Math.PI / 2, 0, 0), color: trim },
    ];
    const material = new MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.2 });
    const mesh = new Mesh(mergeParts(parts), material);
    // 空の高いところにいるので影は落とさない（シャドウマップの範囲外）
    mesh.visible = false;
    return mesh;
}

/** ポップな傘（8枚の色違いゴアを1メッシュに束ねる） */
function createCanopy(): Mesh {
    const colors = [0xff7a45, 0xfff2d8];
    const parts: GeometryPart[] = [];
    for (let i = 0; i < 8; i++) {
        parts.push({
            geometry: new SphereGeometry(2, 5, 6, (i / 8) * TAU, TAU / 8, 0, Math.PI * 0.5),
            matrix: partMatrix(0, 0, 0, 1, 0.6, 1),
            color: colors[i % 2],
        });
    }
    // 吊り紐（4本）。傘の縁からキャラクターの肩あたりまで
    for (let i = 0; i < 4; i++) {
        const angle = (i / 4) * TAU + Math.PI / 4;
        parts.push({
            geometry: new CylinderGeometry(0.03, 0.03, 1.9, 4),
            matrix: partMatrix(Math.cos(angle) * 1.35, -0.95, Math.sin(angle) * 1.35),
            color: 0xdfe6ee,
        });
    }
    const material = new MeshStandardNodeMaterial({
        vertexColors: true,
        roughness: 0.85,
        side: DoubleSide,
    });
    const mesh = new Mesh(mergeParts(parts), material);
    mesh.visible = false;
    return mesh;
}

export function createMatchObjects(scene: Scene, quality: QualitySettings): MatchObjects {
    const group = new Group();
    group.name = 'match';

    const wall = createZoneWall();
    const chest = createChest(quality);
    const chestBeam = createBeam(0xffd257);
    const key = createKey();
    const keyBeam = createBeam(0x8fe3ff);
    const transport = createTransport();
    const canopy = createCanopy();

    // 花火（1つの InstancedMesh を使い回す。粒の状態は型付き配列に持つ）
    const sparkMaterial = new MeshBasicNodeMaterial({ color: 0xffe9a8, toneMapped: false });
    const sparks = new InstancedMesh(new SphereGeometry(0.34, 6, 5), sparkMaterial, SPARKS);
    sparks.frustumCulled = false;
    sparks.count = 0;
    sparks.visible = false;
    const sparkPos = new Float32Array(SPARKS * 3);
    const sparkVel = new Float32Array(SPARKS * 3);
    const sparkLife = new Float32Array(SPARKS);
    const sparkMatrix = new Matrix4();
    const sparkPivot = new Object3D();

    group.add(wall, chest, chestBeam, key, keyBeam, transport, canopy, sparks);
    scene.add(group);

    let keySpin = 0;

    /** 三角関数を毎フレーム作らずに済むよう、揺れの位相だけ進める */
    let bob = 0;

    return {
        setZone(x, z, r, baseY) {
            if (r <= 0) {
                wall.visible = false;
                return;
            }
            wall.visible = true;
            wall.position.set(x, baseY - WALL_BELOW + WALL_HEIGHT / 2, z);
            wall.scale.x = r;
            wall.scale.z = r;
        },
        setChest(x, y, z, visible, beam) {
            chest.visible = visible;
            chest.position.set(x, y, z);
            chestBeam.visible = beam;
            chestBeam.position.set(x, y, z);
        },
        setKey(x, y, z, visible) {
            key.visible = visible;
            keyBeam.visible = visible;
            key.position.set(x, y + 1.1 + Math.sin(bob) * 0.18, z);
            key.rotation.y = keySpin;
            keyBeam.position.set(x, y, z);
        },
        setTransport(x, y, z, yaw, visible) {
            transport.visible = visible;
            transport.position.set(x, y, z);
            transport.rotation.y = yaw;
        },
        setCanopy(x, y, z, yaw, visible) {
            canopy.visible = visible;
            // キャラクターの頭上に吊る（足元からの高さ）
            canopy.position.set(x, y + 2.9, z);
            canopy.rotation.y = yaw;
        },
        burst(x, y, z, hue) {
            sparkMaterial.color.setHSL(hue, 0.85, 0.62);
            sparks.visible = true;
            sparks.count = SPARKS;
            for (let i = 0; i < SPARKS; i++) {
                // 球状に散らす。乱数は使わず、インデックスからの黄金角で均等に配る
                const t = (i + 0.5) / SPARKS;
                const phi = Math.acos(1 - 2 * t);
                const theta = i * 2.399963;
                const sp = SPARK_SPEED * (0.65 + 0.35 * ((i * 7) % 5) * 0.25);
                sparkPos[i * 3] = x;
                sparkPos[i * 3 + 1] = y;
                sparkPos[i * 3 + 2] = z;
                sparkVel[i * 3] = Math.sin(phi) * Math.cos(theta) * sp;
                sparkVel[i * 3 + 1] = Math.cos(phi) * sp + 4;
                sparkVel[i * 3 + 2] = Math.sin(phi) * Math.sin(theta) * sp;
                sparkLife[i] = SPARK_LIFE;
            }
        },
        reset() {
            wall.visible = false;
            chest.visible = false;
            chestBeam.visible = false;
            key.visible = false;
            keyBeam.visible = false;
            transport.visible = false;
            canopy.visible = false;
            sparks.visible = false;
            sparks.count = 0;
            for (let i = 0; i < SPARKS; i++) sparkLife[i] = 0;
        },
        update(dt) {
            bob += dt * 2.2;
            keySpin = (keySpin + dt * 1.4) % TAU;
            if (!sparks.visible) return;
            let alive = 0;
            for (let i = 0; i < SPARKS; i++) {
                if (sparkLife[i] <= 0) continue;
                sparkLife[i] -= dt;
                sparkVel[i * 3 + 1] -= SPARK_GRAVITY * dt;
                sparkPos[i * 3] += sparkVel[i * 3] * dt;
                sparkPos[i * 3 + 1] += sparkVel[i * 3 + 1] * dt;
                sparkPos[i * 3 + 2] += sparkVel[i * 3 + 2] * dt;
                const fade = Math.max(0, sparkLife[i] / SPARK_LIFE);
                sparkPivot.position.set(sparkPos[i * 3], sparkPos[i * 3 + 1], sparkPos[i * 3 + 2]);
                sparkPivot.scale.setScalar(0.35 + fade * 0.9);
                sparkPivot.updateMatrix();
                sparkMatrix.copy(sparkPivot.matrix);
                sparks.setMatrixAt(alive, sparkMatrix);
                alive++;
            }
            sparks.count = alive;
            sparks.visible = alive > 0;
            sparks.instanceMatrix.needsUpdate = true;
        },
        dispose() {
            scene.remove(group);
            group.traverse((object) => {
                const mesh = object as Mesh;
                mesh.geometry?.dispose();
                const material = mesh.material as { dispose?: () => void } | undefined;
                material?.dispose?.();
            });
        },
    };
}
