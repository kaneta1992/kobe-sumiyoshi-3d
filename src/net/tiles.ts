/**
 * タイル取得層。描画から独立させてあるので後続タスク（物理コライダー生成など）から再利用できる。
 * - fetch 失敗は1回リトライし、それでも駄目なら null を返す（例外で停止しない: E1/E3）
 * - 並列・順不同で完了してよい（呼び出し側が座標つきで受け取る: E3）
 */
import { FETCH_CONCURRENCY } from '../config';

async function fetchOnce(url: string, signal?: AbortSignal): Promise<Response> {
    const res = await fetch(url, { signal, mode: 'cors', cache: 'force-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
    return res;
}

async function fetchWithRetry(url: string, signal?: AbortSignal): Promise<Response | null> {
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            return await fetchOnce(url, signal);
        } catch (err) {
            if (attempt === 1) {
                console.warn('[tiles] give up:', url, err);
                return null;
            }
        }
    }
    return null;
}

/** ラスタタイルを ImageBitmap として取得。取得不能なら null（欠損として扱う） */
export async function fetchTileImage(url: string, signal?: AbortSignal): Promise<ImageBitmap | null> {
    const res = await fetchWithRetry(url, signal);
    if (!res) return null;
    try {
        return await createImageBitmap(await res.blob());
    } catch (err) {
        console.warn('[tiles] decode failed:', url, err);
        return null;
    }
}

/** ベクトルタイル等を ArrayBuffer として取得。取得不能なら null */
export async function fetchTileBuffer(url: string, signal?: AbortSignal): Promise<ArrayBuffer | null> {
    const res = await fetchWithRetry(url, signal);
    if (!res) return null;
    try {
        return await res.arrayBuffer();
    } catch (err) {
        console.warn('[tiles] read failed:', url, err);
        return null;
    }
}

/** 同時実行数を制限しつつ items を処理する。結果は items と同じ並び順で返る */
export async function mapPool<T, R>(
    items: readonly T[],
    worker: (item: T, index: number) => Promise<R>,
    concurrency: number = FETCH_CONCURRENCY,
): Promise<R[]> {
    const results = new Array<R>(items.length);
    let cursor = 0;
    const runners: Promise<void>[] = [];
    const lanes = Math.max(1, Math.min(concurrency, items.length));
    for (let i = 0; i < lanes; i++) {
        runners.push(
            (async () => {
                for (;;) {
                    const index = cursor++;
                    if (index >= items.length) return;
                    results[index] = await worker(items[index], index);
                }
            })(),
        );
    }
    await Promise.all(runners);
    return results;
}
