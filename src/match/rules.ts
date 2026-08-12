/**
 * マッチのルール表と決定的レイアウト（契約10）。
 *
 * 全クライアントが「シード1個」から同じ配置・同じ時間割を再現する。ネットワークを流れるのは
 * {シード, 開始時刻} と取得の裁定だけで、座標は一切送らない。
 * 実行時乱数は使わない（data-spec §4 の禁止事項）— ここの PRNG はシード由来。
 *
 * 時間はすべて「マッチ時計の秒」。マッチ時計は ?matchspeed= 倍で早送りできる（デバッグ用）。
 */
import { AREA_HALF } from '../config';
import { LANDMARKS } from '../world/landmarks';

const TAU = Math.PI * 2;

/** 開始ボタンから輸送機に乗るまでの間[ms]（実時間。早送りの対象外） */
export const COUNTDOWN = 3000;
/** 輸送機がエリアを横断しきる時間[s] = 降りられる猶予 */
export const DROP_TIME = 50;
/** 宝箱の回収に必要なチャンネリング[s] */
export const CHANNEL_TIME = 10;
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

/** 鍵が湧く時刻[s]（第2収縮の開始と同時） */
export const KEY_AT = STAGES[1].from;
/** 宝箱の位置ヒントが開く段階（1=四半区画 / 2=円 / 3=正確な位置） */
export const REVEAL_AT = [STAGES[0].from, STAGES[1].from, STAGES[2].from] as const;
/** リマッチ投票の自動締め切り[s]（実時間） */
export const VOTE_TIME = 10;
/** 宝箱・鍵に触れたとみなす距離[m] */
export const REACH = 2.6;
/** 体当たりが届く距離[m] と クールダウン[s] と 押し飛ばす距離[m] */
export const BUMP_REACH = 2.2;
export const BUMP_COOLDOWN = 3;
export const BUMP_PUSH = 1.5;
/** 体当たりが成立する最低速度[m/s]（走っていること） */
export const BUMP_SPEED = 3.2;
/** チャンネリングが中断される移動速度[m/s] */
export const CHANNEL_STILL = 0.5;
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

/** デバッグテレポートで対象から離しておく距離[m]。REACH より外なので接触判定は自分で歩いて成立させる */
export const GOTO_STANDOFF = 3;

/**
 * ?matchgoto=key|chest 目標の手前へテレポートする（デバッグ限定・鍵→宝箱の通し検証用）。
 * 無指定と不正値は null なので、通常フローには何も出ない
 */
export function matchGoto(): 'key' | 'chest' | null {
    const value = new URLSearchParams(location.search).get('matchgoto');
    return value === 'key' || value === 'chest' ? value : null;
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
    chest: Point;
    key: Point;
    /** 最終安置のランドマーク名（実況に使う） */
    finalPlace: string;
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
 * シードから配置を作る。最終安置は実在ランドマークの抽選で、そこから逆順に
 * 中心を外へ広げていくので「次の円は必ず現在の円のだいたい内側」になる。
 */
export function buildLayout(seed: number): MatchLayout {
    const rnd = createRandom(seed);
    const radii = [START_RADIUS, STAGES[0].radius, STAGES[1].radius, STAGES[2].radius];

    // 最終安置＝実在ランドマーク（座標が data-spec で確定しているものだけ）
    const landmark = LANDMARKS[Math.min(LANDMARKS.length - 1, Math.floor(rnd() * LANDMARKS.length))];
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

    // 宝箱は最終安置の中、鍵は第2円の外周寄り（中心で待つだけの試合にしない）
    const chest = scatter(c3, radii[3] * 0.55, rnd, 20);
    const keyAngle = rnd() * TAU;
    const keyDistance = radii[2] * (0.7 + rnd() * 0.2);
    const key = {
        x: clampToArea(c2.x + Math.cos(keyAngle) * keyDistance, 30),
        z: clampToArea(c2.z + Math.sin(keyAngle) * keyDistance, 30),
    };

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
        key,
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

/** 秒を mm:ss へ（HUD 用） */
export function clock(seconds: number): string {
    const total = Math.max(0, Math.round(seconds));
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}
