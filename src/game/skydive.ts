/**
 * スカイダイビング（契約10 の降下）。輸送機に搭乗 → 自由落下 → パラシュート → 着地。
 *
 * スーパーマン飛行（契約06）と同じく物理から切り離して位置を直接動かす。
 * 落下中に見るのは足場の高さだけで、建物の側面とは当たらない（E66）。
 * 屋根の上に降りられるよう、着地の判定には道路・建物の上面を拾う足場高さを使う。
 *
 * 輸送機の経路そのものはシードから決まるマッチ側の持ち物で、ここは
 * 「毎フレーム渡される座席の姿勢に張り付く」だけにしてある。
 */
import { Vector3 } from 'three/webgpu';
import { AREA_HALF } from '../config';

export type SkyState = 'off' | 'ride' | 'fall' | 'canopy';

/** 自由落下の重力[m/s²]（実物より軽くして落ちる時間を稼ぐ） */
const GRAVITY = 16;
/** 自由落下の終端速度[m/s] */
const TERMINAL = 62;
/** 自由落下中の水平最高速度[m/s] */
const FALL_GLIDE = 36;
/** パラシュート展開後の降下速度[m/s] */
const CANOPY_SINK = 7;
/** パラシュート展開後の水平速度[m/s] */
const CANOPY_GLIDE = 14;
/** 水平速度の追従の速さ[1/s]（落下中 / 傘） */
const FALL_ACCEL = 1.5;
const CANOPY_ACCEL = 3;
/** 足場からこの高さで自動的に傘が開く[m] */
const CANOPY_ALTITUDE = 110;
/** 傘を開くときに縦速度を殺す速さ[1/s] */
const CANOPY_BRAKE = 6;
/** 着地とみなす足場からの高さ[m] */
const LAND_HEIGHT = 0.2;
/** 向きの追従の速さ[1/s] */
const TURN_RATE = 5;

export interface Skydive {
    readonly state: SkyState;
    /** 描画・カメラが使う現在位置（足元） */
    readonly position: Vector3;
    readonly yaw: number;
    /** 進行方向の仰角[rad]（アバターの姿勢に使う。負 = 下向き） */
    readonly pitch: number;
    /**
     * 輸送機の座席へ座らせる。off から呼べば搭乗開始。
     * 搭乗中は毎フレーム機体側の姿勢を渡すこと（位置は完全に上書きされる）
     */
    ride(x: number, y: number, z: number, yaw: number): void;
    /** 機体から飛び降りる（ride 中のみ有効） */
    leave(): void;
    /**
     * 1フレーム進める。dirX/dirZ はワールド水平の移動方向（長さ 0..1）。
     * surfaceY は現在位置の足場の高さ。着地したら true を返す
     */
    update(dt: number, dirX: number, dirZ: number, surfaceY: number): boolean;
    /** 強制終了（リマッチ・離脱時） */
    stop(): void;
}

export function createSkydive(): Skydive {
    const position = new Vector3();
    const velocity = new Vector3();
    let state: SkyState = 'off';
    let yaw = 0;
    let pitch = 0;

    return {
        get state() {
            return state;
        },
        position,
        get yaw() {
            return yaw;
        },
        get pitch() {
            return pitch;
        },
        ride(x, y, z, seatYaw) {
            if (state === 'fall' || state === 'canopy') return;
            state = 'ride';
            position.set(x, y, z);
            // 機体の進行方向をそのまま初速にしておくと、飛び降りた瞬間に前へ放り出される
            velocity.set(0, 0, 0);
            yaw = seatYaw;
            pitch = 0;
        },
        leave() {
            if (state !== 'ride') return;
            state = 'fall';
            // 機首方向へ少しだけ押し出す（真下に落ちて機体にめり込まないように）
            velocity.set(-Math.sin(yaw) * 12, -2, -Math.cos(yaw) * 12);
        },
        update(dt, dirX, dirZ, surfaceY) {
            if (state === 'off' || state === 'ride') return false;

            const canopy = state === 'canopy';
            const wantedSpeed = canopy ? CANOPY_GLIDE : FALL_GLIDE;
            const accel = canopy ? CANOPY_ACCEL : FALL_ACCEL;
            const factor = 1 - Math.exp(-accel * dt);
            const length = Math.hypot(dirX, dirZ);
            const scale = length > 1 ? 1 / length : 1;
            velocity.x += (dirX * scale * wantedSpeed - velocity.x) * factor;
            velocity.z += (dirZ * scale * wantedSpeed - velocity.z) * factor;

            if (canopy) {
                velocity.y += (-CANOPY_SINK - velocity.y) * (1 - Math.exp(-CANOPY_BRAKE * dt));
            } else {
                velocity.y = Math.max(-TERMINAL, velocity.y - GRAVITY * dt);
            }

            position.addScaledVector(velocity, dt);
            // エリアの外へは出さない（外は地形も建物も無い）
            const limit = AREA_HALF - 8;
            position.x = Math.max(-limit, Math.min(limit, position.x));
            position.z = Math.max(-limit, Math.min(limit, position.z));

            const speed = Math.hypot(velocity.x, velocity.z);
            if (speed > 0.6) {
                // モデルは yaw=0 で -z を向く
                const target = Math.atan2(-velocity.x, -velocity.z);
                const diff = Math.atan2(Math.sin(target - yaw), Math.cos(target - yaw));
                yaw += diff * Math.min(1, TURN_RATE * dt);
            }
            pitch = Math.atan2(velocity.y, Math.max(speed, 1));

            const height = position.y - surfaceY;
            // 傘は高度で自動展開する（操作を1つ増やさない・ポップな傘は描画側の担当）
            if (!canopy && height < CANOPY_ALTITUDE) state = 'canopy';
            if (height <= LAND_HEIGHT) {
                position.y = surfaceY;
                return true;
            }
            return false;
        },
        stop() {
            state = 'off';
            velocity.set(0, 0, 0);
            pitch = 0;
        },
    };
}
