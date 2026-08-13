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
/**
 * 自由落下の終端速度[m/s]（契約13-8 でやや抑えた）。
 * 前傾（スティック全倒し）でさらに DIVE_BRAKE ぶん落ちにくくなるので、
 * 「まっすぐ下」より「前へ滑る」ほうが得になる
 */
const TERMINAL = 48;
/**
 * 自由落下中の水平最高速度[m/s]（契約13-8 で強化）。
 * TERMINAL を上回るので、全倒しなら水平:垂直が 1:1 を超える
 */
const FALL_GLIDE = 58;
/** 前傾しきったときに終端速度へ掛かる係数（水平へ体重を預けるほど落ちにくい） */
const DIVE_BRAKE = 0.72;
/** パラシュート展開後の降下速度[m/s] */
const CANOPY_SINK = 6;
/** パラシュート展開後の水平速度[m/s]（契約13-8 で強化。傘でも狙って寄せられる） */
const CANOPY_GLIDE = 22;
/** 水平速度の追従の速さ[1/s]（落下中 / 傘）。契約13-8 で操作の効きを上げた */
const FALL_ACCEL = 3.2;
const CANOPY_ACCEL = 4.5;
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
    /** 機体から飛び降りる（ride 中のみ有効）。高度 110m で自動的に傘が開く */
    leave(): void;
    /**
     * その場から真上へ打ち上げて自由落下へ入る（六甲おろしのマント・契約15 追記10）。
     * **傘は開かない** — 落下中の水平:垂直 1.7:1 の滑空だけで着地点を決める。
     * y は打ち上げ後の高度[m]（足元の標高ではなく絶対高）
     */
    launch(x: number, y: number, z: number, yaw: number): void;
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
    /** 高度で傘を自動展開してよいか。マントの打ち上げ（追記10）では開かない */
    let canopyAllowed = true;

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
            canopyAllowed = true;
            // 機首方向へ少しだけ押し出す（真下に落ちて機体にめり込まないように）
            velocity.set(-Math.sin(yaw) * 12, -2, -Math.cos(yaw) * 12);
        },
        launch(x, y, z, startYaw) {
            state = 'fall';
            canopyAllowed = false;
            position.set(x, y, z);
            // 打ち上がりきった頂点から始める。上向きの初速は与えない —
            // 「打ち上げの演出」ではなく「そこから滑空する遊び」が本体（追記10）
            velocity.set(0, 0, 0);
            yaw = startYaw;
            pitch = 0;
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
                // 前傾（入力を倒しているほど）で終端速度が下がる = 水平へ伸びる（契約13-8）
                const lean = Math.min(1, length);
                const terminal = TERMINAL * (1 - (1 - DIVE_BRAKE) * lean);
                velocity.y = Math.max(-terminal, velocity.y - GRAVITY * dt);
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
            // 傘は高度で自動展開する（操作を1つ増やさない・ポップな傘は描画側の担当）。
            // マントの打ち上げでは開かない — 着地まで自分の滑空で決めさせる（追記10）
            if (!canopy && canopyAllowed && height < CANOPY_ALTITUDE) state = 'canopy';
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
