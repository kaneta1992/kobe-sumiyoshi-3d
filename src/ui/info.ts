/**
 * 右下の「ℹ️」ボタンと、その中身（出典・ライセンス / 操作 / 設定）。契約13-5。
 *
 * **出典表記そのものは index.html に置いたまま**（法的必須の文言なので、
 * 文字列を JS 側へ写して取り違える余地を作らない）。ここがやるのは
 * 「常時表示をやめてモーダルへ畳む」ことと、初回だけ気づける導線を出すこと（E93）。
 *
 * DOM は index.html 側にある（#info-button / #info-modal）。古いキャッシュの
 * index.html で開かれても起動ごと止めないよう、無ければ黙って何もしない。
 */
import { LOOK_MAX, LOOK_MIN, getLookScale, isSeen, markSeen, setLookScale } from './settings';

/** 初回の出典トーストを出しておく時間[ms] */
const CREDIT_TOAST_HOLD = 7000;

export interface InfoPanel {
    open(tab?: string): void;
    close(): void;
}

export function createInfoPanel(): InfoPanel | null {
    const button = document.getElementById('info-button');
    const modal = document.getElementById('info-modal');
    if (!button || !modal) return null;

    const tabs = [...modal.querySelectorAll<HTMLElement>('[data-tab]')];
    const panels = [...modal.querySelectorAll<HTMLElement>('[data-panel]')];

    const select = (name: string): void => {
        for (const tab of tabs) tab.classList.toggle('active', tab.dataset.tab === name);
        for (const panel of panels) panel.classList.toggle('hidden', panel.dataset.panel !== name);
    };
    for (const tab of tabs) {
        tab.addEventListener('click', () => select(tab.dataset.tab ?? 'credit'));
    }

    const open = (tab = 'credit'): void => {
        select(tab);
        modal.classList.remove('hidden');
    };
    const close = (): void => modal.classList.add('hidden');

    button.addEventListener('click', () => {
        if (modal.classList.contains('hidden')) open();
        else close();
    });
    modal.addEventListener('click', (e) => {
        if (e.target === modal) close();
    });
    modal.querySelector('.info-close')?.addEventListener('click', close);
    window.addEventListener('keydown', (e) => {
        if (e.code === 'Escape' && !modal.classList.contains('hidden')) close();
    });

    // --- 設定: 視点感度（契約13-1） ---
    const look = document.getElementById('info-look') as HTMLInputElement | null;
    const lookValue = document.getElementById('info-look-value');
    if (look) {
        look.min = String(LOOK_MIN);
        look.max = String(LOOK_MAX);
        look.step = '0.05';
        look.value = String(getLookScale());
        const show = (): void => {
            if (lookValue) lookValue.textContent = `×${Number(look.value).toFixed(2)}`;
        };
        show();
        look.addEventListener('input', () => {
            setLookScale(Number(look.value));
            show();
        });
    }

    // --- 初回だけ「出典はここ」と知らせる（E93: 完全非表示にはしない） ---
    const toast = document.getElementById('info-toast');
    if (toast && !isSeen('credit')) {
        markSeen('credit');
        toast.classList.remove('hidden');
        toast.addEventListener('click', () => {
            toast.classList.add('hidden');
            open('credit');
        });
        window.setTimeout(() => toast.classList.add('hidden'), CREDIT_TOAST_HOLD);
    }

    return { open, close };
}
