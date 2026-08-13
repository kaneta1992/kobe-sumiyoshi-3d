/**
 * P2P マルチプレイ（契約05）。trystero（WebRTC + nostr リレーでのシグナリング）で
 * サーバーを一切持たずに繋ぐ。GitHub Pages のような静的ホスティングでそのまま動く。
 *
 * やっていること:
 *   送信 — 自分の game.state を 12Hz で全ピアへ。動いていない間は間引き、
 *          1秒に1回だけ生存を知らせる
 *   受信 — ピアごとのリングバッファに積み、150ms 遅れの時刻を挟む2点で補間して描く。
 *          パケットが遅れても引き伸ばして走らせず、最後の位置で待つ（E3）
 *   表示 — 遠隔プレイヤーはゴースト（コライダーなし）。徒歩は人型、運転中は車
 *
 * 壊れない側に倒す方針:
 *   - 受信値は毎回検証する。NaN・エリア外・順不同は捨てる（E27）
 *   - シグナリングに届かない環境ではマルチプレイを諦め、単独プレイとして動き続ける（E28）
 *   - 5秒無受信のピアは離脱扱いで消す（E26）
 *
 * URL パラメータ:
 *   ?room=名前   ルームを分ける（既定は kobe-sumiyoshi-3d-v1）
 *   ?solo        マルチプレイを使わない
 */
import { type Scene } from 'three/webgpu';
import { joinRoom, getRelaySockets, selfId } from 'trystero';
import type { Room } from 'trystero';
import { AREA_HALF } from '../config';
import type { GameState } from '../game';
import type { QualitySettings } from '../quality';
import { setNetStatus } from '../ui/loading';
import { botPeerId, peerColor, type BotState } from './peers';
import { createRemotePlayers } from './remote-players';

/** 同じアプリ同士だけが出会うための名前空間 */
const APP_ID = 'kobe-sumiyoshi-3d';
const DEFAULT_ROOM = 'kobe-sumiyoshi-3d-v1';

/** 送信間隔[ms]（= 12Hz。契約の 10〜15Hz の中央） */
const SEND_INTERVAL = 1000 / 12;
/** 動いていなくてもこの間隔では送る[ms]（相手のタイムアウト回避） */
const KEEPALIVE = 1000;
/** 補間の遅延[ms]。ジッタと 1パケット分の間隔を吸収できる幅にする */
const INTERP_DELAY = 150;
/** これだけ受信が途切れたピアは離脱とみなす[ms]（E26） */
const PEER_TIMEOUT = 5000;
/** スナップショットの間隔がこれを超えたら補間せず飛ばす[ms]（タブ復帰・回線断のあと・E3） */
const SNAP_GAP = 600;
/** 1パケットでこれ以上動いていたらワープ扱いにする[m]（リスポーン・乗降） */
const SNAP_DISTANCE = 30;
/** ピアごとのリングバッファ段数（12Hz で約1.3秒ぶん） */
const CAPACITY = 16;
/** 同時に描く遠隔プレイヤーの上限（想定同時数〜8人。BOT と共用・契約12） */
const MAX_REMOTE = 8;
/** これより遠いゴーストは描かない[m]（点にしかならないので描画コールの無駄・E92） */
const DRAW_DISTANCE = 700;
/** これより近いゴーストだけ関節つきのフル表示にする[m]（それ以外は1メッシュ・E92） */
const DETAIL_DISTANCE = 45;
/**
 * フル表示にする人数の上限（E92）。人型はパーツで10メッシュあるので、最終安置に
 * 8体が集まっても描画コール予算（mobile draw ≤ 100）を割らないよう頭数で抑える
 */
const DETAIL_LIMIT = 2;
/** BOT 状態の送信間隔[ms]（8Hz。8体を1パケットにまとめるので帯域は state 1人ぶん強） */
const BOT_SEND_INTERVAL = 1000 / 8;
/** BOT の上限（remote スロットと同数） */
const MAX_BOTS = MAX_REMOTE;
/** 受け入れる座標の範囲[m]。エリア外の値は壊れたピアとみなして捨てる（E27） */
const LIMIT_XZ = AREA_HALF + 200;
const LIMIT_Y_MIN = -500;
const LIMIT_Y_MAX = 4000;
/** リレー接続の生存確認の間隔[ms]（E28 の表示切り替えに使う） */
const RELAY_CHECK = 6000;

/** 送信するのに足る変化量 */
const MOVE_EPSILON = 0.02;
const YAW_EPSILON = 0.005;
const SPEED_EPSILON = 0.15;

const TAU = Math.PI * 2;

/**
 * 1回ぶんのスナップショット（JSON。キーは短く）。
 * m=0（徒歩）なら x,y,z は足元・a は体の向き・s は歩行速度、
 * m=1（運転）なら x,y,z は車体・a は車体の向き・s は車速。
 * m=2（ヘリ）・m=3（イノシシ騎乗）も同じ並びで、乗り物の座標と向きを送る（契約12）。
 * 乗っていない相手の乗り物は描かないので、乗り物と人を1組の座標で送れば足りる。
 *
 * m は元から number なので、2・3 が増えても形は変わらない（後方互換）。
 * 知らない値を受け取った側は「徒歩ではない何か」として車と同じ経路で描くだけになる。
 */
type Snapshot = {
    t: number;
    m: number;
    x: number;
    y: number;
    z: number;
    a: number;
    s: number;
};

/**
 * BOT の状態（契約12）。ホストだけが送る。**state と同じ形**の値を、
 * 1パケットにまとめて別チャンネル（'bots'）で配る:
 *   - 人間のスナップショットと混ざらないので、このチャンネルを知らない
 *     クライアントは BOT が見えないだけで従来どおり動く（後方互換）
 *   - 受け手はこれを仮想ピア（bot0…）として**人間と同じ補間・同じスロット**で描く
 * n = このホストが動かしている BOT の数（これ以上の番号のゴーストは消す・E88）
 */
type BotPacket = {
    t: number;
    n: number;
    /** [番号, m, x, y, z, yaw, speed] の並び */
    b: number[][];
};

export type { BotState } from './peers';

/**
 * マッチ同期（契約10）。state とは**別のチャンネル**なので、このチャンネルを知らない
 * クライアントとも従来どおりアバターは見え続ける（後方互換）。
 * 配置は全員がシードから再現するので、ここを流れるのは開始の合図と裁定だけ。
 *
 *   start  マッチ開始（seed / 開始時刻 / 送信時刻）
 *   claim  取得の申告（非ホスト → ホスト）
 *   award  ホストの裁定（これが正。二重回収を防ぐ・E64）
 *   open   （廃止・契約14）宝箱のチャンネリング開始。受け手は無視する
 *   bump   （廃止・契約14）体当たり。受け手は無視する
 *   vote   リマッチ投票
 *   iclaim アイテム取得の申告（契約11。宝箱と同じ経路）
 *   iaward アイテム取得の裁定（ホストが出す。これが正・E73）
 *   fx     使用したアイテムの効果（滑空・傘・霧玉の遠隔表示・E77）
 *
 * 契約11 で増えたのは種別3つとフィールド3つだけで、既存の種別は形も意味も変えていない。
 * 知らない種別は受け手の switch がそのまま素通りさせるので、後方互換は保たれる
 */
export type MatchPacket = {
    k: 'start' | 'claim' | 'award' | 'open' | 'bump' | 'vote' | 'iclaim' | 'iaward' | 'fx';
    /** マッチ通番。前のマッチのパケットを取り違えないための世代（E67） */
    n: number;
    /** start: マッチシード */
    seed?: number;
    /** start: 送信側の performance.now() 基準の開始時刻[ms] */
    at?: number;
    /** start: 送信時刻[ms]。受信側でローカル時計へのオフセットを作る（E63） */
    now?: number;
    /** claim / award: 対象（'key' は契約14で廃止。旧クライアント互換のため型は残す・E102） */
    w?: 'key' | 'chest';
    /** award: 取得者のピアID */
    who?: string;
    /** bump（廃止）: 押し飛ばす相手のピアID */
    to?: string;
    /** bump（廃止）: 押し出す水平方向 */
    dx?: number;
    dz?: number;
    /** iclaim / iaward: 場のアイテムの番号（配置の添字・契約11） */
    i?: number;
    /** fx: 効果名（glide / canopy / fog / off） */
    e?: string;
    /** fx: 効果が続く秒数 */
    d?: number;
    /** start: 直前のマッチのシード（POI の連続同一を避ける・契約13-4） */
    p?: number;
    /** start: 1 = BOT なしで始める（ホストのロビー設定・契約13-2） */
    nb?: number;
};

/** ピアごとの受信バッファ。配列は参加時に確保し、以後は書き換えるだけ */
interface Peer {
    id: string;
    /** 描画スロット（-1 = 上限で描けない） */
    slot: number;
    /** 相手の時計をこちらの時計へ写すオフセット[ms] */
    offset: number;
    /** 最後に受信したローカル時刻[ms] */
    received: number;
    /** リングバッファの最新位置と有効段数 */
    head: number;
    count: number;
    time: Float64Array;
    x: Float32Array;
    y: Float32Array;
    z: Float32Array;
    a: Float32Array;
    s: Float32Array;
    /** 現在の移動状態（乗降のたびにバッファを捨てるので、段ごとには持たない） */
    mode: number;
    /** BOT の仮想ピアか（ホスト選出・人数表示から外す・E91） */
    bot: boolean;
    /** この BOT を配っているホストのピアID（ホスト交代で時計が変わる・E88） */
    sender: string;
    /** マーカーの色（ピアIDのハッシュ由来。3Dのゴーストと同じ色） */
    color: number;
    /** 直近に描いた補間位置。2Dマップ（契約09）とマッチ（契約10/11）が読む */
    drawX: number;
    drawY: number;
    drawZ: number;
    drawYaw: number;
    /** このフレームに描かれたか（未受信・スロット無しのピアはマップにも出さない） */
    drawn: boolean;
}

export interface Multiplayer {
    /** 毎フレーム呼ぶ（game.update のあと。state を読んで送り、遠隔ぶんを描く） */
    update(dt: number): void;
    /**
     * いま描かれている遠隔プレイヤーを1人ずつ渡す（契約09 の2Dマップ用）。
     * 配列を作らずコールバックで渡す（フレーム内アロケーションを増やさない）
     */
    eachPlayer(
        visit: (
            x: number,
            z: number,
            yaw: number,
            driving: boolean,
            color: number,
            id: string,
        ) => void,
    ): void;
    /**
     * 描かれている遠隔プレイヤーを ID つきで巡回する（体当たりの相手探し・契約10 /
     * ステッキの探知・効果表示・契約11）
     */
    eachPeerPosition(visit: (id: string, x: number, y: number, z: number) => void): void;
    /** 自分のピアID（ホスト選出に使う・契約10） */
    readonly selfId: string;
    /** 自分を含む全ピアIDの昇順リスト。毎回同じ配列を詰め直して返す */
    peerIds(): readonly string[];
    /** ピアIDに対応する色（3Dゴースト・マップのマーカーと同じ） */
    colorOf(id: string): number;
    /**
     * ホストが動かす BOT の状態を配る（契約12）。呼ぶたびにローカルへも同じものを
     * 流し込むので、ホスト自身も**遠隔プレイヤーとまったく同じ経路**で BOT を描く。
     * null / 空配列で BOT のゴーストを片付ける（E88）
     */
    publishBots(states: readonly BotState[] | null): void;
    /** マッチチャンネルへ送る（契約10） */
    sendMatch(packet: MatchPacket): void;
    /** マッチチャンネルの受信ハンドラ（1つだけ。後から差し替えられる） */
    onMatch(handler: ((packet: MatchPacket, peerId: string) => void) | null): void;
    dispose(): void;
}

export interface MultiplayerOptions {
    scene: Scene;
    quality: QualitySettings;
    /** 自分の状態。毎フレーム書き換わる単一オブジェクトをそのまま受け取る */
    state: GameState;
}

/** 角度差を [-π, π] に畳む（補間で遠回りさせない） */
function angleDelta(from: number, to: number): number {
    let d = (to - from) % TAU;
    if (d > Math.PI) d -= TAU;
    else if (d < -Math.PI) d += TAU;
    return d;
}

/** 移動状態 → 同期の m（徒歩と降下は同じ 0。空にいることは座標が語る） */
function modeOf(mode: GameState['mode']): number {
    return mode === 'drive' ? 1 : mode === 'heli' ? 2 : mode === 'boar' ? 3 : 0;
}

/** 受信値の検証（E27）。1つでも怪しければパケットごと捨てる */
function isValid(p: Snapshot): boolean {
    if (typeof p !== 'object' || p === null) return false;
    if (
        !Number.isFinite(p.t) ||
        !Number.isFinite(p.x) ||
        !Number.isFinite(p.y) ||
        !Number.isFinite(p.z) ||
        !Number.isFinite(p.a) ||
        !Number.isFinite(p.s)
    ) {
        return false;
    }
    if (Math.abs(p.x) > LIMIT_XZ || Math.abs(p.z) > LIMIT_XZ) return false;
    if (p.y < LIMIT_Y_MIN || p.y > LIMIT_Y_MAX) return false;
    return Math.abs(p.a) < 1e4 && Math.abs(p.s) < 200;
}

function roomId(): string {
    const name = new URLSearchParams(location.search).get('room');
    return name && name.length <= 64 ? name : DEFAULT_ROOM;
}

export function createMultiplayer(options: MultiplayerOptions): Multiplayer {
    const { scene, quality, state } = options;
    const remote = createRemotePlayers(scene, quality, MAX_REMOTE);
    const room = roomId();

    const peers: Peer[] = [];
    const byId = new Map<string, Peer>();
    /** peerIds() が返す使い回しの配列（呼ぶたびに新しい配列を作らない） */
    const idList: string[] = [];

    let hud = '';
    let relayLive = true;
    let relayChecked = false;
    /** 人間のピア数（BOT は数えない・E91） */
    const humanCount = (): number => {
        let count = 0;
        for (const peer of peers) if (!peer.bot) count++;
        return count;
    };
    const showCount = (): void => {
        const humans = humanCount();
        const text =
            humans > 0
                ? `マルチプレイ: ${humans + 1}人（自分を含む）`
                : relayChecked && !relayLive
                  ? 'マルチプレイ: 未接続（単独プレイ）'
                  : 'マルチプレイ: 自分のみ';
        if (text === hud) return;
        hud = text;
        setNetStatus(text);
    };
    showCount();

    const add = (id: string, bot = false, sender = ''): Peer => {
        const color = peerColor(id);
        const peer: Peer = {
            id,
            slot: remote.acquire(color),
            offset: 0,
            received: performance.now(),
            head: 0,
            count: 0,
            time: new Float64Array(CAPACITY),
            x: new Float32Array(CAPACITY),
            y: new Float32Array(CAPACITY),
            z: new Float32Array(CAPACITY),
            a: new Float32Array(CAPACITY),
            s: new Float32Array(CAPACITY),
            mode: 0,
            bot,
            sender,
            color,
            drawX: 0,
            drawY: 0,
            drawZ: 0,
            drawYaw: 0,
            drawn: false,
        };
        peers.push(peer);
        byId.set(id, peer);
        showCount();
        return peer;
    };

    const removeAt = (index: number): void => {
        const peer = peers[index];
        if (peer.slot >= 0) remote.release(peer.slot);
        byId.delete(peer.id);
        peers.splice(index, 1);
        showCount();
    };

    const remove = (id: string): void => {
        const index = peers.findIndex((peer) => peer.id === id);
        if (index >= 0) removeAt(index);
    };

    /** 受信したスナップショットをバッファへ積む（BOT も同じ経路を通る・契約12） */
    const receive = (packet: Snapshot, id: string, bot = false, sender = ''): void => {
        if (!isValid(packet)) return;
        const now = performance.now();
        const peer = byId.get(id) ?? add(id, bot, sender);
        // ホストが替わると BOT の時計の起点も替わる。積んであるものは捨てて測り直す（E88）
        if (bot && peer.sender !== sender) {
            peer.sender = sender;
            peer.count = 0;
        }
        // 相手の performance.now() は起点が違う。最も遅延の小さかった受信を基準に写す。
        // 少しずつ緩める（0.5%）ことで、一度たまたま小さく出た値に張り付かないようにする
        const sample = now - packet.t;
        peer.offset =
            peer.count === 0
                ? sample
                : Math.min(sample, peer.offset + (now - peer.received) * 0.005);
        peer.received = now;

        const time = packet.t + peer.offset;
        const newest = peer.head;
        // 順不同・重複は捨てる（E3）
        if (peer.count > 0 && time <= peer.time[newest]) return;

        const mode = packet.m;
        // 乗降・リスポーン・長い中断のあとは補間せずに飛ばす（引き伸ばして走らせない）
        const jumped =
            peer.count > 0 &&
            (mode !== peer.mode ||
                time - peer.time[newest] > SNAP_GAP ||
                Math.hypot(packet.x - peer.x[newest], packet.z - peer.z[newest]) > SNAP_DISTANCE);
        if (jumped) peer.count = 0;
        peer.mode = mode;

        const i = peer.count === 0 ? 0 : (newest + 1) % CAPACITY;
        peer.time[i] = time;
        peer.x[i] = packet.x;
        peer.y[i] = packet.y;
        peer.z[i] = packet.z;
        peer.a[i] = packet.a;
        peer.s[i] = packet.s;
        peer.head = i;
        peer.count = Math.min(peer.count + 1, CAPACITY);
        if (peer.slot < 0) peer.slot = remote.acquire(peerColor(id)); // 空きが出ていれば拾う
    };

    /** renderTime を挟む2段を探して補間し、1フレームぶん描く */
    const draw = (peer: Peer, renderTime: number, dt: number): void => {
        if (peer.count === 0 || peer.slot < 0) {
            peer.drawn = false;
            if (peer.slot >= 0) remote.hide(peer.slot);
            return;
        }
        const newest = peer.head;
        let ai = newest;
        let bi = newest;
        if (peer.count > 1 && renderTime < peer.time[newest]) {
            let found = false;
            for (let n = 1; n < peer.count; n++) {
                const j = (newest - n + CAPACITY) % CAPACITY;
                if (peer.time[j] <= renderTime) {
                    ai = j;
                    bi = (j + 1) % CAPACITY;
                    found = true;
                    break;
                }
            }
            // まだ描くべき時刻より前の段が無い（遅延が大きい）ときは最古で待つ
            if (!found) {
                ai = (newest - peer.count + 1 + CAPACITY) % CAPACITY;
                bi = ai;
            }
        }
        const span = peer.time[bi] - peer.time[ai];
        const k = span > 0 ? Math.min(1, Math.max(0, (renderTime - peer.time[ai]) / span)) : 0;
        const x = peer.x[ai] + (peer.x[bi] - peer.x[ai]) * k;
        const y = peer.y[ai] + (peer.y[bi] - peer.y[ai]) * k;
        const z = peer.z[ai] + (peer.z[bi] - peer.z[ai]) * k;
        const yaw = peer.a[ai] + angleDelta(peer.a[ai], peer.a[bi]) * k;
        const speed = peer.s[ai] + (peer.s[bi] - peer.s[ai]) * k;
        peer.drawX = x;
        peer.drawY = y;
        peer.drawZ = z;
        peer.drawYaw = yaw;
        // 遠すぎるゴーストは描かない / 遠い・多いときは簡易アバターへ落とす（予算・E92）
        const distance = Math.hypot(x - state.x, y - state.y, z - state.z);
        if (distance > DRAW_DISTANCE) {
            remote.hide(peer.slot);
            // マップのマーカー（契約09）は距離に関わらず出す。drawn は「位置が分かる」の意味
            peer.drawn = true;
            return;
        }
        remote.show(peer.slot, peer.mode, x, y, z, yaw, speed, dt, distance <= detailCut);
        peer.drawn = true;
    };

    // --- 接続。届かない環境でも例外を投げっぱなしにしない（E28） ---
    let session: Room | null = null;
    let send: ((packet: Snapshot) => Promise<void>) | null = null;
    const offline = (reason: string): void => {
        relayChecked = true;
        relayLive = false;
        console.warn(`[net] マルチプレイは無効です（単独プレイで続行）: ${reason}`);
        showCount();
    };

    // マッチ同期（契約10）は state と別チャンネルで、送れなくても本体は動き続ける
    let sendMatchPacket: ((packet: MatchPacket) => Promise<void>) | null = null;
    let matchHandler: ((packet: MatchPacket, peerId: string) => void) | null = null;
    // BOT 配信（契約12）も別チャンネル。知らないクライアントには何も届かない
    let sendBotPacket: ((packet: BotPacket) => Promise<void>) | null = null;

    /** 受け取った BOT パケットを人間と同じ受信経路へ流す */
    const receiveBots = (packet: BotPacket, from: string): void => {
        if (!packet || !Array.isArray(packet.b) || !Number.isFinite(packet.t)) return;
        const count = Number.isInteger(packet.n) ? Math.max(0, Math.min(MAX_BOTS, packet.n)) : 0;
        for (const row of packet.b) {
            if (!Array.isArray(row) || row.length < 7) continue;
            const index = row[0];
            if (!Number.isInteger(index) || index < 0 || index >= MAX_BOTS) continue;
            incoming.t = packet.t;
            incoming.m = row[1];
            incoming.x = row[2];
            incoming.y = row[3];
            incoming.z = row[4];
            incoming.a = row[5];
            incoming.s = row[6];
            receive(incoming, botPeerId(index), true, from);
        }
        // 引退した BOT（E86）・マッチ終了ぶんのゴーストはその場で消す（E88）
        for (let i = peers.length - 1; i >= 0; i--) {
            const peer = peers[i];
            if (!peer.bot || peer.sender !== from) continue;
            if (Number(peer.id.slice(3)) >= count) removeAt(i);
        }
    };

    try {
        session = joinRoom({ appId: APP_ID }, room, {
            onJoinError: (details) => offline(details.error),
        });
        const action = session.makeAction<Snapshot>('state');
        action.onMessage = (packet, context) => receive(packet, context.peerId);
        send = (packet) => action.send(packet);
        const matchAction = session.makeAction<MatchPacket>('match');
        matchAction.onMessage = (packet, context) => {
            // 中身の検証は受け手（マッチ側）が行う。ここは形だけ見る（E27）
            if (packet && typeof packet === 'object' && typeof packet.k === 'string') {
                matchHandler?.(packet, context.peerId);
            }
        };
        sendMatchPacket = (packet) => matchAction.send(packet);
        const botAction = session.makeAction<BotPacket>('bots');
        botAction.onMessage = (packet, context) => {
            // 中身の検証は receiveBots が行う（E27 と同じく怪しい行は捨てる）
            if (packet && typeof packet === 'object') receiveBots(packet, context.peerId);
        };
        sendBotPacket = (packet) => botAction.send(packet);
        session.onPeerJoin = (id) => {
            if (!byId.has(id)) add(id);
        };
        session.onPeerLeave = remove;
        console.info(`[net] room=${room} id=${selfId}（同じURLをもう1つ開くと相手が見えます）`);
    } catch (err) {
        offline(String(err));
    }

    // リレーへ1本も繋がらない環境（企業ネットワーク等）を検出して表示だけ切り替える（E28）
    const relayTimer = session
        ? setInterval(() => {
              const sockets = getRelaySockets() as Record<string, WebSocket> | undefined;
              relayChecked = true;
              relayLive = sockets
                  ? Object.values(sockets).some((socket) => socket.readyState === WebSocket.OPEN)
                  : false;
              showCount();
          }, RELAY_CHECK)
        : 0;

    // 送信用の使い回し。trystero は send の呼び出し時に同期でJSON化するので共有して安全
    const outgoing: Snapshot = { t: 0, m: 0, x: 0, y: 0, z: 0, a: 0, s: 0 };
    /** BOT を受信経路へ流し込むときの使い回し（receive は値をコピーするので共有して安全） */
    const incoming: Snapshot = { t: 0, m: 0, x: 0, y: 0, z: 0, a: 0, s: 0 };
    const botOut: BotPacket = { t: 0, n: 0, b: [] };
    let lastSend = 0;
    let lastBotSend = 0;
    /** フル表示にする距離のしきい値[m]（毎フレーム決め直す・E92） */
    let detailCut = DETAIL_DISTANCE;
    /** 近い順の距離[m]（上位 DETAIL_LIMIT 件だけ持つ。使い回し） */
    const nearest = new Float64Array(DETAIL_LIMIT);
    /** いまの自分の状態を送信バッファへ写す */
    const capture = (): void => {
        // 乗り物に乗っていれば乗り物の座標を送る（徒歩・降下中は自分の足元）
        const mode = modeOf(state.mode);
        const source = mode === 0 ? state : state.vehicle;
        outgoing.m = mode;
        outgoing.x = source.x;
        outgoing.y = source.y;
        outgoing.z = source.z;
        outgoing.a = source.yaw;
        outgoing.s = source.speed;
    };
    const transmit = (now: number): void => {
        if (!send) return;
        outgoing.t = now;
        lastSend = now;
        // 送信中に相手が切れても未処理の失敗にしない
        void send(outgoing).catch(() => undefined);
    };
    capture(); // 隠れたまま始まっても最初から中身のある状態を送れるようにしておく

    // タブが隠れると rAF が止まり、送信も止まる（自分の状態も進まない）。相手の画面から
    // 突然消えないよう、隠れている間だけ最後の状態をタイマーで送る。復帰したら rAF 側が
    // 引き継ぐ（E3）
    const keepalive = setInterval(() => {
        if (document.hidden) transmit(performance.now());
    }, KEEPALIVE);

    return {
        update(dt) {
            const now = performance.now();

            // --- 送信（12Hz。止まっている間は間引く） ---
            if (send && now - lastSend >= SEND_INTERVAL) {
                const mode = modeOf(state.mode);
                const source = mode === 0 ? state : state.vehicle;
                const moved =
                    mode !== outgoing.m ||
                    Math.abs(source.x - outgoing.x) +
                        Math.abs(source.y - outgoing.y) +
                        Math.abs(source.z - outgoing.z) >
                        MOVE_EPSILON ||
                    Math.abs(angleDelta(outgoing.a, source.yaw)) > YAW_EPSILON ||
                    // 速度も見る。止まった瞬間を送らないと、相手側で足踏みが残る
                    Math.abs(source.speed - outgoing.s) > SPEED_EPSILON;
                if (moved || now - lastSend >= KEEPALIVE) {
                    capture();
                    transmit(now);
                }
            }

            // フル表示にする距離のしきい値。近い順に DETAIL_LIMIT 人までに絞る（E92）。
            // 直前フレームの描画位置で測る（1フレーム古いが、切り替えの判断には十分）
            detailCut = DETAIL_DISTANCE;
            let ranked = 0;
            for (const peer of peers) {
                if (peer.count === 0 || peer.slot < 0) continue;
                const d = Math.hypot(peer.drawX - state.x, peer.drawY - state.y, peer.drawZ - state.z);
                if (d > DETAIL_DISTANCE) continue;
                // 上位 DETAIL_LIMIT 件だけを覚える（挿入ソート。最大でも8件）
                let at = Math.min(ranked, DETAIL_LIMIT - 1);
                while (at > 0 && nearest[at - 1] > d) {
                    nearest[at] = nearest[at - 1];
                    at--;
                }
                if (at < DETAIL_LIMIT) nearest[at] = d;
                ranked = Math.min(ranked + 1, DETAIL_LIMIT);
            }
            if (ranked >= DETAIL_LIMIT) detailCut = nearest[DETAIL_LIMIT - 1];

            // --- 受信ぶんの描画。ついでにタイムアウトしたピアを外す（E26） ---
            const renderTime = now - INTERP_DELAY;
            for (let i = peers.length - 1; i >= 0; i--) {
                const peer = peers[i];
                if (now - peer.received > PEER_TIMEOUT) removeAt(i);
                else draw(peer, renderTime, dt);
            }
        },
        eachPlayer(visit) {
            for (const peer of peers) {
                if (!peer.drawn) continue;
                visit(peer.drawX, peer.drawZ, peer.drawYaw, peer.mode !== 0, peer.color, peer.id);
            }
        },
        eachPeerPosition(visit) {
            for (const peer of peers) {
                if (!peer.drawn) continue;
                visit(peer.id, peer.drawX, peer.drawY, peer.drawZ);
            }
        },
        selfId,
        peerIds() {
            idList.length = 0;
            idList.push(selfId);
            // BOT は人間ではない。ホスト選出・人数表示から外す（E91）
            for (const peer of peers) if (!peer.bot) idList.push(peer.id);
            idList.sort();
            return idList;
        },
        colorOf(id) {
            return byId.get(id)?.color ?? peerColor(id);
        },
        publishBots(states) {
            const now = performance.now();
            const count = states ? Math.min(states.length, MAX_BOTS) : 0;
            // ローカルへは毎フレーム流し込む（ホスト自身の画面でも遠隔と同じ経路で描く）
            for (let i = 0; i < count; i++) {
                const bot = (states as readonly BotState[])[i];
                incoming.t = now;
                incoming.m = bot.mode;
                incoming.x = bot.x;
                incoming.y = bot.y;
                incoming.z = bot.z;
                incoming.a = bot.yaw;
                incoming.s = bot.speed;
                receive(incoming, botPeerId(bot.index), true, selfId);
            }
            for (let i = peers.length - 1; i >= 0; i--) {
                const peer = peers[i];
                if (!peer.bot || peer.sender !== selfId) continue;
                if (Number(peer.id.slice(3)) >= count) removeAt(i);
            }
            if (!sendBotPacket || now - lastBotSend < BOT_SEND_INTERVAL) return;
            lastBotSend = now;
            botOut.t = now;
            botOut.n = count;
            botOut.b.length = 0;
            for (let i = 0; i < count; i++) {
                const bot = (states as readonly BotState[])[i];
                // 座標は cm 単位へ丸めて桁を減らす（JSON の文字数がそのまま帯域になる）
                botOut.b.push([
                    bot.index,
                    bot.mode,
                    Math.round(bot.x * 100) / 100,
                    Math.round(bot.y * 100) / 100,
                    Math.round(bot.z * 100) / 100,
                    Math.round(bot.yaw * 1000) / 1000,
                    Math.round(bot.speed * 100) / 100,
                ]);
            }
            void sendBotPacket(botOut).catch(() => undefined);
        },
        sendMatch(packet) {
            void sendMatchPacket?.(packet).catch(() => undefined);
        },
        onMatch(handler) {
            matchHandler = handler;
        },
        dispose() {
            matchHandler = null;
            clearInterval(keepalive);
            if (relayTimer) clearInterval(relayTimer);
            void session?.leave();
            remote.dispose();
            peers.length = 0;
            byId.clear();
        },
    };
}
