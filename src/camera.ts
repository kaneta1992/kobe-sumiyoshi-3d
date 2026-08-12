/**
 * 簡易フライカメラ（ドラッグで視点回転 + WASD で移動）。
 * 徒歩・車両の操作は後続タスクが担当するので、ここでは見回し確認用に留める。
 */
import { PerspectiveCamera, Vector3 } from 'three/webgpu';

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
