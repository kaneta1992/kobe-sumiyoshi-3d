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
import { allPlaces, placeName } from '../world/landmarks';
import {
    createRandom,
    createZoneNow,
    findHiddenSpot,
    shuffledOrder,
    zoneAt,
    type MatchLayout,
    type WorldProbe,
} from './rules';

const TAU = Math.PI * 2;

/**
 * 所持アイテムは4種 + 枠外の収集品1種（契約15 追記10 のユーザー裁定）。
 * 傘・霧玉・イノシシ笛・千里眼は廃止した — 種類を絞って一つずつの役割を濃くする。
 * 旧アイテムの効果メッセージが古いクライアントから届いても、受信側は黙って捨てる
 */
export type ItemId = 'door' | 'stick' | 'cape' | 'tabi' | 'map';

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
        // 契約14-4: 中核アイテム。使った地点に方向線が残るので、2地点で使えば交点が出る
        hint: '使うと宝箱の方角へ倒れ、方向線がマップに残る（2本の交点で場所が絞れる）',
        seconds: 0,
    },
    cape: {
        id: 'cape',
        name: '六甲おろしのマント',
        kind: 'use',
        color: 0x2ecc71,
        mark: '🦅',
        // 契約15 追記10: 「所持中に滑空」から「使うと打ち上げ → スカイダイビング」へ。
        // 傘は付かないので、着地点は自分の空中操作だけで決める
        hint: '使うとはるか上空へ打ち上がる。そこから滑空してどこへでも降りられる',
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
    map: {
        id: 'map',
        name: '宝の地図の切れ端',
        kind: 'collect',
        color: 0xf2d16b,
        mark: '🗺',
        hint: '3枚集めると宝箱のいる半径40mの円がマップに出る',
        seconds: 0,
    },
};

/** 湧きPOI の数（実在POIの抽選 → 足りなければ道路上へ散らす） */
const SPOT_COUNT = 8;
/** 直近マッチで使ったとみなして避けるPOIの数（連続同一を防ぐ・契約13-4） */
const SPOT_AVOID = 12;
/** 1つのPOIに置くアイテム数 */
const PER_SPOT = 2;
/** POI どうしの最低距離[m] */
const SPOT_GAP = 210;
/** POI の中でアイテムを置く半径[m] */
const SPOT_RADIUS = 1.7;
/**
 * ⚡（速度アップ）の間隔[m] と POI から片側に何個敷くか。
 * 契約14-9: 「道なりに走れば自然に集まる」よう間隔を詰めて列を伸ばした
 * （拾う半径そのものは director 側の COIN_REACH で広げてある）
 */
const COIN_STEP = 7;
const COIN_PER_SIDE = 18;
/** コイン列を敷くのに十分な道路の長さ[m] と、その道を探しに行く範囲[m] */
const COIN_ROAD_LENGTH = 120;
const COIN_ROAD_SEARCH = 90;
/** 偽宝箱（ミミック・契約12）の数と、本物からの距離の範囲[m] */
const MIMIC_COUNT = 3;
const MIMIC_MIN = 45;
const MIMIC_RADIUS = 220;
/** ミミックの隠し場所を探す半径[m]（本物と同じ隠し方をする・契約14-4/E101） */
const MIMIC_HIDE = 55;
/** 補給機の飛来時刻[s]（マッチ時計。ディレクターが前倒しすることがある） */
const SUPPLY_AT = [165, 300] as const;
/** クレートに入る良アイテムの候補（2つ1組。4種になったので全組み合わせ） */
const SUPPLY_SETS: readonly (readonly [ItemId, ItemId])[] = [
    ['door', 'cape'],
    ['stick', 'tabi'],
    ['door', 'tabi'],
    ['cape', 'stick'],
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
    /** 偽宝箱（ミミック・契約12）。宝箱のヒント円の中に紛れ込ませる */
    mimics: readonly { x: number; z: number }[];
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

/** POI の抽選順（シードだけで決まる。前マッチの順とは別物になる・契約13-4） */
function spotOrder(seed: number, count: number): readonly number[] {
    return shuffledOrder((seed ^ 0x51ed270b) >>> 0, count);
}

/**
 * シードから配置を作る。roads は全員が同じデータを持っている（ワールドは全員同一）ので、
 * 道路へのスナップを挟んでも配置は一致する。
 * previousSeed を渡すと、直前のマッチが使ったPOIを避ける（契約13-4）
 */
export function buildItemLayout(
    seed: number,
    layout: MatchLayout,
    roads: readonly RoadPath[],
    previousSeed: number | null = null,
    probe: WorldProbe | null = null,
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

    // 実在POI（Anno 注記 + 基本ランドマーク）から**シードで抽選**する。
    // 直近マッチで使ったPOIは1周目で飛ばすので、連続で同じ場所に湧かない（契約13-4）
    const places = allPlaces();
    const order = spotOrder(seed, places.length);
    const avoid = previousSeed === null ? null : new Set(spotOrder(previousSeed, places.length).slice(0, SPOT_AVOID));
    for (let pass = 0; pass < 2 && spots.length < SPOT_COUNT; pass++) {
        for (const index of order) {
            if (spots.length >= SPOT_COUNT) break;
            if (pass === 0 && avoid?.has(index)) continue;
            if (pass === 1 && !avoid?.has(index)) continue;
            push(places[index].x, places[index].z);
        }
    }
    // 実在POIだけで足りなければ道路上へ散らす（POIが少ない環境でも成立させる）
    for (let guard = 0; guard < 400 && spots.length < SPOT_COUNT; guard++) {
        push((rnd() * 2 - 1) * (AREA_HALF - 180), (rnd() * 2 - 1) * (AREA_HALF - 180));
    }

    // アイテムの内訳。地図の切れ端は必ず3枚以上出す（4枚入れて1枚は取り損ねてもよくする）。
    // 4種になったぶん1種あたりの本数を増やして、POI 16枠が薄くならないようにする（追記10）
    const pool: ItemId[] = ['map', 'map', 'map', 'map'];
    for (const id of ['door', 'stick', 'cape', 'tabi'] as const) {
        pool.push(id, id, id);
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

    // 偽宝箱（ミミック・契約12/14）: 本物の周りへ、**本物とまったく同じ隠し方**で紛れ込ませる。
    // 道路脇に立てると「道路にあるのは偽物」と学習できてしまうので、隠し場所の判定を共有する
    const mimics: { x: number; z: number }[] = [];
    for (let i = 0; i < MIMIC_COUNT; i++) {
        const angle = rnd() * TAU;
        const distance = MIMIC_MIN + Math.sqrt(rnd()) * (MIMIC_RADIUS - MIMIC_MIN);
        const around = {
            x: clampToArea(layout.chest.x + Math.cos(angle) * distance, 20),
            z: clampToArea(layout.chest.z + Math.sin(angle) * distance, 20),
        };
        mimics.push(findHiddenSpot((seed ^ (0x2b1f0a7d + i * 0x9e3779b9)) >>> 0, around, MIMIC_HIDE, probe));
    }

    return { spots, drops, coins, supplies, poiDrops, mimics };
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
    if (value === 'all') return ['door', 'stick', 'cape', 'tabi', 'map'];
    const out: ItemId[] = [];
    for (const part of value.split(',')) {
        const id = part.trim() as ItemId;
        if (id in ITEMS) out.push(id);
    }
    return out;
}
