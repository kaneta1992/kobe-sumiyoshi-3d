/**
 * 遠隔プレイヤーの見た目（契約05）。avatar.ts の人型・車をそのまま使い、
 * ピアごとに「人型ひとつ＋車ひとつ」の組（スロット）を割り当てて描く。
 *
 * ここはゴースト表示に徹する:
 *   - コライダーを一切作らない。位置の権威は各プレイヤー自身にあり、
 *     こちらの物理とは干渉させない（車も人もすり抜ける）
 *   - スロットは使い回す。離脱のたびにジオメトリを作り直さない
 *     （フレームループでのアロケーションと、パイプライン再構築を避ける）
 *   - 徒歩なら人型、運転中なら車だけを出す。降りている相手の車は出さない
 *     （全員の車が同じ場所にスポーンするので、置くと重なるだけになる）
 */
import { Vector3, type Scene } from 'three/webgpu';
import {
    DRIVER_SEAT,
    createCarAvatar,
    createPlayerAvatar,
    type CarAvatar,
    type PlayerAvatar,
} from '../game/avatar';
import { WHEEL_RADIUS, WHEEL_REST_OFFSETS } from '../game/vehicle';
import type { QualitySettings } from '../quality';

/** 舵角の推定に使うホイールベース[m]（vehicle.ts の WHEEL_Z * 2） */
const WHEELBASE = 2.84;

interface Slot {
    player: PlayerAvatar;
    car: CarAvatar;
    used: boolean;
    /** 車輪の回転角[rad]。車速から積分する（相手の車輪角は同期しない） */
    spin: number;
    /** 乗車中か（人型を車の子にしているか） */
    riding: boolean;
    /** 前フレームの車体 yaw[rad]。舵角と車体ロールの推定に使う */
    yaw: number;
    hasYaw: boolean;
    /** 推定した舵角[rad]（12Hz の受信間隔でガタつかないよう平滑化する） */
    steer: number;
}

export interface RemotePlayers {
    /** 空きスロットを確保して番号を返す。上限に達していたら -1（描かないだけで接続は続く） */
    acquire(color: number): number;
    release(slot: number): void;
    /** 補間済みの状態を1フレームぶん描く。driving=true なら x,y,z,yaw は車体のもの */
    show(
        slot: number,
        driving: boolean,
        x: number,
        y: number,
        z: number,
        yaw: number,
        speed: number,
        dt: number,
    ): void;
    dispose(): void;
}

// フレームループで new を作らないための使い回し
const feet = new Vector3();
const wheel = new Vector3();

export function createRemotePlayers(
    scene: Scene,
    quality: QualitySettings,
    max: number,
): RemotePlayers {
    const slots: Slot[] = [];

    const create = (): Slot => {
        // ローカルのプレイヤー・車と同じ材質構成なので、描画パイプラインは使い回される
        const player = createPlayerAvatar(quality);
        const car = createCarAvatar(quality);
        player.group.name = 'peer';
        car.group.name = 'peer-car';
        player.group.visible = false;
        car.group.visible = false;
        scene.add(player.group, car.group);
        return { player, car, used: false, spin: 0, riding: false, yaw: 0, hasYaw: false, steer: 0 };
    };

    /** 乗車 / 降車で人型の親を付け替える（スロット再利用でも状態が残らないように・E37） */
    const setRiding = (slot: Slot, riding: boolean): void => {
        if (slot.riding === riding) return;
        slot.riding = riding;
        if (riding) {
            slot.car.group.add(slot.player.group);
            slot.player.group.position.copy(DRIVER_SEAT);
            slot.player.group.rotation.set(0, Math.PI, 0);
        } else {
            scene.add(slot.player.group);
            slot.player.group.rotation.set(0, 0, 0);
        }
        slot.player.setRiding(riding);
    };

    const assign = (slot: Slot, color: number): void => {
        slot.used = true;
        slot.spin = 0;
        slot.hasYaw = false;
        setRiding(slot, false);
        slot.player.setColor(color);
        slot.car.setColor(color);
    };

    return {
        acquire(color) {
            for (let i = 0; i < slots.length; i++) {
                if (slots[i].used) continue;
                assign(slots[i], color);
                return i;
            }
            if (slots.length >= max) return -1;
            const slot = create();
            assign(slot, color);
            slots.push(slot);
            return slots.length - 1;
        },
        release(slot) {
            const entry = slots[slot];
            if (!entry) return;
            entry.used = false;
            setRiding(entry, false);
            entry.player.group.visible = false;
            entry.car.group.visible = false;
        },
        show(slot, driving, x, y, z, yaw, speed, dt) {
            const entry = slots[slot];
            if (!entry || !entry.used) return;
            setRiding(entry, driving);
            // 乗車中は人型が車の子なので、車を消すと中の人も消える
            entry.player.group.visible = true;
            entry.car.group.visible = driving;
            const step = Math.min(0.05, Math.max(0.0001, dt));
            if (driving) {
                entry.car.group.position.set(x, y, z);
                entry.car.group.rotation.y = yaw;
                entry.spin += (speed / WHEEL_RADIUS) * step;
                // 舵角は同期していない。旋回の角速度から推定する（同期項目を増やさない）
                let target = 0;
                if (entry.hasYaw && Math.abs(speed) > 1) {
                    const turn = Math.atan2(Math.sin(yaw - entry.yaw), Math.cos(yaw - entry.yaw)) / step;
                    target = Math.max(-0.5, Math.min(0.5, Math.atan((turn * WHEELBASE) / speed)));
                }
                entry.yaw = yaw;
                entry.hasYaw = true;
                entry.steer += (target - entry.steer) * (1 - Math.exp(-9 * step));
                const steering = entry.steer;
                for (let i = 0; i < WHEEL_REST_OFFSETS.length; i++) {
                    const offset = WHEEL_REST_OFFSETS[i];
                    wheel.set(offset[0], offset[1], offset[2]);
                    entry.car.setWheel(i, wheel, i < 2 ? steering : 0, entry.spin);
                }
                entry.car.update(speed, steering, false, step);
                entry.player.update(feet, yaw, speed, step);
            } else {
                entry.hasYaw = false;
                feet.set(x, y, z);
                entry.player.update(feet, yaw, speed, step);
            }
        },
        dispose() {
            for (const slot of slots) scene.remove(slot.player.group, slot.car.group);
            slots.length = 0;
        },
    };
}
