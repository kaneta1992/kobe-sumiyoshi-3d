/**
 * 徒歩・運転で共通の入力。キーボード / マウス / タッチを1つの状態にまとめる。
 *
 * 視点はマウスのポインタロック（クリックで掴む・Escで解除）を基本にし、
 * ロックできない場合とタッチではドラッグに落とす。どちらも movementX/Y を
 * 使うので下流は同じ扱いでよい。
 */
import { createTouchControls, type ControlMode, type TouchControls } from '../ui/touch';

export interface InputState {
    /** 右方向 -1..1 */
    moveX: number;
    /** 前方向 -1..1 */
    moveZ: number;
    /** 走る（徒歩）/ アクセル全開（運転） */
    run: boolean;
    /** ブレーキ・パーキングブレーキ（飛行中は上昇） */
    brake: boolean;
    /** 下降（飛行中のみ使う。Cキー） */
    down: boolean;
    /** ジャンプの押下（フレーム末に消費する） */
    jump: boolean;
    /** ジャンプを押しっぱなしか（マントの滑空・契約11。フレーム末に消さない） */
    jumpHeld: boolean;
    /** スーパーマンモードの切り替え押下（?superman のときだけ使う・フレーム末に消費） */
    toggleFly: boolean;
    /** 視点の相対移動[px]。フレーム末に消費する */
    lookX: number;
    lookY: number;
    /** 乗降の押下（フレーム末に消費する） */
    interact: boolean;
    /** リスポーン/姿勢リセットの押下（フレーム末に消費する） */
    respawn: boolean;
}

export interface Input {
    state: InputState;
    /** 毎フレーム頭に呼ぶ。キーの押下状態とタッチUIを state に反映する */
    beginFrame(): void;
    /** 毎フレーム末に呼ぶ。視点差分と押下エッジを消す */
    endFrame(): void;
    /**
     * ゲーム入力の一時停止（E49）。マップを開いている間は true にする。
     * 止めている間は state が中立のままで、キー・ドラッグ・タッチのどれも通さない
     */
    setSuspended(suspended: boolean): void;
    /** 乗降ボタンの表示を切り替える */
    setMode(mode: ControlMode): void;
    /** 乗降できる状態か（近くに車がある / 乗車中）をUIへ伝える */
    setInteractEnabled(enabled: boolean): void;
    readonly touch: TouchControls | null;
    dispose(): void;
}

/** 視点の感度[rad/px] */
const LOOK_SPEED = 0.0028;

const MOVE_KEYS: Record<string, [number, number]> = {
    KeyW: [0, 1],
    ArrowUp: [0, 1],
    KeyS: [0, -1],
    ArrowDown: [0, -1],
    KeyA: [-1, 0],
    ArrowLeft: [-1, 0],
    KeyD: [1, 0],
    ArrowRight: [1, 0],
};

export function createInput(element: HTMLElement): Input {
    const state: InputState = {
        moveX: 0,
        moveZ: 0,
        run: false,
        brake: false,
        down: false,
        jump: false,
        jumpHeld: false,
        toggleFly: false,
        lookX: 0,
        lookY: 0,
        interact: false,
        respawn: false,
    };
    const pressed = new Set<string>();
    const touch = createTouchControls();
    let dragPointer = -1;
    let keyRun = false;
    let keyBrake = false;
    let keyDown = false;
    let suspended = false;

    const onKeyDown = (e: KeyboardEvent): void => {
        if (suspended) return;
        if (e.code in MOVE_KEYS) {
            pressed.add(e.code);
            e.preventDefault();
        }
        if (e.repeat) return;
        if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') keyRun = true;
        if (e.code === 'Space') {
            // 徒歩ではジャンプ・運転ではブレーキ・飛行では上昇（下流で使い分ける）
            keyBrake = true;
            state.jump = true;
            e.preventDefault();
        }
        if (e.code === 'KeyC') keyDown = true;
        if (e.code === 'KeyG') state.toggleFly = true;
        if (e.code === 'KeyF' || e.code === 'KeyE') state.interact = true;
        if (e.code === 'KeyR') state.respawn = true;
    };
    const onKeyUp = (e: KeyboardEvent): void => {
        pressed.delete(e.code);
        if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') keyRun = false;
        if (e.code === 'Space') keyBrake = false;
        if (e.code === 'KeyC') keyDown = false;
    };

    // --- 視点 ---------------------------------------------------------------
    const locked = (): boolean => document.pointerLockElement === element;

    const onPointerDown = (e: PointerEvent): void => {
        if (suspended || e.button !== 0) return;
        if (e.pointerType === 'mouse' && !locked()) {
            // ロックできない環境（iPadOS 等）ではドラッグに落ちる
            void element.requestPointerLock?.();
        }
        dragPointer = e.pointerId;
        element.setPointerCapture(e.pointerId);
    };
    const onPointerMove = (e: PointerEvent): void => {
        if (suspended) return;
        if (!locked() && e.pointerId !== dragPointer) return;
        state.lookX += e.movementX ?? 0;
        state.lookY += e.movementY ?? 0;
    };
    const onPointerUp = (e: PointerEvent): void => {
        if (e.pointerId === dragPointer) dragPointer = -1;
    };

    const onBlur = (): void => {
        // 押しっぱなしのまま裏へ回らせない（E23）
        pressed.clear();
        keyRun = false;
        keyBrake = false;
        keyDown = false;
        dragPointer = -1;
    };

    element.addEventListener('pointerdown', onPointerDown);
    element.addEventListener('pointermove', onPointerMove);
    element.addEventListener('pointerup', onPointerUp);
    element.addEventListener('pointercancel', onPointerUp);
    element.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    document.addEventListener('pointerlockchange', onBlur);

    return {
        state,
        touch,
        beginFrame() {
            if (suspended) {
                // タッチUIの押下が溜まっていても、閉じた瞬間に暴発させない
                touch?.consumeInteract();
                touch?.consumeJump();
                state.jumpHeld = false;
                return;
            }
            let x = 0;
            let z = 0;
            for (const code of pressed) {
                const axis = MOVE_KEYS[code];
                if (!axis) continue;
                x += axis[0];
                z += axis[1];
            }
            state.moveX = Math.max(-1, Math.min(1, x));
            state.moveZ = Math.max(-1, Math.min(1, z));
            state.run = keyRun;
            state.brake = keyBrake;
            state.down = keyDown;
            // 徒歩では Space の押しっぱなしが「ジャンプ長押し」（運転中はブレーキ）
            state.jumpHeld = keyBrake;
            if (!touch) return;
            // タッチはキーボードに重ねる（両方ある端末でどちらも効く・E20）
            if (touch.stickX !== 0) state.moveX = touch.stickX;
            if (touch.stickZ !== 0) state.moveZ = touch.stickZ;
            if (touch.accel) state.run = true;
            if (touch.brake) state.brake = true;
            if (touch.consumeInteract()) state.interact = true;
            if (touch.consumeJump()) state.jump = true;
            if (touch.jumpHeld) state.jumpHeld = true;
        },
        endFrame() {
            state.lookX = 0;
            state.lookY = 0;
            state.interact = false;
            state.respawn = false;
            state.jump = false;
            state.toggleFly = false;
        },
        setSuspended(value) {
            if (suspended === value) return;
            suspended = value;
            if (!value) return;
            // 押しっぱなしを持ち越さず、視点も中立へ戻す。マウスを掴んだままでは
            // マップのボタンを押せないのでポインタロックも解く
            onBlur();
            state.moveX = 0;
            state.moveZ = 0;
            state.run = false;
            state.brake = false;
            state.down = false;
            state.jump = false;
            state.jumpHeld = false;
            state.toggleFly = false;
            state.lookX = 0;
            state.lookY = 0;
            state.interact = false;
            state.respawn = false;
            if (locked()) document.exitPointerLock();
        },
        setMode(mode) {
            touch?.setMode(mode);
        },
        setInteractEnabled(enabled) {
            touch?.setInteractEnabled(enabled);
        },
        dispose() {
            element.removeEventListener('pointerdown', onPointerDown);
            element.removeEventListener('pointermove', onPointerMove);
            element.removeEventListener('pointerup', onPointerUp);
            element.removeEventListener('pointercancel', onPointerUp);
            window.removeEventListener('keydown', onKeyDown);
            window.removeEventListener('keyup', onKeyUp);
            window.removeEventListener('blur', onBlur);
            document.removeEventListener('pointerlockchange', onBlur);
            touch?.dispose();
        },
    };
}

export { LOOK_SPEED };
