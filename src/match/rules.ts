/**
 * マッチのルール表と決定的レイアウト（契約10）。
 *
 * 全クライアントが「シード1個」から同じ配置・同じ時間割を再現する。ネットワークを流れるのは
 * {シード, 開始時刻} と取得の裁定だけで、座標は一切送らない。
 * 実行時乱数は使わない（data-spec §4 の禁止事項）— ここの PRNG はシード由来。
 *
 * 時間はすべて「マッチ時計の秒」。マッチ時計は ?matchspeed= 倍で早送りできる（デバッグ用）。
 *
 * 契約14（情報経済の再設計）: 鍵・チャンネリング・体当たりは廃止。宝箱は**隠し配置**で、
 * 触れた瞬間に勝ち。位置を無償で開示するものはここには無い（安置の円だけが無償の情報）。
 */
import { AREA_HALF } from '../config';
import { allPlaces } from '../world/landmarks';

const TAU = Math.PI * 2;

/** 開始ボタンから輸送機に乗るまでの間[ms]（実時間。早送りの対象外） */
export const COUNTDOWN = 3000;
/** 輸送機がエリアを横断しきる時間[s] = 降りられる猶予 */
export const DROP_TIME = 50;
/** 初期円の半径[m]。エリア全体（対角 1697m）を包むので開始時は誰も減速しない */
export const START_RADIUS = 1900;

/**
 * 安置の3段階。warn=予告 / from..to=収縮 / radius=収縮後の半径[m]。
 * 最終安置に到達するのは 400s ＝ 約6分40秒（契約の「6〜8分」）
 */
export const STAGES = [
    { warn: 50, from: 80, to: 150, radius: 720 },
    { warn: 150, from: 180, to: 260, radius: 400 },
    { warn: 260, from: 300, to: 400, radius: 120 },
] as const;

/** 最終安置に到達する時刻[s]（第3収縮の完了） */
export const FINAL_ZONE_AT = STAGES[STAGES.length - 1].to;
/**
 * アンチストール（契約14-7）: 最終安置に入ってからこの秒数だけ誰も回収しなければ、
 * **1マッチに1回だけ**宝箱から方向花火を上げる。定期花火の置き換え
 */
export const ANTI_STALL_AFTER = 180;
/** リマッチ投票の自動締め切り[s]（実時間） */
export const VOTE_TIME = 10;
/** 宝箱に触れたとみなす距離[m]（触れた瞬間に回収・勝利。契約14-2） */
export const REACH = 2.6;
/** 宝箱・ミミックの「気配」が届く距離[m]（契約14-5） */
export const SENSE_RADIUS = 15;
/** 安置の外での移動速度倍率 */
export const OUTSIDE_SPEED = 0.5;
/** 輸送機の飛行高度（地形の最高点からの余裕）[m] */
export const PLANE_CLEARANCE = 340;

// --- URL パラメータ（デバッグ用） ------------------------------------------

/** マッチ時計の倍率。?matchspeed=6 で6倍速（1マッチが約1分で終わる） */
export function matchSpeed(): number {
    const raw = Number(new URLSearchParams(location.search).get('matchspeed'));
    if (!Number.isFinite(raw) || raw <= 0) return 1;
    return Math.min(60, Math.max(0.25, raw));
}

/** ?matchseed=123 でシードを固定（同じ配置を再現して検証する） */
export function seedOverride(): number | null {
    // 未指定は null。Number(null) が 0 になるので、先に有無を見ること
    const value = new URLSearchParams(location.search).get('matchseed');
    if (value === null || value === '') return null;
    const raw = Number(value);
    return Number.isFinite(raw) ? raw >>> 0 : null;
}

/** ?matchauto でロビーの開始ボタンを押さずに始める（ソロ検証用） */
export function autoStart(): boolean {
    return new URLSearchParams(location.search).has('matchauto');
}

/** ?nobots で BOT なしで始める（ロビーのホスト設定の初期値・契約13-2） */
export function noBots(): boolean {
    return new URLSearchParams(location.search).has('nobots');
}

/** デバッグテレポートで対象から離しておく距離[m]。REACH より外なので接触判定は自分で歩いて成立させる */
export const GOTO_STANDOFF = 3;

/**
 * ?matchgoto=chest|item|mimic 目標の手前へテレポートする（デバッグ限定）。
 * chest は隠された宝箱の通し検証用、item は「いちばん近い未取得アイテム」へ次々に飛ぶ
 * （拾うたびに次のアイテムへ自動で移る・契約11の検証用）。
 * mimic は偽宝箱の検証用（契約12）。
 * 無指定と不正値は null なので、通常フローには何も出ない（key は契約14で廃止）
 */
export type MatchGoto = 'chest' | 'item' | 'mimic';
export function matchGoto(): MatchGoto | null {
    const value = new URLSearchParams(location.search).get('matchgoto');
    return value === 'chest' || value === 'item' || value === 'mimic' ? value : null;
}

// --- 決定的乱数 -------------------------------------------------------------

/** シード付き擬似乱数（mulberry32）。同じシードなら全クライアントで同じ列になる */
export function createRandom(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/**
 * シードだけで決まる 0..count-1 の並び替え（Fisher-Yates）。
 * POI の抽選と「直近使用の除外」に使う（契約13-4）。全クライアントで同じ列になる
 */
export function shuffledOrder(seed: number, count: number): readonly number[] {
    const rnd = createRandom(seed);
    const out: number[] = [];
    for (let i = 0; i < count; i++) out.push(i);
    for (let i = count - 1; i > 0; i--) {
        const j = Math.floor(rnd() * (i + 1));
        const swap = out[i];
        out[i] = out[j];
        out[j] = swap;
    }
    return out;
}

/** 文字列（ピアID）を 32bit へ（FNV-1a） */
export function hashString(text: string): number {
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return hash >>> 0;
}

/**
 * ホストが配るシード。時刻とピアID・通番から作る（実行時乱数は使わない）。
 * ?matchseed= があればそれを優先する
 */
export function makeSeed(selfId: string, counter: number): number {
    const forced = seedOverride();
    if (forced !== null) return forced;
    return (hashString(`${selfId}:${counter}:${Date.now()}`) ^ Math.imul(counter + 1, 0x9e3779b9)) >>> 0;
}

// --- レイアウト -------------------------------------------------------------

export interface Point {
    x: number;
    z: number;
}

export interface MatchLayout {
    seed: number;
    /** 輸送機の経路（エリアを横断する水平の直線） */
    route: { x0: number; z0: number; x1: number; z1: number };
    /** 安置の中心列（0=初期円 … 3=最終円） */
    centers: readonly Point[];
    /** 中心列に対応する半径[m] */
    radii: readonly number[];
    /** 宝箱。最終安置の中の「隠れた」地点（契約14-3） */
    chest: Point;
    /** 最終安置のランドマーク名（実況に使う） */
    finalPlace: string;
}

/**
 * 隠し配置の判定に使うワールドの問い合わせ口（契約14-3）。
 * 全員が同じワールドを持っているので、ここを通しても配置は全クライアントで一致する
 */
export interface WorldProbe {
    /** 足場の高さ（建物・道路を含む） */
    surface(x: number, z: number): number;
    /** 地形だけの高さ */
    ground(x: number, z: number): number;
    /** 最寄りの道路までの距離[m] */
    road(x: number, z: number): number;
}

/** 隠し場所として認める道路からの距離[m]（近すぎ = 道のど真ん中 / 遠すぎ = 山の中） */
const HIDE_NEAR = 7;
const HIDE_FAR = 70;
/** いちばん「らしい」道路からの距離[m]（建物の裏・庭・路地のスケール） */
const HIDE_IDEAL = 20;
/** 立てるとみなす条件: 足場と地形の差[m]（屋根・建物の中を弾く） と 傾き[m] */
const HIDE_ON_GROUND = 0.8;
const HIDE_SLOPE = 1.3;
/** 周囲に立てる地面があるか確かめる半径[m]（E101） */
const HIDE_CLEAR = 1.5;
/** 隠し場所の候補数（多いほど良い場所が見つかるが、道路走査のぶん重くなる） */
const HIDE_TRIES = 32;

/** その場に立てるか（屋根の上・建物の中・急斜面を弾く） */
function standable(probe: WorldProbe, x: number, z: number): boolean {
    const h = probe.surface(x, z);
    if (Math.abs(h - probe.ground(x, z)) > HIDE_ON_GROUND) return false;
    for (let i = 0; i < 4; i++) {
        const angle = (i / 4) * TAU;
        const cx = x + Math.cos(angle) * HIDE_CLEAR;
        const cz = z + Math.sin(angle) * HIDE_CLEAR;
        const nh = probe.surface(cx, cz);
        if (Math.abs(nh - h) > HIDE_SLOPE) return false;
        if (Math.abs(nh - probe.ground(cx, cz)) > HIDE_ON_GROUND) return false;
    }
    return true;
}

/**
 * 「見つける楽しさ」のある隠し場所を1つ選ぶ（契約14-3）。
 * 中心から radius 以内へ候補を散らし、**道路から少し外れていて到達できる**点を選ぶ。
 * probe が無い（ワールド未接続）ときは素直に散らした点を返す
 */
export function findHiddenSpot(
    seed: number,
    center: Point,
    radius: number,
    probe: WorldProbe | null,
    margin = 20,
): Point {
    const rnd = createRandom(seed >>> 0);
    let best: Point | null = null;
    let bestScore = -Infinity;
    let fallback: Point | null = null;
    for (let i = 0; i < HIDE_TRIES; i++) {
        const point = scatter(center, radius, rnd, margin);
        if (!probe) return point;
        if (!fallback) fallback = point;
        if (!standable(probe, point.x, point.z)) continue;
        const distance = probe.road(point.x, point.z);
        if (distance < HIDE_NEAR || distance > HIDE_FAR) continue;
        // 理想の距離にいちばん近いものを採る（同点なら先に出た候補 = シード順で安定）
        const score = -Math.abs(distance - HIDE_IDEAL);
        if (score <= bestScore) continue;
        bestScore = score;
        best = point;
    }
    return best ?? fallback ?? { x: center.x, z: center.z };
}

function clampToArea(value: number, margin: number): number {
    const limit = Math.max(0, AREA_HALF - margin);
    return value < -limit ? -limit : value > limit ? limit : value;
}

/** 中心から半径 radius 以内へ均等に散らした点（面積一様） */
function scatter(from: Point, radius: number, rnd: () => number, margin: number): Point {
    const angle = rnd() * TAU;
    const distance = Math.sqrt(rnd()) * radius;
    return {
        x: clampToArea(from.x + Math.cos(angle) * distance, margin),
        z: clampToArea(from.z + Math.sin(angle) * distance, margin),
    };
}

/**
 * シードから配置を作る。最終安置は実在POIの抽選で、そこから逆順に
 * 中心を外へ広げていくので「次の円は必ず現在の円のだいたい内側」になる。
 * previousSeed を渡すと、直前のマッチの最終安置は選ばない（契約13-4）
 */
export function buildLayout(
    seed: number,
    previousSeed: number | null = null,
    probe: WorldProbe | null = null,
): MatchLayout {
    const rnd = createRandom(seed);
    const radii = [START_RADIUS, STAGES[0].radius, STAGES[1].radius, STAGES[2].radius];

    // 最終安置＝実在POI（data-spec のランドマーク + bvmap Anno の実在注記。創作しない）
    const places = allPlaces();
    const order = shuffledOrder((seed ^ 0x3c79a1d5) >>> 0, places.length);
    const before = previousSeed === null ? -1 : shuffledOrder((previousSeed ^ 0x3c79a1d5) >>> 0, places.length)[0];
    const landmark = places[order[0] === before && order.length > 1 ? order[1] : order[0]];
    const c3 = scatter({ x: landmark.x, z: landmark.z }, radii[3] * 0.4, rnd, radii[3] * 0.6);
    const c2 = scatter(c3, (radii[2] - radii[3]) * 0.7, rnd, radii[2] * 0.5);
    const c1 = scatter(c2, (radii[1] - radii[2]) * 0.7, rnd, radii[1] * 0.5);
    const centers: Point[] = [{ x: 0, z: 0 }, c1, c2, c3];

    // 輸送機はエリア中心から少しずらした直線でエリアを横断する
    const angle = rnd() * TAU;
    const dirX = Math.cos(angle);
    const dirZ = Math.sin(angle);
    const offset = (rnd() - 0.5) * AREA_HALF * 0.8;
    const midX = -dirZ * offset;
    const midZ = dirX * offset;
    const half = AREA_HALF * 1.4;

    // 宝箱は最終安置の中の「隠れた」地点（道路のど真ん中を避け、建物の裏・庭・路地へ寄せる）
    const chest = findHiddenSpot((seed ^ 0x7a3b19c5) >>> 0, c3, radii[3] * 0.7, probe);

    return {
        seed,
        route: {
            x0: midX - dirX * half,
            z0: midZ - dirZ * half,
            x1: midX + dirX * half,
            z1: midZ + dirZ * half,
        },
        centers,
        radii,
        chest,
        finalPlace: landmark.name,
    };
}

// --- 時間割 -----------------------------------------------------------------

/** いまの安置。フレームごとに作り直さないよう、呼び側が持つオブジェクトへ書き込む */
export interface ZoneNow {
    x: number;
    z: number;
    r: number;
    /** 次の円（最終円に到達済みなら現在と同じ） */
    nx: number;
    nz: number;
    nr: number;
    /** 済んだ収縮の数（0..3） */
    stage: number;
    /** 次の収縮が始まるまで[s]（収縮中は0、全部終わったら -1） */
    until: number;
    shrinking: boolean;
}

export function createZoneNow(): ZoneNow {
    return { x: 0, z: 0, r: START_RADIUS, nx: 0, nz: 0, nr: START_RADIUS, stage: 0, until: 0, shrinking: false };
}

/** なめらかな収縮（等速だと止まる瞬間が硬い） */
function smoothstep(k: number): number {
    const t = k < 0 ? 0 : k > 1 ? 1 : k;
    return t * t * (3 - 2 * t);
}

export function zoneAt(layout: MatchLayout, t: number, out: ZoneNow): ZoneNow {
    let stage = 0;
    for (let i = 0; i < STAGES.length; i++) {
        if (t >= STAGES[i].to) stage = i + 1;
    }
    const { centers, radii } = layout;
    if (stage >= STAGES.length) {
        const last = centers[centers.length - 1];
        out.x = last.x;
        out.z = last.z;
        out.r = radii[radii.length - 1];
        out.nx = out.x;
        out.nz = out.z;
        out.nr = out.r;
        out.stage = STAGES.length;
        out.until = -1;
        out.shrinking = false;
        return out;
    }
    const s = STAGES[stage];
    const from = centers[stage];
    const to = centers[stage + 1];
    const k = t <= s.from ? 0 : smoothstep((t - s.from) / (s.to - s.from));
    out.x = from.x + (to.x - from.x) * k;
    out.z = from.z + (to.z - from.z) * k;
    out.r = radii[stage] + (radii[stage + 1] - radii[stage]) * k;
    out.nx = to.x;
    out.nz = to.z;
    out.nr = radii[stage + 1];
    out.stage = stage;
    out.until = t < s.from ? s.from - t : 0;
    out.shrinking = t > s.from && t < s.to;
    return out;
}

/** 方位の呼び名（-z が北・+x が東。ヒントの読み上げに使う・契約14-4） */
const COMPASS = ['北', '北東', '東', '南東', '南', '南西', '西', '北西'] as const;

/** (dx, dz) の向きを8方位の言葉にする */
export function compassName(dx: number, dz: number): string {
    const bearing = Math.atan2(dx, -dz);
    const index = Math.round((bearing / TAU) * 8);
    return COMPASS[((index % 8) + 8) % 8];
}

/** 秒を mm:ss へ（HUD 用） */
export function clock(seconds: number): string {
    const total = Math.max(0, Math.round(seconds));
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}
