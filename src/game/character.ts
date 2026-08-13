/**
 * 徒歩のキャラクター。rapier の KinematicCharacterController を使う。
 *
 * この街は勾配20%超の坂と擁壁・階段が多いので、
 *   - 登坂限界 52°（20%坂 = 11°なので余裕。擁壁の垂直面はきちんと止まる）
 *   - 自動スライドは 54° から（登れる坂で勝手に滑り落ちない・E17）
 *   - autostep で 0.45m までの段差（縁石・階段）を乗り越える
 *   - snap-to-ground で下り坂を飛ばずに追従する
 * を設定している。
 */
import * as RAPIER from '@dimforge/rapier3d-compat';
import { Vector3 } from 'three/webgpu';
import { ACTOR_GROUPS, type Physics } from './physics';

/** カプセル: 半径 + 円筒部の半分の高さ（全高 = (halfHeight + radius) * 2） */
const RADIUS = 0.3;
const HALF_HEIGHT = 0.6;
/** 足元からカプセル中心までの高さ[m] */
export const CHARACTER_CENTER_OFFSET = HALF_HEIGHT + RADIUS;
/** 全高[m] */
export const CHARACTER_HEIGHT = CHARACTER_CENTER_OFFSET * 2;

/**
 * 移動速度[m/s]（契約13-9 / 13-12 で既定を大幅に引き上げた）。
 * BASE = 既定（従来のダッシュ 5.2 の約2倍）。Shift・「歩く」ボタンで SLOW まで落とせる。
 * スタミナは無い（いくらでも走れる）。ここへ ⚡ の倍率（最大2倍）と
 * 韋駄天の地下足袋（×1.3）が掛かるので、最高速は約 27m/s になる
 */
const BASE_SPEED = 10.4;
const SLOW_SPEED = 1.9;
/** 速度の追従の速さ[1/s]。歩き出し・止まりを少しだけ鈍らせる */
const ACCEL = 14;
/**
 * 空中での追従の速さ[1/s]（契約13-13）。地上より鈍らせることで、踏み切ったときの
 * 水平速度が「走り幅跳び」として残る。0 にすると空中で一切曲がれないので、
 * 着地点を微調整できるぶんだけ残す
 */
const AIR_ACCEL = 5;
/** 向きの追従の速さ[rad/s] */
const TURN_RATE = 12;
const GRAVITY = 9.81;
/** 落下速度の上限[m/s] */
const MAX_FALL = 55;
/**
 * 接地中に地面へ押し付ける速度[m/s]（下り坂で浮かないように）。
 * 既定速度を上げた（契約13-12）ぶん、下り坂で足が離れないよう強めてある
 */
const GROUND_STICK = 6;
/**
 * 地面へ吸い付く距離[m]。1物理ステップ（1/60秒）で進む距離が最高速では 0.45m に
 * なるので、急な下り坂が段差扱いにならないよう広げてある（契約13-12）
 */
const SNAP_DISTANCE = 0.9;
/**
 * ジャンプの初速[m/s]（契約06 追記1 → 契約13-13 で強化）。
 * 到達高さ = v²/2g ≒ 2.0m。塀・生け垣を飛び越えられ、60cm の段差要件も当然満たす。
 * 滞空は 2v/g ≒ 1.28秒なので、既定速度 10.4m/s で踏み切れば 13m 跳ぶ。二段ジャンプはしない
 */
const JUMP_SPEED = 6.3;
/** 体当たりで押し飛ばす時間[s]（契約10）。この間だけ移動へ押し出しを上乗せする */
const KNOCKBACK_TIME = 0.28;
/** 通常の登坂限界[deg] と 自動スライドの開始角[deg] */
const SLOPE_CLIMB = 52;
const SLOPE_SLIDE = 54;
/** 韋駄天の地下足袋を持っているときの登坂限界[deg]（急坂で止まらない・契約11） */
const SLOPE_CLIMB_POWER = 72;
const SLOPE_SLIDE_POWER = 74;

export interface Character {
    collider: RAPIER.Collider;
    /** 描画用に補間したカプセル中心の位置 */
    readonly position: Vector3;
    /** 描画用の向き[rad] */
    readonly yaw: number;
    /** 水平方向の実速度[m/s] */
    readonly speed: number;
    readonly grounded: boolean;
    /** 物理ステップ1回ぶん進める。dir は**ワールド座標**の水平移動方向（長さ 0..1） */
    fixedUpdate(dt: number, dirX: number, dirZ: number, slow: boolean): void;
    /** 次の物理ステップで踏み切る（接地していなければ無視される = 二段ジャンプなし） */
    jump(): void;
    /** 描画位置を前ステップとの間で補間する */
    interpolate(alpha: number): void;
    teleport(x: number, y: number, z: number, yaw: number): void;
    setActive(active: boolean): void;
    /** 移動速度の倍率（安置の外での減速に使う・契約10）。1 = 等倍 */
    setSpeedScale(scale: number): void;
    /**
     * 体当たりで押し飛ばされる（契約10）。水平方向 (dirX, dirZ) へ distance[m] ぶんを
     * KNOCKBACK_TIME 秒かけて押し出す。壁があれば当然そこで止まる（移動は controller 経由）
     */
    knockback(dirX: number, dirZ: number, distance: number): void;
    /**
     * 空中での補助（契約11 のマント・傘）。接地していない間だけ効く。
     * sink  = 落下速度の上限[m/s]（0 = 通常の重力のまま）
     * speed = 水平の目標速度[m/s]（0 = 通常の歩き/走り）
     */
    setAirAssist(sink: number, speed: number): void;
    /** 韋駄天の地下足袋（契約11）。急坂でも登れる・滑り落ちない */
    setSlopePower(on: boolean): void;
    /** 物理上の現在位置（補間なし） */
    readonly current: Vector3;
}

export function createCharacter(physics: Physics, x: number, y: number, z: number, yaw: number): Character {
    const world = physics.world;
    const body = world.createRigidBody(
        RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(x, y, z),
    );
    const collider = world.createCollider(
        RAPIER.ColliderDesc.capsule(HALF_HEIGHT, RADIUS).setFriction(0.4).setCollisionGroups(ACTOR_GROUPS),
        body,
    );

    const controller = world.createCharacterController(0.02);
    controller.setUp({ x: 0, y: 1, z: 0 });
    controller.setSlideEnabled(true);
    controller.setMaxSlopeClimbAngle((SLOPE_CLIMB * Math.PI) / 180);
    controller.setMinSlopeSlideAngle((SLOPE_SLIDE * Math.PI) / 180);
    controller.enableAutostep(0.45, 0.2, true);
    controller.enableSnapToGround(SNAP_DISTANCE);
    controller.setApplyImpulsesToDynamicBodies(false);

    const current = new Vector3(x, y, z);
    const previous = current.clone();
    const position = current.clone();
    const velocity = new Vector3();
    const next = { x: 0, y: 0, z: 0 };

    let verticalVelocity = 0;
    let grounded = false;
    let jumpLatched = false;
    let snapped = true;
    let speed = 0;
    let facing = yaw;
    let previousFacing = yaw;
    let renderYaw = yaw;
    let active = true;
    let speedScale = 1;
    /** 押し出しの速度[m/s] と残り時間[s] */
    let pushX = 0;
    let pushZ = 0;
    let pushLeft = 0;
    /** 空中補助（契約11）。落下速度の上限[m/s] と 水平の目標速度[m/s]。0 = 無効 */
    let airSink = 0;
    let airSpeed = 0;
    let slopePower = false;

    return {
        collider,
        current,
        get position() {
            return position;
        },
        get yaw() {
            return renderYaw;
        },
        get speed() {
            return speed;
        },
        get grounded() {
            return grounded;
        },
        fixedUpdate(dt, dirX, dirZ, slow) {
            previous.copy(current);
            previousFacing = facing;
            if (!active) return;

            // 踏み切り。上りに転じている間は snap-to-ground を切らないと地面へ吸い戻される
            if (jumpLatched) {
                jumpLatched = false;
                if (grounded) {
                    verticalVelocity = JUMP_SPEED;
                    grounded = false;
                    controller.disableSnapToGround();
                    snapped = false;
                }
            }

            // 空中補助（マント・傘）は接地していない間だけ効かせる
            const gliding = !grounded && (airSink > 0 || airSpeed > 0);
            const wanted =
                gliding && airSpeed > 0 ? airSpeed : (slow ? SLOW_SPEED : BASE_SPEED) * speedScale;
            const length = Math.hypot(dirX, dirZ);
            const scale = length > 1 ? 1 / length : 1;
            // 滑空（マント・傘）は自前の速度で操るので従来どおりの効き。
            // ただの滞空中は AIR_ACCEL で鈍らせ、助走の勢いを残す（契約13-13）
            const factor = 1 - Math.exp(-(grounded || gliding ? ACCEL : AIR_ACCEL) * dt);
            velocity.x += (dirX * scale * wanted - velocity.x) * factor;
            velocity.z += (dirZ * scale * wanted - velocity.z) * factor;

            if (grounded && verticalVelocity <= 0) verticalVelocity = -GROUND_STICK;
            else verticalVelocity = Math.max(-MAX_FALL, verticalVelocity - GRAVITY * dt);
            // 落下速度の頭打ち（上昇中は触らない = 踏み切りの高さは変えない）
            if (gliding && airSink > 0 && verticalVelocity < -airSink) verticalVelocity = -airSink;

            next.x = velocity.x * dt;
            next.y = verticalVelocity * dt;
            next.z = velocity.z * dt;
            // 体当たりの押し出しは入力とは別に上乗せする（入力で打ち消せない）
            if (pushLeft > 0) {
                const span = Math.min(dt, pushLeft);
                next.x += pushX * span;
                next.z += pushZ * span;
                pushLeft -= dt;
            }
            controller.computeColliderMovement(collider, next);
            const movement = controller.computedMovement();
            grounded = controller.computedGrounded();
            if (grounded && !snapped) {
                controller.enableSnapToGround(SNAP_DISTANCE);
                snapped = true;
            }

            current.x += movement.x;
            current.y += movement.y;
            current.z += movement.z;
            body.setNextKinematicTranslation(current);

            // 実際に動けた量から速度を測る（壁に押し付けたときは 0 になる）
            speed = Math.hypot(movement.x, movement.z) / dt;
            if (length > 0.05) {
                // モデルは yaw=0 で -z を向く（カメラの前方向と同じ定義）
                const target = Math.atan2(-dirX, -dirZ);
                const diff = Math.atan2(Math.sin(target - facing), Math.cos(target - facing));
                facing += diff * Math.min(1, TURN_RATE * dt);
            }
        },
        jump() {
            jumpLatched = true;
        },
        interpolate(alpha) {
            position.lerpVectors(previous, current, alpha);
            const diff = Math.atan2(Math.sin(facing - previousFacing), Math.cos(facing - previousFacing));
            renderYaw = previousFacing + diff * alpha;
        },
        teleport(tx, ty, tz, tyaw) {
            current.set(tx, ty, tz);
            previous.copy(current);
            position.copy(current);
            velocity.set(0, 0, 0);
            verticalVelocity = 0;
            jumpLatched = false;
            pushLeft = 0;
            if (!snapped) {
                controller.enableSnapToGround(SNAP_DISTANCE);
                snapped = true;
            }
            facing = tyaw;
            previousFacing = tyaw;
            renderYaw = tyaw;
            body.setTranslation(current, true);
            body.setNextKinematicTranslation(current);
        },
        setActive(on) {
            active = on;
            collider.setEnabled(on);
            if (!on) {
                velocity.set(0, 0, 0);
                verticalVelocity = 0;
                speed = 0;
                pushLeft = 0;
            }
        },
        setSpeedScale(scale) {
            speedScale = Math.max(0.05, Math.min(4, scale));
        },
        setAirAssist(sink, speed) {
            airSink = Math.max(0, Math.min(60, sink));
            airSpeed = Math.max(0, Math.min(40, speed));
        },
        setSlopePower(on) {
            if (on === slopePower) return;
            slopePower = on;
            controller.setMaxSlopeClimbAngle(((on ? SLOPE_CLIMB_POWER : SLOPE_CLIMB) * Math.PI) / 180);
            controller.setMinSlopeSlideAngle(((on ? SLOPE_SLIDE_POWER : SLOPE_SLIDE) * Math.PI) / 180);
        },
        knockback(dirX, dirZ, distance) {
            const length = Math.hypot(dirX, dirZ);
            if (length < 1e-4 || distance <= 0) return;
            const speedOut = distance / KNOCKBACK_TIME;
            pushX = (dirX / length) * speedOut;
            pushZ = (dirZ / length) * speedOut;
            pushLeft = KNOCKBACK_TIME;
        },
    };
}
