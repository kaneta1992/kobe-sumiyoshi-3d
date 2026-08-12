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
import { Color, type Scene } from 'three/webgpu';
import { joinRoom, getRelaySockets, selfId } from 'trystero';
import type { Room } from 'trystero';
import { AREA_HALF } from '../config';
import type { GameState } from '../game';
import type { QualitySettings } from '../quality';
import { setNetStatus } from '../ui/loading';
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
/** 同時に描く遠隔プレイヤーの上限（想定同時数〜8人） */
const MAX_REMOTE = 8;
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
 * 徒歩中の相手の車は描かないので、車と人を1組の座標で送れば足りる。
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
    /** 現在の状態（乗降のたびにバッファを捨てるので、段ごとには持たない） */
    driving: boolean;
}

export interface Multiplayer {
    /** 毎フレーム呼ぶ（game.update のあと。state を読んで送り、遠隔ぶんを描く） */
    update(dt: number): void;
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

/** ピアIDのハッシュで決まる色。乱数は使わないので、同じ相手はどのタブでも同じ色になる */
const hsl = new Color();
function peerColor(id: string): number {
    let hash = 0x811c9dc5;
    for (let i = 0; i < id.length; i++) {
        hash ^= id.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    const hue = ((hash >>> 0) % 360) / 360;
    return hsl.setHSL(hue, 0.58, 0.5).getHex();
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

    let hud = '';
    let relayLive = true;
    let relayChecked = false;
    const showCount = (): void => {
        const text =
            peers.length > 0
                ? `マルチプレイ: ${peers.length + 1}人（自分を含む）`
                : relayChecked && !relayLive
                  ? 'マルチプレイ: 未接続（単独プレイ）'
                  : 'マルチプレイ: 自分のみ';
        if (text === hud) return;
        hud = text;
        setNetStatus(text);
    };
    showCount();

    const add = (id: string): Peer => {
        const peer: Peer = {
            id,
            slot: remote.acquire(peerColor(id)),
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
            driving: false,
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

    /** 受信したスナップショットをバッファへ積む */
    const receive = (packet: Snapshot, id: string): void => {
        if (!isValid(packet)) return;
        const now = performance.now();
        const peer = byId.get(id) ?? add(id);
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

        const driving = packet.m === 1;
        // 乗降・リスポーン・長い中断のあとは補間せずに飛ばす（引き伸ばして走らせない）
        const jumped =
            peer.count > 0 &&
            (driving !== peer.driving ||
                time - peer.time[newest] > SNAP_GAP ||
                Math.hypot(packet.x - peer.x[newest], packet.z - peer.z[newest]) > SNAP_DISTANCE);
        if (jumped) peer.count = 0;
        peer.driving = driving;

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
        if (peer.count === 0 || peer.slot < 0) return;
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
        remote.show(peer.slot, peer.driving, x, y, z, yaw, speed, dt);
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

    try {
        session = joinRoom({ appId: APP_ID }, room, {
            onJoinError: (details) => offline(details.error),
        });
        const action = session.makeAction<Snapshot>('state');
        action.onMessage = (packet, context) => receive(packet, context.peerId);
        send = (packet) => action.send(packet);
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
    let lastSend = 0;
    /** いまの自分の状態を送信バッファへ写す */
    const capture = (): void => {
        const driving = state.mode === 'drive';
        const source = driving ? state.vehicle : state;
        outgoing.m = driving ? 1 : 0;
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
                const driving = state.mode === 'drive';
                const source = driving ? state.vehicle : state;
                const moved =
                    driving !== (outgoing.m === 1) ||
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

            // --- 受信ぶんの描画。ついでにタイムアウトしたピアを外す（E26） ---
            const renderTime = now - INTERP_DELAY;
            for (let i = peers.length - 1; i >= 0; i--) {
                const peer = peers[i];
                if (now - peer.received > PEER_TIMEOUT) removeAt(i);
                else draw(peer, renderTime, dt);
            }
        },
        dispose() {
            clearInterval(keepalive);
            if (relayTimer) clearInterval(relayTimer);
            void session?.leave();
            remote.dispose();
            peers.length = 0;
            byId.clear();
        },
    };
}
