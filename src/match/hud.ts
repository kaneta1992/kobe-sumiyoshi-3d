/**
 * マッチのUI（契約10 / 契約13-1,3,6）。DOM だけで作る — ポストプロセスの外なので
 * 色が転ばない（E41）。
 *
 * 出すもの:
 *   状態行   画面上部の1行。フェーズ・残り時間・いまの目標（契約13-1 で1行に集約）
 *   効果行   状態行の下。速度倍率・地図の切れ端・効いているアイテムの残り時間
 *   実況     状態行の下に数秒だけ出るテキスト
 *   トースト フェーズ遷移の大きめの告知（契約13-6）
 *   回収UI   PC は「E: 回収」、モバイルは画面下中央の大きな回収ボタン（契約13-3）
 *   矢印     尋ね人ステッキ・千里眼の指す方角（画面下中央・契約11）
 *   端矢印   安置の外にいるときだけ出る「安置はこっち」の画面端インジケータ（契約13-6）
 *   アイテム 所持2枠。クリック/タップか 1・2 キーで使う（契約11・E78）
 *   ビネット 安置の外にいる間の赤い縁（減速していることを体で分かるように）
 *   パネル   ロビー / リザルト（ボタン付き）
 *
 * **目標（宝箱・鍵）の方向を無償で出すことはしない**（契約13 追記の裁定）。
 * 方角を出してよいのは「安置の外にいるときの安置中心」と「アイテムの効果」だけ。
 *
 * CSS は index.html 側にある。ここは中身の作成と文字列の差し替えだけを持つ。
 */

/** 実況が消えるまで[s] */
const NEWS_HOLD = 5;
/** フェーズ遷移トーストが消えるまで[s] */
const TOAST_HOLD = 4.5;

export interface PanelButton {
    label: string;
    onClick(): void;
}

export interface PanelSpec {
    title: string;
    /** 本文（1行1要素） */
    lines: readonly string[];
    /** 見出しの色（勝者のピア色など）。省略時は既定色 */
    color?: string;
    /** 押せるボタン。無ければ出さない */
    button?: PanelButton | null;
    /** メインボタンの上に出す設定トグル（ロビーの BOT あり/なし・契約13-2） */
    toggle?: PanelButton | null;
    /** ボタンの下に出す小さな注記 */
    note?: string;
}

/** 回収UI の1件（契約13-3）。null で消える */
export interface ActionView {
    /** 対象の絵記号 */
    mark: string;
    /** 対象の名前（「宝箱」「鍵」「韋駄天の地下足袋」） */
    target: string;
    /** true = 押しっぱなしで進むチャンネリング（宝箱） */
    hold: boolean;
    /** hold のときの進捗 0..1。それ以外は負 */
    progress: number;
}

/** 所持スロット1枠の表示（契約11）。null = 空 */
export interface SlotView {
    /** 絵記号 */
    mark: string;
    name: string;
    /** 「使用」/「常時」 */
    note: string;
}

export interface MatchHud {
    /** 上部の状態行（毎フレーム呼んでよい。同じ文字列なら DOM を触らない） */
    setStatus(text: string): void;
    /** 状態行の下の効果行（空文字で消える・契約11） */
    setBadge(text: string): void;
    /** 所持2枠（契約11）。毎フレーム呼んでよい。中身が変わったときだけ DOM を触る */
    setSlots(first: SlotView | null, second: SlotView | null): void;
    /**
     * 尋ね人ステッキの方角（契約11）。angle は画面基準[rad]（0 = 画面上）。
     * null で消える
     */
    setArrow(angle: number | null, label: string): void;
    /**
     * 安置の外にいるときだけ出す画面端インジケータ（契約13-6）。
     * angle は画面基準[rad]（0 = 画面上）。null で消える
     */
    setEdgeArrow(angle: number | null, label: string): void;
    /** 実況。同じ文なら出し直さない */
    announce(text: string): void;
    /** フェーズ遷移の大きめトースト（契約13-6）。同じ文なら出し直さない */
    toast(text: string): void;
    /**
     * 回収UI（契約13-3）。PC は「E: 回収」、モバイルは大きなボタン。
     * null で消える。毎フレーム呼んでよい（中身が変わったときだけ DOM を触る）
     */
    setAction(view: ActionView | null): void;
    /** 回収ボタン（または E キー）を押しっぱなしか */
    readonly actionHeld: boolean;
    /** 回収の押下を1回ぶん取り出す（押しっぱなしでは1回しか出ない） */
    consumeActionPress(): boolean;
    /** 宝箱チャンネリングの進捗（0..1）。0 未満で非表示 */
    setChannel(progress: number): void;
    /** 安置の外の赤いビネット（0..1） */
    setVignette(level: number): void;
    /** ロビー / リザルトのパネル。null で閉じる */
    showPanel(panel: PanelSpec | null): void;
    update(dt: number): void;
    dispose(): void;
}

function div(className: string): HTMLDivElement {
    const el = document.createElement('div');
    el.className = className;
    return el;
}

/**
 * onSlot はアイテム枠を押したときに呼ばれる（0 か 1）。キーボードの 1・2 は
 * director 側が拾うので、ここはクリック/タップだけを見る
 */
export function createMatchHud(onSlot?: (index: number) => void): MatchHud {
    const root = div('match-root');
    root.id = 'match-ui';

    const vignette = div('match-vignette');
    const top = div('match-top');
    const status = div('match-status');
    const badge = div('match-badge');
    badge.classList.add('hidden');
    const news = div('match-news');
    top.append(status, badge, news);

    // --- フェーズ遷移トースト（契約13-6。実況より大きく・画面中央やや上） ---
    const toastEl = div('match-toast');
    toastEl.classList.add('hidden');

    // --- 尋ね人ステッキの方角矢印 ---
    const arrow = div('match-arrow');
    const arrowDial = div('match-arrow-dial');
    arrowDial.textContent = '➤';
    const arrowLabel = div('match-arrow-label');
    arrow.append(arrowDial, arrowLabel);
    arrow.classList.add('hidden');

    // --- 安置の外にいるときの画面端インジケータ（契約13-6） ---
    const edge = div('match-edge');
    const edgeDial = div('match-edge-dial');
    edgeDial.textContent = '➤';
    const edgeLabel = div('match-edge-label');
    edge.append(edgeDial, edgeLabel);
    edge.classList.add('hidden');

    // --- 回収UI（契約13-3。PC は文字・モバイルは大きなボタン。同じ要素で両対応） ---
    const action = div('match-action');
    const actionKey = div('match-action-key');
    actionKey.textContent = 'E';
    const actionMark = div('match-action-mark');
    const actionLabel = div('match-action-label');
    const actionRing = div('match-action-ring');
    action.append(actionRing, actionKey, actionMark, actionLabel);
    action.classList.add('hidden');

    // --- 所持2枠（E78: 既存のタッチボタン群と重ならない画面下中央に置く） ---
    const slotRow = div('match-slots');
    const slotEls: HTMLDivElement[] = [];
    const slotMarks: HTMLDivElement[] = [];
    const slotNames: HTMLDivElement[] = [];
    const slotNotes: HTMLDivElement[] = [];
    for (let i = 0; i < 2; i++) {
        const slot = div('match-slot empty');
        const key = div('match-slot-key');
        key.textContent = String(i + 1);
        const mark = div('match-slot-mark');
        const name = div('match-slot-name');
        const note = div('match-slot-note');
        slot.append(key, mark, name, note);
        slot.addEventListener('pointerdown', (e) => {
            e.preventDefault();
            e.stopPropagation();
            onSlot?.(i);
        });
        slotRow.appendChild(slot);
        slotEls.push(slot);
        slotMarks.push(mark);
        slotNames.push(name);
        slotNotes.push(note);
    }

    const channel = div('match-channel');
    const channelFill = div('match-channel-fill');
    const channelLabel = div('match-channel-label');
    channelLabel.textContent = '宝箱を開けている…（動くと中断）';
    channel.append(channelFill, channelLabel);
    channel.classList.add('hidden');

    const panel = div('match-panel');
    const panelTitle = div('match-panel-title');
    const panelBody = div('match-panel-body');
    const panelToggle = document.createElement('button');
    panelToggle.className = 'match-panel-toggle';
    const panelButton = document.createElement('button');
    panelButton.className = 'match-panel-button';
    const panelNote = div('match-panel-note');
    panel.append(panelTitle, panelBody, panelToggle, panelButton, panelNote);
    panel.classList.add('hidden');

    root.append(vignette, top, toastEl, edge, arrow, action, slotRow, channel, panel);
    document.body.appendChild(root);

    let statusText = '';
    let badgeText = '';
    /** スロットの中身のキャッシュ（毎フレーム DOM を組み直さない） */
    const slotKeys = ['', ''];
    let arrowShown = false;
    let arrowLabelText = '';
    let edgeShown = false;
    let edgeLabelText = '';
    let newsText = '';
    let newsLeft = 0;
    let toastText = '';
    let toastLeft = 0;
    let vignetteLevel = -1;
    let channelShown = false;
    let onButton: (() => void) | null = null;
    let onToggle: (() => void) | null = null;
    /** 回収UI の現在の中身（毎フレーム DOM を組み直さないためのキャッシュ） */
    let actionKeyText = '';
    let actionShown = false;
    let actionPointer = false;
    let actionKeyDown = false;
    let actionPressed = false;

    panelButton.addEventListener('click', (e) => {
        e.preventDefault();
        onButton?.();
    });
    panelToggle.addEventListener('click', (e) => {
        e.preventDefault();
        onToggle?.();
    });

    // --- 回収の入力（契約13-3） ---
    const actionDown = (e: PointerEvent): void => {
        if (!actionShown) return;
        e.preventDefault();
        e.stopPropagation();
        action.setPointerCapture(e.pointerId);
        actionPointer = true;
        actionPressed = true;
        action.classList.add('active');
    };
    const actionUp = (): void => {
        actionPointer = false;
        action.classList.remove('active');
    };
    action.addEventListener('pointerdown', actionDown);
    action.addEventListener('pointerup', actionUp);
    action.addEventListener('pointercancel', actionUp);
    action.addEventListener('lostpointercapture', actionUp);
    /**
     * E キーは回収に使う。対象があるときだけ横取りして、乗車（F/E）へは流さない
     * （車の隣のアイテムを拾おうとして乗り込んでしまうのを防ぐ・E99）
     */
    const onActionKeyDown = (e: KeyboardEvent): void => {
        if (!actionShown || e.code !== 'KeyE') return;
        e.preventDefault();
        e.stopPropagation();
        if (e.repeat) return;
        actionKeyDown = true;
        actionPressed = true;
        action.classList.add('active');
    };
    const onActionKeyUp = (e: KeyboardEvent): void => {
        if (e.code !== 'KeyE') return;
        actionKeyDown = false;
        if (!actionPointer) action.classList.remove('active');
    };
    window.addEventListener('keydown', onActionKeyDown, { capture: true });
    window.addEventListener('keyup', onActionKeyUp, { capture: true });
    const onActionBlur = (): void => {
        actionKeyDown = false;
        actionPointer = false;
        action.classList.remove('active');
    };
    window.addEventListener('blur', onActionBlur);

    return {
        setStatus(text) {
            if (text === statusText) return;
            statusText = text;
            status.textContent = text;
            status.classList.toggle('hidden', text === '');
        },
        setBadge(text) {
            if (text === badgeText) return;
            badgeText = text;
            badge.textContent = text;
            badge.classList.toggle('hidden', text === '');
        },
        setSlots(first, second) {
            const views = [first, second];
            for (let i = 0; i < 2; i++) {
                const view = views[i];
                const key = view ? `${view.mark}${view.name}${view.note}` : '';
                if (key === slotKeys[i]) continue;
                slotKeys[i] = key;
                slotEls[i].classList.toggle('empty', !view);
                slotMarks[i].textContent = view ? view.mark : '';
                slotNames[i].textContent = view ? view.name : '空き';
                slotNotes[i].textContent = view ? view.note : '';
            }
        },
        setArrow(angle, label) {
            const show = angle !== null;
            if (show !== arrowShown) {
                arrowShown = show;
                arrow.classList.toggle('hidden', !show);
            }
            if (!show) return;
            // 矢印の絵文字は右向きなので、画面上を 0 にするため 90°戻す
            arrowDial.style.transform = `rotate(${((angle as number) * 180) / Math.PI - 90}deg)`;
            if (label === arrowLabelText) return;
            arrowLabelText = label;
            arrowLabel.textContent = label;
        },
        setEdgeArrow(angle, label) {
            const show = angle !== null;
            if (show !== edgeShown) {
                edgeShown = show;
                edge.classList.toggle('hidden', !show);
            }
            if (!show) return;
            const degrees = ((angle as number) * 180) / Math.PI;
            // 画面中央から角度の向きへ押し出して、画面端に貼り付ける
            edge.style.transform = `translate(-50%, -50%) rotate(${degrees}deg) translateY(-36vmin)`;
            edgeLabel.style.transform = `rotate(${-degrees}deg)`;
            if (label === edgeLabelText) return;
            edgeLabelText = label;
            edgeLabel.textContent = label;
        },
        setAction(view) {
            const show = view !== null;
            if (show !== actionShown) {
                actionShown = show;
                action.classList.toggle('hidden', !show);
                // 回収ボタンとジャンプボタンの誤タップを避ける（E94）
                document.body.classList.toggle('match-action-open', show);
                if (!show) {
                    actionPointer = false;
                    actionKeyDown = false;
                    actionPressed = false;
                    action.classList.remove('active');
                }
            }
            if (!view) return;
            const key = `${view.mark}${view.target}${view.hold ? 'h' : 'p'}`;
            if (key !== actionKeyText) {
                actionKeyText = key;
                actionMark.textContent = view.mark;
                actionLabel.textContent = `${view.target}を回収${view.hold ? '（長押し）' : ''}`;
                action.classList.toggle('hold', view.hold);
            }
            const progress = view.hold ? Math.max(0, Math.min(1, view.progress)) : 0;
            actionRing.style.width = `${(progress * 100).toFixed(1)}%`;
        },
        get actionHeld() {
            return actionShown && (actionPointer || actionKeyDown);
        },
        consumeActionPress() {
            const value = actionPressed;
            actionPressed = false;
            return value;
        },
        announce(text) {
            if (text === newsText && newsLeft > 0) return;
            newsText = text;
            newsLeft = NEWS_HOLD;
            news.textContent = text;
            news.classList.remove('hidden');
            // 再生し直すために一度アニメーションを外す
            news.classList.remove('pop');
            void news.offsetWidth;
            news.classList.add('pop');
        },
        toast(text) {
            if (text === toastText && toastLeft > 0) return;
            toastText = text;
            toastLeft = TOAST_HOLD;
            toastEl.textContent = text;
            toastEl.classList.remove('hidden');
            toastEl.classList.remove('pop');
            void toastEl.offsetWidth;
            toastEl.classList.add('pop');
        },
        setChannel(progress) {
            const show = progress >= 0;
            if (show !== channelShown) {
                channelShown = show;
                channel.classList.toggle('hidden', !show);
            }
            if (show) channelFill.style.width = `${Math.min(100, progress * 100).toFixed(1)}%`;
        },
        setVignette(level) {
            const clamped = Math.max(0, Math.min(1, level));
            if (Math.abs(clamped - vignetteLevel) < 0.02) return;
            vignetteLevel = clamped;
            vignette.style.opacity = clamped.toFixed(2);
        },
        showPanel(spec) {
            if (!spec) {
                panel.classList.add('hidden');
                onButton = null;
                return;
            }
            panelTitle.textContent = spec.title;
            panelTitle.style.color = spec.color ?? '';
            panelBody.replaceChildren();
            for (const line of spec.lines) {
                const row = div('match-panel-line');
                row.textContent = line;
                panelBody.appendChild(row);
            }
            if (spec.toggle) {
                panelToggle.textContent = spec.toggle.label;
                panelToggle.classList.remove('hidden');
                onToggle = spec.toggle.onClick;
            } else {
                panelToggle.classList.add('hidden');
                onToggle = null;
            }
            if (spec.button) {
                panelButton.textContent = spec.button.label;
                panelButton.classList.remove('hidden');
                onButton = spec.button.onClick;
            } else {
                panelButton.classList.add('hidden');
                onButton = null;
            }
            panelNote.textContent = spec.note ?? '';
            panelNote.classList.toggle('hidden', !spec.note);
            panel.classList.remove('hidden');
        },
        update(dt) {
            if (newsLeft > 0) {
                newsLeft -= dt;
                if (newsLeft <= 0) news.classList.add('hidden');
            }
            if (toastLeft > 0) {
                toastLeft -= dt;
                if (toastLeft <= 0) toastEl.classList.add('hidden');
            }
        },
        dispose() {
            window.removeEventListener('keydown', onActionKeyDown, { capture: true });
            window.removeEventListener('keyup', onActionKeyUp, { capture: true });
            window.removeEventListener('blur', onActionBlur);
            document.body.classList.remove('match-action-open');
            root.remove();
        },
    };
}
