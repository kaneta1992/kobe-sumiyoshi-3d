/**
 * 三人称の追従カメラ。後方から見下ろし、マウス/スワイプで yaw・pitch を回す。
 *
 * 狭い路地・擁壁際でカメラが壁へ入り込まないよう、注視点からカメラ位置へ静的コライダーの
 * レイを飛ばして距離を詰める（E18）。詰めるのは即座・戻すのはゆっくりにして、
 * 塀の切れ目でカメラが跳ねないようにする。
 */
import { Vector3, type PerspectiveCamera } from 'three/webgpu';
import type { Physics } from './physics';

/** 見上げ / 見下ろしの限界[rad] */
const PITCH_MIN = -1.2;
const PITCH_MAX = 0.55;
/** 壁に当たったときにカメラを手前へ寄せる余白[m] */
const WALL_MARGIN = 0.4;
/** これ以上は寄らない[m] */
const MIN_DISTANCE = 0.9;

export interface FollowCamera {
    yaw: number;
    pitch: number;
    /** 視点操作[px] を加える */
    look(dx: number, dy: number, speed: number): void;
    /** 進行方向へゆっくり向き直す（運転中の自動整列） */
    alignTo(targetYaw: number, rate: number, dt: number): void;
    /** 追従先が飛んだとき（リスポーン・乗降）に補間を切る */
    snap(): void;
    /**
     * rate は注視点の追従の速さ[1/s]。既定（16）は徒歩・運転向けで、
     * 定常のずれは 速度/rate になる。降下のように速い落下ではここを上げないと
     * 対象が画面外へ流れる（契約10）
     */
    update(dt: number, target: Vector3, height: number, distance: number, rate?: number): void;
    /** 水平の前方向 */
    forward(out: Vector3): Vector3;
    /** 水平の右方向 */
    right(out: Vector3): Vector3;
}

/** 角度差を -π..π に畳む */
function wrapAngle(a: number): number {
    return Math.atan2(Math.sin(a), Math.cos(a));
}

export function createFollowCamera(camera: PerspectiveCamera, physics: Physics): FollowCamera {
    camera.rotation.order = 'YXZ';
    const focus = new Vector3();
    const dir = new Vector3();
    let smoothed: Vector3 | null = null;
    let distance = 6;

    return {
        yaw: 0,
        pitch: -0.24,
        look(dx, dy, speed) {
            this.yaw -= dx * speed;
            this.pitch = Math.max(PITCH_MIN, Math.min(PITCH_MAX, this.pitch - dy * speed));
        },
        alignTo(targetYaw, rate, dt) {
            const diff = wrapAngle(targetYaw - this.yaw);
            this.yaw += diff * Math.min(1, rate * dt);
        },
        snap() {
            smoothed = null;
        },
        forward(out) {
            return out.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
        },
        right(out) {
            return out.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
        },
        update(dt, target, height, wanted, rate = 16) {
            focus.copy(target);
            focus.y += height;
            if (!smoothed) smoothed = focus.clone();
            else smoothed.lerp(focus, 1 - Math.exp(-rate * dt));

            const cp = Math.cos(this.pitch);
            dir.set(-Math.sin(this.yaw) * cp, Math.sin(this.pitch), -Math.cos(this.yaw) * cp);

            // 注視点からカメラ側（-dir）へレイを飛ばし、壁があれば手前で止める
            const reach = physics.castStatic(
                smoothed.x,
                smoothed.y,
                smoothed.z,
                -dir.x,
                -dir.y,
                -dir.z,
                wanted + WALL_MARGIN,
            );
            const allowed = Math.max(MIN_DISTANCE, Math.min(wanted, reach - WALL_MARGIN));
            distance =
                allowed < distance ? allowed : distance + (allowed - distance) * (1 - Math.exp(-3.5 * dt));

            camera.position.copy(smoothed).addScaledVector(dir, -distance);
            camera.rotation.set(this.pitch, this.yaw, 0);
        },
    };
}
