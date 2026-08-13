/**
 * マッチフロー（契約10）: ロビー → 輸送機スカイダイビング → 安置3段収縮 → 鍵 → 宝箱 →
 * 勝利演出 → リマッチ投票。?match のときだけ作られ、既定の自由散策には一切影響しない。
 *
 * 同期の設計:
 *   - ルーム内**最小ピアIDがホスト**。ホストが {seed, 開始時刻} を配って始める
 *   - 宝箱・鍵・安置の中心列・輸送機の経路は全員が seed から**決定的に再現**する（座標は送らない）
 *   - ネットワークを流れるのは開始の合図と、鍵・宝箱の**裁定**（ホストが出す award が正）だけ
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
 *   ?matchgoto=key|chest  目標の3m手前へテレポート（デバッグ。R で再実行）
 */
import type { Scene } from 'three/webgpu';
import { AREA_HALF } from '../config';
import type { Game } from '../game';
import type { MatchPacket, Multiplayer } from '../net/multiplayer';
import { isBotId, peerColor } from '../net/peers';
import { createRemotePlayers, type RemotePlayers } from '../net/remote-players';
import type { QualitySettings } from '../quality';
import type { MapDraw, MapOverlay } from '../ui/map';
import type { World } from '../world';
import { LANDMARKS, placeName } from '../world/landmarks';
import { createBots, type BotFrame, type Bots } from './bots';
import { createDirector, type Director, type DirectorFrame } from './director';
import { createMatchHud } from './hud';
import { createMatchItemObjects } from './item-objects';
import { createMatchObjects, type MatchObjects } from './objects';
import { createWildlife } from './wildlife';
import {
    BUMP_COOLDOWN,
    BUMP_PUSH,
    BUMP_REACH,
    BUMP_SPEED,
    CHANNEL_STILL,
    CHANNEL_TIME,
    COUNTDOWN,
    DROP_TIME,
    GOTO_STANDOFF,
    KEY_AT,
    OUTSIDE_SPEED,
    PLANE_CLEARANCE,
    REACH,
    REVEAL_AT,
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
    zoneAt,
    type MatchLayout,
} from './rules';

const TAU = Math.PI * 2;

/** 宝箱の「円ヒント」の半径[m]（第2段階の開示） */
const CHEST_HINT_RADIUS = 220;
/** 位置が割れたあとの宝箱の花火の間隔[s] */
const CHEST_FIREWORK = 6;
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
type Prize = 'key' | 'chest';

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
    if (packet.k === 'bump') {
        return (
            typeof packet.to === 'string' &&
            Number.isFinite(packet.dx) &&
            Number.isFinite(packet.dz)
        );
    }
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
    let keyY = 0;
    let keyOwner: string | null = null;
    let winner: string | null = null;
    let winnerTime = 0;
    let channel = 0;
    let chestFireworkTimer = 0;
    let winFireworkTimer = 0;
    let bumpCooldown = 0;
    let resultAt = 0;
    /** デバッグテレポートで最後に送った先（同じ目標へ何度も飛ばさない） */
    let gotoSent: Prize | null = null;
    /** ?matchgoto=item で最後に向かったアイテムの位置 */
    let gotoItemX = NaN;
    let gotoItemZ = NaN;
    /** ディレクターへ毎フレーム渡す進行状況（使い回して new を作らない） */
    const frame: DirectorFrame = {
        t: 0,
        dt: 0,
        reveal: 0,
        keyLive: false,
        chestX: 0,
        chestY: 0,
        chestZ: 0,
        active: false,
    };
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

    const announceOnce = (key: string, text: string): void => {
        if (told.has(key)) return;
        told.add(key);
        hud.announce(text);
    };

    /** マッチ状態を初期へ戻す（ロビー・リマッチ。E67: 前マッチが何も残らない） */
    const resetMatch = (): void => {
        layout = null;
        matchTime = 0;
        spectator = false;
        board = 'none';
        keyOwner = null;
        winner = null;
        winnerTime = 0;
        channel = 0;
        chestFireworkTimer = 0;
        winFireworkTimer = 0;
        bumpCooldown = 0;
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
        hud.setChannel(-1);
        hud.setVignette(0);
        game.sky.cancel();
        game.setSpeedScale(1);
    };

    // --- ロビー -------------------------------------------------------------

    /** 中身が変わったときだけパネルを作り直す（毎フレーム DOM を組み直さない） */
    let lobbyKey = '';

    const showLobby = (): void => {
        const count = playerCount();
        const host = isHost();
        const key = `${count}:${host}`;
        if (key === lobbyKey) return;
        lobbyKey = key;
        hud.setStatus('');
        hud.showPanel({
            title: '住吉山手トレジャーロワイヤル',
            lines: [
                `参加 ${count}人${net ? '' : '（ソロ）'}`,
                '輸送機から降下し、鍵を拾って宝箱を最初に開けた人が勝ち。',
                '安置の外は移動が遅くなる。',
            ],
            button: host ? { label: 'マッチ開始', onClick: () => beginMatch() } : null,
            note: host ? undefined : 'ホストの開始を待っています…',
        });
        game.setInputSuspended(true, 'match');
    };

    /** ホストだけが呼ぶ。シードと開始時刻を配って全員で同じマッチを始める */
    const beginMatch = (): void => {
        if (!isHost()) return;
        generation++;
        const seed = makeSeed(selfId, generation);
        const at = performance.now() + COUNTDOWN;
        send({ k: 'start', n: generation, seed, at, now: performance.now() });
        applyStart(seed, at, generation);
    };

    const applyStart = (seed: number, localStartAt: number, n: number): void => {
        resetMatch();
        lobbyKey = '';
        appliedGeneration = n;
        generation = Math.max(generation, n);
        layout = buildLayout(seed);
        startAt = localStartAt;
        chestY = world.getElevationAt(layout.chest.x, layout.chest.z);
        keyY = world.getElevationAt(layout.key.x, layout.key.z);
        // 降下の猶予をとっくに過ぎたマッチへ入った人は観戦（次マッチから参加・契約3）
        spectator = (performance.now() - localStartAt) * 0.001 * speed > DROP_TIME;
        if (spectator) board = 'landed';
        phase = 'live';
        hud.showPanel(null);
        game.setInputSuspended(false, 'match');
        // アイテム・コイン・補給機の配置（同じシードから全員が同じものを作る・契約11）
        director?.start(layout, seed);
        // ヘリコプター2機（シードから決まる開けた場所へ・契約12）
        game.setHelipads(findHelipads(layout, seed));
        // BOT は「10人枠 - 人間」ぶん。ホストだけが動かす（配信は state と同じ形・契約12）
        if (isHost()) bots?.start(layout, seed, Math.max(0, ROSTER - playerCount()));
        else bots?.reset();
        // 検証時にどこへ行けばよいかを追えるようにしておく（配置は全員同じはず）
        console.info(
            `[match] 開始 seed=${seed} 最終安置=${layout.finalPlace} 速度x${speed}` +
                (spectator ? ' （観戦）' : '') +
                `　宝箱 ${layout.chest.x.toFixed(0)},${layout.chest.z.toFixed(0)}` +
                `　鍵 ${layout.key.x.toFixed(0)},${layout.key.z.toFixed(0)}`,
        );
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
        for (const landmark of LANDMARKS) {
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

    /** ホストの裁定。先に届いたほうが勝ち（同時は先着・E64） */
    const award = (prize: Prize, who: string): void => {
        if (prize === 'key' && keyOwner) return;
        if (prize === 'chest' && winner) return;
        send({ k: 'award', n: appliedGeneration, w: prize, who });
        applyAward(prize, who);
    };

    const applyAward = (prize: Prize, who: string): void => {
        if (prize === 'key') {
            if (keyOwner) return;
            keyOwner = who;
            hud.announce(
                who === selfId ? '鍵を手に入れた！宝箱へ急げ' : `${nameOf(who)}が鍵を手に入れた`,
            );
            return;
        }
        if (winner) return;
        winner = who;
        winnerTime = matchTime;
        phase = 'result';
        resultAt = performance.now();
        channel = 0;
        hud.setChannel(-1);
        hud.setVignette(0);
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

    // --- アイテムの裁定（契約11。鍵・宝箱とまったく同じ経路） ---

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
        speed,
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
        eachHuman: (visit) => {
            visit(selfId, game.state.x, game.state.y, game.state.z);
            net?.eachPeerPosition((id, x, y, z) => {
                if (!isBotId(id)) visit(id, x, y, z);
            });
        },
        bump: (targetId, dirX, dirZ) => {
            if (targetId === selfId) {
                game.knockback(dirX, dirZ, BUMP_PUSH);
                if (channel > 0) hud.announce('BOT の体当たりで回収が中断された！');
                channel = 0;
                hud.setChannel(-1);
                return;
            }
            send({ k: 'bump', n: appliedGeneration, to: targetId, dx: dirX, dz: dirZ });
        },
        announce: (text) => hud.announce(text),
    });
    const botBrain: Bots = bots;
    /** BOT へ毎フレーム渡す進行状況（使い回して new を作らない） */
    const botFrame: BotFrame = {
        t: 0,
        dt: 0,
        zone,
        keyLive: false,
        keyOwner: null,
        winner: null,
        reveal: 0,
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
                applyStart(packet.seed as number, (packet.at as number) + offset, packet.n);
                break;
            }
            case 'claim':
                // 裁定はホストだけが出す。自分がホストでなければ黙って捨てる
                if (isHost() && packet.n === appliedGeneration && packet.w) award(packet.w, peerId);
                break;
            case 'award':
                // award を出してよいのはホストだけ（ホストは最小ピアID）
                if (peerId !== net?.peerIds()[0]) return;
                if (packet.n === appliedGeneration && packet.w) applyAward(packet.w, packet.who as string);
                break;
            case 'open':
                if (packet.n === appliedGeneration) hud.announce('誰かが宝箱を開け始めた！');
                break;
            case 'bump':
                if (packet.n !== appliedGeneration) return;
                // BOT への体当たりはホストが受けて BOT 側の状態へ反映する（E83）
                if (packet.to && isBotId(packet.to)) {
                    if (isHost()) botBrain.knock(packet.to, packet.dx as number, packet.dz as number);
                    return;
                }
                if (packet.to !== selfId) return;
                game.knockback(packet.dx as number, packet.dz as number, BUMP_PUSH);
                if (channel > 0) hud.announce('体当たりを食らって回収が中断された！');
                channel = 0;
                hud.setChannel(-1);
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

    // --- 体当たりの相手探し（コールバックは使い回す。フレーム内で関数を作らない） ---
    let bumpFromX = 0;
    let bumpFromZ = 0;
    let bumpTarget: string | null = null;
    let bumpDirX = 0;
    let bumpDirZ = 0;
    const findBumpTarget = (id: string, x: number, _y: number, z: number): void => {
        const dx = x - bumpFromX;
        const dz = z - bumpFromZ;
        const distance = Math.hypot(dx, dz);
        if (distance > BUMP_REACH || distance < 1e-3) return;
        bumpTarget = id;
        bumpDirX = dx / distance;
        bumpDirZ = dz / distance;
    };

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
                announceOnce('t0', '輸送機が住吉山手の上空に到達。好きな場所へ降下せよ');
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

        if (zone.until > 0 && zone.until < 12 / speed + 8) {
            announceOnce(
                `warn${zone.stage}`,
                `まもなく安置が縮小 — 次の中心は${placeName(zone.nx, zone.nz)}`,
            );
        }
        if (zone.shrinking) announceOnce(`shrink${zone.stage}`, '安置が縮み始めた！中へ入れ');

        // --- 段階開示（契約6: 四半区画 → 円 → 正確な位置） ---
        // 宝の地図の切れ端を3枚集めていれば、時間を待たずに正確な位置が出る（契約11）
        const timeReveal = t >= REVEAL_AT[2] ? 3 : t >= REVEAL_AT[1] ? 2 : t >= REVEAL_AT[0] ? 1 : 0;
        const reveal = dir.mapReveal ? 3 : timeReveal;
        if (reveal >= 1) {
            announceOnce(
                'reveal1',
                `宝箱は${layout.chest.z < 0 ? '北' : '南'}${layout.chest.x < 0 ? '西' : '東'}のエリアにあるらしい`,
            );
        }
        if (reveal >= 2) announceOnce('reveal2', '宝箱のおおよその場所が絞り込まれた');
        if (reveal >= 3) {
            announceOnce('reveal3', `宝箱の正確な位置が判明！${placeName(layout.chest.x, layout.chest.z)}`);
        }
        objects.setChest(layout.chest.x, chestY, layout.chest.z, true, reveal >= 2);

        // 位置が割れたら定期的に花火を上げる（全員の足が動く）
        if (reveal >= 3) {
            chestFireworkTimer -= dt;
            if (chestFireworkTimer <= 0) {
                chestFireworkTimer = CHEST_FIREWORK;
                objects.burst(layout.chest.x, chestY + 6, layout.chest.z, 0.12);
            }
        }

        // --- 鍵 ---
        const keyLive = t >= KEY_AT && !keyOwner;
        objects.setKey(layout.key.x, keyY, layout.key.z, keyLive);
        if (t >= KEY_AT) {
            announceOnce('key', `鍵が出現！${placeName(layout.key.x, layout.key.z)}のあたりだ`);
        }
        if (keyLive && !spectator && !claimed.has('key')) {
            const reach = Math.hypot(px - layout.key.x, pz - layout.key.z);
            if (reach < REACH && Math.abs(game.state.y - keyY) < 5) claim('key');
        }

        // --- 宝箱のチャンネリング（移動・被体当たり・円外で必ず切れる・E64） ---
        const nearChest =
            Math.hypot(px - layout.chest.x, pz - layout.chest.z) < REACH &&
            Math.abs(game.state.y - chestY) < 5;
        const canChannel =
            !spectator &&
            !winner &&
            keyOwner === selfId &&
            nearChest &&
            !outside &&
            game.state.mode === 'walk' &&
            game.state.speed < CHANNEL_STILL;
        if (canChannel && !claimed.has('chest')) {
            if (channel <= 0) {
                hud.announce('宝箱を開けている…（動くと中断）');
                send({ k: 'open', n: appliedGeneration });
            }
            channel += dt * speed;
            hud.setChannel(channel / CHANNEL_TIME);
            if (channel >= CHANNEL_TIME) claim('chest');
        } else if (!claimed.has('chest')) {
            if (channel > 0) hud.announce('宝箱の回収が中断された');
            channel = 0;
            hud.setChannel(-1);
        }

        // --- 体当たり（走って接触した相手のチャンネリングを潰す。BOT にも当たる・E83） ---
        bumpCooldown -= dt;
        if (
            (net || botBrain.count > 0) &&
            !spectator &&
            bumpCooldown <= 0 &&
            game.state.mode === 'walk' &&
            game.state.running &&
            game.state.speed > BUMP_SPEED
        ) {
            bumpFromX = px;
            bumpFromZ = pz;
            bumpTarget = null;
            // マルチプレイのゴースト（人間・BOT 兼用）と、ソロの BOT の両方を見る
            if (net) net.eachPeerPosition(findBumpTarget);
            else for (const state of botBrain.states) findBumpTarget(`bot${state.index}`, state.x, state.y, state.z);
            if (bumpTarget) {
                // 相手が BOT で自分がホストなら、その場で BOT へ効かせる（往復しない）
                if (isBotId(bumpTarget) && isHost()) botBrain.knock(bumpTarget, bumpDirX, bumpDirZ);
                else send({ k: 'bump', n: appliedGeneration, to: bumpTarget, dx: bumpDirX, dz: bumpDirZ });
                bumpCooldown = BUMP_COOLDOWN;
                hud.announce('体当たり！');
            }
        }

        // --- 裁定が返ってこないとき（ホスト交代の空白）は自分がホストなら確定させる（E62） ---
        for (const [prize, at] of claimed) {
            if (prize === 'key' && keyOwner) continue;
            if (prize === 'chest' && winner) continue;
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
        // 行き先は「いまの目標」: 鍵を持っていれば宝箱、まだなら鍵。目標が変わったときだけ飛ぶ。
        // 飛んだ先は R の戻り先にもなる（game.warpTo）ので、回収が中断されても手前へ戻れる
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
        } else if (gotoParam && !spectator && !winner) {
            const target: Prize = gotoParam === 'chest' || keyOwner === selfId ? 'chest' : 'key';
            if (target !== gotoSent) {
                gotoSent = target;
                const point = target === 'chest' ? layout.chest : layout.key;
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
                hud.announce(
                    target === 'chest'
                        ? 'デバッグ: 宝箱の手前へ移動（R で再実行）'
                        : 'デバッグ: 鍵の手前へ移動（R で再実行）',
                );
            }
        }

        // --- アイテムとディレクター（契約11。輸送機の姿勢を上書きするので最後に回す） ---
        frame.t = t;
        frame.dt = dt;
        frame.reveal = reveal;
        frame.keyLive = keyLive;
        frame.chestX = layout.chest.x;
        frame.chestY = chestY;
        frame.chestZ = layout.chest.z;
        frame.active = !spectator && !winner && board === 'landed';
        dir.update(frame);

        // --- BOT（契約12。ホストだけが思考を回し、state と同じ形で配る） ---
        if (isHost() && botBrain.count > 0) {
            botFrame.t = t;
            botFrame.dt = dt;
            botFrame.keyLive = keyLive;
            botFrame.keyOwner = keyOwner;
            botFrame.winner = winner;
            botFrame.reveal = reveal;
            botFrame.chestX = layout.chest.x;
            botFrame.chestY = chestY;
            botFrame.chestZ = layout.chest.z;
            botBrain.update(botFrame);
            publishBots();
        }

        // --- 状態行 ---
        const goal = spectator
            ? '観戦中（次のマッチから参加できます）'
            : keyOwner === selfId
              ? '目標: 宝箱を10秒かけて開ける'
              : keyOwner
                ? `鍵は${nameOf(keyOwner)}が所持`
                : t >= KEY_AT
                  ? '目標: 鍵を拾う'
                  : dropping
                    ? '目標: 降下地点を選ぶ'
                    : '目標: 安置の中で鍵の出現を待つ';
        const zoneText =
            zone.until < 0
                ? '最終安置'
                : zone.until > 0
                  ? `次の収縮まで ${clock(zone.until)}`
                  : '安置が収縮中';
        hud.setStatus(`${clock(t)}　安置 ${Math.round(zone.r)}m　${zoneText}　${goal}${outside ? '　⚠ 安置の外（減速中）' : ''}`);
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
                if (autoStart() && isHost()) beginMatch();
                return;
            }
            if (phase === 'live') updateLive(dt, now);
            else updateResult(dt, now);
        },

        drawMap(draw) {
            if (!layout || phase === 'lobby') return;
            const { ctx, screenX, screenY, ppm, scale } = draw;
            const chest = layout.chest;

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

            // アイテムPOI・コイン・クレート（契約11）は安置円の下に敷く
            dir.drawMap(draw);

            // 宝箱のヒント（段階開示。地図3枚で正確な位置を前倒し・契約11）
            const reveal = dir.mapReveal
                ? 3
                : matchTime >= REVEAL_AT[2]
                  ? 3
                  : matchTime >= REVEAL_AT[1]
                    ? 2
                    : matchTime >= REVEAL_AT[0]
                      ? 1
                      : 0;
            if (reveal === 1) {
                const qx = chest.x < 0 ? -AREA_HALF : 0;
                const qz = chest.z < 0 ? -AREA_HALF : 0;
                ctx.fillStyle = 'rgba(255, 196, 66, 0.16)';
                ctx.fillRect(screenX(qx), screenY(qz), AREA_HALF * ppm, AREA_HALF * ppm);
            } else if (reveal === 2) {
                ctx.strokeStyle = 'rgba(230, 160, 30, 0.85)';
                ctx.lineWidth = 2 * scale;
                ctx.beginPath();
                ctx.arc(screenX(chest.x), screenY(chest.z), CHEST_HINT_RADIUS * ppm, 0, TAU);
                ctx.stroke();
            } else if (reveal >= 3) {
                const cx = screenX(chest.x);
                const cz = screenY(chest.z);
                ctx.fillStyle = '#f2b134';
                ctx.strokeStyle = '#ffffff';
                ctx.lineWidth = 2 * scale;
                ctx.beginPath();
                for (let i = 0; i < 10; i++) {
                    const r = (i % 2 === 0 ? 9 : 4.2) * scale;
                    const a = (i / 10) * TAU - Math.PI / 2;
                    const x = cx + Math.cos(a) * r;
                    const y = cz + Math.sin(a) * r;
                    if (i === 0) ctx.moveTo(x, y);
                    else ctx.lineTo(x, y);
                }
                ctx.closePath();
                ctx.fill();
                ctx.stroke();
            }

            // 鍵
            if (matchTime >= KEY_AT && !keyOwner) {
                ctx.fillStyle = '#57c9f2';
                ctx.strokeStyle = '#ffffff';
                ctx.lineWidth = 2 * scale;
                ctx.beginPath();
                ctx.arc(screenX(layout.key.x), screenY(layout.key.z), 6 * scale, 0, TAU);
                ctx.fill();
                ctx.stroke();
            }

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

            // 展望台の千里眼: 最終安置の円と宝箱の位置を先読みで出す（契約12）
            if (dir.farsight) {
                const last = layout.centers[layout.centers.length - 1];
                ctx.save();
                ctx.strokeStyle = 'rgba(100, 240, 200, 0.95)';
                ctx.lineWidth = 2.5 * scale;
                ctx.setLineDash([5 * scale, 5 * scale]);
                ctx.beginPath();
                ctx.arc(
                    screenX(last.x),
                    screenY(last.z),
                    Math.max(2, layout.radii[layout.radii.length - 1] * ppm),
                    0,
                    TAU,
                );
                ctx.stroke();
                ctx.setLineDash([]);
                ctx.strokeStyle = 'rgba(100, 240, 200, 0.95)';
                ctx.beginPath();
                ctx.arc(screenX(chest.x), screenY(chest.z), 9 * scale, 0, TAU);
                ctx.stroke();
                ctx.restore();
            }

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
            dir.attachMap((onPick, onCancel) => map.pickPoint(onPick, onCancel));
        },

        isFogged(id) {
            return dir.isFogged(id);
        },

        dispose() {
            net?.onMatch(null);
            net?.publishBots(null);
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
