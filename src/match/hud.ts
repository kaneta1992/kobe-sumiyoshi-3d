/**
 * マッチのUI（契約10）。DOM だけで作る — ポストプロセスの外なので色が転ばない（E41）。
 *
 * 出すもの:
 *   状態行   画面上部。フェーズ・残り時間・いまの目標
 *   効果行   状態行の下。地図の切れ端の枚数と、効いているアイテムの残り時間（契約11）
 *   実況     状態行の下に数秒だけ出るテキスト（降下開始・収縮予告・鍵出現・勝利）
 *   進捗     宝箱チャンネリングのバー（画面下中央）
 *   矢印     尋ね人ステッキの指す方角（画面下中央・契約11）
 *   アイテム 所持2枠。クリック/タップか 1・2 キーで使う（契約11・E78）
 *   ビネット 安置の外にいる間の赤い縁（減速していることを体で分かるように）
 *   パネル   ロビー / リザルト（ボタン付き）
 *
 * CSS は index.html 側にある。ここは中身の作成と文字列の差し替えだけを持つ。
 */

/** 実況が消えるまで[s] */
const NEWS_HOLD = 5;

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
    /** ボタンの下に出す小さな注記 */
    note?: string;
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
    /** 実況。同じ文なら出し直さない */
    announce(text: string): void;
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

    // --- 尋ね人ステッキの方角矢印 ---
    const arrow = div('match-arrow');
    const arrowDial = div('match-arrow-dial');
    arrowDial.textContent = '➤';
    const arrowLabel = div('match-arrow-label');
    arrow.append(arrowDial, arrowLabel);
    arrow.classList.add('hidden');

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
    const panelButton = document.createElement('button');
    panelButton.className = 'match-panel-button';
    const panelNote = div('match-panel-note');
    panel.append(panelTitle, panelBody, panelButton, panelNote);
    panel.classList.add('hidden');

    root.append(vignette, top, arrow, slotRow, channel, panel);
    document.body.appendChild(root);

    let statusText = '';
    let badgeText = '';
    /** スロットの中身のキャッシュ（毎フレーム DOM を組み直さない） */
    const slotKeys = ['', ''];
    let arrowShown = false;
    let arrowLabelText = '';
    let newsText = '';
    let newsLeft = 0;
    let vignetteLevel = -1;
    let channelShown = false;
    let onButton: (() => void) | null = null;

    panelButton.addEventListener('click', (e) => {
        e.preventDefault();
        onButton?.();
    });

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
            if (newsLeft <= 0) return;
            newsLeft -= dt;
            if (newsLeft <= 0) news.classList.add('hidden');
        },
        dispose() {
            root.remove();
        },
    };
}
