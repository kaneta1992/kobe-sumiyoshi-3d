/**
 * 車両。rapier の DynamicRayCastVehicleController（レイキャスト式の4輪）。
 *
 * 坂の街なので次を優先している:
 *   - 4輪駆動（20%超の坂を登り切れる駆動力）
 *   - 重心を車体中心より下げて横転しにくくする
 *   - パーキングブレーキ（降車中・停車中は坂でも滑り落ちない・E17）
 * 車体は板と箱のプロシージャル形状で、見た目は avatar.ts が作る。
 */
import * as RAPIER from '@dimforge/rapier3d-compat';
import { Quaternion, Vector3 } from 'three/webgpu';
import { ACTOR_GROUPS, type Physics } from './physics';

/** 車体（コライダー）の半分の寸法[m]。全体で 1.5m 幅 × 4.1m 長 */
export const CHASSIS_HALF = { x: 0.75, y: 0.38, z: 2.05 };
export const WHEEL_RADIUS = 0.32;
/** 車輪の取り付け位置（車体ローカル。前輪 = +z 側）。車体の外側に出す */
const WHEEL_X = 0.78;
const WHEEL_Y = -0.3;
const WHEEL_Z = 1.42;
/** サスペンションの自然長[m] */
const SUSPENSION_REST = 0.28;
/** 車体原点から接地面までの高さ[m]（スポーン高さの計算に使う） */
export const VEHICLE_GROUND_OFFSET = -WHEEL_Y + SUSPENSION_REST + WHEEL_RADIUS;

const MASS = 1200;
/** 1輪あたりの最大駆動力[N]。4輪合計で 20% 勾配を余裕をもって登れる値 */
const ENGINE_FORCE = 2100;
const REVERSE_FORCE = 1100;
/** 1輪あたりのブレーキ（1ステップに与える力積の上限） */
const BRAKE = 45;
const PARKING_BRAKE = 900;
/** 最大操舵角[rad]と、高速時にそれを絞る係数 */
const MAX_STEER = 0.52;
const STEER_RATE = 3.4;
/** これ以上は加速しない[m/s] */
const MAX_SPEED = 24;
/** パーキングブレーキで完全に固定する速度のしきい値[m/s] */
const PARK_FREEZE_SPEED = 0.7;

export interface VehicleInput {
    /** 前後（-1..1）。+1 = 前進 */
    throttle: number;
    /** 操舵（-1..1）。+1 = 右 */
    steer: number;
    /** ブレーキ（パーキングブレーキ兼用） */
    brake: boolean;
}

export interface Vehicle {
    body: RAPIER.RigidBody;
    /** 描画用に補間した位置・姿勢 */
    readonly position: Vector3;
    readonly quaternion: Quaternion;
    /** 前後方向の速度[m/s]（負 = 後退） */
    readonly speed: number;
    /** 車の正面を向くカメラ yaw[rad]（カメラの前方向は -z 基準なので車体 yaw とは180°違う） */
    readonly viewYaw: number;
    /** 車体の yaw[rad]（ローカル +z が正面。reset に渡す値） */
    readonly bodyYaw: number;
    readonly occupied: boolean;
    setOccupied(occupied: boolean): void;
    fixedUpdate(dt: number, input: VehicleInput): void;
    interpolate(alpha: number): void;
    /** 姿勢を立て直して置き直す（横転・落下からの復帰・E24） */
    reset(x: number, y: number, z: number, yaw: number): void;
    /** 車輪の描画情報（i = 0:前左 1:前右 2:後左 3:後右） */
    wheelTransform(i: number, outOffset: Vector3): { steering: number; rotation: number };
    /** 乗降位置を決めるための車体ローカル→ワールド変換 */
    localToWorld(lx: number, ly: number, lz: number, out: Vector3): Vector3;
}

const WHEELS: readonly [number, number, number][] = [
    [WHEEL_X, WHEEL_Y, WHEEL_Z],
    [-WHEEL_X, WHEEL_Y, WHEEL_Z],
    [WHEEL_X, WHEEL_Y, -WHEEL_Z],
    [-WHEEL_X, WHEEL_Y, -WHEEL_Z],
];

export function createVehicle(physics: Physics, x: number, y: number, z: number, yaw: number): Vehicle {
    const world = physics.world;
    const spawnRotation = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), yaw);
    const body = world.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic()
            .setTranslation(x, y, z)
            .setRotation(spawnRotation)
            .setCcdEnabled(true)
            .setCanSleep(false)
            .setLinearDamping(0.05)
            .setAngularDamping(0.4),
    );
    // 重心を車体中心より 0.3m 下げる。慣性テンソルは直方体の値をそのまま使う
    body.setAdditionalMassProperties(
        MASS,
        { x: 0, y: -0.3, z: 0 },
        {
            x: (MASS / 12) * (4 * CHASSIS_HALF.y ** 2 + 4 * CHASSIS_HALF.z ** 2),
            y: (MASS / 12) * (4 * CHASSIS_HALF.x ** 2 + 4 * CHASSIS_HALF.z ** 2),
            z: (MASS / 12) * (4 * CHASSIS_HALF.x ** 2 + 4 * CHASSIS_HALF.y ** 2),
        },
        { x: 0, y: 0, z: 0, w: 1 },
        true,
    );
    world.createCollider(
        RAPIER.ColliderDesc.cuboid(CHASSIS_HALF.x, CHASSIS_HALF.y, CHASSIS_HALF.z)
            .setDensity(0)
            .setFriction(0.4)
            .setCollisionGroups(ACTOR_GROUPS),
        body,
    );

    const controller = world.createVehicleController(body);
    for (const [wx, wy, wz] of WHEELS) {
        controller.addWheel(
            { x: wx, y: wy, z: wz },
            { x: 0, y: -1, z: 0 },
            { x: -1, y: 0, z: 0 },
            SUSPENSION_REST,
            WHEEL_RADIUS,
        );
    }
    // サスペンション定数は bullet 由来の無次元値（内部で車体質量が掛かる。実測: 剛性 k で
    // 静的な沈み込みは g/(4k) になる）。k=40 で約 6cm 沈む乗用車らしい足まわりにする
    for (let i = 0; i < WHEELS.length; i++) {
        controller.setWheelSuspensionStiffness(i, 40);
        controller.setWheelSuspensionCompression(i, 4.4);
        controller.setWheelSuspensionRelaxation(i, 2.8);
        controller.setWheelMaxSuspensionTravel(i, 0.18);
        controller.setWheelMaxSuspensionForce(i, 60000);
        controller.setWheelFrictionSlip(i, 2.4);
        controller.setWheelSideFrictionStiffness(i, 0.9);
    }

    const position = new Vector3(x, y, z);
    const quaternion = spawnRotation.clone();
    const current = position.clone();
    const previous = position.clone();
    const currentRotation = spawnRotation.clone();
    const previousRotation = spawnRotation.clone();
    const forward = new Vector3();
    const zero = { x: 0, y: 0, z: 0 };
    const hold = { x: 0, y: 0, z: 0 };

    let steering = 0;
    let speed = 0;
    let occupied = false;
    let upsideDownFor = 0;

    /**
     * 剛体の姿勢を読む。fixedUpdate の先頭（= 直前ステップ後の状態）で previous に、
     * ステップ後の interpolate で current に取り込むことで、補間が常に
     * 「最後の1ステップの間」になる
     */
    const readTransform = (into: Vector3, intoRotation: Quaternion): void => {
        const t = body.translation();
        const r = body.rotation();
        into.set(t.x, t.y, t.z);
        intoRotation.set(r.x, r.y, r.z, r.w);
    };

    const groundedWheels = (): number => {
        let count = 0;
        for (let i = 0; i < WHEELS.length; i++) if (controller.wheelIsInContact(i)) count++;
        return count;
    };

    const bodyYawOf = (): number => {
        forward.set(0, 0, 1).applyQuaternion(currentRotation);
        return Math.atan2(forward.x, forward.z);
    };

    const resetTo = (rx: number, ry: number, rz: number, ryaw: number): void => {
        const rotation = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), ryaw);
        body.setTranslation({ x: rx, y: ry, z: rz }, true);
        body.setRotation(rotation, true);
        body.setLinvel(zero, true);
        body.setAngvel(zero, true);
        current.set(rx, ry, rz);
        previous.copy(current);
        position.copy(current);
        currentRotation.copy(rotation);
        previousRotation.copy(rotation);
        quaternion.copy(rotation);
        steering = 0;
        speed = 0;
        upsideDownFor = 0;
    };

    return {
        body,
        get position() {
            return position;
        },
        get quaternion() {
            return quaternion;
        },
        get speed() {
            return speed;
        },
        get viewYaw() {
            return bodyYawOf() + Math.PI;
        },
        get bodyYaw() {
            return bodyYawOf();
        },
        get occupied() {
            return occupied;
        },
        setOccupied(value) {
            occupied = value;
        },
        fixedUpdate(dt, input) {
            readTransform(previous, previousRotation);
            current.copy(previous);
            currentRotation.copy(previousRotation);

            // 前後速度は剛体の速度を正面（ローカル +z）へ射影して自前で出す。
            // rapier の currentVehicleSpeed() は符号が安定しない（実測でステップごとに反転する）
            forward.set(0, 0, 1).applyQuaternion(currentRotation);
            const velocity = body.linvel();
            speed = velocity.x * forward.x + velocity.y * forward.y + velocity.z * forward.z;
            // 速度に応じて舵角を絞る（高速でハンドルを切りすぎない）
            const limit = MAX_STEER * (1 - Math.min(1, Math.abs(speed) / MAX_SPEED) * 0.62);
            const target = Math.max(-limit, Math.min(limit, -input.steer * limit));
            steering += Math.max(-STEER_RATE * dt, Math.min(STEER_RATE * dt, target - steering));

            // 進行方向は駆動力だけで決める（入力と逆向きに走っていてもブレーキで駆動を殺さない。
            // 殺すと坂道発進で下がり続けて復帰できなくなる）。明示的な減速は Space のブレーキ
            const idle = Math.abs(input.throttle) < 0.02;
            let engine = 0;
            if (!input.brake && Math.abs(speed) < MAX_SPEED) {
                engine = input.throttle > 0 ? input.throttle * ENGINE_FORCE : input.throttle * REVERSE_FORCE;
            }
            // 停車中・降車中は坂で滑り落ちないよう強く効かせる（E17）
            const parking = !occupied || (idle && Math.abs(speed) < 1.2);
            const brakeForce = input.brake ? BRAKE : parking ? PARKING_BRAKE : 0;

            for (let i = 0; i < WHEELS.length; i++) {
                controller.setWheelEngineForce(i, engine);
                controller.setWheelBrake(i, brakeForce);
                if (i < 2) controller.setWheelSteering(i, steering);
            }
            controller.updateVehicle(dt);

            // ブレーキの力積だけでは坂で微速に流れ続けるので、停止直前は水平成分を止める。
            // 上下方向はサスペンションが車高を決めるので触らない（触ると車が沈んだまま固まる）
            if (parking && Math.abs(speed) < PARK_FREEZE_SPEED && groundedWheels() >= 3) {
                const velocity = body.linvel();
                if (velocity.x !== 0 || velocity.z !== 0) {
                    hold.x = 0;
                    hold.y = velocity.y;
                    hold.z = 0;
                    body.setLinvel(hold, false);
                }
            }

            // 横転したまま戻れない状態が続いたら自力で起こす（E24）
            forward.set(0, 1, 0).applyQuaternion(currentRotation);
            upsideDownFor = forward.y < 0.15 && groundedWheels() < 2 ? upsideDownFor + dt : 0;
            if (upsideDownFor > 2.5) resetTo(current.x, current.y + 1.2, current.z, bodyYawOf());
        },
        interpolate(alpha) {
            readTransform(current, currentRotation);
            position.lerpVectors(previous, current, alpha);
            quaternion.slerpQuaternions(previousRotation, currentRotation, alpha);
        },
        reset: resetTo,
        wheelTransform(i, outOffset) {
            const connection = controller.wheelChassisConnectionPointCs(i);
            const length = controller.wheelSuspensionLength(i) ?? SUSPENSION_REST;
            outOffset.set(connection?.x ?? 0, (connection?.y ?? 0) - length, connection?.z ?? 0);
            return {
                steering: controller.wheelSteering(i) ?? 0,
                rotation: controller.wheelRotation(i) ?? 0,
            };
        },
        localToWorld(lx, ly, lz, out) {
            return out.set(lx, ly, lz).applyQuaternion(currentRotation).add(current);
        },
    };
}
