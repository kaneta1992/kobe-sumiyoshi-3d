/**
 * 六甲のイノシシ（契約12）。3種類の出どころを1つの群れとして扱う:
 *   1. ディレクターの「群れ通過」イベント（数頭が走り抜ける。乗れる）
 *   2. イノシシ呼び笛で召喚した1頭（すぐ乗れる）
 *   3. ミミックから飛び出した1頭（乗れない。逃げるだけ）
 *
 * 決定性: 群れの時刻・湧き位置・向きはマッチシードから決まる。走る先は
 * 「向きに沿って地形の上を進む」だけで、経路探索は使わない（イノシシは道を歩かない）。
 *
 * 描画は InstancedMesh 1本（item-objects の boars プール）なので、
 * 何頭出ても描画コールは1のまま。
 */
import type { Game } from '../game';
import type { World } from '../world';
import { placeName } from '../world/landmarks';
import type { MatchItemObjects } from './item-objects';
import { createRandom, createZoneNow, zoneAt, type MatchLayout } from './rules';

const TAU = Math.PI * 2;

/** 同時に走れる頭数（プールの上限と合わせる） */
const MAX_BOARS = 8;
/** 群れイベントの時刻[s]（マッチ時計）と 1回の頭数 */
const HERD_AT = [95, 235, 355] as const;
/** ?matchherd のときの時刻[s]（検証用に前倒しする） */
const HERD_AT_DEBUG = [10, 60, 110] as const;
const HERD_SIZE = 3;
/**
 * ?matchherd 群れを早めに、しかも**自分のすぐ近く**へ出す（検証用）。
 * 通常フローでは何も変わらない（時刻も湧き位置もシードどおり）
 */
const HERD_DEBUG = new URLSearchParams(location.search).has('matchherd');
/** 検証時に群れが湧く距離[m]（自分から見て手前）と、追いつけるようにした速さ[m/s] */
const HERD_DEBUG_DISTANCE = 40;
const HERD_DEBUG_SPEED = 1.6;
/** 群れが走る速さ[m/s] と 走り続ける時間[s] */
const HERD_SPEED = 7.5;
const HERD_LIFE = 55;
/** ミミックから飛び出した個体の速さ[m/s] と 逃げる時間[s] */
const SPOOK_SPEED = 9;
const SPOOK_LIFE = 6;
/** 乗れる距離[m]（走っている個体に横から飛び乗るので、拾得より広めにとる） */
const MOUNT_REACH = 5.5;
/** 騎乗の持続[s]（実時間。90秒で山へ帰る） */
export const RIDE_SECONDS = 90;
/** 群れの間隔[m]（横に広がって走る） と 安置中心からどれだけ手前に湧くか[m] */
const HERD_SPREAD = 4.5;
const HERD_START = 260;

interface Boar {
    alive: boolean;
    x: number;
    y: number;
    z: number;
    yaw: number;
    speed: number;
    left: number;
    /** 乗れる個体か（ミミックから出たものは乗れない） */
    tame: boolean;
    /** 進む向き */
    dirX: number;
    dirZ: number;
}

export interface WildlifeFrame {
    /** マッチ時計[s] */
    t: number;
    /** 実時間[s] */
    dt: number;
}

export interface Wildlife {
    /** マッチ開始（群れの時刻を決める） */
    start(layout: MatchLayout, seed: number): void;
    reset(): void;
    /** 毎フレーム（items.boars の begin と end の間で呼ぶ） */
    update(frame: WildlifeFrame): void;
    /** 笛で1頭呼ぶ（その場で乗せる） */
    summon(): void;
    /** ミミックから1頭飛び出させる（逃げるだけ） */
    spook(x: number, z: number): void;
    /** 近くの乗れる個体に乗る。乗ったら true（F の処理から呼ばれる） */
    tryMount(x: number, z: number): boolean;
    /** 走っている個体を巡回する（2Dマップの目印。乗れる個体だけ出す） */
    eachBoar(visit: (x: number, z: number, tame: boolean) => void): void;
}

export interface WildlifeOptions {
    world: World;
    game: Game;
    announce(text: string): void;
    items: MatchItemObjects;
}

export function createWildlife(options: WildlifeOptions): Wildlife {
    const { world, game, items } = options;
    const boars: Boar[] = [];
    for (let i = 0; i < MAX_BOARS; i++) {
        boars.push({
            alive: false,
            x: 0,
            y: 0,
            z: 0,
            yaw: 0,
            speed: 0,
            left: 0,
            tame: true,
            dirX: 0,
            dirZ: 1,
        });
    }
    /** 群れイベントの湧き位置と向き（シードで決まる） */
    const herdX = new Float32Array(HERD_AT.length);
    const herdZ = new Float32Array(HERD_AT.length);
    const herdAngle = new Float32Array(HERD_AT.length);
    const herdDone = new Uint8Array(HERD_AT.length);
    let ready = false;

    const spawn = (
        x: number,
        z: number,
        angle: number,
        tame: boolean,
        life: number,
        speed: number,
    ): void => {
        const boar = boars.find((entry) => !entry.alive);
        if (!boar) return;
        boar.alive = true;
        boar.x = x;
        boar.z = z;
        boar.y = world.getElevationAt(x, z);
        boar.dirX = Math.sin(angle);
        boar.dirZ = Math.cos(angle);
        // モデルは yaw=0 で -z を向く
        boar.yaw = Math.atan2(-boar.dirX, -boar.dirZ);
        boar.speed = speed;
        boar.left = life;
        boar.tame = tame;
    };

    return {
        start(layout, seed) {
            const rnd = createRandom((seed ^ 0x1d7c3af1) >>> 0);
            const zone = createZoneNow();
            for (let i = 0; i < HERD_AT.length; i++) {
                // その時刻の安置の中を横切らせる（人がいる場所を通す）
                zoneAt(layout, HERD_AT[i], zone);
                const angle = rnd() * TAU;
                // 円が広いうちも「人のいるあたり」を通したいので、湧きは中心の近くに寄せる
                const distance = Math.min(zone.r * 0.75, HERD_START);
                herdX[i] = zone.x - Math.sin(angle) * distance;
                herdZ[i] = zone.z - Math.cos(angle) * distance;
                herdAngle[i] = angle;
                herdDone[i] = 0;
            }
            for (const boar of boars) boar.alive = false;
            ready = true;
        },
        reset() {
            ready = false;
            for (const boar of boars) boar.alive = false;
        },
        update(frame) {
            if (!ready) return;
            // --- 群れイベントの発火 ---
            const times = HERD_DEBUG ? HERD_AT_DEBUG : HERD_AT;
            for (let i = 0; i < times.length; i++) {
                if (herdDone[i] || frame.t < times[i]) continue;
                herdDone[i] = 1;
                const angle = herdAngle[i];
                // 検証（?matchherd）では自分の手前から出す。通常はシードどおりの湧き位置
                const originX = HERD_DEBUG
                    ? game.state.x - Math.sin(angle) * HERD_DEBUG_DISTANCE
                    : herdX[i];
                const originZ = HERD_DEBUG
                    ? game.state.z - Math.cos(angle) * HERD_DEBUG_DISTANCE
                    : herdZ[i];
                for (let k = 0; k < HERD_SIZE; k++) {
                    const offset = (k - (HERD_SIZE - 1) / 2) * HERD_SPREAD;
                    spawn(
                        originX + Math.cos(angle) * offset,
                        originZ - Math.sin(angle) * offset,
                        angle,
                        true,
                        HERD_LIFE,
                        HERD_DEBUG ? HERD_DEBUG_SPEED : HERD_SPEED,
                    );
                }
                options.announce(
                    `イノシシの群れが${placeName(originX, originZ)}を通過中！ F で乗れる`,
                );
                console.info(
                    `[wildlife] 群れ#${i + 1} t=${frame.t.toFixed(0)}s ${originX.toFixed(0)},${originZ.toFixed(0)} 向き ${((angle * 180) / Math.PI).toFixed(0)}°`,
                );
            }

            // --- 移動と描画 ---
            for (const boar of boars) {
                if (!boar.alive) continue;
                boar.left -= frame.dt;
                if (boar.left <= 0) {
                    boar.alive = false;
                    continue;
                }
                boar.x += boar.dirX * boar.speed * frame.dt;
                boar.z += boar.dirZ * boar.speed * frame.dt;
                // 斜面は駆け上がる（イノシシは道を選ばない）
                boar.y = world.getElevationAt(boar.x, boar.z);
                items.boars.push(boar.x, boar.y, boar.z, boar.yaw, 1);
            }
        },
        summon() {
            // 呼んだらその場で乗る（乗り手の下のイノシシは game 側が描く）
            options.announce('イノシシ呼び笛 — 一頭が飛び出してきて、背に乗った！');
            game.mountBoar(RIDE_SECONDS);
        },
        eachBoar(visit) {
            for (const boar of boars) {
                if (boar.alive) visit(boar.x, boar.z, boar.tame);
            }
        },
        spook(x, z) {
            const away = Math.atan2(x - game.state.x, z - game.state.z);
            spawn(x, z, away, false, SPOOK_LIFE, SPOOK_SPEED);
        },
        tryMount(x, z) {
            if (!ready) return false;
            let best: Boar | null = null;
            let bestDistance = MOUNT_REACH;
            for (const boar of boars) {
                if (!boar.alive || !boar.tame) continue;
                const distance = Math.hypot(boar.x - x, boar.z - z);
                if (distance > bestDistance) continue;
                best = boar;
                bestDistance = distance;
            }
            if (!best) return false;
            best.alive = false;
            game.mountBoar(RIDE_SECONDS);
            options.announce('イノシシに飛び乗った！ 90秒だけ坂を駆け上がれる');
            return true;
        },
    };
}
