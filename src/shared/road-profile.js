/**
 * 道路の縦断プロファイル（センターラインに沿った路面標高）を解く。
 *
 * geo.js と同じく **ブラウザと前処理スクリプトの両方から読み込まれる**（契約08）:
 *   - 前処理はこの標高へ地形を吸着させる（カービング）
 *   - クライアントは同じ計算で描画リボン・物理コライダー・橋の桁の高さを決める
 * 二重実装を作ると「カービングした地形」と「描いた路面」がずれて段差が戻るので、
 * 縦断の決め方はここだけに置くこと。
 *
 * やっていること: 道路網を1本のグラフ（交差点の頂点は共有）と見なし、
 *
 *   最小化: Σ w_i (h_i − t_i)²  +  曲げエネルギー（隣接点との差）
 *
 * を Jacobi 反復で解く。t は地形標高、w は「地形へ引き戻す強さ」。
 *   - 通常部は w > 0 なので地形に沿いつつ、SMOOTH_LENGTH より短い凹凸だけが消える
 *     （= 車に優しい滑らかな縦断。一定勾配の坂はラプラシアンが 0 なので歪まない・E45）
 *   - **pinned: true**（クライアント側）は通常部を地形へ固定する。地形は前処理で
 *     この縦断へカービング済みなので、もう一度平滑化すると二重にフィルタが掛かって
 *     路面が地形から浮いてしまう。橋だけを解けばよい
 *   - 交差点は頂点を共有するので、接続する道路の標高が必ず一致する
 *   - **橋（bridge）は w = 0**。データ項が無い区間は隣接平均だけで決まる = 両端の
 *     取付点を結ぶ直線になる。谷の地形を無視して橋台から橋台へ渡る縦断が自動的に出る
 *     （E44: 取付部は共有頂点なので通常部と完全に一致 / E46: タイル境界で分割された
 *     橋も端点が同じ位置なら同一頂点に畳まれて1本の橋として解ける）
 */

/** 中心線の再サンプル間隔[m]。描画リボン・物理・カービングで共有する */
export const PROFILE_STEP = 6;

/** 端点を同一の交差点とみなす量子化幅[m] */
const NODE_QUANT = 0.5;
/** 平滑化の目標長[m]。これより短い波長の凹凸が縦断から消える */
const SMOOTH_LENGTH = 19;
/** 隣接平均へ寄せる強さ（0..1）。1に近づけると発散する */
const LAMBDA = 0.5;
/** 反復回数。SMOOTH_LENGTH / 最小間隔 の2乗程度あれば収束する */
const ITERATIONS = 400;
/** 地形へ引き戻す強さの上限（安定性のため） */
const MU_MAX = 0.4;
/**
 * 地形から離れてよい目安[m]。これを超えると引き戻しを二次で強める。
 * 橋の取付部など、隣接平均が縦断を大きく持ち上げようとする場所で
 * 地形との乖離（= カービング量）が一方的に育つのを抑える
 */
const DEVIATION_SOFT = 1.5;
/** 縦断の目標標高を測る横断オフセット[m]の上限（1mグリッドの単発ノイズ・擁壁を避ける） */
const CROSS_OFFSET_MAX = 2;

/**
 * 長い区間を分割し、地形に追従できる細かさの頂点列にする。
 * 元の頂点は必ず残す（曲がり角を落とさない）ので間隔は一定にならない。
 * @param {readonly {x: number, z: number}[]} points
 * @returns {{x: number, z: number}[]}
 */
export function resamplePolyline(points) {
    const out = [{ x: points[0].x, z: points[0].z }];
    for (let i = 1; i < points.length; i++) {
        const a = points[i - 1];
        const b = points[i];
        const len = Math.hypot(b.x - a.x, b.z - a.z);
        const steps = Math.max(1, Math.ceil(len / PROFILE_STEP));
        for (let s = 1; s <= steps; s++) {
            const t = s / steps;
            out.push({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t });
        }
    }
    return out;
}

function nodeKey(p) {
    return `${Math.round(p.x / NODE_QUANT)},${Math.round(p.z / NODE_QUANT)}`;
}

/**
 * @param {readonly {points: readonly {x: number, z: number}[], width: number, bridge: boolean}[]} lines
 * @param {(x: number, z: number) => number} sampleElevation 地形標高[m]
 * @param {{ pinned?: boolean }} [options] pinned = 通常部は地形標高そのままにする
 * @returns {{ paths: object[], stats: object }}
 */
export function buildRoadProfiles(lines, sampleElevation, options = {}) {
    const pinned = options.pinned === true;
    // --- 1) 再サンプルと弧長 -------------------------------------------------
    const paths = [];
    for (const line of lines) {
        if (!line.points || line.points.length < 2) continue;
        const points = resamplePolyline(line.points);
        if (points.length < 2) continue;
        const dists = new Float64Array(points.length);
        for (let i = 1; i < points.length; i++) {
            dists[i] =
                dists[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].z - points[i - 1].z);
        }
        paths.push({
            points,
            dists,
            heights: new Float64Array(points.length),
            width: Math.max(1.2, Math.min(line.width, 30)),
            bridge: !!line.bridge,
            length: dists[dists.length - 1],
        });
    }

    // --- 2) グラフ（端点は交差点として共有） ---------------------------------
    const nodes = new Map();
    const ids = paths.map((p) => new Int32Array(p.points.length));
    let vertexCount = 0;
    for (let pi = 0; pi < paths.length; pi++) {
        const points = paths[pi].points;
        for (let i = 0; i < points.length; i++) {
            if (i === 0 || i === points.length - 1) {
                const key = nodeKey(points[i]);
                let id = nodes.get(key);
                if (id === undefined) {
                    id = vertexCount++;
                    nodes.set(key, id);
                }
                ids[pi][i] = id;
            } else {
                ids[pi][i] = vertexCount++;
            }
        }
    }

    const target = new Float64Array(vertexCount);
    const weight = new Float64Array(vertexCount);
    const spacing = new Float64Array(vertexCount); // 近傍間隔の平均[m]
    /** @type {number[][]} */
    const neighbours = Array.from({ length: vertexCount }, () => []);
    /** @type {number[][]} */
    const neighbourDist = Array.from({ length: vertexCount }, () => []);

    for (let pi = 0; pi < paths.length; pi++) {
        const path = paths[pi];
        const w = path.bridge ? 0 : 1;
        const offset = Math.min(CROSS_OFFSET_MAX, path.width * 0.4);
        const points = path.points;
        for (let i = 0; i < points.length; i++) {
            const id = ids[pi][i];
            const center = sampleElevation(points[i].x, points[i].z);
            if (pinned) {
                // 地形はカービング済み（コリドー内は平ら）。ここで横断の中央値を採ると
                // 路面が地表からわずかにずれて段差になるので、中心の値をそのまま使う
                target[id] = center;
            } else {
                // 目標標高は横断3点の中央値。中心線が擁壁や縁石に1セル乗っても引きずられない
                const prev = points[Math.max(0, i - 1)];
                const nextPt = points[Math.min(points.length - 1, i + 1)];
                let dirX = nextPt.x - prev.x;
                let dirZ = nextPt.z - prev.z;
                const len = Math.hypot(dirX, dirZ) || 1;
                dirX /= len;
                dirZ /= len;
                const a = sampleElevation(points[i].x - dirZ * offset, points[i].z + dirX * offset);
                const c = sampleElevation(points[i].x + dirZ * offset, points[i].z - dirX * offset);
                target[id] =
                    a < center ? (center < c ? center : a < c ? c : a) : center < c ? (a < c ? a : c) : center;
            }
            if (w > weight[id]) weight[id] = w;
            if (i > 0) {
                const prev = ids[pi][i - 1];
                const d = Math.max(0.05, path.dists[i] - path.dists[i - 1]);
                neighbours[id].push(prev);
                neighbourDist[id].push(d);
                neighbours[prev].push(id);
                neighbourDist[prev].push(d);
            }
        }
    }

    for (let v = 0; v < vertexCount; v++) {
        let sum = 0;
        for (const d of neighbourDist[v]) sum += d;
        spacing[v] = neighbourDist[v].length ? sum / neighbourDist[v].length : PROFILE_STEP;
    }

    // 橋しかない連結成分（両端が他の道路につながっていない = タイル端で切れた橋）は
    // 浮いてしまうので、その成分だけ地形へ引き戻す
    const seen = new Uint8Array(vertexCount);
    const stack = [];
    for (let v = 0; v < vertexCount; v++) {
        if (seen[v]) continue;
        stack.length = 0;
        stack.push(v);
        seen[v] = 1;
        const component = [];
        let anchored = 0;
        while (stack.length > 0) {
            const u = stack.pop();
            component.push(u);
            if (weight[u] > 0) anchored++;
            for (const n of neighbours[u]) {
                if (seen[n]) continue;
                seen[n] = 1;
                stack.push(n);
            }
        }
        if (anchored === 0) for (const u of component) weight[u] = 1;
    }

    // --- 3) 反復 -------------------------------------------------------------
    // pinned のときに動かすのは橋（データ項の無い頂点）だけ。取付点は地形に固定
    // されているので、橋は必ず両端の路面へ滑らかにつながる（E44）
    const h = Float64Array.from(target);
    const next = new Float64Array(vertexCount);
    const active = [];
    for (let v = 0; v < vertexCount; v++) if (!pinned || weight[v] === 0) active.push(v);
    for (let iter = 0; iter < ITERATIONS && active.length > 0; iter++) {
        for (const v of active) {
            const ns = neighbours[v];
            let sum = 0;
            let wsum = 0;
            for (let k = 0; k < ns.length; k++) {
                const iw = 1 / neighbourDist[v][k];
                sum += h[ns[k]] * iw;
                wsum += iw;
            }
            let value = h[v];
            if (wsum > 0) value += LAMBDA * (sum / wsum - value);
            if (weight[v] > 0) {
                const dev = Math.abs(value - target[v]) / DEVIATION_SOFT;
                const mu = Math.min(
                    MU_MAX,
                    LAMBDA * (spacing[v] / SMOOTH_LENGTH) ** 2 * (1 + dev * dev),
                );
                value += mu * (target[v] - value);
            }
            next[v] = value;
        }
        for (const v of active) h[v] = next[v];
    }

    // --- 4) 書き戻しと統計 ---------------------------------------------------
    const deviations = [];
    let roadLength = 0;
    let bridgeLength = 0;
    for (let pi = 0; pi < paths.length; pi++) {
        const path = paths[pi];
        for (let i = 0; i < path.points.length; i++) {
            const id = ids[pi][i];
            path.heights[i] = h[id];
            if (!path.bridge) deviations.push(Math.abs(h[id] - target[id]));
        }
        if (path.bridge) bridgeLength += path.length;
        else roadLength += path.length;
    }
    deviations.sort((a, b) => a - b);
    const at = (p) =>
        deviations.length ? deviations[Math.min(deviations.length - 1, Math.floor(deviations.length * p))] : 0;
    const meanDeviation = deviations.length
        ? deviations.reduce((a, b) => a + b, 0) / deviations.length
        : 0;

    return {
        paths,
        stats: {
            paths: paths.length,
            vertices: vertexCount,
            junctions: nodes.size,
            bridgePaths: paths.filter((p) => p.bridge).length,
            roadLength,
            bridgeLength,
            meanDeviation,
            p90Deviation: at(0.9),
            p99Deviation: at(0.99),
            maxDeviation: deviations.length ? deviations[deviations.length - 1] : 0,
        },
    };
}

/**
 * プロファイル上の距離 d[m] における路面標高[m]。範囲外は端の値。
 * @param {{dists: Float64Array, heights: Float64Array}} path @param {number} d
 * @returns {number}
 */
export function profileHeightAt(path, d) {
    const dists = path.dists;
    const n = dists.length;
    if (d <= dists[0]) return path.heights[0];
    if (d >= dists[n - 1]) return path.heights[n - 1];
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (dists[mid] <= d) lo = mid;
        else hi = mid;
    }
    const span = dists[hi] - dists[lo] || 1;
    const t = (d - dists[lo]) / span;
    return path.heights[lo] + (path.heights[hi] - path.heights[lo]) * t;
}
