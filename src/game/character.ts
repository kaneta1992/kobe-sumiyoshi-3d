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

const WALK_SPEED = 1.9;
const RUN_SPEED = 5.2;
/** 速度の追従の速さ[1/s]。歩き出し・止まりを少しだけ鈍らせる */
const ACCEL = 14;
/** 向きの追従の速さ[rad/s] */
const TURN_RATE = 12;
const GRAVITY = 9.81;
/** 落下速度の上限[m/s] */
const MAX_FALL = 55;
/** 接地中に地面へ押し付ける速度[m/s]（下り坂で浮かないように） */
const GROUND_STICK = 2;

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
    fixedUpdate(dt: number, dirX: number, dirZ: number, run: boolean): void;
    /** 描画位置を前ステップとの間で補間する */
    interpolate(alpha: number): void;
    teleport(x: number, y: number, z: number, yaw: number): void;
    setActive(active: boolean): void;
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
    controller.setMaxSlopeClimbAngle((52 * Math.PI) / 180);
    controller.setMinSlopeSlideAngle((54 * Math.PI) / 180);
    controller.enableAutostep(0.45, 0.2, true);
    controller.enableSnapToGround(0.5);
    controller.setApplyImpulsesToDynamicBodies(false);

    const current = new Vector3(x, y, z);
    const previous = current.clone();
    const position = current.clone();
    const velocity = new Vector3();
    const next = { x: 0, y: 0, z: 0 };

    let verticalVelocity = 0;
    let grounded = false;
    let speed = 0;
    let facing = yaw;
    let previousFacing = yaw;
    let renderYaw = yaw;
    let active = true;

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
        fixedUpdate(dt, dirX, dirZ, run) {
            previous.copy(current);
            previousFacing = facing;
            if (!active) return;

            const wanted = run ? RUN_SPEED : WALK_SPEED;
            const length = Math.hypot(dirX, dirZ);
            const scale = length > 1 ? 1 / length : 1;
            const factor = 1 - Math.exp(-ACCEL * dt);
            velocity.x += (dirX * scale * wanted - velocity.x) * factor;
            velocity.z += (dirZ * scale * wanted - velocity.z) * factor;

            if (grounded && verticalVelocity <= 0) verticalVelocity = -GROUND_STICK;
            else verticalVelocity = Math.max(-MAX_FALL, verticalVelocity - GRAVITY * dt);

            next.x = velocity.x * dt;
            next.y = verticalVelocity * dt;
            next.z = velocity.z * dt;
            controller.computeColliderMovement(collider, next);
            const movement = controller.computedMovement();
            grounded = controller.computedGrounded();

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
            }
        },
    };
}
