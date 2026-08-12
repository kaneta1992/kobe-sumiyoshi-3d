/**
 * スマホ用のタッチUI（左バーチャルスティック + 右のボタン）。
 *
 * 表示の出し分け（E20）: タッチ点を持つ端末でだけ作る。マウスとタッチの両方がある
 * 端末（Surface 等）では「最初にタッチで触った時点」で出す。キーボード・マウス操作は
 * 出しても殺さないので、どちらでも破綻しない。
 *
 * 実装は pointer events のみ。スティックとボタンは canvas より上の DOM なので、
 * ここで受けたポインタは視点ドラッグ（canvas 側のハンドラ）へは流れない。
 */

export type ControlMode = 'walk' | 'drive';

export interface TouchControls {
    /** スティックの倒し量（-1..1）。x = 右 / z = 前 */
    readonly stickX: number;
    readonly stickZ: number;
    /** アクセル（徒歩では「走る」） */
    readonly accel: boolean;
    readonly brake: boolean;
    /** 乗降ボタンの押下を1回ぶん取り出す */
    consumeInteract(): boolean;
    /** ジャンプボタンの押下を1回ぶん取り出す（徒歩のときだけ出る） */
    consumeJump(): boolean;
    setMode(mode: ControlMode): void;
    /** 乗降ボタンを押せる状態か（近くに車がある / 乗車中）を伝える */
    setInteractEnabled(enabled: boolean): void;
    dispose(): void;
}

/** スティックのデッドゾーン（指のわずかなブレで歩き出さない） */
const DEADZONE = 0.16;

function button(label: string, extraClass: string): HTMLDivElement {
    const el = document.createElement('div');
    el.className = `touch-button ${extraClass}`;
    el.textContent = label;
    return el;
}

export function createTouchControls(): TouchControls | null {
    const hasTouch = navigator.maxTouchPoints > 0 || window.matchMedia?.('(any-pointer: coarse)').matches;
    if (!hasTouch) return null;

    const root = document.createElement('div');
    root.id = 'touch-ui';
    // マウス専用機からの誤表示を避けるため、粗いポインタしか無い端末以外は
    // 最初のタッチまで隠しておく
    const coarseOnly = !(window.matchMedia?.('(any-pointer: fine)').matches ?? false);
    if (!coarseOnly) root.classList.add('hidden');

    const stickBase = document.createElement('div');
    stickBase.className = 'touch-stick';
    const knob = document.createElement('div');
    knob.className = 'touch-knob';
    stickBase.appendChild(knob);

    const buttons = document.createElement('div');
    buttons.className = 'touch-buttons';
    const interactButton = button('乗る', 'touch-interact');
    const accelButton = button('走る', 'touch-accel');
    const brakeButton = button('ブレーキ', 'touch-brake');
    const jumpButton = button('ジャンプ', 'touch-jump');
    buttons.append(brakeButton, jumpButton, accelButton, interactButton);

    // 起動時は徒歩。ブレーキボタンは運転中だけ・ジャンプボタンは徒歩のときだけ出す
    brakeButton.classList.add('hidden');
    root.append(stickBase, buttons);
    document.body.appendChild(root);

    const state = { stickX: 0, stickZ: 0, accel: false, brake: false };
    let interactPressed = false;
    let jumpPressed = false;
    let stickPointer = -1;

    const updateStick = (e: PointerEvent): void => {
        const rect = stickBase.getBoundingClientRect();
        const radius = rect.width / 2;
        let dx = (e.clientX - (rect.left + radius)) / radius;
        let dz = -(e.clientY - (rect.top + radius)) / radius;
        const len = Math.hypot(dx, dz);
        if (len > 1) {
            dx /= len;
            dz /= len;
        }
        state.stickX = Math.abs(dx) < DEADZONE ? 0 : dx;
        state.stickZ = Math.abs(dz) < DEADZONE ? 0 : dz;
        knob.style.transform = `translate(${dx * radius * 0.42}px, ${-dz * radius * 0.42}px)`;
    };
    const releaseStick = (): void => {
        stickPointer = -1;
        state.stickX = 0;
        state.stickZ = 0;
        knob.style.transform = 'translate(0px, 0px)';
    };

    const onStickDown = (e: PointerEvent): void => {
        stickPointer = e.pointerId;
        stickBase.setPointerCapture(e.pointerId);
        updateStick(e);
        e.preventDefault();
    };
    const onStickMove = (e: PointerEvent): void => {
        if (e.pointerId !== stickPointer) return;
        updateStick(e);
    };
    const onStickUp = (e: PointerEvent): void => {
        if (e.pointerId !== stickPointer) return;
        releaseStick();
    };
    stickBase.addEventListener('pointerdown', onStickDown);
    stickBase.addEventListener('pointermove', onStickMove);
    stickBase.addEventListener('pointerup', onStickUp);
    stickBase.addEventListener('pointercancel', onStickUp);
    // 指を失った（ブラウザのジェスチャに取られた等）ときも必ず中立へ戻す。
    // これが無いとスティックが倒れっぱなしになり、キーボード入力も上書きし続ける
    stickBase.addEventListener('lostpointercapture', onStickUp);

    /** 押している間だけ true になるボタン */
    const bindHold = (el: HTMLElement, set: (down: boolean) => void): void => {
        const down = (e: PointerEvent): void => {
            el.setPointerCapture(e.pointerId);
            el.classList.add('active');
            set(true);
            e.preventDefault();
        };
        const up = (): void => {
            el.classList.remove('active');
            set(false);
        };
        el.addEventListener('pointerdown', down);
        el.addEventListener('pointerup', up);
        el.addEventListener('pointercancel', up);
        el.addEventListener('pointerleave', up);
        el.addEventListener('lostpointercapture', up);
    };
    bindHold(accelButton, (down) => (state.accel = down));
    bindHold(brakeButton, (down) => (state.brake = down));
    interactButton.addEventListener('pointerdown', (e) => {
        if (interactButton.classList.contains('disabled')) return;
        interactPressed = true;
        interactButton.classList.add('active');
        e.preventDefault();
    });
    const interactUp = (): void => interactButton.classList.remove('active');
    interactButton.addEventListener('pointerup', interactUp);
    interactButton.addEventListener('pointercancel', interactUp);
    // ジャンプは押した瞬間に1回ぶんだけ出す（押しっぱなしで連続ジャンプしない）
    jumpButton.addEventListener('pointerdown', (e) => {
        jumpPressed = true;
        jumpButton.classList.add('active');
        e.preventDefault();
    });
    const jumpUp = (): void => jumpButton.classList.remove('active');
    jumpButton.addEventListener('pointerup', jumpUp);
    jumpButton.addEventListener('pointercancel', jumpUp);
    jumpButton.addEventListener('pointerleave', jumpUp);

    // マウス機でも最初にタッチしたら出す（E20）
    const onFirstTouch = (e: PointerEvent): void => {
        if (e.pointerType !== 'touch') return;
        root.classList.remove('hidden');
        window.removeEventListener('pointerdown', onFirstTouch);
    };
    if (!coarseOnly) window.addEventListener('pointerdown', onFirstTouch, { capture: true });

    const onBlur = (): void => {
        releaseStick();
        state.accel = false;
        state.brake = false;
        accelButton.classList.remove('active');
        brakeButton.classList.remove('active');
        jumpButton.classList.remove('active');
    };
    window.addEventListener('blur', onBlur);

    return {
        get stickX() {
            return state.stickX;
        },
        get stickZ() {
            return state.stickZ;
        },
        get accel() {
            return state.accel;
        },
        get brake() {
            return state.brake;
        },
        consumeInteract() {
            const value = interactPressed;
            interactPressed = false;
            return value;
        },
        consumeJump() {
            const value = jumpPressed;
            jumpPressed = false;
            return value;
        },
        setMode(mode) {
            const driving = mode === 'drive';
            interactButton.textContent = driving ? '降りる' : '乗る';
            accelButton.textContent = driving ? 'アクセル' : '走る';
            brakeButton.classList.toggle('hidden', !driving);
            jumpButton.classList.toggle('hidden', driving);
        },
        setInteractEnabled(enabled) {
            interactButton.classList.toggle('disabled', !enabled);
        },
        dispose() {
            window.removeEventListener('blur', onBlur);
            window.removeEventListener('pointerdown', onFirstTouch, { capture: true });
            root.remove();
        },
    };
}
