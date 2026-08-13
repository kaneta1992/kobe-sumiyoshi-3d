/**
 * 画面から変えられる設定（契約13-1）。いまは視点感度だけを持つ。
 *
 * localStorage に残すが、読めない環境（プライベートモード等）でも既定値で動く。
 * ここは「値を1つ持つだけ」の置き場で、UI は src/ui/info.ts、
 * 実際に効かせるのは src/game/input.ts。
 */

const LOOK_KEY = 'kobe3d.look';
/**
 * 視点感度の倍率の範囲（1 = 従来の感度）。
 * 上限は「もっと速く回したい」という声に合わせて 2.5 → 5 へ広げた（契約15 追記9）。
 * 保存済みの値は従来どおり読める（範囲を広げただけなのでクランプに掛からない）
 */
export const LOOK_MIN = 0.4;
export const LOOK_MAX = 5;

function readNumber(key: string, fallback: number, min: number, max: number): number {
    try {
        const raw = localStorage.getItem(key);
        if (raw === null) return fallback;
        const value = Number(raw);
        if (!Number.isFinite(value)) return fallback;
        return Math.max(min, Math.min(max, value));
    } catch {
        return fallback;
    }
}

function writeNumber(key: string, value: number): void {
    try {
        localStorage.setItem(key, String(value));
    } catch {
        // 保存できなくても今回のセッションでは効いている
    }
}

let lookScale = readNumber(LOOK_KEY, 1, LOOK_MIN, LOOK_MAX);

/** 視点感度の倍率（マウスドラッグ・スワイプの両方に掛かる） */
export function getLookScale(): number {
    return lookScale;
}

export function setLookScale(value: number): void {
    lookScale = Math.max(LOOK_MIN, Math.min(LOOK_MAX, value));
    writeNumber(LOOK_KEY, lookScale);
}

/** 一度きりの表示（ルール説明・出典トースト）を出したか覚える */
export function isSeen(key: string): boolean {
    try {
        return localStorage.getItem(`kobe3d.seen.${key}`) === '1';
    } catch {
        return false;
    }
}

export function markSeen(key: string): void {
    try {
        localStorage.setItem(`kobe3d.seen.${key}`, '1');
    } catch {
        // 覚えられなくても毎回出るだけ
    }
}
