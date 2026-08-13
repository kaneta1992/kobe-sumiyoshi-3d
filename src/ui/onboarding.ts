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
        title: '隠された宝箱に最初に触れた人が勝ち',
        body: '住吉山手のどこかに宝箱が1つだけ隠されている。庭・路地・建物の裏 — 場所は誰も教えてくれない。触れた瞬間に勝ち。',
    },
    {
        mark: '⭕',
        title: '円は縮む — 宝箱は必ず円の中',
        body: 'ただで手に入る手がかりはこれだけ。安置の円が縮むほど探す範囲が狭まる。外にいると移動が遅くなる。',
    },
    {
        mark: '🔮',
        title: 'ステッキ2本の交点が宝箱',
        body: '尋ね人ステッキは使った場所で宝箱の方角へ倒れ、方向線がマップに残る。離れた2か所で使えば交点が出る。地図の切れ端は3枚集めると半径40mの円をくれる。',
    },
    {
        mark: '✨',
        title: '気配とニセモノ',
        body: '15mまで近づくとキラキラの気配が出る。ただしミミック（偽物）も同じ気配を出す — 手がかりの裏を取れ。光の柱にはアイテム、道の⚡は拾うほど足が速くなる。',
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
