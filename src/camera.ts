/**
 * 簡易フライカメラ（ドラッグで視点回転 + WASD で移動）と、
 * 画作りレビュー用の定点カメラ `?shot=1..6`（契約07）。
 */
import { PerspectiveCamera, Vector3 } from 'three/webgpu';
import { AREA_HALF } from './config';

const KEY_AXIS: Record<string, [number, number, number]> = {
    KeyW: [0, 0, 1],
    ArrowUp: [0, 0, 1],
    KeyS: [0, 0, -1],
    ArrowDown: [0, 0, -1],
    KeyA: [-1, 0, 0],
    ArrowLeft: [-1, 0, 0],
    KeyD: [1, 0, 0],
    ArrowRight: [1, 0, 0],
    Space: [0, 1, 0],
    KeyE: [0, 1, 0],
    KeyQ: [0, -1, 0],
    KeyC: [0, -1, 0],
};

/** 渦森橋の中心（docs/data-spec.md §4 / SKILL.md）。橋の景観レビュー用 */
const UZUMORI_BRIDGE = { x: 82, z: 132 };
/** 定点カメラの数（?shot=1..SHOT_COUNT） */
export const SHOT_COUNT = 6;

export interface ShotView {
    eye: Vector3;
    target: Vector3;
    label: string;
}

export interface ShotWorld {
    spawn: { x: number; z: number; dirX: number; dirZ: number };
    getElevationAt(x: number, z: number): number;
    minElevation: number;
    maxElevation: number;
}

/** ?shot の値。範囲外・未指定なら 0（定点カメラを使わない） */
export function shotIndex(): number {
    const raw = Number(new URLSearchParams(location.search).get('shot'));
    return Number.isInteger(raw) && raw >= 1 && raw <= SHOT_COUNT ? raw : 0;
}

/**
 * その定点に固有の時刻[h]。null なら ?hour（既定15時）のまま。
 * 太陽光の色・強さは環境の構築時に読むので、ワールドの読み込みより前に決める必要がある
 */
export function shotHour(index: number): number | null {
    return index === 4 ? 17.5 : null;
}

/** 地表の起伏から「いちばん高い尾根」を粗く探す（山肌の森の定点に使う） */
function findPeak(world: ShotWorld): { x: number; z: number; y: number } {
    let best = { x: 0, z: 0, y: -Infinity };
    for (let z = -AREA_HALF + 60; z < AREA_HALF - 60; z += 40) {
        for (let x = -AREA_HALF + 60; x < AREA_HALF - 60; x += 40) {
            const y = world.getElevationAt(x, z);
            if (y > best.y) best = { x, z, y };
        }
    }
    return best;
}

/** 橋の周りをぐるりと見て、いちばん低い方位（= 谷筋）を返す */
function valleyAzimuth(world: ShotWorld, cx: number, cz: number, radius: number): number {
    let bestAngle = 0;
    let bestY = Infinity;
    for (let i = 0; i < 32; i++) {
        const a = (i / 32) * Math.PI * 2;
        const y = world.getElevationAt(cx + Math.cos(a) * radius, cz + Math.sin(a) * radius);
        if (y < bestY) {
            bestY = y;
            bestAngle = a;
        }
    }
    return bestAngle;
}

/**
 * 定点カメラの視点。画作りのレビューを同じ構図で回すためのもので、
 * 操作系・物理には触らない（カメラ行列だけを毎フレーム上書きする・E59）。
 */
export function shotView(index: number, world: ShotWorld): ShotView | null {
    const spawn = world.spawn;
    const groundAt = (x: number, z: number): number => world.getElevationAt(x, z);
    // スポーン地点の道の進行方向と、その直交方向
    const dx = spawn.dirX;
    const dz = spawn.dirZ;

    switch (index) {
        case 1:
        case 4: {
            // ①④ スポーン地点の街路。歩行者の目線で道なりに見る
            const ex = spawn.x - dx * 7;
            const ez = spawn.z - dz * 7;
            return {
                eye: new Vector3(ex, groundAt(ex, ez) + 1.72, ez),
                target: new Vector3(
                    spawn.x + dx * 45,
                    groundAt(spawn.x + dx * 45, spawn.z + dz * 45) + 3.4,
                    spawn.z + dz * 45,
                ),
                label: index === 4 ? '夕方の街路' : 'スポーン地点の街路',
            };
        }
        case 2: {
            // ② 俯瞰全景。市街地から六甲山麓の稜線までを1枚に収める
            const peak = findPeak(world);
            return {
                eye: new Vector3(peak.x + 260, world.maxElevation + 430, peak.z + 1250),
                target: new Vector3(peak.x - 60, world.minElevation + 160, peak.z - 120),
                label: '俯瞰全景',
            };
        }
        case 3: {
            // ③ 山肌の森。斜面の下から林を見上げる（近景の樹木と稜線が同時に入る画角）
            const peak = findPeak(world);
            const ex = peak.x + 30;
            const ez = peak.z + 330;
            return {
                eye: new Vector3(ex, groundAt(ex, ez) + 9, ez),
                target: new Vector3(peak.x + 10, peak.y - 26, peak.z + 130),
                label: '山肌の森',
            };
        }
        case 5: {
            // ⑤ キャラクター + 車のクローズアップ。車はスポーン地点の 9m 先に出る
            const mx = spawn.x + dx * 4.4;
            const mz = spawn.z + dz * 4.4;
            // 道からはみ出すと建物に潜るので、横へは少しだけ振って斜め後ろから寄る
            const ex = spawn.x - dx * 4.2 - dz * 2.4;
            const ez = spawn.z - dz * 4.2 + dx * 2.4;
            return {
                eye: new Vector3(ex, groundAt(ex, ez) + 1.85, ez),
                target: new Vector3(mx, groundAt(mx, mz) + 0.85, mz),
                label: 'キャラクターと車',
            };
        }
        case 6: {
            // ⑥ 渦森橋の側面（谷側から見上げる）。橋の景観レビュー用
            const { x, z } = UZUMORI_BRIDGE;
            const deck = groundAt(x, z);
            const a = valleyAzimuth(world, x, z, 95);
            const ex = x + Math.cos(a) * 95;
            const ez = z + Math.sin(a) * 95;
            return {
                eye: new Vector3(ex, groundAt(ex, ez) + 16, ez),
                target: new Vector3(x, deck + 12, z),
                label: '渦森橋の側面',
            };
        }
        default:
            return null;
    }
}

export interface FlyCamera {
    update(dt: number): void;
    setView(position: Vector3, target: Vector3): void;
    dispose(): void;
}

export function createFlyCamera(camera: PerspectiveCamera, element: HTMLElement): FlyCamera {
    camera.rotation.order = 'YXZ';
    let yaw = camera.rotation.y;
    let pitch = camera.rotation.x;
    let speed = 60;
    let boosting = false;
    let dragging = false;
    let pointerId = -1;
    const pressed = new Set<string>();
    const forward = new Vector3();
    const right = new Vector3();
    const move = new Vector3();

    const onPointerDown = (e: PointerEvent): void => {
        if (e.button !== 0) return;
        dragging = true;
        pointerId = e.pointerId;
        element.setPointerCapture(e.pointerId);
    };
    const onPointerMove = (e: PointerEvent): void => {
        if (!dragging || e.pointerId !== pointerId) return;
        yaw -= e.movementX * 0.0025;
        pitch -= e.movementY * 0.0025;
        pitch = Math.max(-Math.PI / 2 + 0.02, Math.min(Math.PI / 2 - 0.02, pitch));
    };
    const onPointerUp = (e: PointerEvent): void => {
        if (e.pointerId !== pointerId) return;
        dragging = false;
        pointerId = -1;
    };
    const onKeyDown = (e: KeyboardEvent): void => {
        if (e.code in KEY_AXIS) {
            pressed.add(e.code);
            e.preventDefault();
        }
        if (e.shiftKey) boosting = true;
    };
    const onKeyUp = (e: KeyboardEvent): void => {
        pressed.delete(e.code);
        if (!e.shiftKey) boosting = false;
    };
    const onWheel = (e: WheelEvent): void => {
        speed = Math.max(5, Math.min(1200, speed * (e.deltaY > 0 ? 0.85 : 1.18)));
        e.preventDefault();
    };
    const onBlur = (): void => {
        pressed.clear();
        boosting = false;
        dragging = false;
    };

    element.addEventListener('pointerdown', onPointerDown);
    element.addEventListener('pointermove', onPointerMove);
    element.addEventListener('pointerup', onPointerUp);
    element.addEventListener('pointercancel', onPointerUp);
    element.addEventListener('wheel', onWheel, { passive: false });
    element.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);

    return {
        update(dt) {
            camera.rotation.set(pitch, yaw, 0);
            move.set(0, 0, 0);
            for (const code of pressed) {
                const axis = KEY_AXIS[code];
                move.x += axis[0];
                move.y += axis[1];
                move.z += axis[2];
            }
            if (move.lengthSq() === 0) return;
            camera.getWorldDirection(forward);
            right.crossVectors(forward, camera.up).normalize();
            const step = speed * (boosting ? 5 : 1) * dt;
            camera.position.addScaledVector(forward, move.z * step);
            camera.position.addScaledVector(right, move.x * step);
            camera.position.y += move.y * step;
        },
        setView(position, target) {
            camera.position.copy(position);
            const dir = target.clone().sub(position).normalize();
            pitch = Math.asin(Math.max(-1, Math.min(1, dir.y)));
            yaw = Math.atan2(-dir.x, -dir.z);
            camera.rotation.set(pitch, yaw, 0);
        },
        dispose() {
            element.removeEventListener('pointerdown', onPointerDown);
            element.removeEventListener('pointermove', onPointerMove);
            element.removeEventListener('pointerup', onPointerUp);
            element.removeEventListener('pointercancel', onPointerUp);
            element.removeEventListener('wheel', onWheel);
            window.removeEventListener('keydown', onKeyDown);
            window.removeEventListener('keyup', onKeyUp);
            window.removeEventListener('blur', onBlur);
        },
    };
}
