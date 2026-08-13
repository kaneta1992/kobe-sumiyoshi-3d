/**
 * ミニマップ + 全体マップ（契約09）。Canvas 2D のUIレイヤーで、3Dシーンには一切入らない。
 *
 * 構造（レイヤー）:
 *   1. ベース地図   … 起伏・水域・緑地・道路・建物。**起動時に一度だけ**オフスクリーンへ描く
 *   2. オーバーレイ … いまはエリア境界だけ。安置円・目的地マーカーはここへ足す
 *                     （docs/game-design.md の「安置収縮」。drawOverlays に1本追加すれば載る）
 *   3. マーカー     … 自分・遠隔プレイヤー・ランドマーク。毎更新で描き直す唯一の層
 *
 * 表示中の更新は 10Hz（MAP_INTERVAL）。ベースは drawImage の切り出しで済むので、
 * 毎回やるのはマーカー層の描き直しだけ。更新経路でオブジェクトを作らない。
 *
 * 座標系: ワールドは東 = +x / 北 = -z（docs/data-spec.md §1）なので、
 * 北を上にした地図はワールド x → 画面右、ワールド z → 画面下でそのまま一致する（回転不要）。
 */
import { AREA_HALF } from '../config';
import type { GameState } from '../game';
import type { QualitySettings } from '../quality';
import type { World } from '../world';
import { LANDMARKS } from '../world/landmarks';

/**
 * オーバーレイ層（レイヤー2）へ描き足す側に渡す道具（契約10 の安置円・目標マーカー）。
 * 毎更新で同じオブジェクトを詰め直して渡す（更新経路でアロケーションを増やさない）
 */
export interface MapDraw {
    ctx: CanvasRenderingContext2D;
    /** ワールド x → 画面の CSS px */
    screenX(x: number): number;
    /** ワールド z → 画面の CSS px */
    screenY(z: number): number;
    /** 1メートルあたりの CSS px */
    ppm: number;
    /** マーカーの拡大率（ミニマップ 0.85 / 全体マップ 1） */
    scale: number;
    /** 全体マップか（ラベルを出してよいか） */
    full: boolean;
    /** 描画領域の大きさ[CSS px]（凡例など、画面に貼り付けるものに使う） */
    w: number;
    h: number;
}

export interface MapOverlayOptions {
    world: World;
    quality: QualitySettings;
    /** 自分の状態（毎フレーム書き換わる単一オブジェクトをそのまま受け取る） */
    state: GameState;
    /** 遠隔プレイヤーの巡回。未接続なら何も渡さなければよい（E52） */
    eachRemote(
        visit: (
            x: number,
            z: number,
            yaw: number,
            driving: boolean,
            color: number,
            id: string,
        ) => void,
    ): void;
    /** 全体マップの開閉通知。ゲーム入力の遮断に使う（E49） */
    onToggle(open: boolean): void;
    /** マッチの安置円・目標マーカー（契約10）。?match でないときは null */
    drawMatch?: ((draw: MapDraw) => void) | null;
    /** 探知から消えている相手はマーカーを出さない（霧玉・契約11） */
    hiddenPeer?: ((id: string) => boolean) | null;
}

export interface MapOverlay {
    /** 毎フレーム呼ぶ。中で 10Hz に間引く */
    update(dt: number): void;
    /** 全体マップを開いているか（画面端インジケータを引っ込める・E95） */
    readonly isOpen: boolean;
    /**
     * 全体マップを開いて、次にタップ/クリックした地点をワールド座標で返す
     * （どこでもドア・契約11）。閉じられたら onPick の代わりに onCancel が呼ばれる。
     * すでに1点指しの最中なら false を返す
     */
    pickPoint(onPick: (x: number, z: number) => void, onCancel: () => void): boolean;
    dispose(): void;
}

/** ベース地図の一辺[px]。2400m をこの解像度で持つ（mobile は半分の面積に落とす） */
const BASE_PX_DESKTOP = 3072;
const BASE_PX_MOBILE = 2048;

/** ミニマップの表示半径[m]（徒歩 / 車で引いたとき） */
const MINI_RADIUS_WALK = 150;
const MINI_RADIUS_DRIVE = 265;
/** 引き / 寄りの追従の速さ[1/s] */
const MINI_ZOOM_LERP = 2.2;

/** 全体マップの拡大上限[CSS px/m]（ベース解像度を大きく超えて拡大しない） */
const MAX_PPM = 1.0;
/** ホイール1ノッチあたりの倍率の効き */
const WHEEL_ZOOM = 0.0016;

/** 更新間隔[s]（10Hz。マーカーだけなのでこれで十分・契約09） */
const MAP_INTERVAL = 0.1;

/** タップとみなす移動量[px] / 時間[ms] */
const TAP_SLOP = 12;
const TAP_TIME = 600;

const TAU = Math.PI * 2;

/** ポップな地図調のパレット */
const C = {
    outside: '#dcd6c8',
    ground: '#f7f2e6',
    water: '#9fd2f0',
    waterEdge: '#7cbbe0',
    green: 'rgba(138, 196, 104, 0.42)',
    roadCasing: '#d8cdb8',
    roadFill: '#ffffff',
    bridgeFill: '#fbf4e4',
    building: '#ded6c7',
    buildingEdge: '#c3b8a3',
    border: 'rgba(90, 80, 62, 0.55)',
    self: '#ff6b3a',
    label: '#4a4133',
    labelHalo: 'rgba(255, 255, 255, 0.92)',
};

/** 表示キャンバスの見え方（ワールド中心・縮尺・CSS px サイズ） */
interface MapView {
    cx: number;
    cz: number;
    /** 1メートルあたりの CSS px */
    ppm: number;
    w: number;
    h: number;
}

function clamp(v: number, lo: number, hi: number): number {
    return v < lo ? lo : v > hi ? hi : v;
}

// --- ベース地図（起動時に一度だけ） ---------------------------------------

/**
 * 地形の起伏を淡い陰影で敷く。等高線の代わりに、この町が六甲の斜面であることを見せる。
 * 256角の粗いサンプルを拡大して使う（ぼかしが陰影として自然に効く）
 */
function drawRelief(ctx: CanvasRenderingContext2D, world: World, size: number): void {
    const n = 256;
    const step = (AREA_HALF * 2) / n;
    const height = new Float32Array(n * n);
    for (let j = 0; j < n; j++) {
        const z = -AREA_HALF + (j + 0.5) * step;
        for (let i = 0; i < n; i++) {
            height[j * n + i] = world.getElevationAt(-AREA_HALF + (i + 0.5) * step, z);
        }
    }

    const relief = document.createElement('canvas');
    relief.width = n;
    relief.height = n;
    const rctx = relief.getContext('2d');
    if (!rctx) return;
    const image = rctx.createImageData(n, n);
    const px = image.data;
    // 北西から差す光（地図の慣例）
    const lx = -0.55;
    const lz = -0.55;
    const ly = 0.63;
    for (let j = 0; j < n; j++) {
        for (let i = 0; i < n; i++) {
            const k = j * n + i;
            const xa = height[k - (i > 0 ? 1 : 0)];
            const xb = height[k + (i < n - 1 ? 1 : 0)];
            const za = height[k - (j > 0 ? n : 0)];
            const zb = height[k + (j < n - 1 ? n : 0)];
            const dzdx = (xb - xa) / (2 * step);
            const dzdz = (zb - za) / (2 * step);
            const inv = 1 / Math.hypot(dzdx, dzdz, 1);
            const lit = (-dzdx * lx - dzdz * lz + ly) * inv;
            const shade = clamp(1 + (lit - ly) * 1.7, 0.74, 1.2);
            // 標高で下地の色を変える（低地=クリーム、高所=黄土）
            const t = clamp((height[k] - 60) / 340, 0, 1);
            const o = k * 4;
            px[o] = clamp((247 - 24 * t) * shade, 0, 255);
            px[o + 1] = clamp((242 - 20 * t) * shade, 0, 255);
            px[o + 2] = clamp((230 - 36 * t) * shade, 0, 255);
            px[o + 3] = 255;
        }
    }
    rctx.putImageData(image, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(relief, 0, 0, n, n, 0, 0, size, size);
}

/** 2400m四方のベース地図を1枚作る。ここだけが重い処理で、起動時に一度しか走らない */
function buildBaseMap(world: World, size: number): HTMLCanvasElement {
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d', { alpha: false });
    const startedAt = performance.now();
    if (!ctx) return canvas;

    const s = size / (AREA_HALF * 2);
    /** ワールド → ベース地図の px */
    const bx = (x: number): number => (x + AREA_HALF) * s;
    const bz = (z: number): number => (z + AREA_HALF) * s;

    ctx.fillStyle = C.ground;
    ctx.fillRect(0, 0, size, size);
    drawRelief(ctx, world, size);

    // --- 水域（住吉川・千丈谷川など） ---
    const water = world.mapFeatures.water;
    if (water.length > 0) {
        ctx.beginPath();
        for (const shape of water) {
            for (const ring of shape.rings) {
                ctx.moveTo(bx(ring[0].x), bz(ring[0].z));
                for (let i = 1; i < ring.length; i++) ctx.lineTo(bx(ring[i].x), bz(ring[i].z));
                ctx.closePath();
            }
        }
        ctx.fillStyle = C.water;
        ctx.fill('evenodd');
        ctx.strokeStyle = C.waterEdge;
        ctx.lineWidth = Math.max(1, 1.2 * s);
        ctx.stroke();
    }

    // --- 緑地（樹木の群れを丸で塗る。1500本ずつに区切って重い1パスを避ける） ---
    const trees = world.mapFeatures.trees;
    ctx.fillStyle = C.green;
    for (let start = 0; start < trees.length; start += 1500) {
        const end = Math.min(start + 1500, trees.length);
        ctx.beginPath();
        for (let i = start; i < end; i++) {
            const tree = trees[i];
            // 樹冠より少し大きめに描く。隣同士が繋がって「林」の面になる
            const r = Math.max(2.4, tree.crown * 0.85 * s);
            const x = bx(tree.x);
            const y = bz(tree.z);
            ctx.moveTo(x + r, y);
            ctx.arc(x, y, r, 0, TAU);
        }
        ctx.fill();
    }

    // --- 道路（縁取り → 塗りの2パス。幅員は RdCL 実データ） ---
    const roads = world.mapFeatures.roads;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    for (let pass = 0; pass < 2; pass++) {
        ctx.strokeStyle = pass === 0 ? C.roadCasing : C.roadFill;
        for (const road of roads) {
            const points = road.points;
            if (points.length < 2) continue;
            const width = road.width * s + (pass === 0 ? 1.9 * s : 0);
            ctx.lineWidth = Math.max(pass === 0 ? 2.2 : 1.1, width);
            if (pass === 1 && road.bridge) ctx.strokeStyle = C.bridgeFill;
            ctx.beginPath();
            ctx.moveTo(bx(points[0].x), bz(points[0].z));
            for (let i = 1; i < points.length; i++) ctx.lineTo(bx(points[i].x), bz(points[i].z));
            ctx.stroke();
            if (pass === 1 && road.bridge) ctx.strokeStyle = C.roadFill;
        }
    }

    // --- 建物（1本のパスにまとめて塗り＋縁） ---
    const buildings = world.mapFeatures.buildings;
    ctx.beginPath();
    for (const building of buildings) {
        const outer = building.outer;
        if (outer.length < 3) continue;
        ctx.moveTo(bx(outer[0].x), bz(outer[0].z));
        for (let i = 1; i < outer.length; i++) ctx.lineTo(bx(outer[i].x), bz(outer[i].z));
        ctx.closePath();
    }
    ctx.fillStyle = C.building;
    ctx.fill();
    ctx.strokeStyle = C.buildingEdge;
    ctx.lineWidth = Math.max(0.6, 0.5 * s);
    ctx.stroke();

    console.info(
        `[map] ベース地図 ${size}px を生成 ${Math.round(performance.now() - startedAt)}ms` +
            `（道路 ${roads.length} / 建物 ${buildings.length} / 水域 ${water.length} / 樹木 ${trees.length}）`,
    );
    return canvas;
}

// --- 表示 -----------------------------------------------------------------

export function createMapOverlay(options: MapOverlayOptions): MapOverlay {
    const {
        world,
        quality,
        state,
        eachRemote,
        onToggle,
        drawMatch = null,
        hiddenPeer = null,
    } = options;
    const base = buildBaseMap(world, quality.preset === 'mobile' ? BASE_PX_MOBILE : BASE_PX_DESKTOP);
    const basePerMeter = base.width / (AREA_HALF * 2);

    // --- DOM（CSS は index.html 側） ---
    const mini = document.createElement('div');
    mini.id = 'minimap';
    mini.title = 'マップを開く（M）';
    const miniCanvas = document.createElement('canvas');
    mini.appendChild(miniCanvas);

    const full = document.createElement('div');
    full.id = 'map-full';
    full.classList.add('hidden');
    const fullCanvas = document.createElement('canvas');
    const closeButton = document.createElement('div');
    closeButton.className = 'map-close';
    closeButton.textContent = '✕';
    const hint = document.createElement('div');
    hint.className = 'map-hint';
    hint.textContent = 'ドラッグ: 移動　ホイール/ピンチ: 拡大縮小　Esc: 閉じる';
    full.append(fullCanvas, closeButton, hint);
    document.body.append(mini, full);

    const miniCtx = miniCanvas.getContext('2d');
    const fullCtx = fullCanvas.getContext('2d');

    let open = false;
    let timer = 0;
    let miniRadius = MINI_RADIUS_WALK;
    // 表示キャンバスの CSS px サイズ（レイアウトを毎回測らない）
    let miniSize = 0;
    let fullW = 0;
    let fullH = 0;
    const view: MapView = { cx: 0, cz: 0, ppm: 0.2, w: 0, h: 0 };

    /** ピア色（数値）→ CSS 文字列。更新のたびに文字列を作らない */
    const colorCache = new Map<number, string>();
    const cssColor = (color: number): string => {
        let css = colorCache.get(color);
        if (css === undefined) {
            css = `#${color.toString(16).padStart(6, '0')}`;
            colorCache.set(color, css);
        }
        return css;
    };

    /** キャンバスの実解像度を devicePixelRatio に合わせる（E51） */
    const sizeCanvas = (
        canvas: HTMLCanvasElement,
        ctx: CanvasRenderingContext2D | null,
        cssW: number,
        cssH: number,
    ): void => {
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const w = Math.max(1, Math.round(cssW * dpr));
        const h = Math.max(1, Math.round(cssH * dpr));
        if (canvas.width !== w || canvas.height !== h) {
            canvas.width = w;
            canvas.height = h;
        }
        // 以降は CSS px で描く
        ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    /** レイアウト変化（リサイズ・回転・dpr変更）に追従する（E55） */
    const syncSize = (): void => {
        // 枠線ぶんを含まない実寸を取る（canvas 自身を測る）
        miniSize = Math.round(miniCanvas.getBoundingClientRect().width);
        sizeCanvas(miniCanvas, miniCtx, miniSize, miniSize);
        if (open) {
            fullW = full.clientWidth;
            fullH = full.clientHeight;
            sizeCanvas(fullCanvas, fullCtx, fullW, fullH);
        }
    };

    /** 全域が収まる縮尺 */
    const fitPpm = (): number => Math.min(fullW, fullH) / (AREA_HALF * 2);

    /** 中心と縮尺をエリア内に収める（E53: 端まで行っても地図の外へ飛ばない） */
    const clampView = (): void => {
        view.ppm = clamp(view.ppm, fitPpm(), MAX_PPM);
        const halfW = view.w / 2 / view.ppm;
        const halfH = view.h / 2 / view.ppm;
        view.cx = halfW >= AREA_HALF ? 0 : clamp(view.cx, -AREA_HALF + halfW, AREA_HALF - halfW);
        view.cz = halfH >= AREA_HALF ? 0 : clamp(view.cz, -AREA_HALF + halfH, AREA_HALF - halfH);
    };

    const screenX = (x: number): number => (x - view.cx) * view.ppm + view.w / 2;
    const screenY = (z: number): number => (z - view.cz) * view.ppm + view.h / 2;

    /** レイヤー1: ベース地図の切り出し */
    const drawBase = (ctx: CanvasRenderingContext2D): void => {
        ctx.fillStyle = C.outside;
        ctx.fillRect(0, 0, view.w, view.h);
        const sx = (view.cx - view.w / 2 / view.ppm + AREA_HALF) * basePerMeter;
        const sy = (view.cz - view.h / 2 / view.ppm + AREA_HALF) * basePerMeter;
        const sw = (view.w / view.ppm) * basePerMeter;
        const sh = (view.h / view.ppm) * basePerMeter;
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        // 範囲外は仕様どおり切り詰められる（エリア外は下地の色のまま残る）
        ctx.drawImage(base, sx, sy, sw, sh, 0, 0, view.w, view.h);
    };

    /**
     * レイヤー2: オーバーレイ。エリア境界と、マッチの安置円・目標マーカー（契約10）。
     * マッチ側は drawMatch で MapDraw を受け取り、ここへ好きに描き足す
     */
    let matchDraw: MapDraw | null = null;
    const drawOverlays = (ctx: CanvasRenderingContext2D, scale: number, full: boolean): void => {
        ctx.save();
        ctx.strokeStyle = C.border;
        ctx.lineWidth = 1.5;
        ctx.setLineDash([6, 5]);
        ctx.strokeRect(
            screenX(-AREA_HALF),
            screenY(-AREA_HALF),
            AREA_HALF * 2 * view.ppm,
            AREA_HALF * 2 * view.ppm,
        );
        ctx.restore();
        if (!drawMatch) return;
        if (!matchDraw) {
            matchDraw = { ctx, screenX, screenY, ppm: view.ppm, scale, full, w: view.w, h: view.h };
        }
        matchDraw.ctx = ctx;
        matchDraw.ppm = view.ppm;
        matchDraw.scale = scale;
        matchDraw.full = full;
        matchDraw.w = view.w;
        matchDraw.h = view.h;
        ctx.save();
        drawMatch(matchDraw);
        ctx.restore();
    };

    /** 進行方向（歩き = -z 正面 / 車 = +z 正面。避けようのない差なのでここで吸収する） */
    const heading = { x: 0, z: 0 };
    const setHeading = (yaw: number, driving: boolean): void => {
        const sin = Math.sin(yaw);
        const cos = Math.cos(yaw);
        heading.x = driving ? sin : -sin;
        heading.z = driving ? cos : -cos;
    };

    /** プレイヤーマーカー（丸 + 進行方向の三角） */
    const drawPlayer = (
        ctx: CanvasRenderingContext2D,
        x: number,
        z: number,
        yaw: number,
        driving: boolean,
        color: string,
        scale: number,
    ): void => {
        const px = screenX(x);
        const py = screenY(z);
        setHeading(yaw, driving);
        ctx.fillStyle = color;
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2 * scale;
        const tip = 15 * scale;
        const side = 5.5 * scale;
        const backX = px + heading.x * 4 * scale;
        const backY = py + heading.z * 4 * scale;
        ctx.beginPath();
        ctx.moveTo(px + heading.x * tip, py + heading.z * tip);
        ctx.lineTo(backX - heading.z * side, backY + heading.x * side);
        ctx.lineTo(backX + heading.z * side, backY - heading.x * side);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(px, py, 5.5 * scale, 0, TAU);
        ctx.fill();
        ctx.stroke();
    };

    // ラベルの重なり判定用（[左, 上, 右, 下] × ランドマーク数。毎回作り直さない）
    const labelBoxes = new Float32Array(LANDMARKS.length * 4);
    let labelCount = 0;

    /** レイヤー3: ランドマーク・遠隔プレイヤー・自分（毎更新でここだけ描き直す） */
    const drawMarkers = (ctx: CanvasRenderingContext2D, labels: boolean, scale: number): void => {
        markerCtx = ctx;
        markerScale = scale;
        // ランドマーク
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        ctx.font = '600 13px system-ui, sans-serif';
        ctx.lineJoin = 'round';
        labelCount = 0;
        for (const landmark of LANDMARKS) {
            const px = screenX(landmark.x);
            const py = screenY(landmark.z);
            if (px < -40 || py < -40 || px > view.w + 40 || py > view.h + 40) continue;
            ctx.beginPath();
            ctx.arc(px, py, 3.4 * scale, 0, TAU);
            ctx.fillStyle = C.label;
            ctx.fill();
            ctx.strokeStyle = C.labelHalo;
            ctx.lineWidth = 1.6 * scale;
            ctx.stroke();
            if (!labels) continue;
            // 縮小して名前どうしが重なるときは、先に置いたほうを残す（拡大すれば出る）
            const half = ctx.measureText(landmark.name).width / 2 + 2;
            const left = px - half;
            const right = px + half;
            const top = py - 22;
            const bottom = py - 5;
            let hidden = false;
            for (let i = 0; i < labelCount * 4; i += 4) {
                if (
                    left < labelBoxes[i + 2] &&
                    right > labelBoxes[i] &&
                    top < labelBoxes[i + 3] &&
                    bottom > labelBoxes[i + 1]
                ) {
                    hidden = true;
                    break;
                }
            }
            if (hidden) continue;
            const at = labelCount * 4;
            labelBoxes[at] = left;
            labelBoxes[at + 1] = top;
            labelBoxes[at + 2] = right;
            labelBoxes[at + 3] = bottom;
            labelCount++;
            ctx.lineWidth = 3.5;
            ctx.strokeStyle = C.labelHalo;
            ctx.strokeText(landmark.name, px, py - 7);
            ctx.fillStyle = C.label;
            ctx.fillText(landmark.name, px, py - 7);
        }

        // 遠隔プレイヤー（未接続なら1人も来ない・E52）
        eachRemote(remoteVisitor);

        // 自分（乗り物に乗っていればその座標・契約12）
        const driving = state.vehicle.occupied;
        const self = driving ? state.vehicle : state;
        drawPlayer(ctx, self.x, self.z, self.yaw, driving, C.self, scale);
        markerCtx = null;
    };

    // 巡回コールバックは1つを使い回す（更新のたびに関数を作らない）
    let markerCtx: CanvasRenderingContext2D | null = null;
    let markerScale = 1;
    const remoteVisitor = (
        x: number,
        z: number,
        yaw: number,
        driving: boolean,
        color: number,
        id: string,
    ): void => {
        if (!markerCtx) return;
        // 霧玉で探知から消えている相手は出さない（契約11・E77）
        if (hiddenPeer?.(id)) return;
        drawPlayer(markerCtx, x, z, yaw, driving, cssColor(color), markerScale);
    };

    const drawMini = (): void => {
        if (!miniCtx || miniSize <= 0) return;
        const driving = state.vehicle.occupied;
        const self = driving ? state.vehicle : state;
        view.w = miniSize;
        view.h = miniSize;
        view.cx = self.x;
        view.cz = self.z;
        view.ppm = miniSize / 2 / miniRadius;

        miniCtx.save();
        miniCtx.beginPath();
        miniCtx.arc(miniSize / 2, miniSize / 2, miniSize / 2, 0, TAU);
        miniCtx.clip();
        drawBase(miniCtx);
        drawOverlays(miniCtx, 0.85, false);
        drawMarkers(miniCtx, false, 0.85);
        miniCtx.restore();

        // 北の目印（北固定なので常に上）
        miniCtx.font = '700 11px system-ui, sans-serif';
        miniCtx.textAlign = 'center';
        miniCtx.textBaseline = 'top';
        miniCtx.lineWidth = 3;
        miniCtx.strokeStyle = C.labelHalo;
        miniCtx.strokeText('N', miniSize / 2, 4);
        miniCtx.fillStyle = C.label;
        miniCtx.fillText('N', miniSize / 2, 4);
    };

    const drawFull = (): void => {
        if (!fullCtx || fullW <= 0) return;
        view.w = fullW;
        view.h = fullH;
        clampView();
        drawBase(fullCtx);
        drawOverlays(fullCtx, 1, true);
        drawMarkers(fullCtx, true, 1);
    };

    // --- 開閉 ---
    /** 1点指しの受け取り先（どこでもドア・契約11）。閉じたら取り消す */
    let pickHandler: ((x: number, z: number) => void) | null = null;
    let pickCancel: (() => void) | null = null;
    const HINT_MOVE = 'ドラッグ: 移動　ホイール/ピンチ: 拡大縮小　Esc: 閉じる';
    const HINT_PICK = '🚪 飛びたい場所をタップ／クリック　Esc: やめる';

    const setOpen = (value: boolean): void => {
        if (open === value) return;
        if (!value) {
            // 指さずに閉じた = 取り消し。呼び側がアイテムを消費しないで済むよう必ず知らせる
            const cancel = pickHandler ? pickCancel : null;
            pickHandler = null;
            pickCancel = null;
            hint.textContent = HINT_MOVE;
            cancel?.();
        }
        open = value;
        full.classList.toggle('hidden', !open);
        mini.classList.toggle('dimmed', open);
        onToggle(open);
        if (open) {
            fullW = full.clientWidth;
            fullH = full.clientHeight;
            sizeCanvas(fullCanvas, fullCtx, fullW, fullH);
            // 開いたときは全域。以後の操作は clampView が面倒を見る
            view.cx = 0;
            view.cz = 0;
            view.ppm = 0;
            view.w = fullW;
            view.h = fullH;
            clampView();
            drawFull();
        } else {
            releasePointers();
            drawMini();
        }
        timer = 0;
    };

    // --- 全体マップの操作（ドラッグ・ピンチ・ホイール） ---
    let idA = -1;
    let apx = 0;
    let apy = 0;
    let idB = -1;
    let bpx = 0;
    let bpy = 0;

    const releasePointers = (): void => {
        idA = -1;
        idB = -1;
    };

    const zoomAbout = (ratio: number, px: number, py: number): void => {
        const before = view.ppm;
        view.ppm = clamp(view.ppm * ratio, fitPpm(), MAX_PPM);
        if (view.ppm === before) return;
        const worldX = view.cx + (px - view.w / 2) / before;
        const worldZ = view.cz + (py - view.h / 2) / before;
        view.cx = worldX - (px - view.w / 2) / view.ppm;
        view.cz = worldZ - (py - view.h / 2) / view.ppm;
    };

    /** タップ判定（1点指しのときだけ使う）: 押した位置と時刻 */
    let downX = 0;
    let downY = 0;
    let downAt = 0;

    const onCanvasDown = (e: PointerEvent): void => {
        if (idA < 0) {
            idA = e.pointerId;
            apx = e.clientX;
            apy = e.clientY;
            downX = e.clientX;
            downY = e.clientY;
            downAt = performance.now();
        } else if (idB < 0) {
            idB = e.pointerId;
            bpx = e.clientX;
            bpy = e.clientY;
        } else {
            return;
        }
        fullCanvas.setPointerCapture(e.pointerId);
        e.preventDefault();
    };

    const onCanvasMove = (e: PointerEvent): void => {
        const isA = e.pointerId === idA;
        const isB = e.pointerId === idB;
        if (!isA && !isB) return;
        if (idA >= 0 && idB >= 0) {
            // 2本指: 中点の移動でパン、指の間隔の比でズーム
            const oldMidX = (apx + bpx) / 2;
            const oldMidY = (apy + bpy) / 2;
            const oldDist = Math.max(1, Math.hypot(apx - bpx, apy - bpy));
            if (isA) {
                apx = e.clientX;
                apy = e.clientY;
            } else {
                bpx = e.clientX;
                bpy = e.clientY;
            }
            const midX = (apx + bpx) / 2;
            const midY = (apy + bpy) / 2;
            const dist = Math.max(1, Math.hypot(apx - bpx, apy - bpy));
            view.cx -= (midX - oldMidX) / view.ppm;
            view.cz -= (midY - oldMidY) / view.ppm;
            zoomAbout(dist / oldDist, midX, midY);
        } else {
            view.cx -= (e.clientX - (isA ? apx : bpx)) / view.ppm;
            view.cz -= (e.clientY - (isA ? apy : bpy)) / view.ppm;
            if (isA) {
                apx = e.clientX;
                apy = e.clientY;
            } else {
                bpx = e.clientX;
                bpy = e.clientY;
            }
        }
        clampView();
        drawFull();
    };

    // 指が1本離れても、残った指は次の move から取り直すので飛ばない（E54）
    const onCanvasUp = (e: PointerEvent): void => {
        const wasA = e.pointerId === idA;
        if (wasA) idA = -1;
        else if (e.pointerId === idB) idB = -1;
        // 1点指し（どこでもドア）: 引きずっていない単発のタップだけを拾う
        if (!pickHandler || !wasA || idB >= 0) return;
        if (performance.now() - downAt > TAP_TIME) return;
        if (Math.hypot(e.clientX - downX, e.clientY - downY) > TAP_SLOP) return;
        const handler = pickHandler;
        const worldX = view.cx + (e.clientX - view.w / 2) / view.ppm;
        const worldZ = view.cz + (e.clientY - view.h / 2) / view.ppm;
        pickHandler = null;
        pickCancel = null;
        setOpen(false);
        handler(clamp(worldX, -AREA_HALF, AREA_HALF), clamp(worldZ, -AREA_HALF, AREA_HALF));
    };

    const onWheel = (e: WheelEvent): void => {
        e.preventDefault();
        zoomAbout(Math.exp(-e.deltaY * WHEEL_ZOOM), e.clientX, e.clientY);
        clampView();
        drawFull();
    };

    fullCanvas.addEventListener('pointerdown', onCanvasDown);
    fullCanvas.addEventListener('pointermove', onCanvasMove);
    fullCanvas.addEventListener('pointerup', onCanvasUp);
    fullCanvas.addEventListener('pointercancel', onCanvasUp);
    fullCanvas.addEventListener('lostpointercapture', onCanvasUp);
    fullCanvas.addEventListener('wheel', onWheel, { passive: false });
    closeButton.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        setOpen(false);
    });

    // --- ミニマップのタップ/クリックで開く ---
    let tapX = 0;
    let tapY = 0;
    let tapAt = 0;
    const onMiniDown = (e: PointerEvent): void => {
        tapX = e.clientX;
        tapY = e.clientY;
        tapAt = performance.now();
        e.preventDefault();
    };
    const onMiniUp = (e: PointerEvent): void => {
        if (performance.now() - tapAt > TAP_TIME) return;
        if (Math.hypot(e.clientX - tapX, e.clientY - tapY) > TAP_SLOP) return;
        setOpen(true);
    };
    mini.addEventListener('pointerdown', onMiniDown);
    mini.addEventListener('pointerup', onMiniUp);

    const onKeyDown = (e: KeyboardEvent): void => {
        if (e.code === 'Escape' && open) {
            setOpen(false);
            e.preventDefault();
        } else if (e.code === 'KeyM' && !e.repeat) {
            setOpen(!open);
            e.preventDefault();
        }
    };
    window.addEventListener('keydown', onKeyDown);

    const onResize = (): void => {
        syncSize();
        if (open) {
            clampView();
            drawFull();
        } else {
            drawMini();
        }
    };
    window.addEventListener('resize', onResize);

    syncSize();
    drawMini();

    return {
        update(dt) {
            // 車・ヘリで走っている間は少し引く（先が見えるように）
            const target =
                state.mode === 'drive' || state.mode === 'heli'
                    ? MINI_RADIUS_WALK +
                      (MINI_RADIUS_DRIVE - MINI_RADIUS_WALK) *
                          Math.min(1, Math.abs(state.vehicle.speed) / 16)
                    : MINI_RADIUS_WALK;
            miniRadius += (target - miniRadius) * (1 - Math.exp(-MINI_ZOOM_LERP * dt));

            timer += dt;
            if (timer < MAP_INTERVAL) return;
            timer = 0;
            if (open) drawFull();
            else drawMini();
        },
        get isOpen() {
            return open;
        },
        pickPoint(onPick, onCancel) {
            if (pickHandler) return false;
            // すでに開いていると setOpen が何もしないので、先に開けてから受け取り先を立てる
            setOpen(true);
            pickHandler = onPick;
            pickCancel = onCancel;
            hint.textContent = HINT_PICK;
            return true;
        },
        dispose() {
            window.removeEventListener('keydown', onKeyDown);
            window.removeEventListener('resize', onResize);
            mini.remove();
            full.remove();
        },
    };
}
