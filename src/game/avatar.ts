/**
 * プレイヤーと車の見た目（プロシージャルな簡易モデル）。
 *
 * 後続のマルチプレイでは他プレイヤーぶんを同じ関数で増やせるよう、
 * 「位置・向き・状態を外から与えれば描ける」形にしてある（追記2-3）。
 * テクスチャは使わず、箱と円柱だけで作る（ロード時間とドローコールを増やさない）。
 */
import {
    BoxGeometry,
    CylinderGeometry,
    Group,
    Mesh,
    MeshStandardNodeMaterial,
    Object3D,
    SphereGeometry,
    Vector3,
    type BufferGeometry,
} from 'three/webgpu';
import type { QualitySettings } from '../quality';
import { CHASSIS_HALF, WHEEL_RADIUS } from './vehicle';

/** 歩行アニメの振り幅[rad] */
const SWING = 0.62;

export interface PlayerAvatar {
    group: Group;
    /** 足元の位置・向き・歩行速度[m/s] を与えて1フレーム進める */
    update(feet: Vector3, yaw: number, speed: number, dt: number): void;
    /** 服の色を差し替える（遠隔プレイヤーをピアごとに塗り分ける・契約05） */
    setColor(color: number): void;
}

export interface CarAvatar {
    group: Group;
    /** 車輪 i の（車体ローカルの）位置・操舵角・回転角を与える */
    setWheel(i: number, offset: Vector3, steering: number, rotation: number): void;
    /** 車体の色を差し替える */
    setColor(color: number): void;
}

function material(color: number, roughness: number, metalness = 0): MeshStandardNodeMaterial {
    return new MeshStandardNodeMaterial({ color, roughness, metalness });
}

function part(
    geometry: BufferGeometry,
    mat: MeshStandardNodeMaterial,
    x: number,
    y: number,
    z: number,
    quality: QualitySettings,
): Mesh {
    const mesh = new Mesh(geometry, mat);
    mesh.position.set(x, y, z);
    mesh.castShadow = quality.shadows;
    mesh.receiveShadow = true;
    return mesh;
}

/** yaw=0 で -z を向く（カメラ・キャラクターの向きの定義に合わせる） */
export function createPlayerAvatar(quality: QualitySettings): PlayerAvatar {
    const group = new Group();
    group.name = 'player';
    const cloth = material(0x2f5fa8, 0.85);
    const skin = material(0xd8a98a, 0.75);
    const dark = material(0x2a2f3a, 0.9);

    group.add(part(new BoxGeometry(0.44, 0.66, 0.26), cloth, 0, 1.2, 0, quality));
    group.add(part(new SphereGeometry(0.135, 14, 10), skin, 0, 1.65, 0, quality));
    // 顔の向きが分かるよう、前（-z）へ小さなつばを出す
    group.add(part(new BoxGeometry(0.2, 0.05, 0.1), dark, 0, 1.68, -0.14, quality));

    const limbs: Object3D[] = [];
    for (const side of [-1, 1]) {
        const shoulder = new Object3D();
        shoulder.position.set(side * 0.29, 1.45, 0);
        shoulder.add(part(new BoxGeometry(0.12, 0.54, 0.14), cloth, 0, -0.27, 0, quality));
        const hip = new Object3D();
        hip.position.set(side * 0.12, 0.88, 0);
        hip.add(part(new BoxGeometry(0.16, 0.86, 0.18), dark, 0, -0.43, 0, quality));
        group.add(shoulder, hip);
        limbs.push(shoulder, hip);
    }

    let phase = 0;
    return {
        group,
        update(feet, yaw, speed, dt) {
            group.position.copy(feet);
            group.rotation.y = yaw;
            // 歩幅がおよそ 0.8m になる位相速度
            phase += speed * dt * 3.6;
            const amount = Math.min(1, speed / 3.4) * SWING;
            const swing = Math.sin(phase) * amount;
            // 腕と脚は左右・前後で逆位相
            limbs[0].rotation.x = swing;
            limbs[1].rotation.x = -swing;
            limbs[2].rotation.x = -swing;
            limbs[3].rotation.x = swing;
            // 歩いている間だけわずかに上下する
            group.position.y += Math.abs(Math.sin(phase)) * amount * 0.04;
        },
        setColor(color) {
            cloth.color.setHex(color);
        },
    };
}

/** 車体は +z が正面（rapier の前方向軸に合わせる） */
export function createCarAvatar(quality: QualitySettings): CarAvatar {
    const group = new Group();
    group.name = 'car';
    const paint = material(0xb23b3b, 0.42, 0.35);
    const glass = material(0x1b2430, 0.15, 0.5);
    const trim = material(0x1a1c20, 0.8);
    const lamp = material(0xf2ead2, 0.3);
    const tail = material(0x8c1d1d, 0.4);

    const { x: hx, y: hy, z: hz } = CHASSIS_HALF;
    group.add(part(new BoxGeometry(hx * 2, hy * 2, hz * 2), paint, 0, 0, 0, quality));
    // キャビン（少し後ろ寄り）と窓
    group.add(part(new BoxGeometry(hx * 1.78, 0.52, hz * 0.92), paint, 0, hy + 0.26, -0.2, quality));
    group.add(part(new BoxGeometry(hx * 1.62, 0.34, hz * 0.86), glass, 0, hy + 0.34, -0.2, quality));
    // バンパー・ライト
    group.add(part(new BoxGeometry(hx * 1.9, 0.2, 0.14), trim, 0, -hy + 0.16, hz, quality));
    group.add(part(new BoxGeometry(hx * 1.9, 0.2, 0.14), trim, 0, -hy + 0.16, -hz, quality));
    for (const side of [-1, 1]) {
        group.add(part(new BoxGeometry(0.3, 0.14, 0.08), lamp, side * 0.52, hy - 0.16, hz, quality));
        group.add(part(new BoxGeometry(0.26, 0.12, 0.08), tail, side * 0.55, hy - 0.16, -hz, quality));
    }

    // 車輪: 軸を x にそろえた円柱。pivot で操舵、mesh で転がりを回す
    const tyre = new CylinderGeometry(WHEEL_RADIUS, WHEEL_RADIUS, 0.24, 16);
    tyre.rotateZ(Math.PI / 2);
    const rubber = material(0x14161a, 0.95);
    const pivots: Object3D[] = [];
    const spins: Object3D[] = [];
    for (let i = 0; i < 4; i++) {
        const pivot = new Object3D();
        const mesh = part(tyre, rubber, 0, 0, 0, quality);
        pivot.add(mesh);
        group.add(pivot);
        pivots.push(pivot);
        spins.push(mesh);
    }

    return {
        group,
        setWheel(i, offset, steering, rotation) {
            pivots[i].position.copy(offset);
            pivots[i].rotation.y = steering;
            spins[i].rotation.x = rotation;
        },
        setColor(color) {
            paint.color.setHex(color);
        },
    };
}
