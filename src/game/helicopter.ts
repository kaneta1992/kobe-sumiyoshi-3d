/**
 * ヘリコプター（契約12）。**アーケード飛行**で、物理エンジンは通さない。
 *
 * 車（vehicle.ts）は rapier の4輪モデルだが、ヘリは剛体で飛ばすと接地・ローターの
 * 扱いが増えるだけで操作は良くならない。ここはスーパーマン飛行（契約06）と同じく
 * 位置を自前で積分し、**地形の足場とだけ**当てる:
 *   コレクティブ（上昇/下降）・ピッチ（前後）・ロール（左右のバンク旋回）・ヨー
 *   最高速は車の 1.5 倍。着陸は緩判定（低速で接地すれば降りられる）
 *   荒い接地は「墜落」にして数秒で自動復帰する（E84。車の E24 と同じ考え方）
 *
 * 遠隔へは座標と機首方向だけを送る（姿勢は受け手が速度から推定する）ので、
 * 同期項目は増えない。
 */
import { Vector3 } from 'three/webgpu';
import { AREA_HALF } from '../config';

/** 水平の最高速度[m/s]（車の MAX_SPEED 24 の 1.5 倍） */
const MAX_SPEED = 36;
/** 前後の加速度[m/s²] と ブースト時の倍率 */
const ACCEL = 16;
const BOOST = 1.55;
/** 水平の空気抵抗[1/s]（入力を止めるとゆっくり止まる） */
const DRAG = 0.55;
/** コレクティブの上昇/下降速度[m/s] と 追従の速さ[1/s] */
const CLIMB = 13;
const CLIMB_RATE = 2.6;
/** 入力が無いときの自然沈下[m/s] */
const IDLE_SINK = 1.6;
/** ヨーの角速度[rad/s]（バンクに応じて曲がる） */
const YAW_RATE = 1.1;
/** 見た目の最大バンク・ピッチ[rad] と 追従の速さ[1/s] */
const MAX_ROLL = 0.5;
const MAX_PITCH = 0.34;
const TILT_RATE = 3.2;
/** 着陸できる沈下速度[m/s] と 水平速度[m/s]（これを超えると墜落扱い・E84） */
const LAND_SINK = 9;
const LAND_SPEED = 14;
/** 墜落から復帰するまで[s] */
const RECOVER_TIME = 3;
/** ローターの掛かり（0..1）の追従の速さ[1/s] */
const SPOOL_RATE = 1.4;

export interface HeliInput {
    /** 前後（-1..1）。+1 = 前進 */
    pitch: number;
    /** 左右（-1..1）。+1 = 右バンク */
    roll: number;
    /** 上昇/下降（-1..1）。+1 = 上昇 */
    collective: number;
    boost: boolean;
    /** 操縦者が乗っているか */
    active: boolean;
}

export interface Helicopter {
    /** スキッド接地面の位置 */
    readonly position: Vector3;
    readonly yaw: number;
    readonly pitch: number;
    readonly roll: number;
    /** 水平速度[m/s]（前向きを正） */
    readonly speed: number;
    /** 接地しているか（乗降できる） */
    readonly landed: boolean;
    /** 墜落して自動復帰待ちか（E84） */
    readonly crashed: boolean;
    /** ローターの掛かり具合（0..1）。見た目にだけ使う */
    readonly lift: number;
    /** カメラが機首を向くときの yaw[rad]（カメラの前方向は -z 基準） */
    readonly viewYaw: number;
    /** 置き直す（配置・リセット・自動復帰） */
    place(x: number, y: number, z: number, yaw: number): void;
    /**
     * 1フレーム進める。surfaceAt は足場の高さ（道路・屋根も拾う）。
     * scale は移動倍率（安置の外では上昇率と速度が落ちる・E84）
     */
    update(
        dt: number,
        input: HeliInput,
        surfaceAt: (x: number, z: number) => number,
        scale: number,
    ): void;
}

export function createHelicopter(): Helicopter {
    const position = new Vector3();
    const velocity = new Vector3();
    let yaw = 0;
    let pitch = 0;
    let roll = 0;
    let landed = true;
    let crashFor = -1;
    let lift = 0;
    let forwardSpeed = 0;

    const placeAt = (x: number, y: number, z: number, seatYaw: number): void => {
        position.set(x, y, z);
        velocity.set(0, 0, 0);
        yaw = seatYaw;
        pitch = 0;
        roll = 0;
        landed = true;
        crashFor = -1;
        forwardSpeed = 0;
    };

    return {
        position,
        get yaw() {
            return yaw;
        },
        get pitch() {
            return pitch;
        },
        get roll() {
            return roll;
        },
        get speed() {
            return forwardSpeed;
        },
        get landed() {
            return landed;
        },
        get crashed() {
            return crashFor >= 0;
        },
        get lift() {
            return lift;
        },
        get viewYaw() {
            return yaw + Math.PI;
        },
        place: placeAt,
        update(dt, input, surfaceAt, scale) {
            const step = Math.min(0.05, Math.max(0.0001, dt));
            const ground = surfaceAt(position.x, position.z);

            // --- 墜落からの自動復帰（数秒でその場に立て直す・E84） ---
            if (crashFor >= 0) {
                crashFor += step;
                lift += (0 - lift) * (1 - Math.exp(-SPOOL_RATE * step));
                roll += (1.1 - roll) * (1 - Math.exp(-4 * step));
                position.y = ground;
                if (crashFor > RECOVER_TIME) placeAt(position.x, ground, position.z, yaw);
                return;
            }

            const flying = input.active;
            lift += ((flying ? 1 : 0) - lift) * (1 - Math.exp(-SPOOL_RATE * step));
            if (!flying) {
                // 無人の機体は置いてあるだけ（坂でも転がらない）
                velocity.set(0, 0, 0);
                position.y = ground;
                pitch += (0 - pitch) * (1 - Math.exp(-TILT_RATE * step));
                roll += (0 - roll) * (1 - Math.exp(-TILT_RATE * step));
                landed = true;
                forwardSpeed = 0;
                return;
            }

            // --- 操縦 ---
            // ロールでバンクして曲がる（ヨー単独の操作は増やさない = 片手で飛ばせる）
            yaw -= input.roll * YAW_RATE * step * (0.35 + 0.65 * lift);
            const rollTarget = input.roll * MAX_ROLL;
            const pitchTarget = -input.pitch * MAX_PITCH;
            roll += (rollTarget - roll) * (1 - Math.exp(-TILT_RATE * step));
            pitch += (pitchTarget - pitch) * (1 - Math.exp(-TILT_RATE * step));

            // 機首方向（機体ローカルの +z が正面）
            const fx = Math.sin(yaw);
            const fz = Math.cos(yaw);
            const push = input.pitch * ACCEL * (input.boost ? BOOST : 1) * lift;
            velocity.x += fx * push * step;
            velocity.z += fz * push * step;
            const damp = Math.exp(-DRAG * step);
            velocity.x *= damp;
            velocity.z *= damp;
            const limit = MAX_SPEED * scale * (input.boost ? BOOST : 1);
            const horizontal = Math.hypot(velocity.x, velocity.z);
            if (horizontal > limit) {
                velocity.x *= limit / horizontal;
                velocity.z *= limit / horizontal;
            }

            // コレクティブ（上昇・下降）。安置の外では上昇率が落ちる（E84）
            const wanted =
                input.collective > 0
                    ? input.collective * CLIMB * scale
                    : input.collective < 0
                      ? input.collective * CLIMB
                      : -IDLE_SINK;
            velocity.y += (wanted * lift - velocity.y) * (1 - Math.exp(-CLIMB_RATE * step));

            position.addScaledVector(velocity, step);
            const edge = AREA_HALF - 8;
            position.x = Math.max(-edge, Math.min(edge, position.x));
            position.z = Math.max(-edge, Math.min(edge, position.z));

            // --- 接地 ---
            const floor = surfaceAt(position.x, position.z);
            if (position.y <= floor) {
                const sink = -velocity.y;
                const speedNow = Math.hypot(velocity.x, velocity.z);
                position.y = floor;
                // 沈下も水平速度も小さければ着陸（緩判定）。荒ければ墜落して自動復帰（E84）
                if (sink > LAND_SINK || speedNow > LAND_SPEED) crashFor = 0;
                velocity.set(0, 0, 0);
                landed = true;
            } else {
                landed = position.y - floor < 0.35;
            }
            forwardSpeed = velocity.x * fx + velocity.z * fz;
        },
    };
}
