/**
 * プレイヤー・車・ヘリコプター・イノシシの見た目（契約06 / 契約12）。
 * すべてプロシージャル生成で、外部アセットは読まない。
 *
 * スタイルは「2.7頭身のチビキャラ」。球・カプセル・角丸ボックスだけで作り、
 * 大きな頭と大きな目で表情を出す。アニメーションはボーン相当の Object3D 階層を
 * コードで動かす（SkinnedMesh は使わない。骨・スキンウェイトを手で作る必要がなく、
 * 状態のブレンドが数値の重み付き和で書けるため）。
 *
 * 描画コールの規律:
 *   - 同じ材質のパーツは1つのジオメトリへ束ねる（merge）。人型10・車13メッシュに収める
 *   - three/addons は使わない（コア二重ロードを避ける）ので、角丸ボックスも合成も自前
 *   - 色の変わらない材質（肌・目・靴・ガラス等）はモジュール共有。ピア色ぶんだけ個別に持つ
 *
 * フレームループの規律: update() の中で new を作らない（数値計算とcopyだけ）。
 */
import {
    BufferAttribute,
    BufferGeometry,
    CapsuleGeometry,
    Color,
    CylinderGeometry,
    Group,
    Mesh,
    MeshStandardNodeMaterial,
    Object3D,
    SphereGeometry,
    TorusGeometry,
    Vector3,
} from 'three/webgpu';
import type { QualitySettings } from '../quality';
import { mergeParts as merge, partMatrix as place } from '../world/geom';
import { hashIndex01 } from '../world/hash';
import { CHASSIS_HALF, WHEEL_RADIUS } from './vehicle';

const TAU = Math.PI * 2;

// --- キャラクターの寸法[m]（足元が原点。yaw=0 で -z を向く） ---
/** 頭の半径。全高 1.56m に対して直径 0.58m ＝ 約2.7頭身 */
const HEAD_R = 0.29;
/** 頭の中心の高さ */
const HEAD_Y = 1.24;
/** 首の付け根（頭ノードの原点）。ここを中心に首をかしげる */
const NECK_Y = 1.02;
/** 胸ノードの原点（腰のひねり・前傾の回転中心） */
const CHEST_Y = 0.56;
const SHOULDER_Y = 0.95;
const SHOULDER_X = 0.225;
const HIP_Y = 0.5;
const HIP_X = 0.115;
/** 頭ノードから見た頭の中心 */
const HEAD_C = HEAD_Y - NECK_Y;

/**
 * ポーズを混ぜるときの参照速度[m/s]。character.ts の SLOW_SPEED（1.9）と、
 * 「全力疾走のポーズになりきる速度」を指す。既定速度（10.4）はこれを超えているので、
 * そこから先は脚の回転数だけが上がる（契約13-9/12）
 */
const WALK_REF = 1.9;
const RUN_REF = 5.2;

// 頂点色で1メッシュに束ねるパーツの色
const EYE_DARK = 0x241d1f;
const EYE_SHINE = 0xffffff;
/** 口は肌よりはっきり暗い赤系。正面から笑顔が読めるようにする */
const MOUTH_RED = 0x7d2a33;
const BLUSH_PINK = 0xff97a6;
const PANTS_NAVY = 0x3c4a6b;
const SHOE_DARK = 0x2a2f3d;

/**
 * 運転席（車体ローカル）。キャラクターは足元が原点なので、座面から腰の高さぶん
 * 下げた位置に置くと座って見える。日本仕様の右ハンドル（車体の +z が正面 = 右席は -x）
 */
export const DRIVER_SEAT = new Vector3(-0.34, HIP_Y - 1.22, 0.24);

export interface PlayerAvatar {
    group: Group;
    /**
     * 足元の位置・向き・水平速度[m/s] を与えて1フレーム進める。
     * 乗車中（setRiding(true)）は位置と向きを書き換えない（車の子として置かれている前提）。
     * airborne を省略すると上下速度から推定する（遠隔プレイヤーは同期項目が無いのでこちら）
     */
    update(feet: Vector3, yaw: number, speed: number, dt: number, airborne?: boolean): void;
    /** 乗車ポーズへ / から遷移する（ブレンドで切り替わる。降車時は小さく跳ねる） */
    setRiding(riding: boolean): void;
    /** 踏み切り前の小さな沈み込み（ジャンプ入力の瞬間に呼ぶ） */
    anticipateJump(): void;
    /** スーパーマン飛行のポーズ。pitch = 進行方向の仰角[rad]（正 = 上向き） */
    setFlying(flying: boolean, pitch: number): void;
    /** 服と帽子の色を差し替える（遠隔プレイヤーをピアごとに塗り分ける・契約05） */
    setColor(color: number): void;
}

export interface CarAvatar {
    group: Group;
    /** 車輪 i の（車体ローカルの）位置・操舵角・回転角を与える */
    setWheel(i: number, offset: Vector3, steering: number, rotation: number): void;
    /** 車体の揺れ（サスペンション演出）とブレーキランプ。steering は前輪の舵角[rad] */
    update(speed: number, steering: number, braking: boolean, dt: number): void;
    /** 車体の色を差し替える */
    setColor(color: number): void;
}

// ---------------------------------------------------------------------------
// ジオメトリ生成のヘルパー（すべて構築時のみ。フレームループでは呼ばない）
// ---------------------------------------------------------------------------

/**
 * 角丸ボックス。RoundedBoxGeometry は addons にしか無いので、
 * 単位球の各頂点を「角丸ボックスの表面」まで伸ばして作る（法線は滑らかにつながる）。
 */
function roundedBox(
    sx: number,
    sy: number,
    sz: number,
    radius: number,
    widthSeg = 22,
    heightSeg = 14,
): BufferGeometry {
    const geometry = new SphereGeometry(1, widthSeg, heightSeg);
    const r = Math.min(radius, sx / 2, sy / 2, sz / 2);
    const bx = sx / 2 - r;
    const by = sy / 2 - r;
    const bz = sz / 2 - r;
    // 角丸ボックスの符号付き距離（内側が負）
    const distance = (x: number, y: number, z: number): number => {
        const qx = Math.abs(x) - bx;
        const qy = Math.abs(y) - by;
        const qz = Math.abs(z) - bz;
        const ox = Math.max(qx, 0);
        const oy = Math.max(qy, 0);
        const oz = Math.max(qz, 0);
        return Math.hypot(ox, oy, oz) + Math.min(Math.max(qx, qy, qz), 0) - r;
    };
    const pos = geometry.attributes.position as BufferAttribute;
    const far = Math.max(sx, sy, sz);
    for (let i = 0; i < pos.count; i++) {
        const dx = pos.getX(i);
        const dy = pos.getY(i);
        const dz = pos.getZ(i);
        let lo = 0;
        let hi = far;
        for (let n = 0; n < 24; n++) {
            const mid = (lo + hi) * 0.5;
            if (distance(dx * mid, dy * mid, dz * mid) < 0) lo = mid;
            else hi = mid;
        }
        pos.setXYZ(i, dx * lo, dy * lo, dz * lo);
    }
    geometry.computeVertexNormals();
    return geometry;
}

function material(color: number, roughness: number, metalness = 0): MeshStandardNodeMaterial {
    return new MeshStandardNodeMaterial({ color, roughness, metalness });
}

function meshOf(
    geometry: BufferGeometry,
    mat: MeshStandardNodeMaterial,
    quality: QualitySettings,
    shadow = true,
): Mesh {
    const mesh = new Mesh(geometry, mat);
    mesh.castShadow = shadow && quality.shadows;
    mesh.receiveShadow = true;
    return mesh;
}

/**
 * ピアごとに変えない材質は全アバターで共有する（バインドグループとメモリを増やさない）。
 * 破棄しない前提のモジュール共有（アプリの生存期間と同じ）。
 */
interface SharedMaterials {
    skin: MeshStandardNodeMaterial;
    pants: MeshStandardNodeMaterial;
    /** 頂点色でまとめて描くパーツ用（目・口・ほっぺ・靴）。1メッシュに何色でも入る */
    vc: MeshStandardNodeMaterial;
    glass: MeshStandardNodeMaterial;
    trim: MeshStandardNodeMaterial;
    rubber: MeshStandardNodeMaterial;
    hub: MeshStandardNodeMaterial;
    lamp: MeshStandardNodeMaterial;
}
let sharedCache: SharedMaterials | null = null;
function shared(): SharedMaterials {
    if (!sharedCache) {
        sharedCache = {
            skin: material(0xffcfa8, 0.72),
            pants: material(0x3c4a6b, 0.88),
            vc: new MeshStandardNodeMaterial({
                color: 0xffffff,
                vertexColors: true,
                roughness: 0.6,
                metalness: 0,
            }),
            // 半透明にして運転手が見えるようにする（不透明な人型は先に描かれるので透ける）
            glass: Object.assign(material(0x9fd0e8, 0.06, 0.1), {
                transparent: true,
                opacity: 0.42,
                depthWrite: false,
            }),
            trim: material(0x272b33, 0.72),
            rubber: material(0x191c21, 0.95),
            hub: material(0xe8edf2, 0.32, 0.55),
            lamp: material(0xfff4dc, 0.25),
        };
    }
    return sharedCache;
}

// ---------------------------------------------------------------------------
// キャラクター
// ---------------------------------------------------------------------------

/** yaw=0 で -z を向く（カメラ・キャラクターの向きの定義に合わせる） */
export function createPlayerAvatar(quality: QualitySettings): PlayerAvatar {
    const s = shared();
    const cloth = material(0x3f7ad6, 0.82);
    const cap = material(0x2f5fb0, 0.8);

    const group = new Group();
    group.name = 'player';
    // 坂の傾き・旋回のバンクを受ける（足元が回転中心）
    const tilt = new Object3D();
    // 上下バウンスとスクワッシュ&ストレッチ
    const body = new Object3D();
    const hips = new Object3D();
    hips.position.y = HIP_Y;
    const chest = new Object3D();
    chest.position.y = CHEST_Y;
    const head = new Object3D();
    head.position.y = NECK_Y - CHEST_Y;
    group.add(tilt);
    tilt.add(body);
    body.add(hips, chest);
    chest.add(head);

    // --- 胴（服）: 卵形ひとつ。裾から下はズボンが覗く ---
    chest.add(
        meshOf(
            merge([
                { geometry: new SphereGeometry(1, 20, 14), matrix: place(0, 0.775 - CHEST_Y, 0, 0.25, 0.245, 0.212) },
            ]),
            cloth,
            quality,
        ),
    );
    // --- 腰（ズボン）+ 服の裾のライン。胴の裾に少しだけ潜り込ませる ---
    hips.add(
        meshOf(
            merge([
                { geometry: new SphereGeometry(1, 18, 12), matrix: place(0, 0.06, 0, 0.215, 0.15, 0.19) },
                // 差し色: シャツの裾から覗くベルト（胴の断面より 1cm だけ外に出す）
                { geometry: new CylinderGeometry(0.2, 0.2, 0.055, 20), matrix: place(0, 0.118, 0, 1, 1, 0.86) },
            ]),
            s.pants,
            quality,
        ),
    );

    // --- 頭・耳・首（肌） ---
    head.add(
        meshOf(
            merge([
                { geometry: new SphereGeometry(HEAD_R, 22, 16), matrix: place(0, HEAD_C, 0, 1, 0.98, 0.97) },
                { geometry: new CylinderGeometry(0.082, 0.095, 0.14, 12), matrix: place(0, 0.02, 0) },
                { geometry: new SphereGeometry(0.05, 10, 8), matrix: place(HEAD_R * 0.93, HEAD_C - 0.02, 0.025, 0.55, 0.95, 0.8) },
                { geometry: new SphereGeometry(0.05, 10, 8), matrix: place(-HEAD_R * 0.93, HEAD_C - 0.02, 0.025, 0.55, 0.95, 0.8) },
            ]),
            s.skin,
            quality,
        ),
    );

    // --- 帽子（ピア色）: ドーム + つば ---
    head.add(
        meshOf(
            merge([
                {
                    geometry: new SphereGeometry(HEAD_R + 0.022, 22, 10, 0, TAU, 0, Math.PI * 0.42),
                    matrix: place(0, HEAD_C, 0, 1, 1.04, 1),
                },
                { geometry: new SphereGeometry(1, 16, 10), matrix: place(0, HEAD_C + 0.075, -0.24, 0.185, 0.026, 0.14, 0.16) },
                // てっぺんのボタン
                { geometry: new SphereGeometry(0.035, 10, 8), matrix: place(0, HEAD_C + HEAD_R + 0.012, 0) },
            ]),
            cap,
            quality,
        ),
    );

    // --- 顔: 目（まばたきで縦につぶれるノードにぶら下げる） ---
    const eyeDir = new Vector3(0.47, -0.1, -0.88).normalize();
    const eyeY = HEAD_C + eyeDir.y * 0.25;
    const eyes = new Object3D();
    eyes.position.y = eyeY;
    head.add(eyes);
    const eyeX = eyeDir.x * 0.25;
    const eyeZ = eyeDir.z * 0.25;
    const eyeTurn = Math.atan2(-eyeDir.x, -eyeDir.z);
    // 目とハイライトは同じメッシュ（頂点色）。まばたきで一緒に潰れるのが正しい
    eyes.add(
        meshOf(
            merge([
                { geometry: new SphereGeometry(1, 14, 12), matrix: place(eyeX, 0, eyeZ, 0.066, 0.088, 0.05, 0, eyeTurn, 0), color: EYE_DARK },
                { geometry: new SphereGeometry(1, 14, 12), matrix: place(-eyeX, 0, eyeZ, 0.066, 0.088, 0.05, 0, -eyeTurn, 0), color: EYE_DARK },
                { geometry: new SphereGeometry(0.026, 8, 6), matrix: place(eyeX - 0.022, 0.032, eyeZ - 0.028), color: EYE_SHINE },
                { geometry: new SphereGeometry(0.026, 8, 6), matrix: place(-eyeX + 0.022, 0.032, eyeZ - 0.028), color: EYE_SHINE },
            ]),
            s.vc,
            quality,
            false,
        ),
    );
    // 口（にっこり）とほっぺ。まばたきノードの外に置く（一緒に潰れないように）。
    // 口は平面のままだと弧の下側が顔から浮くので、球面に沿うよう手前へ倒す
    const blushDir = new Vector3(0.63, -0.3, -0.72).normalize();
    const bx = blushDir.x * 0.278;
    const by = HEAD_C + blushDir.y * 0.278;
    const bz = blushDir.z * 0.278;
    const blushTurn = Math.atan2(-blushDir.x, -blushDir.z);
    head.add(
        meshOf(
            merge([
                {
                    geometry: new TorusGeometry(0.084, 0.027, 8, 16, Math.PI),
                    matrix: place(0, HEAD_C - 0.133, -0.222, 1, 0.85, 1, 0.45, 0, Math.PI),
                    color: MOUTH_RED,
                },
                { geometry: new SphereGeometry(1, 12, 10), matrix: place(bx, by, bz, 0.058, 0.036, 0.03, 0, blushTurn, 0), color: BLUSH_PINK },
                { geometry: new SphereGeometry(1, 12, 10), matrix: place(-bx, by, bz, 0.058, 0.036, 0.03, 0, -blushTurn, 0), color: BLUSH_PINK },
            ]),
            s.vc,
            quality,
            false,
        ),
    );

    // --- 腕（肌。手はミトン） ---
    const arms: Object3D[] = [];
    const legs: Object3D[] = [];
    for (const side of [-1, 1]) {
        const arm = new Object3D();
        arm.position.set(side * SHOULDER_X, SHOULDER_Y - CHEST_Y, 0);
        arm.add(
            meshOf(
                merge([
                    { geometry: new CapsuleGeometry(0.082, 0.17, 4, 10), matrix: place(0, -0.167, 0) },
                    { geometry: new SphereGeometry(0.104, 12, 10), matrix: place(0, -0.35, 0, 1, 0.95, 1.05) },
                ]),
                s.skin,
                quality,
            ),
        );
        chest.add(arm);
        arms.push(arm);

        // 脚と靴は色違いだが1メッシュ（頂点色）にして描画コールを増やさない
        const leg = new Object3D();
        leg.position.set(side * HIP_X, 0, 0);
        leg.add(
            meshOf(
                merge([
                    {
                        geometry: new CapsuleGeometry(0.098, 0.16, 4, 10),
                        matrix: place(0, -0.178, 0),
                        color: PANTS_NAVY,
                    },
                    {
                        geometry: roundedBox(0.19, 0.115, 0.27, 0.055, 14, 10),
                        matrix: place(0, -0.42, -0.045),
                        color: SHOE_DARK,
                    },
                ]),
                s.vc,
                quality,
            ),
        );
        hips.add(leg);
        legs.push(leg);
    }

    // --- 状態（すべて数値。フレームループでアロケーションしない） ---
    let time = 0;
    let phase = 0;
    let riding = 0;
    let ridingFlag = false;
    let locomotion = 0;
    let runness = 0;
    let slope = 0;
    let slopeTarget = 0;
    let bank = 0;
    let bankTarget = 0;
    let lastY = 0;
    let lastYaw = 0;
    let hasLast = false;
    let falling = false;
    let airGuess = false;
    let air = 0;
    let fly = 0;
    let flyingFlag = false;
    let flyPitch = 0;
    let flyPitchTarget = 0;
    let deepest = 0;
    let landStrength = 1;
    let landT = -1;
    let hopT = -1;
    let crouchT = -1;
    let blinkWait = 1.4;
    let blinkT = -1;
    let blinkIndex = 0;
    let tiltWait = 3.2;
    let tiltT = -1;
    let tiltDir = 1;
    let tiltIndex = 0;

    const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
    const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

    return {
        group,
        setRiding(value) {
            if (value === ridingFlag) return;
            ridingFlag = value;
            // 降車のときだけ小さく跳ねて降りる
            if (!value) hopT = 0;
            hasLast = false;
        },
        anticipateJump() {
            crouchT = 0;
        },
        setFlying(value, pitch) {
            flyingFlag = value;
            flyPitchTarget = value ? Math.max(-1.2, Math.min(1.2, pitch)) : 0;
        },
        update(feet, yaw, speed, dt, airborne) {
            const step = Math.min(0.05, Math.max(0.0001, dt));
            time += step;
            const moving = Math.abs(speed);
            let vertical = 0;

            if (!ridingFlag) {
                if (hasLast) {
                    const rise = feet.y - lastY;
                    // ワープ（リスポーン・乗降）は坂・落下の判定に混ぜない
                    if (Math.abs(rise) < 1) {
                        const run = Math.max(0.02, moving * step);
                        if (moving > 0.4) slopeTarget = clamp(Math.atan2(rise, run), -0.5, 0.5);
                        vertical = rise / step;
                        // 同期項目を増やさずに滞空を見分ける: 斜面を登って得られる上昇率
                        // （速度 × 勾配）を超えて上がっていたら踏み切ったとみなす
                        if (vertical > 2.2 && vertical > moving * 0.8) airGuess = true;
                        else if (Math.abs(vertical) < 1.3) airGuess = false;
                        if (vertical < -5) {
                            falling = true;
                            deepest = Math.min(deepest, vertical);
                        } else if (falling && vertical > -1.5) {
                            falling = false;
                            landStrength = clamp(-deepest / 12, 0.35, 1);
                            deepest = 0;
                            landT = 0;
                        }
                    }
                    const turn = Math.atan2(Math.sin(yaw - lastYaw), Math.cos(yaw - lastYaw)) / step;
                    bankTarget = clamp(turn * 0.045, -0.17, 0.17) * clamp01(moving / RUN_REF);
                } else {
                    slopeTarget = 0;
                    bankTarget = 0;
                }
                lastY = feet.y;
                lastYaw = yaw;
                hasLast = true;
                group.position.copy(feet);
                group.rotation.y = yaw;
            } else {
                slopeTarget = 0;
                bankTarget = 0;
            }

            // --- 状態の重み。すべて指数追従なので遷移はブレンドになる（E34） ---
            const airborneNow = ridingFlag ? false : (airborne ?? (airGuess || falling));
            riding +=((ridingFlag ? 1 : 0) - riding) * (1 - Math.exp(-9 * step));
            air += ((airborneNow ? 1 : 0) - air) * (1 - Math.exp(-13 * step));
            fly += ((flyingFlag ? 1 : 0) - fly) * (1 - Math.exp(-5 * step));
            flyPitch += (flyPitchTarget - flyPitch) * (1 - Math.exp(-6 * step));
            const moveTarget = clamp01((moving - 0.18) / (WALK_REF * 0.6));
            locomotion += (moveTarget - locomotion) * (1 - Math.exp(-11 * step));
            const runTarget = clamp01((moving - 2.5) / (RUN_REF - 2.5));
            runness += (runTarget - runness) * (1 - Math.exp(-7 * step));
            slope += (slopeTarget - slope) * (1 - Math.exp(-7 * step));
            bank += (bankTarget - bank) * (1 - Math.exp(-8 * step));

            // 飛行 > 乗車 > 滞空 > 地上（重みの総和は常に 1 なので混ぜてもポーズが暴れない）
            const wFly = fly;
            const wRide = (1 - fly) * riding;
            const wAir = (1 - fly) * (1 - riding) * air;
            const ground = (1 - fly) * (1 - riding) * (1 - air);
            const wRun = ground * locomotion * runness;
            const wWalk = ground * locomotion * (1 - runness);
            const wIdle = ground * (1 - locomotion);

            // 歩調は速度から。歩き→走りで位相が連続するので切り替えで足がワープしない
            // 脚の回転数を実速度へ同期させる（契約13-9/12 で既定速度が 10.4m/s になり、
            // ⚡と足袋で最大 27m/s まで伸びる）。歩き〜ダッシュ域は従来どおりの効きで、
            // それより速い域は歩幅も伸びる前提でゆるやかに増やす（ミシン脚にしない）
            const sprint = Math.min(moving, RUN_REF);
            const beyond = Math.max(0, Math.min(moving, 27) - RUN_REF);
            phase = (phase + (0.85 + sprint * 0.3 + beyond * 0.085) * TAU * step) % TAU;
            const swing = Math.sin(phase);
            const breath = Math.sin(time * 1.9);
            const sway = Math.sin(time * 0.85);

            // --- まばたき・首かしげ（乱数は使わず決定的ハッシュで間隔を散らす） ---
            blinkWait -= step;
            if (blinkWait <= 0) {
                blinkIndex++;
                blinkWait = 2.1 + hashIndex01(blinkIndex, 0x51ed) * 3.4;
                blinkT = 0;
            }
            let open = 1;
            if (blinkT >= 0) {
                blinkT += step;
                if (blinkT > 0.14) blinkT = -1;
                else open = 1 - Math.sin((blinkT / 0.14) * Math.PI);
            }
            tiltWait -= step;
            if (tiltWait <= 0) {
                tiltIndex++;
                tiltWait = 4.5 + hashIndex01(tiltIndex, 0x77ab) * 5.5;
                tiltDir = hashIndex01(tiltIndex, 0x91cf) < 0.5 ? -1 : 1;
                tiltT = 0;
            }
            let tiltCurve = 0;
            if (tiltT >= 0) {
                tiltT += step;
                if (tiltT > 1.5) tiltT = -1;
                else tiltCurve = Math.sin((tiltT / 1.5) * Math.PI);
            }

            // --- 踏み切りの沈み込み・着地の弾み・降車のひと跳ね ---
            let squash = 0;
            let hop = 0;
            let hopPose = 0;
            let crouch = 0;
            if (crouchT >= 0) {
                crouchT += step;
                if (crouchT > 0.1) crouchT = -1;
                else crouch = 1 - crouchT / 0.1;
            }
            squash -= crouch * 0.26;
            if (landT >= 0) {
                landT += step;
                if (landT > 0.55) landT = -1;
                else squash = -0.24 * landStrength * Math.exp(-9 * landT) * Math.cos(landT * 21);
            }
            if (hopT >= 0) {
                hopT += step;
                if (hopT > 0.42) hopT = -1;
                else {
                    hopPose = Math.sin((hopT / 0.42) * Math.PI);
                    hop = hopPose * 0.2;
                    squash += hopPose * 0.1;
                }
            }

            // --- 全身: 上下バウンス + スクワッシュ&ストレッチ ---
            // 走りは接地（位相 0, π）で潰れ、空中で伸びる。誇張のため横は体積保存より強く逆に振る
            const bounce = (wWalk * 0.032 + wRun * 0.115) * Math.abs(swing) + wIdle * breath * 0.006;
            const beat = -Math.cos(phase * 2);
            const stretch =
                1 + (wWalk * 0.03 + wRun * 0.19) * beat + squash + wAir * 0.07 + wFly * 0.05;
            const scaleY = Math.max(0.6, stretch);
            const scaleXZ = 1 + (1 - scaleY) * 0.85;
            body.position.y = bounce + hop;
            body.scale.set(scaleXZ, scaleY, scaleXZ);

            // 飛行中は体を水平に伏せる（足元原点のままだと体が前へずれるので z へ戻す）
            tilt.rotation.x = slope * 0.72 * ground + wFly * (flyPitch - Math.PI / 2);
            tilt.rotation.z = bank;
            tilt.position.z = wFly * 0.78;

            // --- 腰・胸・頭 ---
            hips.rotation.y = -(wWalk * 0.09 + wRun * 0.17) * swing;
            hips.rotation.z = (wWalk * 0.04 + wRun * 0.06) * swing;
            const lean =
                -(wWalk * 0.05 + wRun * 0.3) -
                wRide * 0.16 +
                wIdle * (0.01 + breath * 0.012) -
                wAir * 0.12 -
                crouch * 0.3;
            chest.rotation.x = lean;
            chest.rotation.y = (wWalk * 0.1 + wRun * 0.19) * swing;
            chest.rotation.z = wIdle * 0.02 * sway;
            // 伏せている間は首を起こして前を見る
            head.rotation.x =
                -lean * 0.62 + wIdle * breath * 0.02 - hopPose * 0.12 + wAir * 0.14 - wFly * 1.15;
            head.rotation.y = wIdle * 0.13 * Math.sin(time * 0.47);
            head.rotation.z = tiltDir * 0.26 * tiltCurve * (wIdle + wRide * 0.6) + bank * 0.4;
            eyes.scale.y = 0.1 + 0.9 * open;

            // --- 手足（重みの和で混ぜるので、状態が変わっても瞬間移動しない） ---
            const legSwing = wWalk * 0.55 + wRun * 1.02;
            const armSwing = wWalk * 0.46 + wRun * 0.9;
            // 飛行は片腕を前（体のローカルでは真上）へ、もう片腕は体に沿わせる。
            // 足は後ろへ流し、わずかにばたつかせる
            const flutter = Math.sin(time * 3.1) * 0.12;
            for (let i = 0; i < 2; i++) {
                const side = i === 0 ? -1 : 1;
                const dir = i === 0 ? 1 : -1;
                const lead = i === 1 ? 1 : 0;
                const arm = arms[i];
                arm.rotation.x =
                    -dir * swing * armSwing +
                    wRide * 1.24 +
                    wIdle * (0.06 + breath * 0.04) +
                    wAir * 2.15 +
                    wFly * (lead ? Math.PI * 0.97 : 0.12) +
                    hopPose * -0.9 +
                    crouch * -0.5;
                arm.rotation.z =
                    side *
                    (0.13 * (1 - wRide - wFly) +
                        0.03 * wRide +
                        wRun * 0.05 +
                        wAir * 0.34 +
                        wFly * 0.06 +
                        hopPose * 0.35);
                const leg = legs[i];
                leg.rotation.x =
                    dir * swing * legSwing +
                    wRide * 1.12 +
                    wIdle * side * 0.02 +
                    wAir * (dir > 0 ? 0.5 : -0.3) +
                    wFly * (0.05 + dir * flutter) -
                    hopPose * 0.35 +
                    crouch * 0.55;
                leg.rotation.z = side * (wRide * 0.13 + wAir * 0.06 + hopPose * 0.1);
            }
        },
        setColor(color) {
            cloth.color.setHex(color);
            cap.color.copy(cloth.color).offsetHSL(0.04, 0.06, -0.12);
        },
    };
}

// ---------------------------------------------------------------------------
// 車
// ---------------------------------------------------------------------------

/** 車体は +z が正面（rapier の前方向軸に合わせる） */
export function createCarAvatar(quality: QualitySettings): CarAvatar {
    const s = shared();
    const paint = material(0xe0533f, 0.4, 0.3);
    const tail = material(0x8c1d1d, 0.38);
    tail.emissive = new Color(0x180404);

    const group = new Group();
    group.name = 'car';
    // 車輪は路面に付いたまま、車体だけをピッチ・ロールさせる（サスペンション演出）
    const shell = new Object3D();
    group.add(shell);

    const { z: hz } = CHASSIS_HALF;
    // ボディ・屋根・ピラーをひとつのメッシュに束ねる。キャビンは箱で埋めずに
    // 「屋根 + 4本のピラー」にして、窓から運転手が見えるようにする
    shell.add(
        meshOf(
            merge([
                { geometry: roundedBox(1.72, 0.88, hz * 2 + 0.05, 0.36), matrix: place(0, 0.02, 0) },
                // 屋根
                { geometry: roundedBox(1.56, 0.3, 2.06, 0.22), matrix: place(0, 0.94, -0.16) },
                // ピラー（前は寝かせ、後ろは少し前傾させて車らしいシルエットにする）
                { geometry: roundedBox(0.18, 0.68, 0.22, 0.07), matrix: place(0.72, 0.58, 0.82, 1, 1, 1, -0.32) },
                { geometry: roundedBox(0.18, 0.68, 0.22, 0.07), matrix: place(-0.72, 0.58, 0.82, 1, 1, 1, -0.32) },
                { geometry: roundedBox(0.22, 0.68, 0.62, 0.14), matrix: place(0.71, 0.58, -1.02, 1, 1, 1, 0.2) },
                { geometry: roundedBox(0.22, 0.68, 0.62, 0.14), matrix: place(-0.71, 0.58, -1.02, 1, 1, 1, 0.2) },
                // 前後のフェンダーの張り出し
                { geometry: roundedBox(1.7, 0.44, 1.12, 0.21), matrix: place(0, -0.16, 1.42) },
                { geometry: roundedBox(1.7, 0.44, 1.12, 0.21), matrix: place(0, -0.16, -1.42) },
            ]),
            paint,
            quality,
        ),
    );
    // 窓。上端は屋根の中・下端は車体の中に隠して、側面だけがガラスに見えるようにする
    const glass = meshOf(roundedBox(1.5, 0.58, 2.12, 0.2), s.glass, quality, false);
    glass.position.set(0, 0.58, -0.16);
    shell.add(glass);
    // バンパー・ミラー・ランプの縁取り・車内（ダッシュボード・シート・ハンドル）
    shell.add(
        meshOf(
            merge([
                { geometry: roundedBox(1.68, 0.28, 0.3, 0.12), matrix: place(0, -0.26, hz - 0.02) },
                { geometry: roundedBox(1.68, 0.28, 0.3, 0.12), matrix: place(0, -0.26, -hz + 0.02) },
                { geometry: roundedBox(0.16, 0.14, 0.1, 0.05), matrix: place(0.84, 0.52, 0.84) },
                { geometry: roundedBox(0.16, 0.14, 0.1, 0.05), matrix: place(-0.84, 0.52, 0.84) },
                // ランプの縁取り（車体色が何色でもライトが読めるように）
                { geometry: new SphereGeometry(0.22, 12, 10), matrix: place(0.53, 0.14, hz - 0.1, 1, 0.84, 0.42) },
                { geometry: new SphereGeometry(0.22, 12, 10), matrix: place(-0.53, 0.14, hz - 0.1, 1, 0.84, 0.42) },
                { geometry: new SphereGeometry(0.19, 12, 10), matrix: place(0.55, 0.22, -hz + 0.08, 1, 0.86, 0.42) },
                { geometry: new SphereGeometry(0.19, 12, 10), matrix: place(-0.55, 0.22, -hz + 0.08, 1, 0.86, 0.42) },
                // 車内: 窓から中が空っぽに見えないようにする（描画コールは増やさない）
                { geometry: roundedBox(1.4, 0.36, 0.34, 0.1), matrix: place(0, 0.2, 0.82) },
                { geometry: roundedBox(1.3, 0.56, 0.18, 0.07), matrix: place(0, 0.3, -0.3) },
                {
                    geometry: new TorusGeometry(0.2, 0.028, 6, 16),
                    matrix: place(-0.34, 0.06, 0.64, 1, 1, 1, -0.35, 0, 0),
                },
            ]),
            s.trim,
            quality,
        ),
    );
    // ヘッドライト / テールランプ
    shell.add(
        meshOf(
            merge([
                { geometry: new SphereGeometry(0.19, 12, 10), matrix: place(0.53, 0.14, hz - 0.06, 1, 0.82, 0.5) },
                { geometry: new SphereGeometry(0.19, 12, 10), matrix: place(-0.53, 0.14, hz - 0.06, 1, 0.82, 0.5) },
            ]),
            s.lamp,
            quality,
            false,
        ),
    );
    shell.add(
        meshOf(
            merge([
                { geometry: new SphereGeometry(0.16, 12, 10), matrix: place(0.55, 0.22, -hz + 0.04, 1, 0.85, 0.5) },
                { geometry: new SphereGeometry(0.16, 12, 10), matrix: place(-0.55, 0.22, -hz + 0.04, 1, 0.85, 0.5) },
            ]),
            tail,
            quality,
            false,
        ),
    );

    // 車輪: 軸を x にそろえた円柱。pivot で操舵、spin で転がりを回す
    const tyre = new CylinderGeometry(WHEEL_RADIUS + 0.03, WHEEL_RADIUS + 0.03, 0.3, 18);
    tyre.rotateZ(Math.PI / 2);
    const hub = new CylinderGeometry(0.185, 0.185, 0.36, 12);
    hub.rotateZ(Math.PI / 2);
    const pivots: Object3D[] = [];
    const spins: Object3D[] = [];
    for (let i = 0; i < 4; i++) {
        const pivot = new Object3D();
        const spin = new Object3D();
        spin.add(meshOf(tyre, s.rubber, quality));
        spin.add(meshOf(hub, s.hub, quality, false));
        pivot.add(spin);
        group.add(pivot);
        pivots.push(pivot);
        spins.push(spin);
    }

    let pitch = 0;
    let pitchVel = 0;
    let roll = 0;
    let accel = 0;
    let lastSpeed = 0;
    let lamp = 0;

    return {
        group,
        setWheel(i, offset, steering, rotation) {
            pivots[i].position.copy(offset);
            pivots[i].rotation.y = steering;
            spins[i].rotation.x = rotation;
        },
        update(speed, steering, braking, dt) {
            const step = Math.min(0.05, Math.max(0.0001, dt));
            const raw = (speed - lastSpeed) / step;
            lastSpeed = speed;
            accel += (Math.max(-16, Math.min(16, raw)) - accel) * (1 - Math.exp(-14 * step));

            // 加速で持ち上がり、減速で沈む。バネなので少し行き過ぎて戻る
            const target = Math.max(-0.1, Math.min(0.1, -accel * 0.011));
            pitchVel += (target - pitch) * 260 * step;
            pitchVel *= Math.exp(-9 * step);
            pitch += pitchVel * step;
            const rollTarget = Math.max(
                -0.1,
                Math.min(0.1, steering * Math.abs(speed) * 0.022),
            );
            roll += (rollTarget - roll) * (1 - Math.exp(-6 * step));
            shell.rotation.x = pitch;
            shell.rotation.z = roll;
            shell.position.y = -Math.abs(pitch) * 0.1;

            // ブレーキランプ: 明示的なブレーキか、はっきりした減速で点く
            const lit = braking || accel < -2.4 ? 1 : 0;
            lamp += (lit - lamp) * (1 - Math.exp(-24 * step));
            tail.emissive.setRGB(0.09 + 1.05 * lamp, 0.02 + 0.06 * lamp, 0.02 + 0.04 * lamp);
        },
        setColor(color) {
            paint.color.setHex(color);
        },
    };
}

// ---------------------------------------------------------------------------
// ヘリコプター（契約12）
// ---------------------------------------------------------------------------

/** merge() へ渡すパーツの形（world/geom の GeometryPart と同じ） */
type Part = Parameters<typeof merge>[0][number];

/** 機体ローカルの操縦席（キャラクターは足元が原点なので、座面から腰の高さぶん下げる） */
export const HELI_SEAT = new Vector3(-0.34, 0.62, 0.42);
/** スキッド接地面からローターまでの高さ[m]（カメラ・着陸判定の目安） */
export const HELI_HEIGHT = 2.5;

export interface HeliAvatar {
    group: Group;
    /** ローターを回す。lift = 0..1（エンジンの掛かり具合） */
    update(lift: number, dt: number): void;
    setColor(color: number): void;
}

/**
 * ヘリコプター。原点はスキッドの接地面、+z が機首方向（車と同じ向きの定義）。
 * 描画コールは「胴体（ピア色）」と「メインローター」の2つに収める。
 */
export function createHeliAvatar(quality: QualitySettings): HeliAvatar {
    const s = shared();
    const paint = material(0x3f7ad6, 0.42, 0.25);
    const dark = 0x272b33;
    const glassBlue = 0x9fd0e8;

    const group = new Group();
    group.name = 'heli';
    // yaw → pitch → roll の順で受ける（ロールが機首方向を回さない）
    group.rotation.order = 'YXZ';

    group.add(
        meshOf(
            merge([
                { geometry: new SphereGeometry(1, 18, 14), matrix: place(0, 1.15, 0.15, 0.95, 0.82, 1.55) },
                { geometry: new SphereGeometry(1, 16, 12), matrix: place(0, 1.22, 0.72, 0.82, 0.66, 0.95), color: glassBlue },
                { geometry: new CylinderGeometry(0.19, 0.13, 3.5, 10), matrix: place(0, 1.32, -2.5, 1, 1, 1, Math.PI / 2, 0, 0), color: dark },
                { geometry: roundedBox(0.12, 1, 0.62, 0.06, 10, 8), matrix: place(0, 1.75, -4), color: dark },
                { geometry: roundedBox(1.5, 0.1, 0.42, 0.05, 10, 8), matrix: place(0, 1.42, -3.85), color: dark },
                { geometry: new CylinderGeometry(0.62, 0.62, 0.05, 12), matrix: place(0.2, 1.78, -4.05, 1, 1, 1, 0, 0, Math.PI / 2), color: 0x3a3f4a },
                { geometry: new CylinderGeometry(0.11, 0.13, 0.5, 8), matrix: place(0, 2.02, 0.1), color: dark },
                { geometry: new CylinderGeometry(0.075, 0.075, 3.4, 8), matrix: place(0.95, 0.08, 0.1, 1, 1, 1, Math.PI / 2, 0, 0), color: dark },
                { geometry: new CylinderGeometry(0.075, 0.075, 3.4, 8), matrix: place(-0.95, 0.08, 0.1, 1, 1, 1, Math.PI / 2, 0, 0), color: dark },
                { geometry: new CylinderGeometry(0.06, 0.06, 0.72, 6), matrix: place(0.72, 0.42, 0.85, 1, 1, 1, 0, 0, 0.35), color: dark },
                { geometry: new CylinderGeometry(0.06, 0.06, 0.72, 6), matrix: place(-0.72, 0.42, 0.85, 1, 1, 1, 0, 0, -0.35), color: dark },
                { geometry: new CylinderGeometry(0.06, 0.06, 0.72, 6), matrix: place(0.72, 0.42, -0.7, 1, 1, 1, 0, 0, 0.35), color: dark },
                { geometry: new CylinderGeometry(0.06, 0.06, 0.72, 6), matrix: place(-0.72, 0.42, -0.7, 1, 1, 1, 0, 0, -0.35), color: dark },
            ]),
            paint,
            quality,
        ),
    );

    // メインローター（ハブ + 4枚羽）。回転は Object3D 側で行う
    const rotor = new Object3D();
    rotor.position.set(0, 2.3, 0.1);
    const blades: Part[] = [
        { geometry: new CylinderGeometry(0.2, 0.2, 0.18, 8), matrix: place(0, 0, 0), color: dark },
    ];
    for (let i = 0; i < 4; i++) {
        const angle = (i / 4) * TAU;
        blades.push({
            geometry: roundedBox(0.28, 0.05, 4.2, 0.03, 8, 6),
            matrix: place(Math.sin(angle) * 2.1, 0, Math.cos(angle) * 2.1, 1, 1, 1, 0, angle, 0),
            color: 0x2f343d,
        });
    }
    rotor.add(meshOf(merge(blades), s.vc, quality, false));
    group.add(rotor);

    let spin = 0;

    return {
        group,
        update(lift, dt) {
            const step = Math.min(0.05, Math.max(0.0001, dt));
            spin = (spin + (6 + Math.max(0, Math.min(1, lift)) * 26) * step) % TAU;
            rotor.rotation.y = spin;
        },
        setColor(color) {
            paint.color.setHex(color);
        },
    };
}

// ---------------------------------------------------------------------------
// イノシシ（契約12）
// ---------------------------------------------------------------------------

/** 騎乗中のライダーの足元位置（イノシシローカル。原点は接地面） */
export const BOAR_SEAT = new Vector3(0, 0.72, -0.05);

/**
 * 六甲のイノシシ。yaw=0 で -z を向く（キャラクターと同じ定義なので、
 * 騎乗中は乗り手の向きをそのまま渡せる）。頂点色で1メッシュ。
 */
export function createBoarGeometry(): BufferGeometry {
    const fur = 0x6b5442;
    const back = 0x4a3a2d;
    const nose = 0x3a2f28;
    const tusk = 0xf1ead6;
    const parts: Part[] = [
        { geometry: new SphereGeometry(1, 16, 12), matrix: place(0, 0.62, 0.05, 0.34, 0.34, 0.6), color: fur },
        { geometry: new SphereGeometry(1, 12, 8), matrix: place(0, 0.92, 0.05, 0.1, 0.12, 0.5), color: back },
        { geometry: new SphereGeometry(1, 14, 12), matrix: place(0, 0.66, -0.52, 0.26, 0.26, 0.28), color: back },
        { geometry: new CylinderGeometry(0.14, 0.19, 0.34, 10), matrix: place(0, 0.56, -0.76, 1, 1, 1, -Math.PI / 2, 0, 0), color: fur },
        { geometry: new SphereGeometry(0.15, 10, 8), matrix: place(0, 0.55, -0.92, 1, 0.85, 0.6), color: nose },
        { geometry: new CylinderGeometry(0.02, 0.045, 0.24, 6), matrix: place(0.13, 0.5, -0.86, 1, 1, 1, -0.5, 0, 0.3), color: tusk },
        { geometry: new CylinderGeometry(0.02, 0.045, 0.24, 6), matrix: place(-0.13, 0.5, -0.86, 1, 1, 1, -0.5, 0, -0.3), color: tusk },
        { geometry: new SphereGeometry(1, 8, 6), matrix: place(0.17, 0.86, -0.46, 0.07, 0.11, 0.03), color: back },
        { geometry: new SphereGeometry(1, 8, 6), matrix: place(-0.17, 0.86, -0.46, 0.07, 0.11, 0.03), color: back },
        { geometry: new CylinderGeometry(0.03, 0.02, 0.3, 6), matrix: place(0, 0.78, 0.62, 1, 1, 1, 0.7, 0, 0), color: back },
    ];
    for (const sx of [-1, 1]) {
        for (const sz of [-1, 1]) {
            parts.push({
                geometry: new CapsuleGeometry(0.075, 0.28, 4, 8),
                matrix: place(sx * 0.2, 0.26, sz * 0.32),
                color: back,
            });
            parts.push({
                geometry: new SphereGeometry(0.085, 8, 6),
                matrix: place(sx * 0.2, 0.07, sz * 0.32, 1, 0.7, 1.1),
                color: nose,
            });
        }
    }
    return merge(parts);
}

export interface BoarAvatar {
    group: Group;
    /** 走りの上下動。speed は水平速度[m/s] */
    update(speed: number, dt: number): void;
}

/** 1体ぶんのイノシシ（騎乗表示用）。描画コールは1 */
export function createBoarAvatar(quality: QualitySettings): BoarAvatar {
    const group = new Group();
    group.name = 'boar';
    const body = new Object3D();
    group.add(body);
    const skin = new MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.85 });
    body.add(meshOf(createBoarGeometry(), skin, quality));

    let phase = 0;

    return {
        group,
        update(speed, dt) {
            const step = Math.min(0.05, Math.max(0.0001, dt));
            const pace = Math.abs(speed);
            phase =
                (phase +
                    (1.2 + Math.min(pace, RUN_REF) * 0.55 + Math.max(0, Math.min(pace, 20) - RUN_REF) * 0.14) *
                        TAU *
                        step) %
                TAU;
            const gait = Math.min(1, pace / 5);
            body.position.y = Math.abs(Math.sin(phase)) * 0.09 * gait;
            body.rotation.x = Math.sin(phase * 2) * 0.06 * gait;
            body.rotation.z = Math.sin(phase) * 0.045 * gait;
        },
    };
}

// ---------------------------------------------------------------------------
// 簡易アバター（契約12: 遠くの遠隔プレイヤー・BOT 用）
// ---------------------------------------------------------------------------

export interface SimpleAvatar {
    group: Group;
    setColor(color: number): void;
}

/**
 * 立ちポーズのまま動かない1メッシュの人型。BOT8体が同時に見えても描画コールが
 * 増えないよう、遠くのゴーストはこちらで描く（E92）。服と帽子の色はピアごとに
 * 変わるので、頂点色のその範囲だけを書き換える。
 */
export function createSimpleAvatar(quality: QualitySettings): SimpleAvatar {
    const skinColor = 0xffcfa8;
    const parts: Part[] = [
        // 先頭3つ = 服・帽子（setColor で塗り替える範囲）
        { geometry: new SphereGeometry(1, 12, 10), matrix: place(0, 0.775, 0, 0.25, 0.245, 0.212), color: 0xffffff },
        {
            geometry: new SphereGeometry(HEAD_R + 0.022, 12, 8, 0, TAU, 0, Math.PI * 0.42),
            matrix: place(0, HEAD_Y, 0, 1, 1.04, 1),
            color: 0xffffff,
        },
        { geometry: new SphereGeometry(1, 12, 8), matrix: place(0, HEAD_Y + 0.075, -0.24, 0.185, 0.026, 0.14, 0.16), color: 0xffffff },
        { geometry: new SphereGeometry(HEAD_R, 14, 12), matrix: place(0, HEAD_Y, 0, 1, 0.98, 0.97), color: skinColor },
        { geometry: new SphereGeometry(1, 12, 8), matrix: place(0, 0.56, 0, 0.215, 0.15, 0.19), color: PANTS_NAVY },
        { geometry: new SphereGeometry(1, 10, 8), matrix: place(0.12, HEAD_Y - 0.03, -0.25, 0.055, 0.075, 0.04), color: EYE_DARK },
        { geometry: new SphereGeometry(1, 10, 8), matrix: place(-0.12, HEAD_Y - 0.03, -0.25, 0.055, 0.075, 0.04), color: EYE_DARK },
    ];
    for (const side of [-1, 1]) {
        parts.push({
            geometry: new CapsuleGeometry(0.082, 0.2, 4, 8),
            matrix: place(side * (SHOULDER_X + 0.03), SHOULDER_Y - 0.16, 0, 1, 1, 1, 0, 0, side * -0.12),
            color: skinColor,
        });
        parts.push({
            geometry: new CapsuleGeometry(0.098, 0.16, 4, 8),
            matrix: place(side * HIP_X, 0.32, 0),
            color: PANTS_NAVY,
        });
        parts.push({
            geometry: new SphereGeometry(1, 8, 6),
            matrix: place(side * HIP_X, 0.06, -0.04, 0.095, 0.06, 0.14),
            color: SHOE_DARK,
        });
    }
    // 服・帽子の頂点数を、束ねる前に数えておく
    let clothVerts = 0;
    for (let i = 0; i < 3; i++) {
        const part = parts[i].geometry;
        clothVerts += part.index ? part.index.count : part.attributes.position.count;
    }
    const geometry = merge(parts);
    const mesh = new Mesh(geometry, new MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.8 }));
    mesh.castShadow = false;
    mesh.receiveShadow = quality.shadows;

    const group = new Group();
    group.name = 'peer-simple';
    group.add(mesh);
    const colorAttribute = geometry.getAttribute('color') as BufferAttribute;
    const tint = new Color();

    return {
        group,
        setColor(color) {
            tint.setHex(color);
            for (let i = 0; i < clothVerts; i++) colorAttribute.setXYZ(i, tint.r, tint.g, tint.b);
            colorAttribute.needsUpdate = true;
        },
    };
}
