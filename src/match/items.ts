/**
 * アイテムの定義表と決定的配置（契約11）。
 *
 * 契約10 のレイアウトと同じ約束で動く: **シード1個から全員が同じ配置を再現**する。
 * ネットワークを流れるのは「誰が何番を取ったか」の裁定だけで、座標は一切送らない。
 * ここに実行時乱数は無い（PRNG はシード由来 = rules.ts の createRandom）。
 *
 * 配置の考え方（docs/game-design.md の退屈ゼロ設計）:
 *   - 湧きPOI は実在ランドマーク優先 → 足りないぶんは道路上へ散らす
 *   - POI へ向かう道路にコイン列を敷く（マリオのコイン誘導と同じ文法）
 *   - 補給機は中盤にその時刻の安置中心へ飛ぶ（人が集まる場所へ物を落とす）
 */
import { AREA_HALF } from '../config';
import type { RoadPath } from '../shared/road-profile.js';
import { LANDMARKS, placeName } from '../world/landmarks';
import { createRandom, createZoneNow, zoneAt, type MatchLayout } from './rules';

const TAU = Math.PI * 2;

export type ItemId = 'door' | 'stick' | 'cape' | 'tabi' | 'umbrella' | 'map' | 'fog';

export interface ItemSpec {
    id: ItemId;
    name: string;
    /**
     * use    = 使ってスロットを消費する
     * hold   = 持っているあいだ常時効く（使用操作は無い）
     * collect= スロットを使わない収集品（地図の切れ端）
     */
    kind: 'use' | 'hold' | 'collect';
    /** ピックアップとHUDの色 */
    color: number;
    /** HUD の絵記号 */
    mark: string;
    /** HUD の1行説明 */
    hint: string;
    /** use の効果時間[s]（実時間。0 = 即時） */
    seconds: number;
}

export const ITEMS: Readonly<Record<ItemId, ItemSpec>> = {
    door: {
        id: 'door',
        name: 'どこでもドア',
        kind: 'use',
        color: 0xff5fa2,
        mark: '🚪',
        hint: '使うとマップが開く。タップした地点へ飛ぶ',
        seconds: 0,
    },
    stick: {
        id: 'stick',
        name: '尋ね人ステッキ',
        kind: 'use',
        color: 0x9b7bff,
        mark: '🔮',
        hint: '30秒、最寄りプレイヤー（居なければ宝箱）の方角が出る',
        seconds: 30,
    },
    cape: {
        id: 'cape',
        name: '六甲おろしのマント',
        kind: 'hold',
        color: 0x2ecc71,
        mark: '🦅',
        hint: '所持中、ジャンプ長押しで滑空',
        seconds: 0,
    },
    tabi: {
        id: 'tabi',
        name: '韋駄天の地下足袋',
        kind: 'hold',
        color: 0xff9f2e,
        mark: '👟',
        hint: '所持中、移動+30%・急坂でも減速しない',
        seconds: 0,
    },
    umbrella: {
        id: 'umbrella',
        name: 'メリーポピンズの傘',
        kind: 'hold',
        color: 0x4fc3f7,
        mark: '☂',
        hint: '所持中、落下がゆっくり。高所から傘が再展開する',
        seconds: 0,
    },
    map: {
        id: 'map',
        name: '宝の地図の切れ端',
        kind: 'collect',
        color: 0xf2d16b,
        mark: '🗺',
        hint: '3枚集めると宝箱の正確な位置が出る',
        seconds: 0,
    },
    fog: {
        id: 'fog',
        name: '住吉川の霧玉',
        kind: 'use',
        color: 0xc9d6e4,
        mark: '🌫',
        hint: '45秒、ステッキ等の探知とマップから消える',
        seconds: 45,
    },
};

/** 湧きPOI の数（実在ランドマーク優先 → 残りは道路上へ散らす） */
const SPOT_COUNT = 8;
/** 1つのPOIに置くアイテム数 */
const PER_SPOT = 2;
/** POI どうしの最低距離[m] */
const SPOT_GAP = 210;
/** POI の中でアイテムを置く半径[m] */
const SPOT_RADIUS = 1.7;
/** コインの間隔[m] と POI から片側に何個敷くか */
const COIN_STEP = 8;
const COIN_PER_SIDE = 10;
/** コイン列を敷くのに十分な道路の長さ[m] と、その道を探しに行く範囲[m] */
const COIN_ROAD_LENGTH = 120;
const COIN_ROAD_SEARCH = 90;
/** 補給機の飛来時刻[s]（マッチ時計。ディレクターが前倒しすることがある） */
const SUPPLY_AT = [165, 300] as const;
/** クレートに入る良アイテムの候補（2つ1組） */
const SUPPLY_SETS: readonly (readonly [ItemId, ItemId])[] = [
    ['door', 'cape'],
    ['tabi', 'umbrella'],
    ['door', 'tabi'],
    ['cape', 'umbrella'],
];

/**
 * 場に置かれたアイテム1つ。spot >= 0 は湧きPOI、spot < 0 は補給クレート（-1-補給番号）。
 * 配列の**添字がそのまま裁定の識別子**になるので、順番を変えてはいけない
 */
export interface ItemDrop {
    x: number;
    z: number;
    id: ItemId;
    spot: number;
}

export interface ItemSpot {
    x: number;
    z: number;
    /** 実況に使う地名 */
    place: string;
}

export interface Supply {
    /** 既定の飛来時刻[s]（マッチ時計） */
    at: number;
    /** 投下地点 */
    x: number;
    z: number;
}

export interface ItemLayout {
    spots: readonly ItemSpot[];
    /** POI ぶん → 補給クレートぶん の順に並ぶ（添字が識別子） */
    drops: readonly ItemDrop[];
    coins: readonly { x: number; z: number }[];
    supplies: readonly Supply[];
    /** drops のうち POI ぶんの個数（これ以降はクレートが着地するまで場に出ない） */
    poiDrops: number;
}

function clampToArea(value: number, margin: number): number {
    const limit = Math.max(0, AREA_HALF - margin);
    return value < -limit ? -limit : value > limit ? limit : value;
}

/**
 * (x,z) にいちばん近い道路上の頂点。道路が1本も無ければ null。
 * minLength を渡すと短い区間を無視する（コイン列を敷ける長さの道を選ぶため）
 */
function nearestRoadVertex(
    roads: readonly RoadPath[],
    x: number,
    z: number,
    minLength = 0,
): { path: RoadPath; index: number; distance: number } | null {
    let best: { path: RoadPath; index: number; distance: number } | null = null;
    let bestDistance = Infinity;
    for (const path of roads) {
        if (path.length < minLength) continue;
        const points = path.points;
        for (let i = 0; i < points.length; i++) {
            const d = (points[i].x - x) ** 2 + (points[i].z - z) ** 2;
            if (d >= bestDistance) continue;
            bestDistance = d;
            if (best) {
                best.path = path;
                best.index = i;
            } else {
                best = { path, index: i, distance: 0 };
            }
        }
    }
    if (best) best.distance = Math.sqrt(bestDistance);
    return best;
}

/**
 * POI を置く道路上の点を選ぶ。コイン列が敷ける長さの道を優先し、
 * 近くに無ければ最寄りの道でよしとする
 */
function roadAnchor(
    roads: readonly RoadPath[],
    x: number,
    z: number,
): { path: RoadPath; index: number } | null {
    const long = nearestRoadVertex(roads, x, z, COIN_ROAD_LENGTH);
    if (long && long.distance < COIN_ROAD_SEARCH) return long;
    return nearestRoadVertex(roads, x, z);
}

/**
 * POI へ向かう道路にコインを敷く（両方向へ COIN_PER_SIDE 個ずつ）。
 * 頂点の位置ではなく**弧長**で等間隔に置く（長い直線区間でも列が途切れない）
 */
function layCoins(
    out: { x: number; z: number }[],
    path: RoadPath,
    index: number,
    step: number,
): void {
    const points = path.points;
    const dists = path.dists;
    const last = points.length - 1;
    const base = dists[index];
    for (const direction of [1, -1]) {
        for (let k = 1; k <= COIN_PER_SIDE; k++) {
            const target = base + direction * step * k;
            if (target < dists[0] || target > dists[last]) break;
            let i = 1;
            while (i < last && dists[i] < target) i++;
            const span = dists[i] - dists[i - 1];
            const t = span > 1e-6 ? (target - dists[i - 1]) / span : 0;
            out.push({
                x: points[i - 1].x + (points[i].x - points[i - 1].x) * t,
                z: points[i - 1].z + (points[i].z - points[i - 1].z) * t,
            });
        }
    }
}

/**
 * シードから配置を作る。roads は全員が同じデータを持っている（ワールドは全員同一）ので、
 * 道路へのスナップを挟んでも配置は一致する
 */
export function buildItemLayout(
    seed: number,
    layout: MatchLayout,
    roads: readonly RoadPath[],
): ItemLayout {
    // マッチ本体のシードと同じ列を使うと配置が絡むので、ひねってから使う
    const rnd = createRandom((seed ^ 0x5bf03635) >>> 0);
    const spots: ItemSpot[] = [];
    const coins: { x: number; z: number }[] = [];

    const push = (x: number, z: number): boolean => {
        const near = roadAnchor(roads, x, z);
        const px = near ? near.path.points[near.index].x : clampToArea(x, 40);
        const pz = near ? near.path.points[near.index].z : clampToArea(z, 40);
        for (const spot of spots) {
            if (Math.hypot(spot.x - px, spot.z - pz) < SPOT_GAP) return false;
        }
        spots.push({ x: px, z: pz, place: placeName(px, pz) });
        if (near) layCoins(coins, near.path, near.index, COIN_STEP);
        return true;
    };

    // 実在ランドマークを先に埋める（実況で地名を呼べる）
    for (const landmark of LANDMARKS) {
        if (spots.length >= SPOT_COUNT) break;
        push(landmark.x, landmark.z);
    }
    for (let guard = 0; guard < 400 && spots.length < SPOT_COUNT; guard++) {
        push((rnd() * 2 - 1) * (AREA_HALF - 180), (rnd() * 2 - 1) * (AREA_HALF - 180));
    }

    // アイテムの内訳。地図の切れ端は必ず3枚以上出す（4枚入れて1枚は取り損ねてもよくする）
    const pool: ItemId[] = ['map', 'map', 'map', 'map'];
    for (const id of ['door', 'stick', 'cape', 'tabi', 'umbrella', 'fog'] as const) {
        pool.push(id, id);
    }
    // 種類の偏りを均すシャッフル（Fisher-Yates・シード由来）
    for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(rnd() * (i + 1));
        const swap = pool[i];
        pool[i] = pool[j];
        pool[j] = swap;
    }

    const drops: ItemDrop[] = [];
    for (let s = 0; s < spots.length; s++) {
        for (let k = 0; k < PER_SPOT; k++) {
            const angle = ((k + 0.5) / PER_SPOT) * TAU + s;
            drops.push({
                x: spots[s].x + Math.cos(angle) * SPOT_RADIUS,
                z: spots[s].z + Math.sin(angle) * SPOT_RADIUS,
                id: pool[(s * PER_SPOT + k) % pool.length],
                spot: s,
            });
        }
    }
    const poiDrops = drops.length;

    // 補給クレート: その時刻の安置中心の内側へ落とす（人が集まる場所へ物を落とす）
    const zone = createZoneNow();
    const supplies: Supply[] = [];
    for (let i = 0; i < SUPPLY_AT.length; i++) {
        zoneAt(layout, SUPPLY_AT[i], zone);
        const angle = rnd() * TAU;
        const distance = Math.sqrt(rnd()) * zone.r * 0.6;
        const x = clampToArea(zone.x + Math.cos(angle) * distance, 40);
        const z = clampToArea(zone.z + Math.sin(angle) * distance, 40);
        supplies.push({ at: SUPPLY_AT[i], x, z });
        const set = SUPPLY_SETS[Math.floor(rnd() * SUPPLY_SETS.length) % SUPPLY_SETS.length];
        for (let k = 0; k < 2; k++) {
            drops.push({
                x: x + (k === 0 ? -1.3 : 1.3),
                z,
                id: set[k],
                spot: -1 - i,
            });
        }
    }

    return { spots, drops, coins, supplies, poiDrops };
}

/**
 * ?matchdebug でアイテム効果の遷移をコンソールへ出す（検証用）。
 * 起動時に1回だけ読む — 判定を毎フレームやらない
 */
export const MATCH_DEBUG = new URLSearchParams(location.search).has('matchdebug');

/**
 * 「行く理由」がこの数を下回ったら次のイベントを前倒しする（退屈ゼロのリード監視）。
 * 既定は設計どおり2。?matchlead=99 のように上げると必ず前倒しが起きるので、
 * 前倒しの経路そのものを検証できる
 */
export const LEAD_MIN = (() => {
    // 未指定は null。Number(null) が 0 になるので、先に有無を見ること（rules.ts と同じ罠）
    const value = new URLSearchParams(location.search).get('matchlead');
    if (value === null || value === '') return 2;
    const raw = Number(value);
    if (!Number.isFinite(raw)) return 2;
    return Math.max(0, Math.min(99, Math.round(raw)));
})();

/** ?matchitem=door,stick / all で開始時に持たせる（デバッグ）。不正値は無視 */
export function debugItems(): ItemId[] {
    const value = new URLSearchParams(location.search).get('matchitem');
    if (!value) return [];
    if (value === 'all') return ['door', 'stick', 'cape', 'tabi', 'umbrella', 'map', 'fog'];
    const out: ItemId[] = [];
    for (const part of value.split(',')) {
        const id = part.trim() as ItemId;
        if (id in ITEMS) out.push(id);
    }
    return out;
}
