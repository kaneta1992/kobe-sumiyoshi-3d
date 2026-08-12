/**
 * 前処理で叩く HTTP。相手（S3・地理院）はどちらも稀に接続を切るので、
 * 数百枚のタイルを順に取る用途では黙って張り直せないと全体が落ちる。
 */

/**
 * @param {string} url
 * @param {{ attempts?: number, method?: string }} [opts]
 * @returns {Promise<Response|null>} 取得できなければ null（404 は即 null）
 */
export async function fetchRetry(url, opts = {}) {
    const attempts = opts.attempts ?? 4;
    let lastErr = null;
    for (let i = 0; i < attempts; i++) {
        try {
            const res = await fetch(url, opts.method ? { method: opts.method } : undefined);
            if (res.ok) return res;
            if (res.status === 404) return null;
            lastErr = new Error(`HTTP ${res.status}`);
        } catch (err) {
            lastErr = err;
        }
        await new Promise((r) => setTimeout(r, 300 * (i + 1)));
    }
    console.warn(`[net] 取得できませんでした（${attempts}回試行）: ${url} — ${lastErr}`);
    return null;
}
