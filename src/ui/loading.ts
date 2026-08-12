/** ローディング進捗UIとステータス表示。DOM は index.html 側に用意してある。 */

function el<T extends HTMLElement>(id: string): T {
    const node = document.getElementById(id);
    if (!node) throw new Error(`#${id} が見つかりません`);
    return node as T;
}

const overlay = el<HTMLDivElement>('loading');
const bar = el<HTMLDivElement>('loading-bar');
const label = el<HTMLDivElement>('loading-label');
const status = el<HTMLDivElement>('status');
const help = el<HTMLDivElement>('help');
// マルチプレイ表示（契約05）は後から足した要素。古いキャッシュの index.html で
// 開かれても起動ごと止めないよう、無ければ黙って何もしない
const net = document.getElementById('net');

export function setLoadingProgress(loaded: number, total: number, phase: string): void {
    const ratio = total > 0 ? Math.min(1, loaded / total) : 0;
    bar.style.width = `${(ratio * 100).toFixed(1)}%`;
    label.textContent = `${phase}　${loaded} / ${total}`;
}

export function hideLoading(): void {
    overlay.classList.add('hidden');
}

export function setStatus(text: string): void {
    status.textContent = text;
}

/** 画面左下の操作説明。徒歩／運転／自由カメラで内容が変わる */
export function setHelp(text: string): void {
    help.textContent = text;
}

/** 画面右上のマルチプレイ表示（接続人数）。空文字にすると枠ごと消える（契約05） */
export function setNetStatus(text: string): void {
    if (net) net.textContent = text;
}

export function showFatal(message: string): void {
    overlay.classList.remove('hidden');
    bar.style.width = '100%';
    bar.style.background = '#d05a4a';
    label.textContent = message;
}
