/**
 * 遠隔プレイヤーの見た目（契約05 / 契約12）。avatar.ts の人型・車・ヘリ・イノシシを
 * そのまま使い、ピア（および BOT）ごとに「スロット」を割り当てて描く。
 *
 * ここはゴースト表示に徹する:
 *   - コライダーを一切作らない。位置の権威は各プレイヤー自身（BOT はホスト）にあり、
 *     こちらの物理とは干渉させない（車も人もすり抜ける）
 *   - スロットは使い回す。離脱のたびにジオメトリを作り直さない
 *     （フレームループでのアロケーションと、パイプライン再構築を避ける）
 *   - 乗り物ごとに出す物を1つに絞る。降りている相手の車は出さない
 *     （全員の車が同じ場所にスポーンするので、置くと重なるだけになる）
 *   - 人型・車・ヘリ・イノシシは**使われたスロットにだけ**作る（契約12: BOT8体で
 *     スロットが一気に埋まっても、要らない乗り物のジオメトリまでは作らない）
 *
 * 描画コールの規律（契約12・E92）: 人型はパーツごとに10メッシュあるので、8体が
 * 同時に見えると予算（mobile draw ≤ 100）を超える。近い数体だけをフル表示にし、
 * それ以外は1メッシュの簡易アバターへ落とす（near フラグは呼び側が距離で決める）。
 */
import { Vector3, type Scene } from 'three/webgpu';
import {
    BOAR_SEAT,
    DRIVER_SEAT,
    HELI_SEAT,
    createBoarAvatar,
    createCarAvatar,
    createHeliAvatar,
    createPlayerAvatar,
    createSimpleAvatar,
    type BoarAvatar,
    type CarAvatar,
    type HeliAvatar,
    type PlayerAvatar,
    type SimpleAvatar,
} from '../game/avatar';
import { WHEEL_RADIUS, WHEEL_REST_OFFSETS } from '../game/vehicle';
import type { QualitySettings } from '../quality';

/** 舵角の推定に使うホイールベース[m]（vehicle.ts の WHEEL_Z * 2） */
const WHEELBASE = 2.84;

/** 同期される移動状態（Snapshot.m）。0 徒歩 / 1 運転 / 2 ヘリ / 3 イノシシ騎乗 */
export const MODE_WALK = 0;
export const MODE_DRIVE = 1;
export const MODE_HELI = 2;
export const MODE_BOAR = 3;

interface Slot {
    used: boolean;
    color: number;
    /** 出番が来たときにだけ作る（作ったら使い回す） */
    player: PlayerAvatar | null;
    simple: SimpleAvatar | null;
    car: CarAvatar | null;
    heli: HeliAvatar | null;
    boar: BoarAvatar | null;
    /** いま出している乗り物（0 徒歩 / 1 車 / 2 ヘリ / 3 イノシシ） */
    mode: number;
    /** 人型をフル表示にしているか（false = 簡易アバター） */
    detailed: boolean;
    /** 車輪の回転角[rad]。車速から積分する（相手の車輪角は同期しない） */
    spin: number;
    /** 前フレームの yaw[rad]。舵角・バンクの推定に使う */
    yaw: number;
    hasYaw: boolean;
    /** 推定した舵角[rad]（12Hz の受信間隔でガタつかないよう平滑化する） */
    steer: number;
}

export interface RemotePlayers {
    /** 空きスロットを確保して番号を返す。上限に達していたら -1（描かないだけで接続は続く） */
    acquire(color: number): number;
    release(slot: number): void;
    /**
     * 補間済みの状態を1フレームぶん描く。mode は MODE_*（1..3 なら x,y,z,yaw は乗り物のもの）。
     * near=false のスロットは1メッシュの簡易アバターで描く（E92）
     */
    show(
        slot: number,
        mode: number,
        x: number,
        y: number,
        z: number,
        yaw: number,
        speed: number,
        dt: number,
        near: boolean,
    ): void;
    /** このフレームは描かない（遠すぎる・未受信） */
    hide(slot: number): void;
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

    const create = (): Slot => ({
        used: false,
        color: 0xffffff,
        player: null,
        simple: null,
        car: null,
        heli: null,
        boar: null,
        mode: MODE_WALK,
        detailed: false,
        spin: 0,
        yaw: 0,
        hasYaw: false,
        steer: 0,
    });

    // --- 遅延生成（ローカルのプレイヤー・車と同じ材質構成なのでパイプラインは使い回される） ---
    const playerOf = (slot: Slot): PlayerAvatar => {
        if (!slot.player) {
            slot.player = createPlayerAvatar(quality);
            slot.player.group.name = 'peer';
            slot.player.setColor(slot.color);
            scene.add(slot.player.group);
        }
        return slot.player;
    };
    const simpleOf = (slot: Slot): SimpleAvatar => {
        if (!slot.simple) {
            slot.simple = createSimpleAvatar(quality);
            slot.simple.setColor(slot.color);
            scene.add(slot.simple.group);
        }
        return slot.simple;
    };
    const carOf = (slot: Slot): CarAvatar => {
        if (!slot.car) {
            slot.car = createCarAvatar(quality);
            slot.car.group.name = 'peer-car';
            slot.car.setColor(slot.color);
            scene.add(slot.car.group);
        }
        return slot.car;
    };
    const heliOf = (slot: Slot): HeliAvatar => {
        if (!slot.heli) {
            slot.heli = createHeliAvatar(quality);
            slot.heli.group.name = 'peer-heli';
            slot.heli.setColor(slot.color);
            scene.add(slot.heli.group);
        }
        return slot.heli;
    };
    const boarOf = (slot: Slot): BoarAvatar => {
        if (!slot.boar) {
            slot.boar = createBoarAvatar(quality);
            slot.boar.group.name = 'peer-boar';
            scene.add(slot.boar.group);
        }
        return slot.boar;
    };

    /** 全部隠す（スロットの解放・表示の切り替え前に必ず通す） */
    const hideAll = (slot: Slot): void => {
        if (slot.player) slot.player.group.visible = false;
        if (slot.simple) slot.simple.group.visible = false;
        if (slot.car) slot.car.group.visible = false;
        if (slot.heli) slot.heli.group.visible = false;
        if (slot.boar) slot.boar.group.visible = false;
    };

    /**
     * 乗り物と人型の親子付けを切り替える（スロット再利用でも状態が残らないように・E37）。
     * 車・ヘリは座席へ人型をぶら下げる。イノシシは人型を場に置いたまま背に乗せる（E85）
     */
    const setMode = (slot: Slot, mode: number): void => {
        if (slot.mode === mode) return;
        const player = playerOf(slot);
        slot.mode = mode;
        if (mode === MODE_DRIVE) {
            carOf(slot).group.add(player.group);
            player.group.position.copy(DRIVER_SEAT);
            player.group.rotation.set(0, Math.PI, 0);
        } else if (mode === MODE_HELI) {
            heliOf(slot).group.add(player.group);
            player.group.position.copy(HELI_SEAT);
            player.group.rotation.set(0, Math.PI, 0);
        } else {
            scene.add(player.group);
            player.group.rotation.set(0, 0, 0);
        }
        player.setRiding(mode !== MODE_WALK);
    };

    const assign = (slot: Slot, color: number): void => {
        slot.used = true;
        slot.color = color;
        slot.spin = 0;
        slot.hasYaw = false;
        slot.detailed = false;
        setMode(slot, MODE_WALK);
        slot.player?.setColor(color);
        slot.simple?.setColor(color);
        slot.car?.setColor(color);
        slot.heli?.setColor(color);
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
            setMode(entry, MODE_WALK);
            hideAll(entry);
        },
        hide(slot) {
            const entry = slots[slot];
            if (entry) hideAll(entry);
        },
        show(slot, mode, x, y, z, yaw, speed, dt, near) {
            const entry = slots[slot];
            if (!entry || !entry.used) return;
            const step = Math.min(0.05, Math.max(0.0001, dt));

            // 遠いゴーストは1メッシュの簡易アバターで描く（描画コールを増やさない・E92）
            if (!near && mode === MODE_WALK) {
                if (entry.detailed || entry.mode !== MODE_WALK) setMode(entry, MODE_WALK);
                entry.detailed = false;
                hideAll(entry);
                const simple = simpleOf(entry);
                simple.group.visible = true;
                simple.group.position.set(x, y, z);
                simple.group.rotation.y = yaw;
                return;
            }
            entry.detailed = true;
            if (entry.simple) entry.simple.group.visible = false;

            setMode(entry, mode);
            const player = playerOf(entry);
            // 乗り物の子になっているときは、乗り物を消すと中の人も消える
            player.group.visible = true;
            if (entry.car) entry.car.group.visible = mode === MODE_DRIVE;
            if (entry.heli) entry.heli.group.visible = mode === MODE_HELI;
            if (entry.boar) entry.boar.group.visible = mode === MODE_BOAR;

            if (mode === MODE_DRIVE) {
                const car = carOf(entry);
                car.group.position.set(x, y, z);
                car.group.rotation.y = yaw;
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
                    car.setWheel(i, wheel, i < 2 ? steering : 0, entry.spin);
                }
                car.update(speed, steering, false, step);
                player.update(feet, yaw, speed, step);
                return;
            }

            if (mode === MODE_HELI) {
                const heli = heliOf(entry);
                heli.group.position.set(x, y, z);
                heli.group.rotation.y = yaw;
                // 姿勢は同期していない。速度と旋回から前傾・バンクを推定する
                let bank = 0;
                if (entry.hasYaw) {
                    const turn = Math.atan2(Math.sin(yaw - entry.yaw), Math.cos(yaw - entry.yaw)) / step;
                    bank = Math.max(-0.5, Math.min(0.5, turn * 0.5));
                }
                entry.yaw = yaw;
                entry.hasYaw = true;
                entry.steer += (bank - entry.steer) * (1 - Math.exp(-6 * step));
                heli.group.rotation.z = entry.steer;
                heli.group.rotation.x = Math.max(-0.35, Math.min(0.35, speed * 0.012));
                heli.update(1, step);
                player.update(feet, yaw, 0, step);
                return;
            }

            entry.hasYaw = false;
            if (mode === MODE_BOAR) {
                const boar = boarOf(entry);
                boar.group.position.set(x, y, z);
                boar.group.rotation.y = yaw;
                boar.update(speed, step);
                // 人型は場に置いたまま背へ乗せる（乗車ポーズだけ借りる）
                player.group.position.set(x, y + BOAR_SEAT.y, z);
                player.group.rotation.set(0, yaw, 0);
                player.update(feet, yaw, speed, step);
                return;
            }

            feet.set(x, y, z);
            player.update(feet, yaw, speed, step);
        },
        dispose() {
            for (const slot of slots) {
                if (slot.player) scene.remove(slot.player.group);
                if (slot.simple) scene.remove(slot.simple.group);
                if (slot.car) scene.remove(slot.car.group);
                if (slot.heli) scene.remove(slot.heli.group);
                if (slot.boar) scene.remove(slot.boar.group);
            }
            slots.length = 0;
        },
    };
}
