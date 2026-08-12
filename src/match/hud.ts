/**
 * マッチのUI（契約10）。DOM だけで作る — ポストプロセスの外なので色が転ばない（E41）。
 *
 * 出すもの:
 *   状態行   画面上部。フェーズ・残り時間・いまの目標
 *   実況     状態行の下に数秒だけ出るテキスト（降下開始・収縮予告・鍵出現・勝利）
 *   進捗     宝箱チャンネリングのバー（画面下中央）
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

export interface MatchHud {
    /** 上部の状態行（毎フレーム呼んでよい。同じ文字列なら DOM を触らない） */
    setStatus(text: string): void;
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

export function createMatchHud(): MatchHud {
    const root = div('match-root');
    root.id = 'match-ui';

    const vignette = div('match-vignette');
    const top = div('match-top');
    const status = div('match-status');
    const news = div('match-news');
    top.append(status, news);

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

    root.append(vignette, top, channel, panel);
    document.body.appendChild(root);

    let statusText = '';
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
