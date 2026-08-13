/**
 * マッチフロー（契約10 / 契約14）: ロビー → 輸送機スカイダイビング → 安置3段収縮 →
 * 隠された宝箱を探す → 触れて勝利 → リマッチ投票。?match のときだけ作られ、
 * 既定の自由散策には一切影響しない。
 *
 * 契約14の芯: **宝箱の位置は無償では開示しない**。光の柱もマップの★も定期花火も無い。
 * 無償の情報は安置の円（＝範囲）だけで、方向・距離・円はアイテムを使って自分で集める。
 *
 * 同期の設計:
 *   - ルーム内**最小ピアIDがホスト**。ホストが {seed, 開始時刻} を配って始める
 *   - 宝箱・安置の中心列・輸送機の経路は全員が seed から**決定的に再現**する（座標は送らない）
 *   - ネットワークを流れるのは開始の合図と、宝箱の**裁定**（ホストが出す award が正）だけ
 *   - ホストが落ちたら次点ピアが継承する。seed と開始時刻は全員が持っているので進行は続く（E62）
 *   - 相手の時計は受信時にローカル時計へオフセット補正する（E63・multiplayer の E32 と同じ方式）
 *
 * ソロ（?solo&match）でも全フェーズが成立する。裁定役は自分（E65）。
 *
 * URL パラメータ:
 *   ?match             マッチモード
 *   ?matchspeed=6      マッチ時計を6倍速（デバッグ）
 *   ?matchseed=123     シード固定（同じ配置を再現）
 *   ?matchauto         ロビーの開始ボタンを押さずに始める
 *   ?matchgoto=chest   目標の3m手前へテレポート（デバッグ。R で再実行）
 */
import type { Scene } from 'three/webgpu';
import type { Game } from '../game';
import type { MatchPacket, Multiplayer } from '../net/multiplayer';
import { isBotId, peerColor } from '../net/peers';
import { createRemotePlayers, type RemotePlayers } from '../net/remote-players';
import type { QualitySettings } from '../quality';
import type { MapDraw, MapOverlay } from '../ui/map';
import { createOnboarding } from '../ui/onboarding';
import type { World } from '../world';
import { allPlaces, placeName } from '../world/landmarks';
import { createBots, type BotFrame, type Bots } from './bots';
import { createDirector, type Director, type DirectorFrame } from './director';
import { createMatchHud } from './hud';
import { createMatchItemObjects } from './item-objects';
import { MATCH_DEBUG } from './items';
import { createMatchObjects, type MatchObjects } from './objects';
import { createWildlife } from './wildlife';
import {
    COUNTDOWN,
    DROP_TIME,
    GOTO_STANDOFF,
    OUTSIDE_SPEED,
    PLANE_CLEARANCE,
    REACH,
    VOTE_TIME,
    autoStart,
    buildLayout,
    clock,
    createRandom,
    createZoneNow,
    hashString,
    makeSeed,
    matchGoto,
    matchSpeed,
    noBots,
    zoneAt,
    type MatchLayout,
    type WorldProbe,
} from './rules';

const TAU = Math.PI * 2;

/** 勝利演出の花火の間隔[s] */
const WIN_FIREWORK = 1.3;
/** 裁定が返ってこないときに再申告するまで[s]（ホスト交代の空白を埋める・E62） */
const CLAIM_RETRY = 2.5;
/** 輸送機の後部ハッチ（機体中心からの後ろ向きの距離[m]） */
const RAMP_BACK = 10.5;
/** マッチの想定人数（BOT で埋める上限。BOT は remote スロット数まで・契約12） */
const ROSTER = 9;
/** ヘリコプターの配置数（契約12） */
const HELI_COUNT = 2;
/** ヘリの発着地点として認める平坦さ（半径[m] と 許容する高低差[m]） */
const PAD_RADIUS = 9;
const PAD_FLAT = 2.2;
/** ソロ表示の BOT を描く距離[m] と、関節つきフル表示にする距離[m]・体数（予算・E92） */
const SOLO_DRAW_DISTANCE = 700;
const SOLO_DETAIL_DISTANCE = 45;
const SOLO_DETAIL_LIMIT = 2;

type Phase = 'lobby' | 'live' | 'result';
/** 降下の進み方 */
type Board = 'none' | 'aboard' | 'dropped' | 'landed';
/** 裁定の対象。契約14で鍵を廃止したので宝箱だけ（プロトコルの w は互換のため残す） */
type Prize = 'chest';

export interface MatchOptions {
    scene: Scene;
    world: World;
    quality: QualitySettings;
    game: Game;
    /** ?solo・未接続では null（1人マッチとして成立する・E65） */
    net: Multiplayer | null;
}

export interface Match {
    /** 毎フレーム game.update より前に呼ぶ（輸送機の座席姿勢を先に渡すため） */
    update(dt: number): void;
    /** 2Dマップのオーバーレイ層（契約09 の drawMatch）へ渡す */
    drawMap(draw: MapDraw): void;
    /** 全体マップを後から渡す（どこでもドアの行き先指定・契約11） */
    attachMap(map: MapOverlay): void;
    /** 霧玉で探知から消えている相手か（マップのマーカー抑止・契約11） */
    isFogged(id: string): boolean;
    dispose(): void;
}

/** 受信パケットの検証（E27 と同じ方針: 1つでも怪しければ丸ごと捨てる） */
function validPacket(packet: MatchPacket): boolean {
    if (!Number.isInteger(packet.n) || packet.n < 0 || packet.n > 1e6) return false;
    if (packet.k === 'start') {
        return (
            Number.isFinite(packet.seed) &&
            Number.isFinite(packet.at) &&
            Number.isFinite(packet.now)
        );
    }
    if (packet.k === 'award') return typeof packet.who === 'string' && packet.who.length <= 128;
    if (packet.k === 'iclaim') return Number.isInteger(packet.i) && (packet.i as number) >= 0;
    if (packet.k === 'iaward') {
        return (
            Number.isInteger(packet.i) &&
            (packet.i as number) >= 0 &&
            typeof packet.who === 'string' &&
            packet.who.length <= 128
        );
    }
    if (packet.k === 'fx') {
        return typeof packet.e === 'string' && packet.e.length <= 16 && Number.isFinite(packet.d);
    }
    return true;
}

export function createMatch(options: MatchOptions): Match {
    const { scene, world, quality, game, net } = options;
    /** 初回マッチ前のルール説明（契約13-6） */
    const onboarding = createOnboarding();
    /** 全体マップ（開いている間はインジケータを出さない・E95） */
    let mapOverlay: MapOverlay | null = null;
    /** アイテムとディレクター（契約11）。下の裁定ヘルパーが揃ってから作る */
    let director: Director | null = null;
    /** BOT（契約12）。ホストだけが思考を回す */
    let bots: Bots | null = null;
    /**
     * ソロ（?solo・未接続）用のゴースト表示。マルチプレイがあるときは
     * multiplayer 側のスロットを人間と共用するので、ここは作らない（契約12）
     */
    let soloGhosts: RemotePlayers | null = null;
    const hud = createMatchHud((index) => director?.useSlot(index));
    const objects: MatchObjects = createMatchObjects(scene, quality);
    const itemObjects = createMatchItemObjects(scene, quality);
    const speed = matchSpeed();
    /** デバッグテレポートの指定（?matchgoto）。null = 無効（通常フロー） */
    const gotoParam = matchGoto();
    const selfId = net?.selfId ?? 'solo';
    const planeY = world.stats.maxElevation + PLANE_CLEARANCE;
    /** 後部ハッチ上の立ち位置の左右のずれ[m]。ピアIDから決めるので人が重ならない */
    const seatSide = ((hashString(selfId) % 5) - 2) * 1.3;

    // --- 進行状態（リマッチで丸ごと戻す・E67） ---
    let phase: Phase = 'lobby';
    let generation = 0;
    let appliedGeneration = -1;
    let layout: MatchLayout | null = null;
    let startAt = 0;
    let matchTime = 0;
    let spectator = false;
    let board: Board = 'none';
    let chestY = 0;
    let winner: string | null = null;
    let winnerTime = 0;
    let winFireworkTimer = 0;
    let resultAt = 0;
    /** 直前のマッチのシード（POI の連続同一を避ける・契約13-4）。null = 初回 */
    let previousSeed: number | null = null;
    /** ホスト設定: BOT を入れるか（全員へ start パケットで配る・契約13-2） */
    let botsEnabled = !noBots();
    /** ルール説明を出している間はマッチを始めない（契約13-6） */
    let rulesOpen = false;
    /** デバッグテレポートで最後に送った先（同じ目標へ何度も飛ばさない） */
    let gotoSent: Prize | null = null;
    /** ?matchgoto=item で最後に向かったアイテムの位置 */
    let gotoItemX = NaN;
    let gotoItemZ = NaN;
    /** ディレクターへ毎フレーム渡す進行状況（使い回して new を作らない） */
    const frame: DirectorFrame = {
        t: 0,
        dt: 0,
        chestX: 0,
        chestY: 0,
        chestZ: 0,
        over: false,
        active: false,
    };
    /** 回収UI へ毎フレーム渡す1件（使い回して new を作らない・契約13-3） */
    const actionView = { mark: '', target: '' };
    const votes = new Set<string>();
    const claimed = new Map<Prize, number>();
    /** 申告済みのアイテム番号 → 申告時刻[ms]（裁定が返らないときの再申告用・契約11） */
    const itemClaimed = new Map<number, number>();
    /** 一度きりの実況・演出を出したかどうか */
    const told = new Set<string>();

    const zone = createZoneNow();

    const isHost = (): boolean => {
        if (!net) return true;
        const ids = net.peerIds();
        return ids.length === 0 || ids[0] === selfId;
    };
    const playerCount = (): number => (net ? net.peerIds().length : 1);

    const nameOf = (id: string): string =>
        id === selfId
            ? 'あなた'
            : (bots?.nameOf(id) ?? (isBotId(id) ? `BOT ${Number(id.slice(3)) + 1}` : `プレイヤー ${id.slice(0, 4)}`));
    const colorOf = (id: string): string => {
        const color = net?.colorOf(id) ?? peerColor(id);
        return `#${color.toString(16).padStart(6, '0')}`;
    };

    const send = (packet: MatchPacket): void => net?.sendMatch(packet);

    /**
     * フェーズ遷移の告知（契約13-6）。実況より大きいトーストで1回だけ出す。
     * 実況と二重に出すと画面が同じ文で埋まるので、こちらはトーストだけ
     */
    const toastOnce = (key: string, text: string): void => {
        if (told.has(key)) return;
        told.add(key);
        hud.toast(text);
    };

    /** マッチ状態を初期へ戻す（ロビー・リマッチ。E67: 前マッチが何も残らない） */
    const resetMatch = (): void => {
        layout = null;
        matchTime = 0;
        spectator = false;
        board = 'none';
        winner = null;
        winnerTime = 0;
        winFireworkTimer = 0;
        gotoSent = null;
        votes.clear();
        claimed.clear();
        itemClaimed.clear();
        told.clear();
        objects.reset();
        director?.reset();
        // BOT・ヘリ・イノシシも前のマッチを持ち越さない（E87）
        bots?.reset();
        net?.publishBots(null);
        if (soloGhosts) {
            for (const slot of botSlots) if (slot >= 0) soloGhosts.release(slot);
            botSlots.length = 0;
        }
        game.dismountAll();
        game.setHelipads([]);
        hud.setVignette(0);
        hud.setAction(null);
        hud.setEdgeArrow(null, '');
        game.sky.cancel();
        game.setSpeedScale(1);
    };

    // --- ロビー -------------------------------------------------------------

    /** 中身が変わったときだけパネルを作り直す（毎フレーム DOM を組み直さない） */
    let lobbyKey = '';

    const showLobby = (): void => {
        // E97: 人数は「人間だけ」を出す（BOT は peerIds から外れている）
        const count = playerCount();
        const host = isHost();
        const key = `${count}:${host}:${botsEnabled}`;
        if (key === lobbyKey) return;
        lobbyKey = key;
        hud.setStatus('');
        hud.showPanel({
            title: '住吉山手トレジャーロワイヤル',
            lines: [
                `参加 ${count}人${net ? '' : '（ソロ）'}${host && !botsEnabled ? '（BOTなし）' : ''}`,
                '宝箱は町のどこかに隠されている。最初に触れた人が勝ち。',
                '円は縮む — 宝箱は必ず円の中。あとはアイテムでヒントを集めて絞り込め。',
            ],
            toggle: host
                ? {
                      label: `BOT: ${botsEnabled ? 'あり' : 'なし'}`,
                      onClick: () => {
                          botsEnabled = !botsEnabled;
                          lobbyKey = '';
                          showLobby();
                      },
                  }
                : null,
            button: host ? { label: 'マッチ開始', onClick: () => startWithRules() } : null,
            note: host ? undefined : 'ホストの開始を待っています…',
        });
        game.setInputSuspended(true, 'match');
    };

    /** 初回だけルール説明を挟んでから始める（契約13-6） */
    const startWithRules = (): void => {
        if (rulesOpen) return;
        rulesOpen = onboarding.show(() => {
            rulesOpen = false;
            beginMatch();
        });
        if (!rulesOpen) beginMatch();
    };

    /** ホストだけが呼ぶ。シードと開始時刻を配って全員で同じマッチを始める */
    const beginMatch = (): void => {
        if (!isHost()) return;
        generation++;
        const seed = makeSeed(selfId, generation);
        const at = performance.now() + COUNTDOWN;
        // p（前マッチのシード）と nb（BOT なし）はホストの設定を全員へ配る。
        // 知らないクライアントは無視するだけなので後方互換（契約13-2 / 13-4）
        send({
            k: 'start',
            n: generation,
            seed,
            at,
            now: performance.now(),
            p: previousSeed ?? undefined,
            nb: botsEnabled ? undefined : 1,
        });
        applyStart(seed, at, generation, previousSeed, botsEnabled);
    };

    const applyStart = (
        seed: number,
        localStartAt: number,
        n: number,
        prevSeed: number | null,
        withBots: boolean,
    ): void => {
        resetMatch();
        lobbyKey = '';
        appliedGeneration = n;
        generation = Math.max(generation, n);
        botsEnabled = withBots;
        // 隠し配置はワールド（地形・建物・道路）を見て決める。全員が同じワールドなので
        // probe を通しても配置は一致する（契約14-3）
        layout = buildLayout(seed, prevSeed, probe);
        startAt = localStartAt;
        chestY = game.physics.surfaceHeight(layout.chest.x, layout.chest.z);
        // 降下の猶予をとっくに過ぎたマッチへ入った人は観戦（次マッチから参加・契約3）
        spectator = (performance.now() - localStartAt) * 0.001 * speed > DROP_TIME;
        if (spectator) board = 'landed';
        phase = 'live';
        hud.showPanel(null);
        game.setInputSuspended(false, 'match');
        // アイテム・⚡・補給機の配置（同じシードから全員が同じものを作る・契約11/13）
        director?.start(layout, seed, prevSeed, probe);
        previousSeed = seed;
        // ヘリコプター2機（シードから決まる開けた場所へ・契約12）
        game.setHelipads(findHelipads(layout, seed));
        // BOT は「10人枠 - 人間」ぶん。ホストの「BOT: なし」設定なら1体も出さない（契約13-2）
        if (isHost() && withBots) bots?.start(layout, seed, Math.max(0, ROSTER - playerCount()));
        else bots?.reset();
        // 宝箱の座標は ?matchdebug のときだけ出す（普通に遊ぶときは
        // コンソールを開いても答えが見えない = 契約14の「無償開示なし」を徹底する）
        console.info(
            `[match] 開始 seed=${seed} 最終安置=${layout.finalPlace} 速度x${speed}` +
                (withBots ? '' : ' BOTなし') +
                (spectator ? ' （観戦）' : '') +
                (MATCH_DEBUG
                    ? `　宝箱 ${layout.chest.x.toFixed(0)},${layout.chest.z.toFixed(0)}`
                    : ''),
        );
    };

    /**
     * 隠し配置の判定に渡すワールドの問い合わせ口（契約14-3）。
     * 道路までの距離は「最寄りの道路頂点」で十分（宝箱を置く粒度は数mでよい）
     */
    const probe: WorldProbe = {
        surface: (x, z) => game.physics.surfaceHeight(x, z),
        ground: (x, z) => world.getElevationAt(x, z),
        road: (x, z) => {
            let best = Infinity;
            for (const path of world.mapFeatures.roads) {
                for (const point of path.points) {
                    const d = (point.x - x) ** 2 + (point.z - z) ** 2;
                    if (d < best) best = d;
                }
            }
            return Math.sqrt(best);
        },
    };

    // --- ヘリコプターの配置（契約12） --------------------------------------

    /** その場所が機体を置ける平坦さか（校庭・公園のような開けた場所を選ぶ） */
    const isFlat = (x: number, z: number): boolean => {
        const base = world.getElevationAt(x, z);
        for (let i = 0; i < 8; i++) {
            const angle = (i / 8) * TAU;
            const h = world.getElevationAt(
                x + Math.cos(angle) * PAD_RADIUS,
                z + Math.sin(angle) * PAD_RADIUS,
            );
            if (Math.abs(h - base) > PAD_FLAT) return false;
            // 建物・道路の上（足場が地形より高い）は避ける
            if (
                Math.abs(
                    game.physics.surfaceHeight(
                        x + Math.cos(angle) * PAD_RADIUS,
                        z + Math.sin(angle) * PAD_RADIUS,
                    ) - h,
                ) > 1.5
            ) {
                return false;
            }
        }
        return true;
    };

    /**
     * 発着地点を2か所選ぶ。実在ランドマーク（渦が森小の校庭など）を第一候補にして、
     * 見つからなければシードから散らした点で平坦な場所を探す
     */
    const findHelipads = (
        matchLayout: MatchLayout,
        seed: number,
    ): { x: number; z: number; yaw: number }[] => {
        const pads: { x: number; z: number; yaw: number }[] = [];
        const rnd = createRandom((seed ^ 0x6ad91f07) >>> 0);
        const push = (x: number, z: number): boolean => {
            if (!isFlat(x, z)) return false;
            for (const pad of pads) {
                if (Math.hypot(pad.x - x, pad.z - z) < 300) return false;
            }
            pads.push({ x, z, yaw: rnd() * TAU });
            return true;
        };
        for (const landmark of allPlaces()) {
            if (pads.length >= HELI_COUNT) break;
            push(landmark.x, landmark.z);
        }
        // 足りないぶんは初期の安置の中から探す（人が通る場所に置く）
        for (let guard = 0; guard < 200 && pads.length < HELI_COUNT; guard++) {
            const angle = rnd() * TAU;
            const distance = Math.sqrt(rnd()) * matchLayout.radii[1];
            push(
                matchLayout.centers[1].x + Math.cos(angle) * distance,
                matchLayout.centers[1].z + Math.sin(angle) * distance,
            );
        }
        console.info(
            `[match] ヘリ ${pads.length}機 ${pads.map((p) => `${p.x.toFixed(0)},${p.z.toFixed(0)}`).join(' / ')}`,
        );
        return pads;
    };

    // --- 裁定 ---------------------------------------------------------------

    /** ホストの裁定。先に届いたほうが勝ち（同時タッチは先着・E64） */
    const award = (prize: Prize, who: string): void => {
        if (winner) return;
        send({ k: 'award', n: appliedGeneration, w: prize, who });
        applyAward(prize, who);
    };

    const applyAward = (prize: Prize, who: string): void => {
        // 旧クライアントからの鍵の裁定は無視する（鍵は契約14で廃止・E102）
        if (prize !== 'chest' || winner) return;
        winner = who;
        winnerTime = matchTime;
        phase = 'result';
        resultAt = performance.now();
        hud.setVignette(0);
        hud.setAction(null);
        hud.setEdgeArrow(null, '');
        game.setSpeedScale(1);
        game.setInputSuspended(true, 'match');
        hud.announce(`${nameOf(who)}が宝箱を回収！`);
        showResult();
    };

    /** 自分の取得を申告する。自分がホストならその場で確定させる */
    const claim = (prize: Prize): void => {
        claimed.set(prize, performance.now());
        if (isHost()) award(prize, selfId);
        else send({ k: 'claim', n: appliedGeneration, w: prize });
    };

    // --- アイテムの裁定（契約11。宝箱とまったく同じ経路） ---

    /** 裁定を確定させる（再申告の対象からも外す） */
    const settleItem = (index: number, who: string): void => {
        itemClaimed.delete(index);
        director?.applyTake(index, who);
    };

    const awardItem = (index: number, who: string): void => {
        send({ k: 'iaward', n: appliedGeneration, i: index, who });
        settleItem(index, who);
    };

    const claimItem = (index: number): void => {
        itemClaimed.set(index, performance.now());
        if (isHost()) awardItem(index, selfId);
        else send({ k: 'iclaim', n: appliedGeneration, i: index });
    };

    // --- イノシシ（群れ・笛・ミミック。契約12） ---
    const wildlife = createWildlife({
        world,
        game,
        items: itemObjects,
        announce: (text) => hud.announce(text),
    });
    // 徒歩で F を押して、車もヘリも無ければ野生のイノシシに乗る
    game.setMountHook((x, z) => wildlife.tryMount(x, z));

    director = createDirector({
        world,
        game,
        hud,
        objects,
        items: itemObjects,
        wildlife,
        selfId,
        claimItem,
        sendFx: (effect, seconds) => send({ k: 'fx', n: appliedGeneration, e: effect, d: seconds }),
        announce: (text) => hud.announce(text),
        nameOf,
        eachPeer: (visit) => net?.eachPeerPosition(visit),
    });
    /** 上で作り終えたので、以降は null にならない */
    const dir: Director = director;

    // --- BOT（契約12。思考はホストだけ、配信は state と同じ形） ---
    bots = createBots({
        world,
        physics: game.physics,
        speed,
        // 裁定はホスト（= BOT を動かしている自分）が出す。人間の申告とまったく同じ経路
        claimPrize: (prize, botId) => award(prize, botId),
        claimItem: (index, botId) => awardItem(index, botId),
        eachDrop: (visit) => dir.eachDrop(visit),
        eachCoin: (visit) => dir.eachCoin(visit),
        announce: (text) => hud.announce(text),
    });
    const botBrain: Bots = bots;
    /** BOT へ毎フレーム渡す進行状況（使い回して new を作らない） */
    const botFrame: BotFrame = {
        t: 0,
        dt: 0,
        zone,
        winner: null,
        chestX: 0,
        chestY: 0,
        chestZ: 0,
    };

    // --- リザルトとリマッチ --------------------------------------------------

    const showResult = (): void => {
        const host = isHost();
        const mine = winner === selfId;
        hud.showPanel({
            title: mine ? '勝利！宝箱を回収した' : `${nameOf(winner ?? '')}の勝ち`,
            color: winner ? colorOf(winner) : undefined,
            lines: [
                `所要時間 ${clock(winnerTime)}`,
                `最終安置 ${layout?.finalPlace ?? ''}`,
                net ? `参加 ${playerCount()}人` : 'ソロマッチ',
            ],
            button: { label: 'もう一回', onClick: () => vote() },
            note: host ? '全員の投票か10秒で次のマッチが始まります' : 'ホストが次のマッチを始めます',
        });
    };

    const vote = (): void => {
        if (votes.has(selfId)) return;
        votes.add(selfId);
        send({ k: 'vote', n: appliedGeneration });
        hud.announce('リマッチに投票した');
    };

    // --- 受信 ---------------------------------------------------------------

    const receive = (packet: MatchPacket, peerId: string): void => {
        if (!validPacket(packet)) return;
        switch (packet.k) {
            case 'start': {
                // 送信側の時計をこちらへ写す（E63）
                const offset = performance.now() - (packet.now as number);
                if (!Number.isFinite(offset) || Math.abs(offset) > 3600_000) return;
                if (packet.n <= appliedGeneration) return; // 途中参加者向けの再送を二重適用しない
                applyStart(
                    packet.seed as number,
                    (packet.at as number) + offset,
                    packet.n,
                    Number.isFinite(packet.p) ? (packet.p as number) : null,
                    packet.nb !== 1,
                );
                break;
            }
            case 'claim':
                // 裁定はホストだけが出す。自分がホストでなければ黙って捨てる。
                // 旧クライアントの鍵の申告（w='key'）は award 側で落ちる（E102）
                if (isHost() && packet.n === appliedGeneration && packet.w === 'chest') {
                    award('chest', peerId);
                }
                break;
            case 'award':
                // award を出してよいのはホストだけ（ホストは最小ピアID）
                if (peerId !== net?.peerIds()[0]) return;
                if (packet.n === appliedGeneration && packet.w) {
                    applyAward(packet.w as Prize, packet.who as string);
                }
                break;
            // open（チャンネリング開始）と bump（体当たり）は契約14で廃止。
            // 旧クライアントから届いても黙って捨てる（E102）
            case 'open':
            case 'bump':
                break;
            case 'iclaim':
                if (isHost() && packet.n === appliedGeneration) awardItem(packet.i as number, peerId);
                break;
            case 'iaward':
                if (peerId !== net?.peerIds()[0]) return;
                if (packet.n === appliedGeneration) settleItem(packet.i as number, packet.who as string);
                break;
            case 'fx':
                if (packet.n === appliedGeneration) dir.applyFx(peerId, packet.e as string, packet.d as number);
                break;
            case 'vote':
                votes.add(peerId);
                break;
        }
    };
    net?.onMatch(receive);

    // --- BOT の配信 -----------------------------------------------------------

    /**
     * BOT の状態を配る。マルチプレイがあるときは multiplayer が人間と同じ経路へ
     * 流し込む（スロットも共用）。ソロのときは遠隔表示そのものが無いので、
     * ここで同じアバターを直接描く（契約12）
     */
    const publishBots = (): void => {
        if (net) {
            net.publishBots(botBrain.states);
            return;
        }
        if (!soloGhosts) soloGhosts = createRemotePlayers(scene, quality, ROSTER - 1);
        // フル表示は近い順に SOLO_DETAIL_LIMIT 体まで（描画コール予算・E92）
        let detailCut = SOLO_DETAIL_DISTANCE;
        let ranked = 0;
        for (const state of botBrain.states) {
            const d = Math.hypot(
                state.x - game.state.x,
                state.y - game.state.y,
                state.z - game.state.z,
            );
            if (d > SOLO_DETAIL_DISTANCE) continue;
            let at = Math.min(ranked, SOLO_DETAIL_LIMIT - 1);
            while (at > 0 && soloNearest[at - 1] > d) {
                soloNearest[at] = soloNearest[at - 1];
                at--;
            }
            if (at < SOLO_DETAIL_LIMIT) soloNearest[at] = d;
            ranked = Math.min(ranked + 1, SOLO_DETAIL_LIMIT);
        }
        if (ranked >= SOLO_DETAIL_LIMIT) detailCut = soloNearest[SOLO_DETAIL_LIMIT - 1];
        for (const state of botBrain.states) {
            if (botSlots[state.index] === undefined) {
                botSlots[state.index] = soloGhosts.acquire(peerColor(`bot${state.index}`));
            }
            const slot = botSlots[state.index];
            if (slot < 0) continue;
            const distance = Math.hypot(
                state.x - game.state.x,
                state.y - game.state.y,
                state.z - game.state.z,
            );
            if (distance > SOLO_DRAW_DISTANCE) {
                soloGhosts.hide(slot);
                continue;
            }
            soloGhosts.show(
                slot,
                state.mode,
                state.x,
                state.y,
                state.z,
                state.yaw,
                state.speed,
                lastDt,
                distance <= detailCut,
            );
        }
    };
    /** ソロ表示のスロット（BOT 番号 → スロット番号） */
    const botSlots: number[] = [];
    /** フル表示の絞り込みに使う「近い順の距離」（使い回し） */
    const soloNearest = new Float64Array(SOLO_DETAIL_LIMIT);
    let lastDt = 0;

    // --- フェーズごとの更新 --------------------------------------------------

    let knownPeers = 0;

    const updateLive = (dt: number, now: number): void => {
        if (!layout) return;
        const t = (now - startAt) * 0.001 * speed;
        matchTime = Math.max(0, t);
        if (t < 0) {
            hud.setStatus(`降下まで ${Math.ceil(-t)}…`);
            return;
        }

        // --- 輸送機と降下 ---
        const dropping = t < DROP_TIME;
        const route = layout.route;
        const u = Math.min(1, t / DROP_TIME);
        const planeX = route.x0 + (route.x1 - route.x0) * u;
        const planeZ = route.z0 + (route.z1 - route.z0) * u;
        const runX = route.x1 - route.x0;
        const runZ = route.z1 - route.z0;
        const runLength = Math.hypot(runX, runZ) || 1;
        const dirX = runX / runLength;
        const dirZ = runZ / runLength;
        // アバター・機体モデルは yaw=0 で -z を向く
        const planeYaw = Math.atan2(-dirX, -dirZ);
        objects.setTransport(planeX, planeY, planeZ, planeYaw, dropping);

        if (!spectator) {
            if (board === 'none' && dropping) {
                board = 'aboard';
                toastOnce('t0', '降下開始！　好きな場所へ飛び降りろ（Space / ジャンプ）');
            }
            if (board === 'aboard') {
                if (game.sky.state === 'ride' || game.sky.state === 'off') {
                    // 後部ハッチの上に立たせる（機体の真下だとカメラが胴体で塞がる）
                    game.sky.ride(
                        planeX - dirX * RAMP_BACK - dirZ * seatSide,
                        planeY - 1.5,
                        planeZ - dirZ * RAMP_BACK + dirX * seatSide,
                        planeYaw,
                    );
                }
                // 猶予が切れたら強制的に降ろす（機体はエリアの外へ抜けてしまう）
                if (!dropping) game.sky.leave();
                if (game.sky.state === 'fall' || game.sky.state === 'canopy') board = 'dropped';
            }
            if (board === 'dropped') {
                if (game.sky.state === 'off') {
                    board = 'landed';
                    hud.announce(`${placeName(game.state.x, game.state.z)}に着地`);
                }
            }
        }
        objects.setCanopy(
            game.state.x,
            game.state.y,
            game.state.z,
            game.state.yaw,
            game.sky.state === 'canopy',
        );

        // --- 安置 ---
        zoneAt(layout, t, zone);
        objects.setZone(zone.x, zone.z, zone.r, game.state.y);
        const px = game.state.x;
        const pz = game.state.z;
        const fromCenter = Math.hypot(px - zone.x, pz - zone.z);
        const outside = fromCenter > zone.r;
        // 安置の外の減速と、アイテムの加速（足袋・コイン）を掛け合わせる（契約11）
        game.setSpeedScale((outside ? OUTSIDE_SPEED : 1) * dir.speedScale);
        hud.setVignette(outside ? Math.min(0.85, 0.35 + (fromCenter - zone.r) / 600) : 0);

        // 安置の外にいる間だけ「安置はこっち」を画面端に出す（契約13-6。
        // 宝箱の方角は出さない — 場所を推理するのがこのゲームの芯・契約14）。
        // 全体マップを開いている間は消す（E95）
        if (outside && !mapOverlay?.isOpen && !winner) {
            const dx = zone.x - px;
            const dz = zone.z - pz;
            hud.setEdgeArrow(
                Math.atan2(dx, -dz) - game.viewYaw,
                `安置まで ${Math.round(fromCenter - zone.r)}m`,
            );
        } else {
            hud.setEdgeArrow(null, '');
        }

        if (zone.until > 0 && zone.until < 12 / speed + 8) {
            toastOnce(
                `warn${zone.stage}`,
                `まもなく安置が縮小 — 次の中心は${placeName(zone.nx, zone.nz)}`,
            );
        }
        if (zone.shrinking) toastOnce(`shrink${zone.stage}`, '安置が縮み始めた！　円の中へ入れ');

        // --- 宝箱（契約14-3: 隠されている。光の柱もマップの★も花火も無い） ---
        objects.setChest(layout.chest.x, chestY, layout.chest.z, true);

        // --- 触れた瞬間に回収・勝利（契約14-2: チャンネリングも鍵も無い） ---
        // 高さの差を見るのは、真上の建物・真下の道から誤って触れないようにするため
        if (
            !spectator &&
            !winner &&
            !claimed.has('chest') &&
            board === 'landed' &&
            Math.hypot(px - layout.chest.x, pz - layout.chest.z) < REACH &&
            Math.abs(game.state.y - chestY) < 5
        ) {
            claim('chest');
        }

        // --- 裁定が返ってこないとき（ホスト交代の空白）は自分がホストなら確定させる（E62） ---
        for (const [prize, at] of claimed) {
            if (winner) continue;
            if (now - at < CLAIM_RETRY * 1000) continue;
            claimed.set(prize, now);
            if (isHost()) award(prize, selfId);
            else send({ k: 'claim', n: appliedGeneration, w: prize });
        }
        for (const [index, at] of itemClaimed) {
            if (now - at < CLAIM_RETRY * 1000) continue;
            itemClaimed.set(index, now);
            if (isHost()) awardItem(index, selfId);
            else send({ k: 'iclaim', n: appliedGeneration, i: index });
        }

        // --- デバッグテレポート（?matchgoto。指定が無ければ何も起きない） ---
        // 飛んだ先は R の戻り先にもなる（game.warpTo）。
        // ?matchgoto=item は「いちばん近い未取得アイテム」を追いかける。拾うと次の
        // アイテムが最寄りになるので、そのまま次々に飛べる（アイテムの通し確認用）。
        // mimic / lookout も同じ仕組みで偽宝箱・見晴らしスポットの手前へ飛ぶ（契約12）
        if ((gotoParam === 'item' || gotoParam === 'mimic' || gotoParam === 'lookout') && !spectator && !winner) {
            const near =
                gotoParam === 'item'
                    ? dir.nearestDrop(px, pz)
                    : gotoParam === 'mimic'
                      ? dir.nearestMimic(px, pz)
                      : dir.nearestLookoutSpot(px, pz);
            if (near && (near.x !== gotoItemX || near.z !== gotoItemZ)) {
                gotoItemX = near.x;
                gotoItemZ = near.z;
                board = 'landed';
                const awayX = px - near.x;
                const awayZ = pz - near.z;
                const away = Math.hypot(awayX, awayZ);
                const ux = away > 1e-3 ? awayX / away : 1;
                const uz = away > 1e-3 ? awayZ / away : 0;
                game.warpTo(
                    near.x + ux * GOTO_STANDOFF,
                    near.z + uz * GOTO_STANDOFF,
                    Math.atan2(ux, uz),
                );
                hud.announce(
                    gotoParam === 'item'
                        ? 'デバッグ: 次のアイテムの手前へ移動（R で戻る）'
                        : gotoParam === 'mimic'
                          ? 'デバッグ: 偽宝箱の手前へ移動（R で戻る）'
                          : 'デバッグ: 見晴らしスポットへ移動（R で戻る）',
                );
            }
        } else if (gotoParam === 'chest' && !spectator && !winner) {
            if (gotoSent !== 'chest') {
                gotoSent = 'chest';
                const point = layout.chest;
                // 「3m手前」= いま自分がいる側へずらす。接触は自分で歩いて成立させる（判定は飛ばさない）
                const awayX = px - point.x;
                const awayZ = pz - point.z;
                const away = Math.hypot(awayX, awayZ);
                const ux = away > 1e-3 ? awayX / away : 1;
                const uz = away > 1e-3 ? awayZ / away : 0;
                // 降下中でも打ち切って着地扱いにする（輸送機へ戻さない）
                board = 'landed';
                game.warpTo(
                    point.x + ux * GOTO_STANDOFF,
                    point.z + uz * GOTO_STANDOFF,
                    Math.atan2(ux, uz),
                );
                hud.announce('デバッグ: 宝箱の手前へ移動（R で再実行）');
            }
        }

        // --- アイテムとディレクター（契約11。輸送機の姿勢を上書きするので最後に回す） ---
        frame.t = t;
        frame.dt = dt;
        frame.chestX = layout.chest.x;
        frame.chestY = chestY;
        frame.chestZ = layout.chest.z;
        frame.over = winner !== null;
        frame.active = !spectator && !winner && board === 'landed';
        dir.update(frame);

        // --- 統一の回収UI（契約13-3。宝箱は触れた瞬間に勝ちなので、ここは場のアイテムだけ） ---
        // ディレクターが「いま拾えるアイテム」を決めたあとに出す
        const pick = frame.active ? dir.pickTarget : null;
        if (pick) {
            actionView.mark = pick.mark;
            actionView.target = pick.name;
            hud.setAction(actionView);
        } else {
            hud.setAction(null);
        }
        if (hud.consumeActionPress() && pick) dir.takePick();

        // --- BOT（契約12。ホストだけが思考を回し、state と同じ形で配る） ---
        if (isHost() && botBrain.count > 0) {
            botFrame.t = t;
            botFrame.dt = dt;
            botFrame.winner = winner;
            botFrame.chestX = layout.chest.x;
            botFrame.chestY = chestY;
            botFrame.chestZ = layout.chest.z;
            botBrain.update(botFrame);
            publishBots();
        }

        // --- 状態行（契約13-1: 上部1行に集約。狭い画面でも切れないよう簡潔に） ---
        // 契約14: 目標は最初から最後まで1つ「宝箱を探せ」。段階も鍵も無い
        const goal = spectator
            ? '観戦中'
            : dropping
              ? '降下地点を選べ'
              : '宝箱を探せ（ヒントを集めろ）';
        const zoneText =
            zone.until < 0 ? '最終安置' : zone.until > 0 ? `収縮まで${clock(zone.until)}` : '収縮中';
        hud.setStatus(
            `${clock(t)}　⭕${Math.round(zone.r)} ${zoneText}　${goal}${outside ? '　⚠外' : ''}`,
        );
    };

    const updateResult = (dt: number, now: number): void => {
        if (!layout || !winner) return;
        objects.setZone(zone.x, zone.z, zone.r, game.state.y);
        winFireworkTimer -= dt;
        if (winFireworkTimer <= 0) {
            winFireworkTimer = WIN_FIREWORK;
            // 回収者の頭上（＝宝箱の位置）で打ち上げる
            objects.burst(layout.chest.x, chestY + 9, layout.chest.z, ((now * 0.0004) % 1 + 1) % 1);
        }
        // 決着後もビーコン・補給機は画に残す（拾得と使用だけ止める）
        frame.dt = dt;
        frame.over = true;
        frame.active = false;
        dir.update(frame);
        // BOT も画に残す（思考は止め、最後の姿勢のまま立たせておく）
        if (isHost() && botBrain.count > 0) publishBots();
        const elapsed = (now - resultAt) * 0.001;
        hud.setStatus(`リザルト　${nameOf(winner)}の勝利　${clock(winnerTime)}`);
        // 全員の投票がそろうか10秒でホストが次を始める
        if (isHost() && (votes.size >= playerCount() || elapsed >= VOTE_TIME)) beginMatch();
    };

    return {
        update(dt) {
            const now = performance.now();
            lastDt = dt;
            hud.update(dt);
            objects.update(dt);

            // 参加者が増えたら、進行中のマッチの開始情報を配り直す（途中参加は観戦になる）
            const count = playerCount();
            if (count > knownPeers && phase !== 'lobby' && isHost() && layout) {
                send({
                    k: 'start',
                    n: appliedGeneration,
                    seed: layout.seed,
                    at: startAt,
                    now,
                });
                // 人間が増えたぶんだけ BOT を引退させて枠を空ける（E86）
                for (let i = knownPeers; i < count; i++) botBrain.retire();
            }
            knownPeers = count;

            if (phase === 'lobby') {
                showLobby();
                // ?matchauto はルール説明を挟まない（自動検証を止めない）
                if (autoStart() && isHost()) beginMatch();
                return;
            }
            if (phase === 'live') updateLive(dt, now);
            else updateResult(dt, now);
        },

        drawMap(draw) {
            if (!layout || phase === 'lobby') return;
            const { ctx, screenX, screenY, ppm, scale } = draw;

            // 輸送機の経路（降下中だけ）
            if (matchTime < DROP_TIME) {
                ctx.save();
                ctx.strokeStyle = 'rgba(40, 44, 54, 0.5)';
                ctx.lineWidth = 2 * scale;
                ctx.setLineDash([9 * scale, 7 * scale]);
                ctx.beginPath();
                ctx.moveTo(screenX(layout.route.x0), screenY(layout.route.z0));
                ctx.lineTo(screenX(layout.route.x1), screenY(layout.route.z1));
                ctx.stroke();
                ctx.restore();
            }

            // アイテムPOI・コイン・クレートと、集めた手がかり（契約11/14）は安置円の下に敷く。
            // **宝箱そのものはマップに描かない**（無償開示なし・契約14-3）
            dir.drawMap(draw);

            // ヘリコプター（契約12）。乗り物がどこにあるか分からないと乗りに行けない
            game.eachHeli((hx, hz, hyaw, occupied) => {
                const sx = screenX(hx);
                const sy = screenY(hz);
                ctx.save();
                ctx.translate(sx, sy);
                ctx.rotate(hyaw);
                ctx.strokeStyle = occupied ? '#ffd257' : '#3f7ad6';
                ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
                ctx.lineWidth = 2 * scale;
                const r = 6 * scale;
                ctx.beginPath();
                ctx.arc(0, 0, r * 0.55, 0, TAU);
                ctx.fill();
                ctx.stroke();
                // ローターの十字
                ctx.beginPath();
                ctx.moveTo(-r, -r);
                ctx.lineTo(r, r);
                ctx.moveTo(r, -r);
                ctx.lineTo(-r, r);
                ctx.stroke();
                ctx.restore();
            });

            // ソロの BOT（マルチプレイがあるときは遠隔プレイヤーとして描かれている）
            if (!net) {
                for (const state of botBrain.states) {
                    ctx.fillStyle = `#${peerColor(`bot${state.index}`).toString(16).padStart(6, '0')}`;
                    ctx.strokeStyle = '#ffffff';
                    ctx.lineWidth = 1.5 * scale;
                    ctx.beginPath();
                    ctx.arc(screenX(state.x), screenY(state.z), 4.5 * scale, 0, TAU);
                    ctx.fill();
                    ctx.stroke();
                }
            }

            // 安置（現在の円 = 実線 / 次の円 = 破線）
            ctx.strokeStyle = 'rgba(46, 132, 235, 0.95)';
            ctx.lineWidth = 3 * scale;
            ctx.beginPath();
            ctx.arc(screenX(zone.x), screenY(zone.z), Math.max(1, zone.r * ppm), 0, TAU);
            ctx.stroke();
            if (zone.until >= 0) {
                ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
                ctx.lineWidth = 2 * scale;
                ctx.setLineDash([7 * scale, 6 * scale]);
                ctx.beginPath();
                ctx.arc(screenX(zone.nx), screenY(zone.nz), Math.max(1, zone.nr * ppm), 0, TAU);
                ctx.stroke();
                ctx.setLineDash([]);
            }
        },

        attachMap(map) {
            mapOverlay = map;
            dir.attachMap((onPick, onCancel) => map.pickPoint(onPick, onCancel));
        },

        isFogged(id) {
            return dir.isFogged(id);
        },

        dispose() {
            net?.onMatch(null);
            net?.publishBots(null);
            onboarding.dispose();
            hud.dispose();
            objects.dispose();
            dir.dispose();
            soloGhosts?.dispose();
            game.setMountHook(null);
            game.setHelipads([]);
            game.setSpeedScale(1);
            game.setInputSuspended(false, 'match');
        },
    };
}
