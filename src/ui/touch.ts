/**
 * スマホ用のタッチUI（左バーチャルスティック + 右のボタン）。契約13-1 で全面見直し。
 *
 * 表示の出し分け（E20 / 契約13-1 のバグ修正）:
 *   「最後に使った入力デバイス」に従う。**本物のタッチ（touchstart）でだけ出し、
 *   マウスを使った瞬間に引っ込める**。以前は pointerdown を見ていたため、
 *   マウスのドラッグでもタッチUIが出ることがあった。
 *   粗いポインタしか無い端末（= スマホ・タブレット）では最初から出す。
 *
 * 配置（契約13-1）:
 *   - 親指の到達圏へ寄せる（左下スティック・右下ボタン。どちらも下端 + セーフエリア）
 *   - 当たり判定はボタン本体より広い（padding ぶんの透明な余白を持たせる）
 *   - 押し間違いを避けるためボタン同士の間隔を空け、回収ボタン表示中はジャンプを隠す（E94）
 *
 * 実装は pointer events のみ。スティックとボタンは canvas より上の DOM なので、
 * ここで受けたポインタは視点ドラッグ（canvas 側のハンドラ）へは流れない。
 */

/** 'heli' はヘリ操縦中、'boar' はイノシシ騎乗中（契約12） */
export type ControlMode = 'walk' | 'drive' | 'heli' | 'boar';

export interface TouchControls {
    /** スティックの倒し量（-1..1）。x = 右 / z = 前 */
    readonly stickX: number;
    readonly stickZ: number;
    /** 徒歩では「歩く」（契約13-9 で既定が全力になったので、ボタンは減速側） */
    readonly accel: boolean;
    readonly brake: boolean;
    /** 乗降ボタンの押下を1回ぶん取り出す */
    consumeInteract(): boolean;
    /** ジャンプボタンの押下を1回ぶん取り出す（徒歩のときだけ出る） */
    consumeJump(): boolean;
    /** ジャンプボタンを押しっぱなしか（マントの滑空・契約11） */
    readonly jumpHeld: boolean;
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
    const face = document.createElement('div');
    face.className = 'touch-face';
    face.textContent = label;
    el.appendChild(face);
    return el;
}

function setLabel(el: HTMLDivElement, label: string): void {
    const face = el.firstElementChild;
    if (face) face.textContent = label;
}

export function createTouchControls(): TouchControls | null {
    const hasTouch = navigator.maxTouchPoints > 0 || window.matchMedia?.('(any-pointer: coarse)').matches;
    if (!hasTouch) return null;

    const root = document.createElement('div');
    root.id = 'touch-ui';
    // 粗いポインタしか無い端末（スマホ）は最初から出す。マウスもある端末では
    // 本物のタッチがあるまで隠しておく
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
    const accelButton = button('歩く', 'touch-accel');
    const brakeButton = button('ブレーキ', 'touch-brake');
    const jumpButton = button('ジャンプ', 'touch-jump');
    // 2×2 の塊にする（CSS で row-reverse + wrap-reverse）。DOM の先頭ほど右下 =
    // いちばん親指が届く位置になるので、よく押す順に並べる（契約13-1）
    buttons.append(jumpButton, accelButton, interactButton, brakeButton);

    // 起動時は徒歩。ブレーキボタンは運転中だけ・ジャンプボタンは徒歩のときだけ出す
    brakeButton.classList.add('hidden');
    root.append(stickBase, buttons);
    document.body.appendChild(root);

    const state = { stickX: 0, stickZ: 0, accel: false, brake: false, jumpHeld: false };
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
    // ジャンプは押した瞬間に1回ぶんだけ出す（押しっぱなしで連続ジャンプしない）。
    // 押しっぱなしかどうかは別に持つ（マントの滑空・契約11）
    jumpButton.addEventListener('pointerdown', (e) => {
        jumpPressed = true;
        state.jumpHeld = true;
        jumpButton.setPointerCapture(e.pointerId);
        jumpButton.classList.add('active');
        e.preventDefault();
    });
    const jumpUp = (): void => {
        state.jumpHeld = false;
        jumpButton.classList.remove('active');
    };
    jumpButton.addEventListener('pointerup', jumpUp);
    jumpButton.addEventListener('pointercancel', jumpUp);
    jumpButton.addEventListener('pointerleave', jumpUp);
    jumpButton.addEventListener('lostpointercapture', jumpUp);

    // --- 表示デバイスの追従（契約13-1 のバグ修正） ---
    // touchstart は本物の指でしか飛ばない。pointerdown の pointerType は環境によって
    // 'touch' に化けることがあるので、出す条件はこちらを正とする
    const onTouchStart = (): void => root.classList.remove('hidden');
    /** マウス（実ポインタ）を使ったら引っ込める。指を離した直後の合成イベントは無視する */
    const onMouse = (e: PointerEvent): void => {
        if (e.pointerType !== 'mouse') return;
        if (stickPointer >= 0) return;
        root.classList.add('hidden');
        onBlur();
    };
    if (!coarseOnly) {
        window.addEventListener('touchstart', onTouchStart, { capture: true, passive: true });
        window.addEventListener('pointerdown', onMouse, { capture: true });
        window.addEventListener('pointermove', onMouse, { capture: true });
    }

    const onBlur = (): void => {
        releaseStick();
        state.accel = false;
        state.brake = false;
        state.jumpHeld = false;
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
        get jumpHeld() {
            return state.jumpHeld;
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
            const heli = mode === 'heli';
            const onBoard = mode !== 'walk';
            setLabel(interactButton, onBoard ? '降りる' : '乗る');
            // 徒歩の既定が全力になったので、このボタンは「歩く（ゆっくり）」（契約13-9）
            setLabel(accelButton, mode === 'drive' ? 'アクセル' : heli ? 'ブースト' : '歩く');
            // ヘリはコレクティブ（上昇/下降）を Space・C と同じボタンへ割り当てる
            setLabel(brakeButton, heli ? '上昇' : 'ブレーキ');
            setLabel(jumpButton, heli ? '下降' : 'ジャンプ');
            brakeButton.classList.toggle('hidden', mode !== 'drive' && !heli);
            jumpButton.classList.toggle('hidden', mode === 'drive' || mode === 'boar');
        },
        setInteractEnabled(enabled) {
            interactButton.classList.toggle('disabled', !enabled);
        },
        dispose() {
            window.removeEventListener('blur', onBlur);
            window.removeEventListener('touchstart', onTouchStart, { capture: true });
            window.removeEventListener('pointerdown', onMouse, { capture: true });
            window.removeEventListener('pointermove', onMouse, { capture: true });
            root.remove();
        },
    };
}
