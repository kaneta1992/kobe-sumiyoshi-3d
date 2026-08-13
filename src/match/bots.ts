/**
 * BOT（契約12）。ホストだけが思考を実行し、**人間とまったく同じ state 形式**で配る。
 * 受け手（他のピア・ホスト自身）は遠隔プレイヤーと同じ経路で描くので、ここは
 * 「座標・向き・速度を毎フレーム決める」ことだけに集中する。
 *
 * 決定性: 体数・降下地点・性格（速さのばらつき・反応の遅さ）はすべて
 * **マッチシード**から決まる（実行時乱数は使わない）。位置の進み方は dt 依存だが、
 * 判断の材料は全員が知っている情報だけなので、ホストが替わっても同じ動きになる。
 *
 * 物理は簡略化してよい（契約12-6）: コライダーは持たず、足場の高さ（レイキャスト1本）
 * へ吸着させる。壁は抜けるが、道路グラフに沿って歩くので見た目には出ない。
 *
 * 強さ: 移動は人間の全力疾走（5.2m/s）より遅い 4.3m/s。鍵・宝箱への反応にも
 * シード由来の遅れを入れてあるので、まっすぐ向かえば人間が先着できる。
 */
import type { Physics } from '../game/physics';
import { botPeerId, type BotState } from '../net/peers';
import type { World } from '../world';
import { buildRoadGraph, type RoadGraph } from '../world/road-graph';
import {
    BUMP_COOLDOWN,
    BUMP_REACH,
    CHANNEL_TIME,
    DROP_TIME,
    KEY_AT,
    OUTSIDE_SPEED,
    PLANE_CLEARANCE,
    REACH,
    createRandom,
    type MatchLayout,
    type ZoneNow,
} from './rules';

/** BOT の水平移動速度[m/s]（人間の全力 5.2 より遅い） */
const BOT_SPEED = 4.3;
/** 向きの追従[rad/s] */
const TURN_RATE = 5;
/** 経路の通過点に着いたとみなす距離[m] */
const WAYPOINT_REACH = 4;
/** 目標が動いたら経路を引き直す距離[m] と、放っておいても引き直す間隔[s] */
const REPATH_DISTANCE = 25;
const REPATH_INTERVAL = 6;
/** 進んでいないと判定する時間[s] と 距離[m]（E82） */
const STUCK_TIME = 1.6;
const STUCK_DISTANCE = 0.7;
/** スタックが続いたら最寄りの道路ノードへ寄せ直す（E82） */
const STUCK_WARP_COUNT = 3;
/** アイテムを拾う距離[m] */
const PICK_REACH = 2.4;
/** 経路の最大段数（これを超える経路は先頭ぶんだけ辿って引き直す） */
const PATH_MAX = 512;
/** 降下: 自由落下の速度[m/s] / 傘の速度[m/s] / 傘が開く高度[m] / 水平速度[m/s] */
const FALL_SINK = 55;
const CANOPY_SINK = 8;
const CANOPY_ALTITUDE = 110;
const FALL_GLIDE = 30;
/** 安置の外にいるときに中心へ戻り始める余裕[m] */
const ZONE_MARGIN = 30;
/** 宝箱・鍵へ向かい始めるまでの反応の遅れの幅[s]（シードで1体ずつ決まる） */
const REACT_DELAY = 12;

type Goal = 'drop' | 'item' | 'key' | 'chest' | 'zone';

/** 毎フレーム渡す進行状況（match/index が持っているものをそのまま渡す） */
export interface BotFrame {
    /** マッチ時計[s] */
    t: number;
    /** 実時間[s] */
    dt: number;
    zone: ZoneNow;
    keyLive: boolean;
    keyOwner: string | null;
    winner: string | null;
    /** 宝箱の開示段階（2 以上で BOT も宝箱の場所を知る） */
    reveal: number;
    chestX: number;
    chestY: number;
    chestZ: number;
}

export interface BotsOptions {
    world: World;
    physics: Physics;
    /** マッチ時計の倍率（早送り時は BOT も同じだけ速く動かす。既定は1） */
    speed: number;
    /** 鍵・宝箱の取得申告（ホスト自身が裁定する） */
    claimPrize(prize: 'key' | 'chest', botId: string): void;
    /** 場のアイテムの取得申告 */
    claimItem(index: number, botId: string): void;
    /** 未取得のアイテムを巡回する */
    eachDrop(visit: (index: number, x: number, z: number) => void): void;
    /** 人間（自分を含む）の位置を巡回する */
    eachHuman(visit: (id: string, x: number, y: number, z: number) => void): void;
    /** 体当たり（BOT → 誰か） */
    bump(targetId: string, dirX: number, dirZ: number): void;
    announce(text: string): void;
}

export interface Bots {
    /** マッチ開始。count 体を配置する（リマッチでも同じ経路・E87） */
    start(layout: MatchLayout, seed: number, count: number): void;
    reset(): void;
    /** ホストだけが呼ぶ。states が書き換わる */
    update(frame: BotFrame): void;
    /** 配信用の状態（update のあとに読む。使い回しの配列） */
    readonly states: readonly BotState[];
    readonly count: number;
    /** 1体引退させる（人間が途中参加したとき・E86） */
    retire(): void;
    /** BOT が体当たりを受けた（チャンネリングが切れる・E83） */
    knock(id: string, dirX: number, dirZ: number): void;
    /** 表示名（BOT でなければ null） */
    nameOf(id: string): string | null;
}

interface Bot {
    index: number;
    id: string;
    name: string;
    /** 'plane' 搭乗中 / 'fall' 降下中 / 'ground' 着地後 */
    phase: 'plane' | 'fall' | 'ground';
    x: number;
    y: number;
    z: number;
    yaw: number;
    speed: number;
    /** 降下地点 */
    dropX: number;
    dropZ: number;
    /** 飛び降りるマッチ時計[s] */
    jumpAt: number;
    /** 速さの個体差（0.9〜1.08） */
    pace: number;
    /** 鍵・宝箱へ反応するまでの遅れ[s] */
    delay: number;
    goal: Goal;
    targetX: number;
    targetZ: number;
    /** 追いかけているアイテムの番号（-1 = 無し） */
    targetItem: number;
    path: Int32Array;
    pathLength: number;
    pathAt: number;
    repathIn: number;
    /** 経路を引き直した基準点（目標がこれだけ動いたら引き直す） */
    pathToX: number;
    pathToZ: number;
    stuckFor: number;
    stuckCount: number;
    lastX: number;
    lastZ: number;
    channel: number;
    bumpCooldown: number;
}

export function createBots(options: BotsOptions): Bots {
    const { world, physics, speed } = options;
    const planeY = world.stats.maxElevation + PLANE_CLEARANCE;
    /** 道路グラフは最初のマッチで1回だけ作る（ワールドは変わらない） */
    let graph: RoadGraph | null = null;

    const bots: Bot[] = [];
    const states: BotState[] = [];
    let layout: MatchLayout | null = null;
    let live = 0;
    /** 1フレームに1回だけ経路を引く（8体ぶんの A* を同じフレームに走らせない） */
    let pathBudget = 0;

    const makeBot = (index: number): Bot => ({
        index,
        id: botPeerId(index),
        name: `BOT ${index + 1}`,
        phase: 'plane',
        x: 0,
        y: 0,
        z: 0,
        yaw: 0,
        speed: 0,
        dropX: 0,
        dropZ: 0,
        jumpAt: 0,
        pace: 1,
        delay: 0,
        goal: 'drop',
        targetX: 0,
        targetZ: 0,
        targetItem: -1,
        path: new Int32Array(PATH_MAX),
        pathLength: 0,
        pathAt: 0,
        repathIn: 0,
        pathToX: 0,
        pathToZ: 0,
        stuckFor: 0,
        stuckCount: 0,
        lastX: 0,
        lastZ: 0,
        channel: 0,
        bumpCooldown: 0,
    });

    /** 目標を決め直す（全員が知っている情報だけで判断する） */
    const chooseGoal = (bot: Bot, frame: BotFrame): void => {
        if (!layout) return;
        const zone = frame.zone;
        const fromCenter = Math.hypot(bot.x - zone.x, bot.z - zone.z);
        // 安置の外（もしくは縁）にいるなら、まず中へ戻る
        if (fromCenter > zone.r - ZONE_MARGIN) {
            const scale = zone.r > 1 ? Math.max(0, (zone.r - ZONE_MARGIN * 2) / fromCenter) : 0;
            bot.goal = 'zone';
            bot.targetItem = -1;
            bot.targetX = zone.x + (bot.x - zone.x) * scale;
            bot.targetZ = zone.z + (bot.z - zone.z) * scale;
            return;
        }
        // 鍵を持っていれば宝箱へ（場所を知っているのは開示が進んでから）
        if (frame.keyOwner === bot.id && frame.reveal >= 2) {
            bot.goal = 'chest';
            bot.targetItem = -1;
            bot.targetX = frame.chestX;
            bot.targetZ = frame.chestZ;
            return;
        }
        // 鍵が出ていれば鍵へ（1体ずつ違う反応の遅れぶんは気づかない）
        if (frame.keyLive && frame.t >= KEY_AT + bot.delay) {
            bot.goal = 'key';
            bot.targetItem = -1;
            bot.targetX = layout.key.x;
            bot.targetZ = layout.key.z;
            return;
        }
        // それ以外は近くの未取得アイテムを拾いに行く
        let bestIndex = -1;
        let bestX = 0;
        let bestZ = 0;
        let bestDistance = 500;
        options.eachDrop((index, x, z) => {
            // 安置の外のアイテムは取りに行かない
            if (Math.hypot(x - zone.x, z - zone.z) > zone.r) return;
            const d = Math.hypot(x - bot.x, z - bot.z);
            if (d >= bestDistance) return;
            bestDistance = d;
            bestIndex = index;
            bestX = x;
            bestZ = z;
        });
        if (bestIndex >= 0) {
            bot.goal = 'item';
            bot.targetItem = bestIndex;
            bot.targetX = bestX;
            bot.targetZ = bestZ;
            return;
        }
        bot.goal = 'zone';
        bot.targetItem = -1;
        bot.targetX = zone.x;
        bot.targetZ = zone.z;
    };

    /** 目標までの経路を引く（1フレーム1本まで） */
    const repath = (bot: Bot): void => {
        if (!graph || pathBudget <= 0) return;
        pathBudget--;
        const from = graph.nearest(bot.x, bot.z, 160);
        const to = graph.nearest(bot.targetX, bot.targetZ, 160);
        bot.pathLength = from >= 0 && to >= 0 ? graph.findPath(from, to, bot.path) : 0;
        bot.pathAt = 0;
        bot.repathIn = REPATH_INTERVAL;
        bot.pathToX = bot.targetX;
        bot.pathToZ = bot.targetZ;
    };

    /** いま向かう先（経路の次の通過点、無ければ目標そのもの） */
    const steerTo = (bot: Bot, out: { x: number; z: number }): void => {
        if (!graph) {
            out.x = bot.targetX;
            out.z = bot.targetZ;
            return;
        }
        while (bot.pathAt < bot.pathLength) {
            const node = bot.path[bot.pathAt];
            const nx = graph.x(node);
            const nz = graph.z(node);
            if (Math.hypot(nx - bot.x, nz - bot.z) > WAYPOINT_REACH) {
                out.x = nx;
                out.z = nz;
                return;
            }
            bot.pathAt++;
        }
        out.x = bot.targetX;
        out.z = bot.targetZ;
    };

    const waypoint = { x: 0, z: 0 };

    // 体当たりの相手探し（フレーム内で関数を作らない）
    let scanBot: Bot | null = null;
    let bumpId = '';
    let bumpX = 0;
    let bumpZ = 0;
    const findBumpTarget = (id: string, x: number, _y: number, z: number): void => {
        if (!scanBot || bumpId !== '') return;
        const dx = x - scanBot.x;
        const dz = z - scanBot.z;
        if (Math.hypot(dx, dz) > BUMP_REACH) return;
        bumpId = id;
        bumpX = dx;
        bumpZ = dz;
    };

    const step = (bot: Bot, frame: BotFrame): void => {
        if (!layout) return;
        const dt = frame.dt;
        const t = frame.t;

        // --- 輸送機に乗っている間 ---
        if (bot.phase === 'plane') {
            const u = Math.min(1, Math.max(0, t / DROP_TIME));
            const route = layout.route;
            const px = route.x0 + (route.x1 - route.x0) * u;
            const pz = route.z0 + (route.z1 - route.z0) * u;
            const dirX = route.x1 - route.x0;
            const dirZ = route.z1 - route.z0;
            const length = Math.hypot(dirX, dirZ) || 1;
            bot.x = px - (dirX / length) * (12 + bot.index * 1.4);
            bot.z = pz - (dirZ / length) * (12 + bot.index * 1.4);
            bot.y = planeY - 1.5;
            bot.yaw = Math.atan2(-dirX / length, -dirZ / length);
            bot.speed = 0;
            if (t >= bot.jumpAt) bot.phase = 'fall';
            return;
        }

        const ground = physics.surfaceHeight(bot.x, bot.z);

        // --- 降下（自由落下 → 傘 → 着地） ---
        if (bot.phase === 'fall') {
            const dx = bot.dropX - bot.x;
            const dz = bot.dropZ - bot.z;
            const distance = Math.hypot(dx, dz);
            const altitude = bot.y - ground;
            const move = Math.min(distance, FALL_GLIDE * dt);
            if (distance > 0.5) {
                bot.x += (dx / distance) * move;
                bot.z += (dz / distance) * move;
                bot.yaw = Math.atan2(-dx, -dz);
            }
            bot.y -= (altitude > CANOPY_ALTITUDE ? FALL_SINK : CANOPY_SINK) * dt;
            bot.speed = 0;
            if (bot.y <= ground) {
                bot.y = ground;
                bot.phase = 'ground';
                bot.lastX = bot.x;
                bot.lastZ = bot.z;
                chooseGoal(bot, frame);
                repath(bot);
            }
            return;
        }

        // --- 地上 ---
        bot.y = ground;
        bot.bumpCooldown -= dt;
        bot.repathIn -= dt;

        // 目標の見直し（拾われた・鍵が出た・安置が動いた、をここで拾う）
        const previousGoal = bot.goal;
        const previousItem = bot.targetItem;
        chooseGoal(bot, frame);
        const goalMoved =
            bot.goal !== previousGoal ||
            bot.targetItem !== previousItem ||
            Math.hypot(bot.targetX - bot.pathToX, bot.targetZ - bot.pathToZ) > REPATH_DISTANCE;
        if (goalMoved || bot.repathIn <= 0 || bot.pathLength === 0) repath(bot);

        // --- 宝箱のチャンネリング（鍵を持っていて宝箱に触れている間） ---
        const toChest = Math.hypot(bot.x - frame.chestX, bot.z - frame.chestZ);
        if (frame.keyOwner === bot.id && !frame.winner && toChest < REACH) {
            if (bot.channel <= 0) options.announce(`${bot.name}が宝箱を開け始めた！`);
            bot.channel += dt * speed;
            bot.speed = 0;
            if (bot.channel >= CHANNEL_TIME) {
                bot.channel = 0;
                options.claimPrize('chest', bot.id);
            }
            // 立ち止まっている間も、寄ってきた相手は突き飛ばす
            if (bot.bumpCooldown <= 0) {
                scanBot = bot;
                bumpId = '';
                options.eachHuman(findBumpTarget);
                scanBot = null;
                if (bumpId !== '') {
                    const length = Math.hypot(bumpX, bumpZ) || 1;
                    options.bump(bumpId, bumpX / length, bumpZ / length);
                    bot.bumpCooldown = BUMP_COOLDOWN;
                }
            }
            return;
        }
        bot.channel = 0;

        // --- 移動 ---
        steerTo(bot, waypoint);
        const dx = waypoint.x - bot.x;
        const dz = waypoint.z - bot.z;
        const distance = Math.hypot(dx, dz);
        const outside = Math.hypot(bot.x - frame.zone.x, bot.z - frame.zone.z) > frame.zone.r;
        const pace = BOT_SPEED * bot.pace * speed * (outside ? OUTSIDE_SPEED : 1);
        if (distance > 0.3) {
            const move = Math.min(distance, pace * dt);
            bot.x += (dx / distance) * move;
            bot.z += (dz / distance) * move;
            const target = Math.atan2(-dx, -dz);
            const diff = Math.atan2(Math.sin(target - bot.yaw), Math.cos(target - bot.yaw));
            bot.yaw += diff * Math.min(1, TURN_RATE * dt);
            bot.speed = move / Math.max(dt, 1e-3);
        } else {
            bot.speed = 0;
        }

        // --- スタック検知（崖・行き止まり）→ 経路の引き直し → 近傍ワープ（E82） ---
        bot.stuckFor += dt;
        if (bot.stuckFor >= STUCK_TIME) {
            const moved = Math.hypot(bot.x - bot.lastX, bot.z - bot.lastZ);
            if (moved < STUCK_DISTANCE) {
                bot.stuckCount++;
                if (bot.stuckCount >= STUCK_WARP_COUNT && graph) {
                    const node = graph.nearest(bot.targetX, bot.targetZ, 400);
                    if (node >= 0) {
                        bot.x = graph.x(node);
                        bot.z = graph.z(node);
                        bot.y = physics.surfaceHeight(bot.x, bot.z);
                    }
                    bot.stuckCount = 0;
                }
                bot.pathLength = 0;
                repath(bot);
            } else {
                bot.stuckCount = 0;
            }
            bot.stuckFor = 0;
            bot.lastX = bot.x;
            bot.lastZ = bot.z;
        }

        // --- 拾得（アイテム → 鍵。裁定はホスト = 自分が出す・E83） ---
        if (bot.targetItem >= 0 && Math.hypot(bot.x - bot.targetX, bot.z - bot.targetZ) < PICK_REACH) {
            options.claimItem(bot.targetItem, bot.id);
            bot.targetItem = -1;
        }
        if (
            frame.keyLive &&
            !frame.keyOwner &&
            Math.hypot(bot.x - layout.key.x, bot.z - layout.key.z) < REACH
        ) {
            options.claimPrize('key', bot.id);
        }

        // --- 体当たり（走っている最中に相手へ突っ込んだとき） ---
        if (bot.bumpCooldown <= 0 && bot.speed > 2 && !frame.winner) {
            scanBot = bot;
            bumpId = '';
            options.eachHuman(findBumpTarget);
            scanBot = null;
            if (bumpId !== '') {
                const length = Math.hypot(bumpX, bumpZ) || 1;
                options.bump(bumpId, bumpX / length, bumpZ / length);
                bot.bumpCooldown = BUMP_COOLDOWN;
            }
        }
    };

    return {
        states,
        get count() {
            return live;
        },
        start(nextLayout, seed, count) {
            layout = nextLayout;
            live = Math.max(0, count);
            if (!graph && live > 0) graph = buildRoadGraph(world.mapFeatures.roads);
            // マッチ本体・アイテムとは別の列を使う（配置が絡まないようにひねる）
            const rnd = createRandom((seed ^ 0x2f6d1b53) >>> 0);
            while (bots.length < live) bots.push(makeBot(bots.length));
            states.length = 0;
            for (let i = 0; i < live; i++) {
                const bot = bots[i];
                bot.phase = 'plane';
                bot.jumpAt = DROP_TIME * (0.12 + rnd() * 0.7);
                bot.pace = 0.9 + rnd() * 0.18;
                bot.delay = rnd() * REACT_DELAY;
                // 降下地点は第1安置の中（そこそこ散らばり、収縮で置いていかれない）
                const angle = rnd() * Math.PI * 2;
                const radius = Math.sqrt(rnd()) * nextLayout.radii[1] * 0.85;
                const dropX = nextLayout.centers[1].x + Math.cos(angle) * radius;
                const dropZ = nextLayout.centers[1].z + Math.sin(angle) * radius;
                const road = graph;
                const node = road ? road.nearest(dropX, dropZ, 300) : -1;
                bot.dropX = road && node >= 0 ? road.x(node) : dropX;
                bot.dropZ = road && node >= 0 ? road.z(node) : dropZ;
                bot.goal = 'drop';
                bot.targetX = bot.dropX;
                bot.targetZ = bot.dropZ;
                bot.targetItem = -1;
                bot.pathLength = 0;
                bot.pathAt = 0;
                bot.repathIn = 0;
                bot.stuckFor = 0;
                bot.stuckCount = 0;
                bot.channel = 0;
                bot.bumpCooldown = 0;
                bot.speed = 0;
                states.push({ index: i, mode: 0, x: 0, y: 0, z: 0, yaw: 0, speed: 0 });
            }
            if (live > 0) console.info(`[bots] ${live}体が参戦（降下は ${bots[0].jumpAt.toFixed(0)}s〜）`);
        },
        reset() {
            layout = null;
            live = 0;
            states.length = 0;
        },
        update(frame) {
            if (!layout) return;
            pathBudget = 1;
            for (let i = 0; i < live; i++) {
                const bot = bots[i];
                step(bot, frame);
                const state = states[i];
                state.mode = 0;
                state.x = bot.x;
                state.y = bot.y;
                state.z = bot.z;
                state.yaw = bot.yaw;
                state.speed = bot.speed;
            }
        },
        retire() {
            if (live <= 0) return;
            live--;
            states.length = live;
            console.info(`[bots] 人間の参加により1体引退（残り ${live}体）`);
        },
        knock(id, dirX, dirZ) {
            for (let i = 0; i < live; i++) {
                const bot = bots[i];
                if (bot.id !== id) continue;
                bot.channel = 0;
                bot.x += dirX * 1.5;
                bot.z += dirZ * 1.5;
                bot.pathLength = 0;
                return;
            }
        },
        nameOf(id) {
            for (const bot of bots) if (bot.id === id) return bot.name;
            return null;
        },
    };
}
