/**
 * 実在ランドマークの表。座標は docs/data-spec.md に載っているものだけを使う（創作しない）。
 *
 * 2Dマップのラベル（契約09）と、マッチの最終安置の抽選・実況の地名（契約10）が
 * 同じ表を読む。渦森台・展望台公園・千丈谷は data-spec に方角の記述しか無いので、
 * 座標が確定するまでここへは入れない（無い地名を実況で口にしないため）。
 */
import { ORIGIN_LAT, ORIGIN_LON } from '../config';
import { latToZ, lonToX } from '../geo';

export interface Landmark {
    name: string;
    x: number;
    z: number;
}

export const LANDMARKS: readonly Landmark[] = [
    { name: '渦が森小学校', lon: 135.2503338, lat: 34.7389573 },
    { name: '渦森橋', lon: 135.25301, lat: 34.739446 },
    { name: '住吉山手9丁目', lon: ORIGIN_LON, lat: ORIGIN_LAT },
].map((l) => ({ name: l.name, x: lonToX(l.lon), z: latToZ(l.lat) }));

/** 8方位（北 = -z）。地名が確定しない場所の言い方 */
const COMPASS = ['北', '北東', '東', '南東', '南', '南西', '西', '北西'] as const;

/** range[m] 以内でいちばん近いランドマーク。無ければ null */
export function nearestLandmark(x: number, z: number, range = 260): Landmark | null {
    let best: Landmark | null = null;
    let bestDistance = range * range;
    for (const landmark of LANDMARKS) {
        const d = (landmark.x - x) ** 2 + (landmark.z - z) ** 2;
        if (d >= bestDistance) continue;
        bestDistance = d;
        best = landmark;
    }
    return best;
}

/** 原点から見た方角 */
export function compassOf(x: number, z: number): string {
    const angle = Math.atan2(x, -z); // 0 = 北、+ = 東回り
    const index = (Math.round((angle / (Math.PI * 2)) * 8) + 8) % 8;
    return COMPASS[index];
}

/** 実況で使う場所の言い方。近くにランドマークがあればその名前、無ければ方角だけ */
export function placeName(x: number, z: number): string {
    const landmark = nearestLandmark(x, z);
    return landmark ? landmark.name : `${compassOf(x, z)}のあたり`;
}
