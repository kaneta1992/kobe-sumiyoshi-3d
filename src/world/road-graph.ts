/**
 * RdCL（道路中心線）から作る移動グラフ（契約12）。BOT の経路探索に使う。
 *
 * ワールドは全員同一なので、このグラフも全員同じものになる（BOT を動かすのはホスト
 * だけだが、ホストが替わっても同じ経路が出る = リプレイ可能）。
 *
 * 作り方:
 *   - 縦断プロファイル済みの道路の頂点（PROFILE_STEP = 6m 間隔）をノードにする
 *   - 2m 格子へ量子化して同じ点をまとめる（交差点で線どうしがつながる）
 *   - 隣接セルにある 2.5m 以内のノードも結ぶ（端点がセル境界で分かれた交差点の救済）
 *   - 隣接は CSR（連続配列）で持ち、探索中にアロケーションしない
 *
 * 探索は A*（直線距離ヒューリスティック）。作業配列は使い回し、訪問済みの判定は
 * 世代スタンプで行う（毎回のクリアを省く）。
 */
import type { RoadPath } from '../shared/road-profile.js';

/** ノードをまとめる格子の一辺[m] */
const CELL = 2;
/** 隣接セルのノードを結ぶ距離[m] */
const JOIN = 2.5;
/** 最寄りノードを探す空間ハッシュの一辺[m] */
const LOOKUP_CELL = 32;
/** A* が1回の探索で取り出すノードの上限（病的な入力で固まらないように） */
const MAX_EXPAND = 80000;

export interface RoadGraph {
    readonly nodeCount: number;
    /** ノードの座標 */
    x(node: number): number;
    z(node: number): number;
    /** (x,z) にいちばん近いノード。range[m] 以内に無ければ -1 */
    nearest(x: number, z: number, range?: number): number;
    /**
     * A* 経路。out へ from → to のノード番号を順に書き、長さを返す（0 = 到達不能）。
     * out に収まらない長さの経路は out.length で打ち切る（先頭ぶんだけ辿れば十分）
     */
    findPath(from: number, to: number, out: Int32Array): number;
}

export function buildRoadGraph(roads: readonly RoadPath[]): RoadGraph {
    // --- ノードの作成（2m 格子で同じ点をまとめる） ---
    const cellOf = (x: number, z: number): number =>
        (Math.round(x / CELL) + 4096) * 8192 + (Math.round(z / CELL) + 4096);
    const nodeOfCell = new Map<number, number>();
    const nx: number[] = [];
    const nz: number[] = [];
    const edgeA: number[] = [];
    const edgeB: number[] = [];

    const nodeAt = (x: number, z: number): number => {
        const key = cellOf(x, z);
        const found = nodeOfCell.get(key);
        if (found !== undefined) return found;
        const index = nx.length;
        nx.push(x);
        nz.push(z);
        nodeOfCell.set(key, index);
        return index;
    };

    for (const road of roads) {
        const points = road.points;
        let previous = -1;
        for (let i = 0; i < points.length; i++) {
            const node = nodeAt(points[i].x, points[i].z);
            if (previous >= 0 && previous !== node) {
                edgeA.push(previous);
                edgeB.push(node);
            }
            previous = node;
        }
    }

    // --- セル境界で分かれた同じ交差点をつなぐ ---
    for (const [key, node] of nodeOfCell) {
        for (let dx = 0; dx <= 1; dx++) {
            for (let dz = dx === 0 ? 1 : -1; dz <= 1; dz++) {
                const other = nodeOfCell.get(key + dx * 8192 + dz);
                if (other === undefined || other === node) continue;
                if (Math.hypot(nx[node] - nx[other], nz[node] - nz[other]) > JOIN) continue;
                edgeA.push(node);
                edgeB.push(other);
            }
        }
    }

    const nodeCount = nx.length;
    const posX = new Float32Array(nx);
    const posZ = new Float32Array(nz);

    // --- 隣接を CSR へ（両方向） ---
    const degree = new Int32Array(nodeCount + 1);
    for (let i = 0; i < edgeA.length; i++) {
        degree[edgeA[i]]++;
        degree[edgeB[i]]++;
    }
    const start = new Int32Array(nodeCount + 1);
    let total = 0;
    for (let i = 0; i < nodeCount; i++) {
        start[i] = total;
        total += degree[i];
    }
    start[nodeCount] = total;
    const fill = new Int32Array(nodeCount);
    const neighbour = new Int32Array(total);
    const cost = new Float32Array(total);
    const link = (a: number, b: number): void => {
        const at = start[a] + fill[a]++;
        neighbour[at] = b;
        cost[at] = Math.hypot(posX[a] - posX[b], posZ[a] - posZ[b]);
    };
    for (let i = 0; i < edgeA.length; i++) {
        link(edgeA[i], edgeB[i]);
        link(edgeB[i], edgeA[i]);
    }

    // --- 最寄りノード用の空間ハッシュ ---
    const buckets = new Map<number, number[]>();
    const bucketOf = (x: number, z: number): number =>
        (Math.floor(x / LOOKUP_CELL) + 512) * 2048 + (Math.floor(z / LOOKUP_CELL) + 512);
    for (let i = 0; i < nodeCount; i++) {
        const key = bucketOf(posX[i], posZ[i]);
        const list = buckets.get(key);
        if (list) list.push(i);
        else buckets.set(key, [i]);
    }

    // --- A* の作業配列（使い回し。世代スタンプで初期化を省く） ---
    const gScore = new Float32Array(nodeCount);
    const cameFrom = new Int32Array(nodeCount);
    const stamp = new Int32Array(nodeCount);
    const closed = new Uint8Array(nodeCount);
    let generation = 0;
    const heapNode = new Int32Array(nodeCount + 8);
    const heapCost = new Float32Array(nodeCount + 8);
    let heapSize = 0;

    const heapPush = (node: number, priority: number): void => {
        if (heapSize >= heapNode.length) return;
        let i = heapSize++;
        heapNode[i] = node;
        heapCost[i] = priority;
        while (i > 0) {
            const parent = (i - 1) >> 1;
            if (heapCost[parent] <= heapCost[i]) break;
            const tn = heapNode[parent];
            const tc = heapCost[parent];
            heapNode[parent] = heapNode[i];
            heapCost[parent] = heapCost[i];
            heapNode[i] = tn;
            heapCost[i] = tc;
            i = parent;
        }
    };
    const heapPop = (): number => {
        const top = heapNode[0];
        heapSize--;
        if (heapSize > 0) {
            heapNode[0] = heapNode[heapSize];
            heapCost[0] = heapCost[heapSize];
            let i = 0;
            for (;;) {
                const left = i * 2 + 1;
                const right = left + 1;
                let best = i;
                if (left < heapSize && heapCost[left] < heapCost[best]) best = left;
                if (right < heapSize && heapCost[right] < heapCost[best]) best = right;
                if (best === i) break;
                const tn = heapNode[best];
                const tc = heapCost[best];
                heapNode[best] = heapNode[i];
                heapCost[best] = heapCost[i];
                heapNode[i] = tn;
                heapCost[i] = tc;
                i = best;
            }
        }
        return top;
    };

    console.info(`[nav] 道路グラフ ノード ${nodeCount}　辺 ${edgeA.length}`);

    return {
        nodeCount,
        x(node) {
            return posX[node];
        },
        z(node) {
            return posZ[node];
        },
        nearest(x, z, range = 120) {
            let best = -1;
            let bestDistance = range * range;
            const rings = Math.max(1, Math.ceil(range / LOOKUP_CELL));
            const cx = Math.floor(x / LOOKUP_CELL);
            const cz = Math.floor(z / LOOKUP_CELL);
            for (let ring = 0; ring <= rings; ring++) {
                for (let dx = -ring; dx <= ring; dx++) {
                    for (let dz = -ring; dz <= ring; dz++) {
                        // 内側のリングは前の周回で見ている
                        if (ring > 0 && Math.abs(dx) !== ring && Math.abs(dz) !== ring) continue;
                        const list = buckets.get(
                            ((cx + dx) + 512) * 2048 + ((cz + dz) + 512),
                        );
                        if (!list) continue;
                        for (const node of list) {
                            const d = (posX[node] - x) ** 2 + (posZ[node] - z) ** 2;
                            if (d >= bestDistance) continue;
                            bestDistance = d;
                            best = node;
                        }
                    }
                }
                // ひとつ見つかったリングの外側まで見れば十分（ここは最短でなくてもよい）
                if (best >= 0 && ring > 0) break;
            }
            return best;
        },
        findPath(from, to, out) {
            if (from < 0 || to < 0 || from >= nodeCount || to >= nodeCount) return 0;
            if (from === to) {
                out[0] = from;
                return 1;
            }
            generation++;
            heapSize = 0;
            gScore[from] = 0;
            cameFrom[from] = -1;
            stamp[from] = generation;
            closed[from] = 0;
            heapPush(from, Math.hypot(posX[to] - posX[from], posZ[to] - posZ[from]));
            let expanded = 0;
            let found = false;
            while (heapSize > 0 && expanded < MAX_EXPAND) {
                const node = heapPop();
                if (stamp[node] !== generation || closed[node] === 1) continue;
                closed[node] = 1;
                expanded++;
                if (node === to) {
                    found = true;
                    break;
                }
                const end = start[node + 1];
                for (let i = start[node]; i < end; i++) {
                    const next = neighbour[i];
                    const g = gScore[node] + cost[i];
                    if (stamp[next] === generation && g >= gScore[next]) continue;
                    stamp[next] = generation;
                    closed[next] = 0;
                    gScore[next] = g;
                    cameFrom[next] = node;
                    heapPush(next, g + Math.hypot(posX[to] - posX[next], posZ[to] - posZ[next]));
                }
            }
            if (!found) return 0;
            // 逆順に辿って out へ詰め直す
            let length = 0;
            for (let node = to; node >= 0; node = cameFrom[node]) {
                length++;
                if (node === from) break;
            }
            const count = Math.min(length, out.length);
            let node = to;
            for (let i = length - 1; i >= 0; i--) {
                if (i < count) out[i] = node;
                if (node === from) break;
                node = cameFrom[node];
            }
            return count;
        },
    };
}
