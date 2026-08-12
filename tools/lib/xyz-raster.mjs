/**
 * 図郭ZIP（XYZテキスト）→ エリアの 1m グリッドラスター。
 *
 * 1図郭は 90MB のテキスト16本（合計1.4GB）で、8図郭では 11GB を超える。全部読むと
 * 遅いので次の順で削る（契約02 E3: 一括読み込みしない・分割実行できる）:
 *   1. 各テキストの先頭だけ展開して開始座標を得て、エリアと交差しない区画は開かない
 *   2. 開いた区画はストリームで展開し、行ごとにバイト列のまま数値を読む（文字列を作らない）
 *   3. 対象の緯度帯を通り過ぎたら、その区画の残りは読まずに打ち切る
 *
 * 集約は DSM/DEM とも「セル内の最大値」で揃える。DEM を平均にすると、六甲山麓に多い
 * 擁壁や崖（水平 0.5m で標高が数十m変わる）で DSM の最大値と DEM の平均が別の高さを
 * 指してしまい、nDSM に数十mの偽の突起が出る。同じ取り方に揃えれば差が素直に
 * 「地面の上に載っている物の高さ」になる（契約02 E11）。
 */
import yauzl from 'yauzl';
import { AREA_HALF } from '../../src/shared/geo.js';
import { makeLocalTransform, planeBounds } from './projection.mjs';

/** グリッドはエリア外周に余白を持たせる（端の建物・地形の継ぎ目対策 = E1） */
export const GRID_MARGIN = 120;
export const GRID_HALF = AREA_HALF + GRID_MARGIN;
export const CELL = 1;
export const GN = (GRID_HALF * 2) / CELL + 1;

/** 明らかな異常値（NODATA の -9999 など）を弾く高さの範囲[m] */
const H_MIN = -50;
const H_MAX = 1500;

export const NO_DATA = -1e9;

/** @returns {{ dsmMax: Float32Array, demMax: Float32Array }} */
export function createGrids() {
    return {
        dsmMax: new Float32Array(GN * GN).fill(NO_DATA),
        demMax: new Float32Array(GN * GN).fill(NO_DATA),
    };
}

/** ZIPのエントリ一覧（ディレクトリを除く） */
function listEntries(path) {
    return new Promise((resolve, reject) => {
        yauzl.open(path, { lazyEntries: true, autoClose: false }, (err, zip) => {
            if (err) return reject(err);
            const entries = [];
            zip.on('entry', (e) => {
                if (!/\/$/.test(e.fileName)) entries.push(e);
                zip.readEntry();
            });
            zip.on('end', () => resolve({ zip, entries }));
            zip.on('error', reject);
            zip.readEntry();
        });
    });
}

/** yauzl の openReadStream は展開済みのバイト列を流す（自前で inflate してはいけない） */
function openEntryStream(zip, entry) {
    return new Promise((resolve, reject) => {
        zip.openReadStream(entry, (err, stream) => (err ? reject(err) : resolve(stream)));
    });
}

/** 先頭だけ読んで最初の点の平面直角座標を得る */
async function peekOrigin(zip, entry) {
    const stream = await openEntryStream(zip, entry);
    return await new Promise((resolve, reject) => {
        let text = '';
        let done = false;
        const finish = (v) => {
            if (done) return;
            done = true;
            stream.destroy();
            resolve(v);
        };
        stream.on('data', (d) => {
            text += d.toString('latin1');
            const nl = text.indexOf('\n');
            if (nl > 0) {
                const parts = text.slice(0, nl).trim().split(/\s+/);
                finish({ e: Number(parts[0]), n: Number(parts[1]) });
            } else if (text.length > 1 << 16) finish(null);
        });
        stream.on('end', () => finish(null));
        // 途中で止めたときの CRC エラーは想定内なので握りつぶす
        stream.on('error', () => (done ? undefined : reject(new Error('区画の先頭を読めません'))));
    });
}

/**
 * 1図郭を読んでグリッドへ集約する。
 * @param {string} zipFile
 * @param {'dsm'|'dem'} kind
 * @param {{ dsmMax: Float32Array, demMax: Float32Array }} grids
 * @returns {Promise<{ entriesRead: number, entriesSkipped: number, pointsUsed: number }>}
 */
export async function rasterizeSheet(zipFile, kind, grids) {
    const bounds = planeBounds(GRID_MARGIN);
    const tf = makeLocalTransform(GRID_MARGIN);
    const { zip, entries } = await listEntries(zipFile);

    try {
        // --- 区画の開始座標を集めて、区画サイズを推定する ---
        const origins = new Map();
        for (const e of entries) origins.set(e.fileName, await peekOrigin(zip, e));
        const gap = (values) => {
            const s = [...new Set(values)].sort((a, b) => a - b);
            let g = Infinity;
            for (let i = 1; i < s.length; i++) g = Math.min(g, s[i] - s[i - 1]);
            return g;
        };
        const known = [...origins.values()].filter(Boolean);
        const blockW = gap(known.map((o) => o.e));
        const blockH = gap(known.map((o) => o.n));

        let entriesRead = 0;
        let entriesSkipped = 0;
        let pointsUsed = 0;

        for (const entry of entries) {
            const o = origins.get(entry.fileName);
            // 区画の並び方（南下か北上か）は読まずには決まらないので N 方向は両側に見る
            const intersects =
                !o ||
                !Number.isFinite(blockW) ||
                !Number.isFinite(blockH) ||
                (o.e <= bounds.maxE &&
                    o.e + blockW >= bounds.minE &&
                    o.n - blockH <= bounds.maxN &&
                    o.n + blockH >= bounds.minN);
            if (!intersects) {
                entriesSkipped++;
                continue;
            }
            entriesRead++;
            const n = await readEntry(zip, entry, kind, grids, bounds, tf);
            pointsUsed += n;
            if (process.env.RASTER_VERBOSE) {
                console.log(`  [raster] ${entry.fileName} origin=(${o?.e},${o?.n}) points=${n}`);
            }
        }
        return { entriesRead, entriesSkipped, pointsUsed };
    } finally {
        zip.close();
    }
}

/** バイト列から数値を読む。戻り値は [値, 次の位置]。区切りは空白・カンマ・改行 */
let numVal = 0;
function readNumber(buf, i, end) {
    while (i < end && (buf[i] === 32 || buf[i] === 9 || buf[i] === 44)) i++;
    let neg = false;
    if (buf[i] === 45) {
        neg = true;
        i++;
    } else if (buf[i] === 43) i++;
    let v = 0;
    let any = false;
    while (i < end) {
        const c = buf[i];
        if (c >= 48 && c <= 57) {
            v = v * 10 + (c - 48);
            any = true;
            i++;
        } else break;
    }
    if (i < end && buf[i] === 46) {
        i++;
        let scale = 0.1;
        while (i < end) {
            const c = buf[i];
            if (c >= 48 && c <= 57) {
                v += (c - 48) * scale;
                scale *= 0.1;
                any = true;
                i++;
            } else break;
        }
    }
    numVal = any ? (neg ? -v : v) : NaN;
    return i;
}

/**
 * 1区画をストリーム展開してグリッドに積む。
 * @returns {Promise<number>} 採用した点数
 */
function readEntry(zip, entry, kind, grids, bounds, tf) {
    const { e0, n0, cx, cz } = tf;
    const { minE, maxE, minN, maxN } = bounds;
    const target = kind === 'dsm' ? grids.dsmMax : grids.demMax;

    let used = 0;
    let entered = false;
    let descending = null;
    let lastN = NaN;
    let carry = null;

    /** 完全な行を含むバッファ区間を処理する。戻り値: 打ち切るなら true */
    const consume = (buf, end) => {
        let i = 0;
        while (i < end) {
            // 行末を探す
            let nl = i;
            while (nl < end && buf[nl] !== 10) nl++;
            if (nl >= end) break;
            const lineEnd = nl > i && buf[nl - 1] === 13 ? nl - 1 : nl;

            let p = readNumber(buf, i, lineEnd);
            const E = numVal;
            if (E >= minE && E <= maxE) {
                p = readNumber(buf, p, lineEnd);
                const N = numVal;
                if (N >= minN && N <= maxN) {
                    readNumber(buf, p, lineEnd);
                    const h = numVal;
                    if (h >= H_MIN && h <= H_MAX) {
                        const de = E - e0;
                        const dn = N - n0;
                        const x =
                            cx[0] + cx[1] * de + cx[2] * dn + cx[3] * de * de + cx[4] * de * dn + cx[5] * dn * dn;
                        const z =
                            cz[0] + cz[1] * de + cz[2] * dn + cz[3] * de * de + cz[4] * de * dn + cz[5] * dn * dn;
                        const col = Math.round((x + GRID_HALF) / CELL);
                        const row = Math.round((z + GRID_HALF) / CELL);
                        if (col >= 0 && col < GN && row >= 0 && row < GN) {
                            const idx = row * GN + col;
                            if (h > target[idx]) target[idx] = h;
                            used++;
                        }
                    }
                    entered = true;
                }
                // 対象の帯を一度通ってから外れたら、この区画の残りは要らない
                if (Number.isFinite(N)) {
                    if (descending === null && Number.isFinite(lastN) && N !== lastN) {
                        descending = N < lastN;
                    }
                    lastN = N;
                    if (entered && descending !== null) {
                        if (descending ? N < minN : N > maxN) return true;
                    }
                }
            }
            i = nl + 1;
        }
        return i;
    };

    return new Promise((resolve, reject) => {
        let stopped = false;
        openEntryStream(zip, entry).then((stream) => {
            const stop = () => {
                if (stopped) return;
                stopped = true;
                stream.destroy();
                resolve(used);
            };
            stream.on('data', (chunk) => {
                if (stopped) return;
                const buf = carry ? Buffer.concat([carry, chunk]) : chunk;
                const r = consume(buf, buf.length);
                if (r === true) return stop();
                carry = r < buf.length ? buf.subarray(r) : null;
            });
            stream.on('end', () => {
                if (!stopped && carry && carry.length) {
                    consume(Buffer.concat([carry, Buffer.from('\n')]), carry.length + 1);
                }
                stop();
            });
            // 打ち切り後に出る CRC 不一致は想定内。それ以外は失敗として上げる
            stream.on('error', (e) => (stopped ? undefined : reject(e)));
        }, reject);
    });
}
