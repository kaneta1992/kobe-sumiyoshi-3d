/**
 * アイテムの実行時状態と「退屈ゼロ」ディレクター（契約11）。
 *
 * 受け持ち:
 *   拾得       接触で申告 → ホスト裁定（宝箱と同経路。先着が正・E73）
 *   所持       2枠 + 収集品（地図の切れ端はスロットを使わない）
 *   効果       どこでもドア / ステッキ / マント / 足袋 / 傘 / 霧玉 / 千里眼
 *   情報       ステッキの方向線・千里眼の扇形・地図の円・宝箱の気配（契約14）
 *   ディレクター ルートビーコン・コイン誘導・補給機・リード監視・アンチストール
 *
 * 契約14の情報経済: **無償で宝箱の位置を出すものはここには無い**。プレイヤーが自分で
 * 使ったアイテムだけが手がかりを残し、それはマッチが終わるまでマップに積み上がる。
 *
 * 決定性: 配置も補給機の時刻も **シード + マッチ時計** から決まる（実行時乱数は使わない）。
 * リード監視の前倒しも「全員が同じように知っている情報」（残りビーコン数・クレート）
 * だけで判定するので、各クライアントで同じタイミングに発火する。
 *
 * 効果時間は**実時間**で数える（?matchspeed で早送りしてもアイテムの体感は変えない）。
 */
import type { Game } from '../game';
import type { MapDraw } from '../ui/map';
import type { World } from '../world';
import { placeName } from '../world/landmarks';
import type { MatchHud } from './hud';
import type { MatchItemObjects } from './item-objects';
import {
    ITEMS,
    LEAD_MIN,
    MATCH_DEBUG,
    buildItemLayout,
    debugItems,
    findLookouts,
    type ItemId,
    type ItemLayout,
} from './items';
import type { MatchObjects } from './objects';
import {
    ANTI_STALL_AFTER,
    FINAL_ZONE_AT,
    PLANE_CLEARANCE,
    REACH,
    SENSE_RADIUS,
    compassName,
    createRandom,
    type MatchLayout,
    type WorldProbe,
} from './rules';
import type { Wildlife } from './wildlife';

const TAU = Math.PI * 2;

/** アイテムを拾える距離[m] と 高さの差[m] */
const PICK_REACH = 2.4;
const PICK_HEIGHT = 4.5;
/**
 * ⚡（速度アップ）を拾える距離[m]。契約14-9 で 2.6 → 4.2 へ広げた:
 * 道なりに走るだけで列が拾えるようにする（狙って踏みに行かなくてよい）
 */
const COIN_REACH = 4.2;
/** ⚡を描く距離[m]。列は数百個あるのでインスタンス上限に収まるよう近傍だけ出す */
const COIN_DRAW = 170;
/**
 * ⚡1個ぶんの永続速度アップと、⚡だけで届く上限倍率（契約13-10 / 契約14-9）。
 * 0.03 なので上限 2.0 には **34個**で届く（1マッチで現実的に到達できる量）。
 * マッチ中は減らない・リマッチでリセット。取得は各自ローカル（同期しない）
 */
const SPEED_PER_COIN = 0.03;
const SPEED_CAP = 2;
/**
 * 韋駄天の地下足袋の移動倍率。**⚡の上限2倍の上に重ねてよい**（契約13 追記の項目11。
 * レアアイテムの突破感を優先する裁定）。最大 2.0 × 1.3 = 2.6 倍
 */
const TABI_SPEED = 1.3;
/** マント滑空: 落下速度の上限[m/s] と 水平速度[m/s] */
const CAPE_SINK = 2.2;
const CAPE_GLIDE = 12;
/** 傘: 落下速度の上限[m/s] と 水平速度[m/s]。傘が開くのはこの高さ以上[m] */
const UMBRELLA_SINK = 4.2;
const UMBRELLA_GLIDE = 6.5;
const UMBRELLA_ALTITUDE = 3;
/** 地図の切れ端が揃う枚数 と、揃ったときに出る円の半径[m]（契約14-4） */
const MAP_PIECES = 3;
const MAP_CIRCLE = 40;
/** 円の中心を宝箱からずらす最大距離[m]（中心が答えにならないように） */
const MAP_CIRCLE_OFFSET = 18;
/** 千里眼の扇形の半角[rad] と 距離帯の刻み[m]（契約14-4） */
const CONE_HALF = 0.26;
const BAND_STEP = 100;
/** ステッキの方向線をマップに描く長さ[m] */
const RAY_LENGTH = 1400;
/** 補給機がエリアを横切る時間[s]（マッチ時計）と、投下するまでの時間[s] */
const SUPPLY_FLIGHT = 18;
const SUPPLY_RELEASE = 8;
/** クレートの降下速度[m/s]（マッチ時計） */
const CRATE_SINK = 26;
/** リードが2未満のときに前倒しした補給機が飛ぶまで[s] */
const EARLY_LEAD_DELAY = 6;
/** アンチストールの花火を上げる高さ[m]（建物越しにも見える高さから散らす・契約14-7） */
const STALL_BURST_HEIGHT = 45;
/**
 * ビーコンを消す距離[m]。加算合成の柱の中に入ると画面が真っ白になるうえ、
 * そこまで来た人にはもう案内は要らない
 */
const BEACON_HIDE = 10;
/** 遠隔プレイヤーの効果表示が切れるまでの猶予[ms]（送信は1.2秒ごと） */
const FX_REFRESH = 1.2;
const FX_HOLD = 2.2;

/** 千里眼が使える見晴らしスポットからの距離[m] */
const LOOKOUT_USE = 22;
/** 気配の粒: 舞う半径[m]・高さ[m]・最大数（近いほど増える・契約14-5） */
const MOTE_RADIUS = 1.9;
const MOTE_HEIGHT = 1.3;
const MOTE_MAX = 14;
/** 偽宝箱（ミミック）が開く距離[m] と 開いたときに押し戻される距離[m] */
const MIMIC_REACH = REACH;
const MIMIC_PUSH = 2.4;

/** どこでもドアの着地点を探す同心円（半径[m]と分割数） */
const LAND_RINGS = [0, 5, 10, 17, 26, 38] as const;
/** 立てるとみなす傾き（2m 離れた地点との高低差[m]） */
const LAND_SLOPE = 1.7;

export interface DirectorOptions {
    world: World;
    game: Game;
    hud: MatchHud;
    /** 花火の打ち上げ・輸送機の使い回し（契約10 のオブジェクト） */
    objects: MatchObjects;
    items: MatchItemObjects;
    /** イノシシ（群れ・笛・ミミック。契約12） */
    wildlife: Wildlife;
    selfId: string;
    /** アイテム index を取ったと申告する（ホスト裁定へ流す） */
    claimItem(index: number): void;
    /** 効果を全員へ配る（fx パケット） */
    sendFx(effect: string, seconds: number): void;
    announce(text: string): void;
    nameOf(id: string): string;
    /** 遠隔プレイヤーの巡回（未接続なら1人も来ない） */
    eachPeer(visit: (id: string, x: number, y: number, z: number) => void): void;
}

/** 毎フレーム渡す進行状況 */
export interface DirectorFrame {
    /** マッチ時計[s] */
    t: number;
    /** 実時間の経過[s]（効果時間はこちらで数える） */
    dt: number;
    /** 宝箱の位置（ヒントの計算に使う。**表示には一切使わない**・契約14） */
    chestX: number;
    chestY: number;
    chestZ: number;
    /** 決着したか（アンチストールを止める） */
    over: boolean;
    /** 拾得・使用ができる状態か（降下中・観戦・決着後は false） */
    active: boolean;
}

export interface Director {
    /**
     * 全体マップの「1点を指す」入力を差し込む（どこでもドア）。
     * マップはマッチより後に作られるので、main.ts が後から渡す。
     * 開けたら true を返すこと（開けなければドアは消費されない）
     */
    attachMap(
        pick: (onPick: (x: number, z: number) => void, onCancel: () => void) => boolean,
    ): void;
    /**
     * マッチ開始。配置を作り直す（リマッチでも同じ経路・E76）。
     * previousSeed は直前のマッチのシード（POI の連続同一を避ける・契約13-4）
     */
    start(layout: MatchLayout, seed: number, previousSeed: number | null, probe: WorldProbe): void;
    /** ロビーへ戻す（全部消す） */
    reset(): void;
    update(frame: DirectorFrame): void;
    drawMap(draw: MapDraw): void;
    /** スロットを使う（HUD のボタン / 1・2キー） */
    useSlot(index: number): void;
    /** ホストの裁定を反映する */
    applyTake(index: number, who: string): void;
    /** 遠隔プレイヤーの効果表示（E77） */
    applyFx(peerId: string, effect: string, seconds: number): void;
    /** ステッキ・マップの探知から消えているか（霧玉・E77） */
    isFogged(id: string): boolean;
    /** アイテム由来の移動倍率（安置の減速と掛け合わせる） */
    readonly speedScale: number;
    /** いま回収できる場のアイテム（契約13-3）。無ければ null */
    readonly pickTarget: { mark: string; name: string } | null;
    /** 回収アクションを実行する（拾えたら true・契約13-3） */
    takePick(): boolean;
    /** 場に残っている⚡を巡回する（BOT も同じルールで拾う・契約13-10） */
    eachCoin(visit: (x: number, z: number) => void): void;
    /** ?matchgoto=item 用: いちばん近い未取得アイテムの位置 */
    nearestDrop(x: number, z: number): { x: number; z: number } | null;
    /** 場に残っているアイテムを巡回する（BOT の目標選び・契約12） */
    eachDrop(visit: (index: number, x: number, z: number) => void): void;
    /** ?matchgoto=mimic / lookout 用: いちばん近い偽宝箱 / 見晴らしスポット（契約12） */
    nearestMimic(x: number, z: number): { x: number; z: number } | null;
    nearestLookoutSpot(x: number, z: number): { x: number; z: number } | null;
    dispose(): void;
}

export function createDirector(options: DirectorOptions): Director {
    const { world, game, hud, objects, items, wildlife, selfId } = options;
    const planeY = world.stats.maxElevation + PLANE_CLEARANCE;
    /**
     * 見晴らしスポット（契約12）。地形は変わらないので最初のマッチで1回だけ測る。
     * 標高の上位から離れた4か所（全員が同じ場所になる）
     */
    let lookouts: { x: number; z: number; y: number }[] | null = null;

    let layout: ItemLayout | null = null;
    /** 全体マップの1点指し（main.ts が attachMap で差す。未接続なら false を返すだけ） */
    let pickOnMap: (
        onPick: (x: number, z: number) => void,
        onCancel: () => void,
    ) => boolean = () => false;
    /** 補給クレートの着地面の高さ[m]（配置ごとに1回だけ測る） */
    const supplyGround = new Float32Array(8);
    /** 0 = 場にある / 1 = 取られた / 2 = 自分が申告中（先行表示・E73） */
    let taken = new Uint8Array(0);
    let dropY = new Float32Array(0);
    let coinTaken = new Uint8Array(0);
    let coinY = new Float32Array(0);
    let spotY = new Float32Array(0);
    /** 補給機の飛来時刻[s]（前倒しで早まることがある）と、着地したか */
    let supplyAt = new Float32Array(0);
    let supplyLanded = new Uint8Array(0);
    let supplyTold = new Uint8Array(0);

    // --- 自分の所持と効果 ---
    const slots: (ItemId | null)[] = [null, null];
    /** 申告中のアイテム index → 入れたスロット（-1 = 地図の切れ端） */
    const pending = new Map<number, number>();
    let mapPieces = 0;
    let fogLeft = 0;
    /**
     * 集めた手がかり（契約14-4）。マッチが終わるまで消えない = 情報が積み上がる。
     * ステッキ = 使用地点から宝箱へ伸びる方向線 / 千里眼 = 方角+距離帯の扇形 /
     * 地図3枚 = 宝箱を含む半径40mの円
     */
    const marks: { x: number; y: number; z: number; angle: number }[] = [];
    const cones: { x: number; z: number; angle: number; near: number; far: number }[] = [];
    let mapCircle: { x: number; z: number } | null = null;
    /** 円の中心を宝箱からずらす向き（シード由来。中心＝答えにしない） */
    let circleSeed = 0;
    /** 宝箱・ミミックの気配の強さ 0..1（契約14-5）。0 = 何も感じない */
    let sense = 0;
    let senseTold = false;
    /** 拾った⚡の数（契約13-10。マッチ中は永続・リマッチでリセット） */
    let coins = 0;
    /** 回収アクションの対象になっている場のアイテム番号（-1 = 無し・契約13-3） */
    let pickIndex = -1;
    /** 偽宝箱の開封済みフラグと足元の高さ（契約12） */
    let mimicOpened = new Uint8Array(0);
    let mimicY = new Float32Array(0);
    let picking = false;
    let canUse = false;
    /** 遠隔へ配っている自分の空中状態 */
    let airState = '';
    let airSent = 0;
    /** 遠隔プレイヤーの効果（id → 効果名と失効するローカル時刻[ms]） */
    const peerFx = new Map<string, { effect: string; until: number }>();

    // --- ディレクターの進行 ---
    /** アンチストールの花火を上げたか（1マッチ1回・E103） */
    let stallFired = false;
    let leadWarned = false;
    /** 直近にログへ出したリード数（?matchdebug のときだけ使う） */
    let leadShown = -1;
    let spin = 0;
    let bob = 0;

    /** イノシシへ毎フレーム渡す進行状況（使い回して new を作らない） */
    const wildFrame = { t: 0, dt: 0 };

    /**
     * 直近フレームの宝箱の位置。ヒントを作るときにだけ読む
     * （アイテムを使った瞬間の計算に要るので、フレームの外からも参照できるよう控えておく）
     */
    let chestX = 0;
    let chestZ = 0;

    // 巡回コールバックは使い回す（フレーム内で関数を作らない）
    let peerNow = 0;
    const drawPeerFx = (id: string, x: number, y: number, z: number): void => {
        const fx = peerFx.get(id);
        if (!fx || fx.until < peerNow) return;
        if (fx.effect === 'canopy') items.canopies.push(x, y + 2.9, z, 0, 1);
        else if (fx.effect === 'glide') items.wings.push(x, y + 1.5, z, 0, 1);
    };

    function isFoggedAt(id: string, now: number): boolean {
        if (id === selfId) return fogLeft > 0;
        const fx = peerFx.get(id);
        return !!fx && fx.effect === 'fog' && fx.until >= now;
    }

    /** 立てる地点へ寄せる（建物の中・急斜面へ落とさない・E74） */
    const findStandable = (x: number, z: number): { x: number; z: number } => {
        const surface = game.physics.surfaceHeight;
        for (const radius of LAND_RINGS) {
            const steps = radius === 0 ? 1 : 8;
            for (let i = 0; i < steps; i++) {
                const angle = (i / steps) * TAU;
                const cx = x + Math.cos(angle) * radius;
                const cz = z + Math.sin(angle) * radius;
                const h = surface(cx, cz);
                const slope = Math.max(
                    Math.abs(h - surface(cx + 2, cz)),
                    Math.abs(h - surface(cx - 2, cz)),
                    Math.abs(h - surface(cx, cz + 2)),
                    Math.abs(h - surface(cx, cz - 2)),
                );
                if (slope < LAND_SLOPE) return { x: cx, z: cz };
            }
        }
        return { x, z };
    };

    /** 拾えたら true。同種2個目・枠が埋まっているときは拾わない（E75） */
    const takeIntoBag = (index: number, id: ItemId): boolean => {
        if (ITEMS[id].kind === 'collect') {
            mapPieces++;
            pending.set(index, -1);
            return true;
        }
        if (slots[0] === id || slots[1] === id) return false;
        const slot = slots[0] === null ? 0 : slots[1] === null ? 1 : -1;
        if (slot < 0) return false;
        slots[slot] = id;
        pending.set(index, slot);
        return true;
    };

    const dropFromBag = (index: number): void => {
        const slot = pending.get(index);
        if (slot === undefined) return;
        pending.delete(index);
        if (slot < 0) mapPieces = Math.max(0, mapPieces - 1);
        else slots[slot] = null;
    };

    /** 場のアイテムの数え上げ（ビーコンの点灯・リード監視に使う） */
    const spotAlive = (spot: number): boolean => {
        if (!layout) return false;
        const drops = layout.drops;
        for (let i = 0; i < drops.length; i++) {
            if (drops[i].spot === spot && taken[i] !== 1) return true;
        }
        return false;
    };

    // --- 使用 ---------------------------------------------------------------

    const useDoor = (slot: number): void => {
        if (picking) return;
        picking = true;
        const opened = pickOnMap(
            (x, z) => {
                picking = false;
                // 使い切りなので、行き先が決まった瞬間にスロットを空ける
                if (slots[slot] !== 'door') return;
                slots[slot] = null;
                const point = findStandable(x, z);
                const dx = point.x - game.state.x;
                const dz = point.z - game.state.z;
                game.teleportTo(point.x, point.z, Math.atan2(-dx, -dz));
                options.announce(`どこでもドアで${placeName(point.x, point.z)}へ移動した`);
            },
            () => {
                // 指さずに閉じたらドアは減らない（次にまた使える）
                picking = false;
            },
        );
        if (!opened) {
            picking = false;
            options.announce('マップを開けないため、どこでもドアは使えなかった');
        }
    };

    const useSlot = (index: number): void => {
        if (!canUse || index < 0 || index > 1) return;
        const id = slots[index];
        if (!id) return;
        const spec = ITEMS[id];
        if (spec.kind === 'hold') {
            options.announce(`${spec.name}は所持しているだけで効いている（${spec.hint}）`);
            return;
        }
        if (id === 'door') {
            useDoor(index);
            return;
        }
        if (id === 'stick') {
            // 契約14-4: 使い切り。使った地点で宝箱の方角へ倒れ、方向線がその場とマップに残る。
            // 2地点で使えば線の交点が宝箱 — この三角測量がゲームの中核
            slots[index] = null;
            const x = game.state.x;
            const z = game.state.z;
            const dx = chestX - x;
            const dz = chestZ - z;
            marks.push({ x, y: game.physics.surfaceHeight(x, z), z, angle: Math.atan2(dx, -dz) });
            objects.burst(x, game.state.y + 1, z, 0.74);
            options.announce(
                `尋ね人ステッキが${compassName(dx, dz)}へ倒れた — 方向線がマップに残った` +
                    (marks.length >= 2 ? '（2本目！交点を見ろ）' : '（別の場所でもう1本引け）'),
            );
            return;
        }
        if (id === 'fog') {
            slots[index] = null;
            fogLeft = spec.seconds;
            options.sendFx('fog', spec.seconds);
            objects.burst(game.state.x, game.state.y + 1.2, game.state.z, 0.56);
            options.announce('住吉川の霧玉 — 45秒、探知から消える');
            return;
        }
        if (id === 'whistle') {
            // 空中・乗り物の上では吹けない（着地してから乗る・E85）
            if (game.state.mode !== 'walk' || !game.state.grounded) {
                options.announce('地面に降りてからでないとイノシシは呼べない');
                return;
            }
            slots[index] = null;
            wildlife.summon();
            return;
        }
        if (id === 'eye') {
            const spot = nearestLookout(game.state.x, game.state.z);
            if (!spot) {
                options.announce('展望台の千里眼は「見晴らしスポット」でしか使えない');
                return;
            }
            // 契約14-4: 方角 + ざっくりした距離帯。扇形がマップに残る（点は出さない）
            slots[index] = null;
            const x = game.state.x;
            const z = game.state.z;
            const dx = chestX - x;
            const dz = chestZ - z;
            const distance = Math.hypot(dx, dz);
            const near = Math.max(0, Math.round(distance / BAND_STEP) * BAND_STEP - BAND_STEP);
            cones.push({ x, z, angle: Math.atan2(dx, -dz), near, far: near + BAND_STEP * 2 });
            objects.burst(x, game.state.y + 2, z, 0.42);
            options.announce(
                `展望台の千里眼 — 宝箱は${compassName(dx, dz)}へ ${near}〜${near + BAND_STEP * 2}m`,
            );
        }
    };

    /** 使える距離にある見晴らしスポット（無ければ null・契約12） */
    const nearestLookout = (x: number, z: number): { x: number; z: number; y: number } | null => {
        if (!lookouts) return null;
        for (const spot of lookouts) {
            if (Math.hypot(spot.x - x, spot.z - z) <= LOOKOUT_USE) return spot;
        }
        return null;
    };

    const onKeyDown = (e: KeyboardEvent): void => {
        if (e.repeat || !canUse) return;
        if (e.code === 'Digit1' || e.code === 'Numpad1') {
            useSlot(0);
            e.preventDefault();
        } else if (e.code === 'Digit2' || e.code === 'Numpad2') {
            useSlot(1);
            e.preventDefault();
        }
    };
    window.addEventListener('keydown', onKeyDown);

    // --- 更新 ---------------------------------------------------------------

    const updateSupplies = (frame: DirectorFrame): number => {
        if (!layout) return 0;
        let active = 0;
        for (let i = 0; i < layout.supplies.length; i++) {
            const supply = layout.supplies[i];
            const at = supplyAt[i];
            const t = frame.t;
            if (t < at) continue;
            const since = t - at;
            if (!supplyTold[i]) {
                supplyTold[i] = 1;
                options.announce(`補給機が飛来！${placeName(supply.x, supply.z)}へ物資投下`);
            }
            // 機体（契約10 の輸送機を使い回す。降下フェーズが終わってから飛ぶ）
            const angle = i * 2.3 + 0.7;
            const dirX = Math.cos(angle);
            const dirZ = Math.sin(angle);
            if (since < SUPPLY_FLIGHT) {
                const u = since / SUPPLY_FLIGHT - SUPPLY_RELEASE / SUPPLY_FLIGHT;
                objects.setTransport(
                    supply.x + dirX * u * 1500,
                    planeY,
                    supply.z + dirZ * u * 1500,
                    Math.atan2(-dirX, -dirZ),
                    true,
                );
            }
            const ground = supplyGround[i];
            const fall = since - SUPPLY_RELEASE;
            if (fall < 0) {
                active++;
                continue;
            }
            const y = Math.max(ground, planeY - fall * CRATE_SINK);
            const landed = y <= ground + 0.01;
            if (landed && !supplyLanded[i]) supplyLanded[i] = 1;
            // クレートは中身を取り切るまで置いておく
            const emptied = !spotAlive(-1 - i);
            if (!emptied) {
                items.crates.push(supply.x, y, supply.z, i * 0.6, 1);
                if (!landed) items.canopies.push(supply.x, y + 4.4, supply.z, i, 1.6);
                if (Math.hypot(game.state.x - supply.x, game.state.z - supply.z) > BEACON_HIDE) {
                    items.beacons.push(supply.x, ground, supply.z, 0, 1, 0x8fe3ff);
                }
                active++;
            }
        }
        return active;
    };

    /** 空中での補助（マント・傘）を決めて、遠隔へ配る状態も更新する */
    const updateAir = (frame: DirectorFrame): void => {
        const hasCape = slots[0] === 'cape' || slots[1] === 'cape';
        const hasUmbrella = slots[0] === 'umbrella' || slots[1] === 'umbrella';
        const airborne = frame.active && game.state.mode === 'walk' && !game.state.grounded;
        const altitude = game.state.y - world.getElevationAt(game.state.x, game.state.z);
        let next = '';
        if (airborne && hasCape && game.jumpHeld) next = 'glide';
        else if (airborne && hasUmbrella && altitude > UMBRELLA_ALTITUDE) next = 'canopy';

        if (next === 'glide') game.setAirAssist(CAPE_SINK, CAPE_GLIDE);
        else if (next === 'canopy') game.setAirAssist(UMBRELLA_SINK, UMBRELLA_GLIDE);
        else game.setAirAssist(0, 0);

        // 自分の見た目
        if (next === 'glide') {
            items.wings.push(game.state.x, game.state.y + 1.5, game.state.z, game.state.yaw, 1);
        } else if (next === 'canopy') {
            items.canopies.push(game.state.x, game.state.y + 2.9, game.state.z, game.state.yaw, 1);
        }

        // 遠隔への配信（状態が変わったときと、続いている間は1.2秒ごと）
        airSent -= frame.dt;
        if (next !== airState || (next !== '' && airSent <= 0)) {
            if (MATCH_DEBUG && next !== airState) {
                console.info(
                    `[director] 空中補助 ${airState || 'なし'} → ${next || 'なし'}` +
                        `　高度 ${altitude.toFixed(1)}m　時刻 ${(performance.now() * 0.001).toFixed(2)}s`,
                );
            }
            airState = next;
            airSent = FX_REFRESH;
            options.sendFx(next === '' ? 'off' : next, FX_HOLD);
        }
    };

    /** リードの数（全員が同じように知っている「行く理由」だけを数える） */
    const countLeads = (crates: number): number => {
        if (!layout) return 0;
        let leads = crates;
        for (let s = 0; s < layout.spots.length; s++) {
            if (spotAlive(s)) leads++;
        }
        return leads;
    };

    /**
     * 宝箱・ミミックの気配（契約14-5）。粒は**自分の周り**に舞わせる:
     * 宝箱の位置に出すと壁越しに方角が割れてしまう（E100）。
     * 「近い」ことだけを伝えて、どちらに近いかは自分の足で確かめさせる
     */
    const updateSense = (frame: DirectorFrame): void => {
        if (!layout || !frame.active) {
            sense = 0;
            senseTold = false;
            return;
        }
        const px = game.state.x;
        const pz = game.state.z;
        let nearest = Math.hypot(px - frame.chestX, pz - frame.chestZ);
        for (let i = 0; i < layout.mimics.length; i++) {
            // 開けてしまったミミックはもう気配を出さない（跡地に惑わされない）
            if (mimicOpened[i]) continue;
            const d = Math.hypot(px - layout.mimics[i].x, pz - layout.mimics[i].z);
            if (d < nearest) nearest = d;
        }
        sense = nearest >= SENSE_RADIUS ? 0 : 1 - nearest / SENSE_RADIUS;
        if (sense <= 0) {
            senseTold = false;
            return;
        }
        if (!senseTold) {
            senseTold = true;
            options.announce('何かの気配がする… この辺りだ');
        }
        const count = Math.max(3, Math.round(sense * MOTE_MAX));
        for (let i = 0; i < count; i++) {
            const phase = bob * 0.6 + (i / count) * TAU;
            const radius = MOTE_RADIUS * (0.55 + 0.45 * Math.sin(phase * 1.7 + i));
            items.motes.push(
                px + Math.cos(phase) * radius,
                game.state.y + MOTE_HEIGHT + Math.sin(phase * 2.3 + i) * 0.5,
                pz + Math.sin(phase) * radius,
                phase,
                0.6 + sense * 0.6,
            );
        }
    };

    const update = (frame: DirectorFrame): void => {
        canUse = frame.active && !picking;
        if (!layout) return;
        const { t, dt } = frame;
        spin = (spin + dt * 1.6) % TAU;
        bob += dt * 2.4;
        fogLeft = Math.max(0, fogLeft - dt);
        peerNow = performance.now();
        chestX = frame.chestX;
        chestZ = frame.chestZ;

        // 地図の切れ端が3枚そろったら「宝箱を含む円」を作る（契約14-4）。
        // 中心が答えにならないよう、シードで決まるぶんだけ宝箱からずらす
        if (!mapCircle && mapPieces >= MAP_PIECES) {
            const rnd = createRandom(circleSeed);
            const angle = rnd() * TAU;
            const offset = rnd() * MAP_CIRCLE_OFFSET;
            mapCircle = {
                x: chestX + Math.cos(angle) * offset,
                z: chestZ + Math.sin(angle) * offset,
            };
            options.announce(`宝の地図が揃った — 宝箱は半径${MAP_CIRCLE}mの円の中だ（M でマップ）`);
        }

        const px = game.state.x;
        const pz = game.state.z;
        const py = game.state.y;

        items.pickups.begin();
        items.beacons.begin();
        items.coins.begin();
        items.crates.begin();
        items.canopies.begin();
        items.wings.begin();
        items.boars.begin();
        items.mimics.begin();
        items.lookouts.begin();
        items.marks.begin();
        items.motes.begin();

        // --- 補給機・クレート ---
        const crates = updateSupplies(frame);

        // --- イノシシ（群れイベント・逃げる個体。契約12） ---
        wildFrame.t = t;
        wildFrame.dt = dt;
        wildlife.update(wildFrame);

        // --- 見晴らしスポット（千里眼が使える場所を目印で示す・契約12） ---
        if (lookouts) {
            for (const spot of lookouts) {
                items.lookouts.push(spot.x, spot.y, spot.z, 0, 1);
                if (Math.hypot(px - spot.x, pz - spot.z) > BEACON_HIDE) {
                    items.beacons.push(spot.x, spot.y + 3, spot.z, 0, 0.32, 0x64f0c8);
                }
            }
        }

        // --- 偽宝箱（ミミック・契約12。触れると開いてイノシシが飛び出す） ---
        for (let i = 0; i < layout.mimics.length; i++) {
            if (mimicOpened[i]) continue;
            const mimic = layout.mimics[i];
            items.mimics.push(mimic.x, mimicY[i], mimic.z, i * 1.7, 1);
            if (!frame.active) continue;
            if (Math.abs(py - mimicY[i]) > PICK_HEIGHT) continue;
            if (Math.hypot(px - mimic.x, pz - mimic.z) > MIMIC_REACH) continue;
            mimicOpened[i] = 1;
            wildlife.spook(mimic.x, mimic.z);
            objects.burst(mimic.x, mimicY[i] + 1, mimic.z, 0.05);
            const awayX = px - mimic.x;
            const awayZ = pz - mimic.z;
            const away = Math.hypot(awayX, awayZ) || 1;
            game.knockback(awayX / away, awayZ / away, MIMIC_PUSH);
            options.announce('ミミックだ！ 中からイノシシが飛び出して逃げていった');
        }

        // --- 場のアイテム（契約13-3: 接触の自動取得をやめ、回収アクションで取る） ---
        const drops = layout.drops;
        let nearestPick = -1;
        let nearestPickDistance = PICK_REACH;
        for (let i = 0; i < drops.length; i++) {
            if (taken[i] === 1) continue;
            const drop = drops[i];
            // クレートの中身はクレートが着地するまで出ない
            if (drop.spot < 0 && !supplyLanded[-1 - drop.spot]) continue;
            const y = dropY[i] + 0.85 + Math.sin(bob + i) * 0.14;
            items.pickups.push(drop.x, y, drop.z, spin + i, 1, ITEMS[drop.id].color);
            if (taken[i] === 2 || !frame.active) continue;
            if (Math.abs(py - dropY[i]) > PICK_HEIGHT) continue;
            const distance = Math.hypot(px - drop.x, pz - drop.z);
            if (distance > nearestPickDistance) continue;
            nearestPickDistance = distance;
            nearestPick = i;
        }
        pickIndex = nearestPick;

        // --- ルートビーコン（取り尽くすと消灯） ---
        for (let s = 0; s < layout.spots.length; s++) {
            if (!spotAlive(s)) continue;
            const spot = layout.spots[s];
            if (Math.hypot(px - spot.x, pz - spot.z) <= BEACON_HIDE) continue;
            items.beacons.push(spot.x, spotY[s], spot.z, 0, 1, 0xffd257);
        }

        // --- ⚡（触れるだけで拾える永続の速度アップ・契約13-10 / 契約14-9） ---
        // ここだけは回収ボタンを要求しない: 数が多く、拾うたびにボタンを押させると
        // 走る気持ちよさが死ぬ。拾った実感は HUD の倍率表示とスパークで返す。
        // 描くのは近傍だけ（列は数百個あり、インスタンス上限を超えると見えない⚡ができる）
        const sparks = layout.coins;
        for (let i = 0; i < sparks.length; i++) {
            if (coinTaken[i]) continue;
            const spark = sparks[i];
            const dx = px - spark.x;
            const dz = pz - spark.z;
            if (Math.abs(dx) < COIN_DRAW && Math.abs(dz) < COIN_DRAW) {
                items.coins.push(spark.x, coinY[i] + 0.75, spark.z, spin * 2 + i, 1);
            }
            if (!frame.active) continue;
            if (Math.abs(py - coinY[i]) > PICK_HEIGHT) continue;
            if (Math.hypot(dx, dz) > COIN_REACH) continue;
            coinTaken[i] = 1;
            coins++;
        }

        // --- 集めた手がかりの3D表示（倒れたステッキ）と 宝箱の気配（契約14-4/5） ---
        for (const mark of marks) items.marks.push(mark.x, mark.y + 0.02, mark.z, mark.angle, 1);
        updateSense(frame);

        // --- 所持効果 ---
        game.setSlopePower(hasTabi());
        updateAir(frame);
        options.eachPeer(drawPeerFx);

        // --- アンチストール（契約14-7。定期花火の置き換え） ---
        // 最終安置に入って3分たっても誰も回収しないときだけ、**1マッチ1回**方向花火を上げる
        if (!stallFired && !frame.over && t >= FINAL_ZONE_AT + ANTI_STALL_AFTER) {
            stallFired = true;
            objects.burst(frame.chestX, frame.chestY + STALL_BURST_HEIGHT, frame.chestZ, 0.11);
            options.announce(
                `${placeName(frame.chestX, frame.chestZ)}の方角で花火が上がった！　宝箱はあのあたりだ`,
            );
            console.info(
                `[director] アンチストール花火 t=${t.toFixed(0)}s（最終安置 +${ANTI_STALL_AFTER}s・1マッチ1回）`,
            );
        }

        // --- リード監視（2未満なら次のイベントを前倒し） ---
        const leads = countLeads(crates);
        if (MATCH_DEBUG && leads !== leadShown) {
            leadShown = leads;
            console.info(`[director] リード ${leads}（下限 ${LEAD_MIN}）t=${t.toFixed(0)}s`);
        }
        if (leads < LEAD_MIN && t > 30) {
            if (!leadWarned) {
                leadWarned = true;
                let pulled = -1;
                for (let i = 0; i < supplyAt.length; i++) {
                    if (frame.t < supplyAt[i]) {
                        supplyAt[i] = t + EARLY_LEAD_DELAY;
                        pulled = i;
                        break;
                    }
                }
                if (pulled >= 0) {
                    console.info(
                        `[director] リード ${leads} < ${LEAD_MIN} → 補給機 #${pulled + 1} を t=${t.toFixed(0)}s へ前倒し`,
                    );
                    options.announce('しばらく動きが無い… 補給機が予定を早めて飛来する');
                } else {
                    // 宝箱の位置を漏らす花火は廃止（契約14-7）。残っているイベントが無ければ
                    // アンチストールの3分待ちに任せる
                    console.info(
                        `[director] リード ${leads} < ${LEAD_MIN} だが前倒しできるイベントが無い（t=${t.toFixed(0)}s）`,
                    );
                }
            }
        } else {
            leadWarned = false;
        }

        items.pickups.end();
        items.beacons.end();
        items.coins.end();
        items.crates.end();
        items.canopies.end();
        items.wings.end();
        items.boars.end();
        items.mimics.end();
        items.lookouts.end();
        items.marks.end();
        items.motes.end();

        // --- HUD ---
        hud.setSlots(slotView(0), slotView(1));
        hud.setBadge(badgeText());
    };

    const slotView = (index: number): { mark: string; name: string; note: string } | null => {
        const id = slots[index];
        if (!id) return null;
        const spec = ITEMS[id];
        return { mark: spec.mark, name: spec.name, note: spec.kind === 'hold' ? '常時' : '使用' };
    };

    /** ⚡ だけで決まる倍率（上限あり）。足袋はこの上に掛ける（契約13 項目11） */
    const coinScale = (): number => Math.min(SPEED_CAP, 1 + coins * SPEED_PER_COIN);

    const badgeText = (): string => {
        // 速度倍率は常時表示（契約13-10）。⚡が0でも「×1.00」を出して成長が見えるようにする
        const parts: string[] = [`⚡ ×${(coinScale() * (hasTabi() ? TABI_SPEED : 1)).toFixed(2)}`];
        if (mapPieces > 0) parts.push(`🗺 ${Math.min(mapPieces, MAP_PIECES)}/${MAP_PIECES}`);
        if (hasTabi()) parts.push(`👟 ×${TABI_SPEED}`);
        if (slots[0] === 'cape' || slots[1] === 'cape') parts.push('🦅 Space長押しで滑空');
        // 集めた手がかりの数（マップ(M)で重ねて見る・契約14-4）
        if (marks.length > 0) parts.push(`🔮 方向線 ${marks.length}`);
        if (cones.length > 0) parts.push(`👁 扇形 ${cones.length}`);
        if (mapCircle) parts.push('🗺 円');
        if (fogLeft > 0) parts.push(`🌫 ${Math.ceil(fogLeft)}s`);
        if (game.boarSeconds > 0) parts.push(`🐗 ${Math.ceil(game.boarSeconds)}s`);
        // 気配は距離が近いほど強い（契約14-5）
        if (sense > 0) parts.push(sense > 0.6 ? '✨ すぐそこだ！' : '✨ 気配');
        return parts.join('　');
    };

    const hasTabi = (): boolean => slots[0] === 'tabi' || slots[1] === 'tabi';

    return {
        attachMap(pick) {
            pickOnMap = pick;
        },
        start(nextLayout, seed, previousSeed, probe) {
            layout = buildItemLayout(seed, nextLayout, world.mapFeatures.roads, previousSeed, probe);
            circleSeed = (seed ^ 0x4d3ac71b) >>> 0;
            const surface = game.physics.surfaceHeight;
            // 見晴らしスポットは地形だけで決まるので1回測れば使い回せる（契約12）
            if (!lookouts) {
                lookouts = findLookouts(world.getElevationAt);
                for (const spot of lookouts) spot.y = surface(spot.x, spot.z);
                console.info(
                    `[director] 見晴らしスポット ${lookouts
                        .map((s) => `${s.x.toFixed(0)},${s.z.toFixed(0)}(${s.y.toFixed(0)}m)`)
                        .join(' / ')}`,
                );
            }
            mimicOpened = new Uint8Array(layout.mimics.length);
            mimicY = new Float32Array(layout.mimics.length);
            for (let i = 0; i < layout.mimics.length; i++) {
                mimicY[i] = surface(layout.mimics[i].x, layout.mimics[i].z);
            }
            wildlife.start(nextLayout, seed);
            taken = new Uint8Array(layout.drops.length);
            dropY = new Float32Array(layout.drops.length);
            for (let i = 0; i < layout.drops.length; i++) {
                dropY[i] = surface(layout.drops[i].x, layout.drops[i].z);
            }
            coinTaken = new Uint8Array(layout.coins.length);
            coinY = new Float32Array(layout.coins.length);
            for (let i = 0; i < layout.coins.length; i++) {
                coinY[i] = surface(layout.coins[i].x, layout.coins[i].z);
            }
            spotY = new Float32Array(layout.spots.length);
            for (let i = 0; i < layout.spots.length; i++) {
                spotY[i] = surface(layout.spots[i].x, layout.spots[i].z);
            }
            supplyAt = new Float32Array(layout.supplies.length);
            supplyLanded = new Uint8Array(layout.supplies.length);
            supplyTold = new Uint8Array(layout.supplies.length);
            for (let i = 0; i < layout.supplies.length; i++) {
                supplyAt[i] = layout.supplies[i].at;
                supplyGround[i] = surface(layout.supplies[i].x, layout.supplies[i].z);
            }
            // デバッグ: ?matchitem= で最初から持たせる
            for (const id of debugItems()) {
                if (ITEMS[id].kind === 'collect') mapPieces = MAP_PIECES;
                else if (slots[0] === null) slots[0] = id;
                else if (slots[1] === null) slots[1] = id;
            }
            console.info(
                `[director] アイテム ${layout.drops.length}（POI ${layout.spots.length}: ` +
                    `${layout.spots.map((s) => s.place).join('・')}）` +
                    `　⚡ ${layout.coins.length}　補給機 ${layout.supplies.map((s) => `${s.at}s`).join('/')}` +
                    `　ミミック ${layout.mimics.map((m) => `${m.x.toFixed(0)},${m.z.toFixed(0)}`).join(' / ')}`,
            );
        },
        reset() {
            layout = null;
            slots[0] = null;
            slots[1] = null;
            pending.clear();
            peerFx.clear();
            mapPieces = 0;
            fogLeft = 0;
            // ⚡の成長はマッチ単位。リマッチでは必ず 1.00 から（契約13-10）
            coins = 0;
            pickIndex = -1;
            // 集めた手がかりもマッチ単位。リマッチには持ち越さない（E99）
            marks.length = 0;
            cones.length = 0;
            mapCircle = null;
            sense = 0;
            senseTold = false;
            mimicOpened = new Uint8Array(0);
            wildlife.reset();
            picking = false;
            canUse = false;
            airState = '';
            stallFired = false;
            leadWarned = false;
            leadShown = -1;
            items.reset();
            game.setAirAssist(0, 0);
            game.setSlopePower(false);
            hud.setSlots(null, null);
            hud.setBadge('');
        },
        update,
        drawMap(draw) {
            if (!layout) return;
            const { ctx, screenX, screenY, ppm, scale, full } = draw;

            // --- 集めた手がかり（契約14-4）。線・扇形・円が重なるほど場所が絞れる ---
            // 千里眼の扇形（方角 + 距離帯）
            for (const cone of cones) {
                const sx = screenX(cone.x);
                const sy = screenY(cone.z);
                // 画面の角度へ（マップは +z が下・-z が上なので、北 = 上 = -90°）
                const base = cone.angle - Math.PI / 2;
                ctx.save();
                ctx.fillStyle = 'rgba(100, 240, 200, 0.16)';
                ctx.strokeStyle = 'rgba(100, 240, 200, 0.9)';
                ctx.lineWidth = 1.5 * scale;
                ctx.beginPath();
                ctx.arc(sx, sy, Math.max(1, cone.near * ppm), base - CONE_HALF, base + CONE_HALF);
                ctx.arc(sx, sy, Math.max(1, cone.far * ppm), base + CONE_HALF, base - CONE_HALF, true);
                ctx.closePath();
                ctx.fill();
                ctx.stroke();
                ctx.restore();
            }
            // ステッキの方向線（2本の交点が宝箱）
            for (const mark of marks) {
                const sx = screenX(mark.x);
                const sy = screenY(mark.z);
                ctx.save();
                ctx.strokeStyle = 'rgba(155, 123, 255, 0.95)';
                ctx.lineWidth = 2.2 * scale;
                ctx.beginPath();
                ctx.moveTo(sx, sy);
                ctx.lineTo(
                    screenX(mark.x + Math.sin(mark.angle) * RAY_LENGTH),
                    screenY(mark.z - Math.cos(mark.angle) * RAY_LENGTH),
                );
                ctx.stroke();
                ctx.fillStyle = '#9b7bff';
                ctx.beginPath();
                ctx.arc(sx, sy, 3.5 * scale, 0, TAU);
                ctx.fill();
                ctx.restore();
            }
            // 地図3枚の円（この中のどこかに宝箱がある）
            if (mapCircle) {
                ctx.save();
                ctx.strokeStyle = 'rgba(242, 209, 107, 0.95)';
                ctx.fillStyle = 'rgba(242, 209, 107, 0.14)';
                ctx.lineWidth = 2 * scale;
                ctx.setLineDash([6 * scale, 4 * scale]);
                ctx.beginPath();
                ctx.arc(screenX(mapCircle.x), screenY(mapCircle.z), Math.max(2, MAP_CIRCLE * ppm), 0, TAU);
                ctx.fill();
                ctx.stroke();
                ctx.restore();
            }
            // コインは全体マップでだけ薄く出す（ミニマップでは道路と喧嘩する）
            if (full) {
                ctx.fillStyle = 'rgba(255, 200, 60, 0.7)';
                for (let i = 0; i < layout.coins.length; i++) {
                    if (coinTaken[i]) continue;
                    const coin = layout.coins[i];
                    ctx.fillRect(screenX(coin.x) - 1.2, screenY(coin.z) - 1.2, 2.4, 2.4);
                }
            }
            // 未取得のアイテムPOI
            for (let s = 0; s < layout.spots.length; s++) {
                if (!spotAlive(s)) continue;
                const spot = layout.spots[s];
                ctx.fillStyle = '#ffd257';
                ctx.strokeStyle = '#ffffff';
                ctx.lineWidth = 2 * scale;
                ctx.beginPath();
                ctx.arc(screenX(spot.x), screenY(spot.z), 5 * scale, 0, TAU);
                ctx.fill();
                ctx.stroke();
            }
            // 走っているイノシシ（乗れる個体だけ。契約12の「群れ通過」を見つけられるように）
            wildlife.eachBoar((bx, bz, tame) => {
                if (!tame) return;
                ctx.fillStyle = '#6b5442';
                ctx.strokeStyle = '#ffffff';
                ctx.lineWidth = 1.2 * scale;
                ctx.beginPath();
                ctx.arc(screenX(bx), screenY(bz), 3.6 * scale, 0, TAU);
                ctx.fill();
                ctx.stroke();
            });

            // 見晴らしスポット（千里眼が使える場所・契約12）
            if (lookouts) {
                ctx.fillStyle = '#64f0c8';
                ctx.strokeStyle = '#ffffff';
                ctx.lineWidth = 1.5 * scale;
                for (const spot of lookouts) {
                    const sx = screenX(spot.x);
                    const sy = screenY(spot.z);
                    const size = 5 * scale;
                    ctx.beginPath();
                    ctx.moveTo(sx, sy - size);
                    ctx.lineTo(sx + size, sy + size * 0.8);
                    ctx.lineTo(sx - size, sy + size * 0.8);
                    ctx.closePath();
                    ctx.fill();
                    ctx.stroke();
                }
            }
            // 補給クレート
            for (let i = 0; i < layout.supplies.length; i++) {
                if (!supplyLanded[i] || !spotAlive(-1 - i)) continue;
                const supply = layout.supplies[i];
                ctx.fillStyle = '#8fe3ff';
                ctx.strokeStyle = '#ffffff';
                ctx.lineWidth = 2 * scale;
                const size = 5 * scale;
                ctx.beginPath();
                ctx.rect(screenX(supply.x) - size, screenY(supply.z) - size, size * 2, size * 2);
                ctx.fill();
                ctx.stroke();
            }

            // --- 凡例（全体マップだけ・E99）。手がかりの種類が見分けられるようにする ---
            if (!full) return;
            const rows: [string, string][] = [];
            if (marks.length > 0) rows.push(['#9b7bff', 'ステッキの方向線（交点＝宝箱）']);
            if (cones.length > 0) rows.push(['#64f0c8', '千里眼の扇形（方角と距離帯）']);
            if (mapCircle) rows.push(['#f2d16b', `地図の円（半径${MAP_CIRCLE}m・この中）`]);
            if (rows.length === 0) return;
            ctx.save();
            ctx.font = `${12 * scale}px system-ui, sans-serif`;
            ctx.textBaseline = 'middle';
            ctx.textAlign = 'left';
            const lineHeight = 18 * scale;
            const swatch = 14 * scale;
            const pad = 8 * scale;
            const textAt = 10 + pad + swatch + 6 * scale;
            let boxWidth = 0;
            for (const row of rows) {
                boxWidth = Math.max(boxWidth, ctx.measureText(row[1]).width);
            }
            boxWidth += textAt - 10 + pad;
            // 下端の操作ヒントバーと重ならない高さに置く
            const top = draw.h - 52 - rows.length * lineHeight - pad;
            ctx.fillStyle = 'rgba(16, 18, 24, 0.72)';
            ctx.fillRect(10, top, boxWidth, rows.length * lineHeight + pad * 2);
            for (let i = 0; i < rows.length; i++) {
                const y = top + pad + lineHeight * (i + 0.5);
                ctx.fillStyle = rows[i][0];
                ctx.fillRect(10 + pad, y - 3 * scale, swatch, 6 * scale);
                ctx.fillStyle = '#eef2f7';
                ctx.fillText(rows[i][1], textAt, y);
            }
            ctx.restore();
        },
        useSlot,
        applyTake(index, who) {
            if (!layout || index < 0 || index >= taken.length) return;
            const mine = pending.has(index);
            if (taken[index] === 1) {
                if (mine) dropFromBag(index);
                return;
            }
            taken[index] = 1;
            if (who === selfId) {
                pending.delete(index);
                return;
            }
            if (mine) {
                // 先を越された。先行表示していたぶんを取り消す（E73）
                dropFromBag(index);
                options.announce(`${options.nameOf(who)}が先にアイテムを拾った`);
            }
        },
        applyFx(peerId, effect, seconds) {
            if (effect === 'off') {
                peerFx.delete(peerId);
                return;
            }
            if (effect !== 'glide' && effect !== 'canopy' && effect !== 'fog') return;
            const hold = Math.max(0, Math.min(120, seconds));
            peerFx.set(peerId, { effect, until: performance.now() + hold * 1000 });
            if (effect === 'fog') {
                options.announce(`${options.nameOf(peerId)}が霧に紛れて消えた`);
            }
        },
        isFogged(id) {
            return isFoggedAt(id, performance.now());
        },
        get speedScale() {
            // ⚡は上限2倍、足袋はその上に重ねる（契約13 項目11の裁定）
            return coinScale() * (hasTabi() ? TABI_SPEED : 1);
        },
        get pickTarget() {
            if (!layout || pickIndex < 0) return null;
            const spec = ITEMS[layout.drops[pickIndex].id];
            return { mark: spec.mark, name: spec.name };
        },
        takePick() {
            if (!layout || pickIndex < 0 || taken[pickIndex] !== 0) return false;
            const index = pickIndex;
            const drop = layout.drops[index];
            if (!takeIntoBag(index, drop.id)) {
                options.announce('持ち物がいっぱいで拾えない（1・2 で使うか、別のアイテムを取る）');
                return false;
            }
            taken[index] = 2;
            pickIndex = -1;
            options.claimItem(index);
            const spec = ITEMS[drop.id];
            options.announce(
                spec.kind === 'collect'
                    ? `${spec.name}を拾った（${Math.min(mapPieces, MAP_PIECES)}/${MAP_PIECES}）`
                    : `${spec.name}を手に入れた — ${spec.hint}`,
            );
            return true;
        },
        eachCoin(visit) {
            if (!layout) return;
            for (const spark of layout.coins) visit(spark.x, spark.z);
        },
        eachDrop(visit) {
            if (!layout) return;
            for (let i = 0; i < layout.drops.length; i++) {
                if (taken[i] === 1) continue;
                const drop = layout.drops[i];
                // クレートの中身は着地するまで場に出ていない
                if (drop.spot < 0 && !supplyLanded[-1 - drop.spot]) continue;
                visit(i, drop.x, drop.z);
            }
        },
        nearestMimic(x, z) {
            if (!layout) return null;
            let best: { x: number; z: number } | null = null;
            let bestDistance = Infinity;
            for (let i = 0; i < layout.mimics.length; i++) {
                if (mimicOpened[i]) continue;
                const d = Math.hypot(layout.mimics[i].x - x, layout.mimics[i].z - z);
                if (d >= bestDistance) continue;
                bestDistance = d;
                best = layout.mimics[i];
            }
            return best;
        },
        nearestLookoutSpot(x, z) {
            if (!lookouts) return null;
            let best: { x: number; z: number } | null = null;
            let bestDistance = Infinity;
            for (const spot of lookouts) {
                const d = Math.hypot(spot.x - x, spot.z - z);
                if (d >= bestDistance) continue;
                bestDistance = d;
                best = spot;
            }
            return best;
        },
        nearestDrop(x, z) {
            if (!layout) return null;
            let best: { x: number; z: number } | null = null;
            let bestDistance = Infinity;
            for (let i = 0; i < layout.drops.length; i++) {
                if (taken[i] === 1) continue;
                if (layout.drops[i].spot < 0 && !supplyLanded[-1 - layout.drops[i].spot]) continue;
                const d = Math.hypot(layout.drops[i].x - x, layout.drops[i].z - z);
                if (d >= bestDistance) continue;
                bestDistance = d;
                best = { x: layout.drops[i].x, z: layout.drops[i].z };
            }
            return best;
        },
        dispose() {
            window.removeEventListener('keydown', onKeyDown);
            items.dispose();
            game.setAirAssist(0, 0);
            game.setSlopePower(false);
        },
    };
}
