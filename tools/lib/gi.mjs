/**
 * ベイクGI（契約07 追記1）。1mグリッドの地表（道路カービング後）と DSM から
 * 「時刻に依存しない量」だけを焼く。色は実行時に環境光・太陽色で変調する。
 *
 *   R = 空の可視率（地表 +0.3m）      … 谷筋・路地・林床の暗部
 *   G = 1バウンス相当の間接光の受光量 … 暗部が真っ黒に潰れないための回り込み
 *   B = 空の可視率（地表 +8m）        … 壁の上部・樹冠・屋根はここへ補間する
 *
 * 遮蔽のモデル:
 *   - 地形と建物は「硬い遮蔽」。方位ごとの水平線角 α を求め、コサイン加重半球の
 *     解析解 1 − sin²α = 1/(1+tan²α) を使う。
 *   - 樹冠は「参加媒質」。水平線モデルは遮蔽体が上へ無限に続く前提なので、
 *     隙間だらけの葉群に当てると過剰に暗くなる。距離重み付きの密度を積んで
 *     exp(−k·density) の透過率にする。
 *
 * 太陽の直接光はここでは焼かない（実行時のシャドウマップが担当）。焼くのは
 * 時刻に依存しない量だけなので、?hour を変えても破綻しない。
 *
 * 値は暗部の分解能を確保するため sqrt 圧縮して 8bit に格納する（実行時に二乗で戻す）。
 */
import { AREA_HALF } from '../../src/shared/geo.js';
import { CELL, GN, GRID_HALF, NO_DATA } from './xyz-raster.mjs';

/** 出力の一辺（クライアントの地形頂点数と同じにして補間のズレを作らない） */
export const GI_SIZE = 1025;
/** G チャンネルの格納スケール（0..BOUNCE_SCALE を 0..255 に写す） */
export const BOUNCE_SCALE = 0.3;

/** 受光点の高さ[m] */
const EYE_LOW = 0.3;
const EYE_HIGH = 8;
/** 方位分割数 */
const DIRECTIONS = 16;
/** 水平線を探す距離[m]。近傍を密に、遠方は粗く */
const STEPS = [1.5, 3, 5, 8, 12, 18, 27, 40, 60, 90, 135, 200, 300];
/** 樹冠を「濃い」とみなす高さ[m]（これ以上は密度1） */
const CANOPY_FULL = 10;
/** 樹冠の消衰係数。大きいほど林床が暗い */
const CANOPY_K = 1.0;
/** 反射面のアルベド（住宅地の壁・舗装・土のならし値） */
const ALBEDO = 0.32;
/** 間接光の供給元とみなす近傍の半径[出力セル] */
const BLUR_RADIUS = 8;

/** 出力グリッドを半径 r の箱ぼかし（分離型）でならす */
function boxBlur(src, size, r) {
    const tmp = new Float32Array(src.length);
    const out = new Float32Array(src.length);
    const width = r * 2 + 1;
    const clamp = (v) => (v < 0 ? 0 : v > size - 1 ? size - 1 : v);
    for (let row = 0; row < size; row++) {
        const base = row * size;
        let sum = 0;
        for (let c = -r; c <= r; c++) sum += src[base + clamp(c)];
        for (let col = 0; col < size; col++) {
            tmp[base + col] = sum / width;
            sum += src[base + clamp(col + r + 1)] - src[base + clamp(col - r)];
        }
    }
    for (let col = 0; col < size; col++) {
        let sum = 0;
        for (let c = -r; c <= r; c++) sum += tmp[clamp(c) * size + col];
        for (let row = 0; row < size; row++) {
            out[row * size + col] = sum / width;
            sum += tmp[clamp(row + r + 1) * size + col] - tmp[clamp(row - r) * size + col];
        }
    }
    return out;
}

/**
 * @param {Float32Array} ground カービング後の地表（1mグリッド）
 * @param {Float32Array} dsmMax DSM（NO_DATA を含む）
 * @param {Uint8Array} buildingMask 建物フットプリント（1mグリッド）
 * @returns {{ rgb: Uint8Array, meta: object, stats: object }}
 */
export function bakeGi(ground, dsmMax, buildingMask) {
    // 硬い遮蔽体の面（地形 + 建物）と、樹冠の密度を分けて持つ
    const hard = new Float32Array(GN * GN);
    const canopyLow = new Float32Array(GN * GN);
    const canopyHigh = new Float32Array(GN * GN);
    for (let i = 0; i < hard.length; i++) {
        const g = ground[i];
        const d = dsmMax[i];
        const nd = d !== NO_DATA && d > g ? d - g : 0;
        if (buildingMask[i]) {
            hard[i] = g + nd;
            continue;
        }
        hard[i] = g;
        canopyLow[i] = Math.min(1, nd / CANOPY_FULL);
        canopyHigh[i] = Math.min(1, Math.max(0, nd - EYE_HIGH) / CANOPY_FULL);
    }

    const N = GI_SIZE;
    const step = (AREA_HALF * 2) / (N - 1);
    const dirs = new Float32Array(DIRECTIONS * 2);
    for (let d = 0; d < DIRECTIONS; d++) {
        const a = (d / DIRECTIONS) * Math.PI * 2;
        dirs[d * 2] = Math.cos(a);
        dirs[d * 2 + 1] = Math.sin(a);
    }
    // 近いサンプルほど大きな立体角を覆う。総和が 1 になるよう正規化する
    const weights = new Float32Array(STEPS.length);
    let weightSum = 0;
    for (let s = 0; s < STEPS.length; s++) {
        weights[s] = 1 / (1 + STEPS[s] * 0.25);
        weightSum += weights[s];
    }
    for (let s = 0; s < STEPS.length; s++) weights[s] /= weightSum;

    /** 1mグリッドの最近傍セル番号（水平線探索なので補間は不要） */
    const cellAt = (x, z) => {
        let c = Math.round((x + GRID_HALF) / CELL);
        let r = Math.round((z + GRID_HALF) / CELL);
        if (c < 0) c = 0;
        else if (c > GN - 1) c = GN - 1;
        if (r < 0) r = 0;
        else if (r > GN - 1) r = GN - 1;
        return r * GN + c;
    };
    /** 地表の双線形サンプル */
    const groundAt = (x, z) => {
        const fx = Math.min(Math.max((x + GRID_HALF) / CELL, 0), GN - 1);
        const fz = Math.min(Math.max((z + GRID_HALF) / CELL, 0), GN - 1);
        const col = Math.min(Math.floor(fx), GN - 2);
        const row = Math.min(Math.floor(fz), GN - 2);
        const tx = fx - col;
        const tz = fz - row;
        return (
            ground[row * GN + col] * (1 - tx) * (1 - tz) +
            ground[row * GN + col + 1] * tx * (1 - tz) +
            ground[(row + 1) * GN + col] * (1 - tx) * tz +
            ground[(row + 1) * GN + col + 1] * tx * tz
        );
    };

    const skyLow = new Float32Array(N * N);
    const skyHigh = new Float32Array(N * N);
    for (let row = 0; row < N; row++) {
        const z = -AREA_HALF + row * step;
        for (let col = 0; col < N; col++) {
            const x = -AREA_HALF + col * step;
            const g = groundAt(x, z);
            const eyeLow = g + EYE_LOW;
            const eyeHigh = g + EYE_HIGH;
            let visLow = 0;
            let visHigh = 0;
            for (let d = 0; d < DIRECTIONS; d++) {
                const dx = dirs[d * 2];
                const dz = dirs[d * 2 + 1];
                let tLow = 0;
                let tHigh = 0;
                let densityLow = 0;
                let densityHigh = 0;
                for (let s = 0; s < STEPS.length; s++) {
                    const dist = STEPS[s];
                    const i = cellAt(x + dx * dist, z + dz * dist);
                    const h = hard[i];
                    const a = (h - eyeLow) / dist;
                    if (a > tLow) tLow = a;
                    const b = (h - eyeHigh) / dist;
                    if (b > tHigh) tHigh = b;
                    densityLow += canopyLow[i] * weights[s];
                    densityHigh += canopyHigh[i] * weights[s];
                }
                visLow += (1 / (1 + tLow * tLow)) * Math.exp(-CANOPY_K * densityLow);
                visHigh += (1 / (1 + tHigh * tHigh)) * Math.exp(-CANOPY_K * densityHigh);
            }
            skyLow[row * N + col] = visLow / DIRECTIONS;
            skyHigh[row * N + col] = visHigh / DIRECTIONS;
        }
    }

    // 1バウンス: 「塞がれている量」×アルベド×「塞いでいる面のあたりの明るさ」。
    // 塞いでいる面の受光量は近傍の空可視率のならしで代用する（谷底は暗い斜面に
    // 囲まれるので回り込みも弱い、開けた路地は明るい壁から回り込む、が出る）
    const open = boxBlur(skyLow, N, BLUR_RADIUS);
    const rgb = new Uint8Array(N * N * 3);
    let minSky = 1;
    let sumSky = 0;
    let maxBounce = 0;
    const encode = (v) => Math.round(Math.sqrt(Math.min(1, Math.max(0, v))) * 255);
    for (let i = 0; i < skyLow.length; i++) {
        const sky = skyLow[i];
        const bounce = (1 - sky) * ALBEDO * open[i];
        if (sky < minSky) minSky = sky;
        sumSky += sky;
        if (bounce > maxBounce) maxBounce = bounce;
        rgb[i * 3] = encode(sky);
        rgb[i * 3 + 1] = encode(bounce / BOUNCE_SCALE);
        rgb[i * 3 + 2] = encode(skyHigh[i]);
    }

    return {
        rgb,
        meta: {
            version: 1,
            size: N,
            areaHalf: AREA_HALF,
            /** 格納値は sqrt 圧縮。復号は (v/255)^2 */
            encoding: 'sqrt',
            /** B は「地表 +eyeHigh[m]」の空可視率。壁・樹冠はここへ向けて補間する */
            eyeLow: EYE_LOW,
            eyeHigh: EYE_HIGH,
            bounceScale: BOUNCE_SCALE,
            albedo: ALBEDO,
            source: '兵庫県 50cmメッシュ DSM/DEM から前処理でベイク（空可視率 + 1バウンス）',
        },
        stats: { minSky, meanSky: sumSky / skyLow.length, maxBounce },
    };
}
