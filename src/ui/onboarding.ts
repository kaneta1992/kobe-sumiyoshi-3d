/**
 * 初回マッチ前のルール説明カード（契約13-6）。
 *
 * 「展開が分からないままボットが勝つ」を無くすための最小限の前置き。
 * 4枚をめくるだけ・いつでもスキップでき、「次から表示しない」で二度と出ない。
 *
 * DOM はここで作る（?match のときにしか要らないものを index.html へ置かない）。
 * CSS は index.html 側の #onboarding。
 */
import { isSeen, markSeen } from './settings';

interface Card {
    mark: string;
    title: string;
    body: string;
}

/**
 * 文言は「いま遊べるルール」ではなく**ゲームの芯**だけを言う（契約13 追記の裁定）。
 * 情報を集めて宝箱の場所を推理するのが核なので、場所を直接教える導線には触れない
 */
const CARDS: readonly Card[] = [
    {
        mark: '🏆',
        title: '宝箱に最初に触れた人が勝ち',
        body: '住吉山手のどこかに宝箱が1つだけ隠れている。先に辿り着いた人の勝ち。',
    },
    {
        mark: '⭕',
        title: '円は縮む — 宝箱は必ず円の中',
        body: '安置の円は時間とともに縮んでいく。外にいると移動が遅くなる。縮んだ先が宝箱の在り処のヒントになる。',
    },
    {
        mark: '🔍',
        title: 'ヒントを集めて場所を推理',
        body: 'アイテムで方角や距離のヒントが手に入る。集めた手がかりを重ねて、宝箱の場所を絞り込め。',
    },
    {
        mark: '💡',
        title: '光の柱 = アイテムスポット',
        body: '地面から伸びる光の柱にはアイテムが落ちている。⚡を拾うほど移動が速くなる。',
    },
];

const SEEN_KEY = 'rules';

export interface Onboarding {
    /** 説明を出す。既に「次から表示しない」なら何もせず false を返す */
    show(onDone: () => void): boolean;
    dispose(): void;
}

function div(className: string): HTMLDivElement {
    const el = document.createElement('div');
    el.className = className;
    return el;
}

export function createOnboarding(): Onboarding {
    const root = div('onboarding');
    root.id = 'onboarding';
    root.classList.add('hidden');

    const card = div('onboarding-card');
    const mark = div('onboarding-mark');
    const title = div('onboarding-title');
    const body = div('onboarding-body');
    const dots = div('onboarding-dots');
    const row = div('onboarding-row');
    const next = document.createElement('button');
    next.className = 'onboarding-next';
    const skip = document.createElement('button');
    skip.className = 'onboarding-skip';
    skip.textContent = 'スキップ';
    row.append(skip, next);

    const hideRow = document.createElement('label');
    hideRow.className = 'onboarding-hide';
    const hideBox = document.createElement('input');
    hideBox.type = 'checkbox';
    const hideText = document.createElement('span');
    hideText.textContent = '次から表示しない';
    hideRow.append(hideBox, hideText);

    const dotEls: HTMLDivElement[] = [];
    for (let i = 0; i < CARDS.length; i++) {
        const dot = div('onboarding-dot');
        dots.appendChild(dot);
        dotEls.push(dot);
    }

    card.append(mark, title, body, dots, row, hideRow);
    root.appendChild(card);
    document.body.appendChild(root);

    let index = 0;
    let done: (() => void) | null = null;

    const render = (): void => {
        const spec = CARDS[index];
        mark.textContent = spec.mark;
        title.textContent = spec.title;
        body.textContent = spec.body;
        next.textContent = index === CARDS.length - 1 ? 'はじめる' : '次へ';
        for (let i = 0; i < dotEls.length; i++) dotEls[i].classList.toggle('active', i === index);
    };

    const finish = (): void => {
        if (hideBox.checked) markSeen(SEEN_KEY);
        root.classList.add('hidden');
        const callback = done;
        done = null;
        callback?.();
    };

    next.addEventListener('click', () => {
        if (index < CARDS.length - 1) {
            index++;
            render();
            return;
        }
        finish();
    });
    skip.addEventListener('click', finish);

    return {
        show(onDone) {
            if (isSeen(SEEN_KEY)) return false;
            index = 0;
            done = onDone;
            render();
            root.classList.remove('hidden');
            return true;
        },
        dispose() {
            root.remove();
        },
    };
}
