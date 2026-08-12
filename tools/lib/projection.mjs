/**
 * 平面直角座標系第V系 → ローカル ENU の変換（docs/data-spec.md §4.5）。
 *
 * 図郭ZIPの点は数千万〜数億点あるため、1点ごとに proj4 を呼ぶと現実的な時間で
 * 終わらない。対象エリアは 2.4km 四方しかなく、この範囲では
 * 「平面直角座標 → 緯度経度 → ローカル ENU」は事実上アフィン変換なので、
 * proj4 で係数を求めたアフィン式を本番の変換に使い、残差を実測して検証する。
 * （残差が閾値を超えたら例外にして黙って誤差を混入させない）
 */
import proj4 from 'proj4';
import { AREA_HALF, latToZ, lonToX, ORIGIN_LAT, ORIGIN_LON } from '../../src/shared/geo.js';

/** 測地成果2000/2011 平面直角座標系第V系（JGD2000とJGD2011の差はこの用途では無視可） */
const CS_V =
    '+proj=tmerc +lat_0=36 +lon_0=134.33333333333334 +k=0.9999 ' +
    '+x_0=0 +y_0=0 +ellps=GRS80 +units=m +no_defs';
const WGS84 = '+proj=longlat +datum=WGS84 +no_defs';

const toLonLat = proj4(CS_V, WGS84);

/** 平面直角座標(easting, northing)[m] → 緯度経度 */
export function planeToLonLat(easting, northing) {
    const [lon, lat] = toLonLat.forward([easting, northing]);
    return { lon, lat };
}

/** 緯度経度 → 平面直角座標(easting, northing)[m] */
export function lonLatToPlane(lon, lat) {
    const [easting, northing] = toLonLat.inverse([lon, lat]);
    return { easting, northing };
}

/** 平面直角座標 → ローカル座標（proj4 経由の厳密版。検証とbbox算出に使う） */
export function planeToLocalExact(easting, northing) {
    const { lon, lat } = planeToLonLat(easting, northing);
    return { x: lonToX(lon), z: latToZ(lat), lon, lat };
}

/**
 * エリアを覆う平面直角座標の矩形。図郭内の点を捨てる一次フィルタに使う。
 * @param {number} margin エリア半幅に足す余裕[m]
 */
export function planeBounds(margin) {
    const half = AREA_HALF + margin;
    let minE = Infinity;
    let maxE = -Infinity;
    let minN = Infinity;
    let maxN = -Infinity;
    // 外周を刻んで包絡矩形を取る（回転があるので四隅だけでは足りない）
    const STEPS = 32;
    for (let i = 0; i <= STEPS; i++) {
        const t = -half + (2 * half * i) / STEPS;
        for (const [x, z] of [
            [t, -half],
            [t, half],
            [-half, t],
            [half, t],
        ]) {
            const lon = ORIGIN_LON + x / (111320 * Math.cos((ORIGIN_LAT * Math.PI) / 180));
            const lat = ORIGIN_LAT - z / 111132;
            const { easting, northing } = lonLatToPlane(lon, lat);
            if (easting < minE) minE = easting;
            if (easting > maxE) maxE = easting;
            if (northing < minN) minN = northing;
            if (northing > maxN) maxN = northing;
        }
    }
    // 端の丸め誤差ぶんだけ広げておく
    return { minE: minE - 1, maxE: maxE + 1, minN: minN - 1, maxN: maxN + 1 };
}

/**
 * エリア近傍で成立する (E,N) → (x,z) の2次テイラー近似を作る。
 *
 * 1次（アフィン）だけだとエリア端で 0.2m ずれる（子午線収束の交差項 ∂²x/∂E∂N が
 * 効くため）。2次項まで入れるとミリメートル未満に収まる。係数は解析ループの内側で
 * 直接使うので、関数ではなく素の数値として返す。
 *
 * @param {number} margin
 * @returns {{ e0: number, n0: number, cx: Float64Array, cz: Float64Array, maxResidual: number }}
 *   cx/cz = [定数, dE, dN, dE², dE·dN, dN²] の係数
 */
export function makeLocalTransform(margin) {
    const center = lonLatToPlane(ORIGIN_LON, ORIGIN_LAT);
    const e0 = center.easting;
    const n0 = center.northing;
    const H = 1000;

    const at = (de, dn) => planeToLocalExact(e0 + de, n0 + dn);
    const c = at(0, 0);
    const eP = at(H, 0);
    const eM = at(-H, 0);
    const nP = at(0, H);
    const nM = at(0, -H);
    const pp = at(H, H);
    const pm = at(H, -H);
    const mp = at(-H, H);
    const mm = at(-H, -H);

    const coef = (key) => {
        const f0 = c[key];
        const fE = (eP[key] - eM[key]) / (2 * H);
        const fN = (nP[key] - nM[key]) / (2 * H);
        const fEE = (eP[key] - 2 * f0 + eM[key]) / (H * H);
        const fNN = (nP[key] - 2 * f0 + nM[key]) / (H * H);
        const fEN = (pp[key] - pm[key] - mp[key] + mm[key]) / (4 * H * H);
        return Float64Array.from([f0, fE, fN, fEE / 2, fEN, fNN / 2]);
    };
    const cx = coef('x');
    const cz = coef('z');

    // 検証: エリア全域 11×11 点で近似と proj4 厳密解の差を測る
    const half = AREA_HALF + margin;
    let maxResidual = 0;
    for (let i = 0; i <= 10; i++) {
        for (let j = 0; j <= 10; j++) {
            const de = -half + (2 * half * i) / 10;
            const dn = -half + (2 * half * j) / 10;
            const exact = planeToLocalExact(e0 + de, n0 + dn);
            const ax = cx[0] + cx[1] * de + cx[2] * dn + cx[3] * de * de + cx[4] * de * dn + cx[5] * dn * dn;
            const az = cz[0] + cz[1] * de + cz[2] * dn + cz[3] * de * de + cz[4] * de * dn + cz[5] * dn * dn;
            const d = Math.hypot(ax - exact.x, az - exact.z);
            if (d > maxResidual) maxResidual = d;
        }
    }
    if (!(maxResidual < 0.05)) {
        throw new Error(
            `平面直角→ローカル変換の近似残差が大きすぎます: ${maxResidual.toFixed(3)}m`,
        );
    }
    return { e0, n0, cx, cz, maxResidual };
}
