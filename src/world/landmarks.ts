/**
 * 実在ランドマークの表と、実行時に足される実在注記POI（契約13-4）。
 *
 * 座標は docs/data-spec.md に載っているものと、地理院ベクトルタイルの **Anno レイヤー
 * （実在注記）** から読んだものだけを使う。**名前も座標も創作しない**。
 *
 * 2Dマップのラベル（契約09）と、マッチの最終安置の抽選・実況の地名（契約10）、
 * アイテムの湧きPOI（契約11/13）が同じ表を読む。
 */
import { ORIGIN_LAT, ORIGIN_LON } from '../config';
import { latToZ, lonToX } from '../geo';

export interface Landmark {
    name: string;
    x: number;
    z: number;
}

/**
 * 座標が data-spec で確定している基本ランドマーク。
 * 白鶴美術館は契約13-4 の指定座標（Anno の注記位置ともほぼ一致する）
 */
export const LANDMARKS: readonly Landmark[] = [
    { name: '渦が森小学校', lon: 135.2503338, lat: 34.7389573 },
    { name: '渦森橋', lon: 135.25301, lat: 34.739446 },
    { name: '住吉山手9丁目', lon: ORIGIN_LON, lat: ORIGIN_LAT },
    { name: '白鶴美術館', lon: 135.2582, lat: 34.731 },
].map((l) => ({ name: l.name, x: lonToX(l.lon), z: latToZ(l.lat) }));

/**
 * 実行時のPOI表（基本ランドマーク + Anno 由来）。ワールドの読み込みが終わるまでは
 * 基本ランドマークだけ。**全クライアントが同じ並びを持つ**ことがマッチの決定性の前提なので、
 * setPlaces は座標で厳密に整列してから確定させる（タイルの到着順に依存させない）
 */
let places: readonly Landmark[] = LANDMARKS;

/** 同じ場所とみなす距離[m]（注記の重複と基本ランドマークの重なりを潰す） */
const DEDUP_DISTANCE = 60;

/**
 * Anno 由来のPOIを取り込む（world 側が到達可能性で絞ってから渡す・E96）。
 * 基本ランドマークを先に置き、名前・位置が重なるものは捨てる。
 * 最後に x → z → 名前 の辞書順で並べ替えるので、並びは入力順に依存しない
 */
export function setPlaces(extra: readonly Landmark[]): readonly Landmark[] {
    const picked: Landmark[] = [...LANDMARKS];
    const sorted = [...extra].sort(
        (a, b) => a.x - b.x || a.z - b.z || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
    );
    for (const note of sorted) {
        let duplicate = false;
        for (const kept of picked) {
            if (kept.name === note.name) {
                duplicate = true;
                break;
            }
            if (Math.hypot(kept.x - note.x, kept.z - note.z) < DEDUP_DISTANCE) {
                duplicate = true;
                break;
            }
        }
        if (!duplicate) picked.push({ name: note.name, x: note.x, z: note.z });
    }
    picked.sort((a, b) => a.x - b.x || a.z - b.z || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    places = picked;
    return places;
}

/** いま使えるPOIの全部（基本ランドマーク + Anno 由来）。並びは全クライアントで一致する */
export function allPlaces(): readonly Landmark[] {
    return places;
}

/** 8方位（北 = -z）。地名が確定しない場所の言い方 */
const COMPASS = ['北', '北東', '東', '南東', '南', '南西', '西', '北西'] as const;

/** range[m] 以内でいちばん近いランドマーク。無ければ null */
export function nearestLandmark(x: number, z: number, range = 260): Landmark | null {
    let best: Landmark | null = null;
    let bestDistance = range * range;
    for (const landmark of places) {
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
