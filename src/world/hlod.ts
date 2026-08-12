/**
 * HLOD（ヒエラルキカルLOD）。ワールドを四分木セルに切り、
 *   近: 個別ジオメトリ（L0 / 180m セル）
 *   中: 簡略統合メッシュ（L1 / 360m セル）
 *   遠: セル単位の統合プロキシ（L2 / 720m セル）
 * を距離で選び分ける。上位段階を描くときは配下の下位段階を丸ごと切るので
 * 二重描画は起きない。
 *
 * フレームループ内で new を作らない（追記2-6）: 走査スタックとスクラッチ
 * ベクタはモジュールスコープで使い回す。
 */
import { Box3, Frustum, Group, Object3D, Vector3 } from 'three/webgpu';
import { AREA_HALF, CULL_MARGIN } from '../config';

/** L0 セルの半辺[m]。L1 は2倍、L2 は4倍 */
export const HLOD_L0_HALF = 90;
const LEVELS = 3;

export interface HlodCell {
    level: number;
    cx: number;
    cz: number;
    half: number;
}

interface HlodNode {
    cell: HlodCell;
    box: Box3;
    object: Object3D | null;
    children: HlodNode[] | null;
    items: number[];
}

export interface Hlod {
    group: Group;
    /** 段階ごとの描画セル数（stats 用）。update のたびに書き換わる */
    readonly drawn: Int32Array;
    readonly cellCount: number;
    update(cameraPos: Vector3, frustum: Frustum, nearDist: number, midDist: number, viewDist: number): void;
}

/** レベル L のセル半辺 */
function halfAt(level: number): number {
    return HLOD_L0_HALF * (1 << level);
}

const scratchBox = new Box3();
const scratchVec = new Vector3();
const stack: HlodNode[] = [];

/**
 * アイテム（建物・道路片・小物）を四分木に配り、段階ごとの統合メッシュを作る。
 * build は「そのセルに属するアイテム番号」を受け取り、Object3D か null を返す。
 */
export function buildHlod(
    positions: readonly { readonly x: number; readonly z: number }[],
    build: (level: number, indices: readonly number[], cell: HlodCell) => Object3D | null,
): Hlod {
    const group = new Group();
    group.name = 'hlod';

    const limit = AREA_HALF + CULL_MARGIN;
    const topHalf = halfAt(LEVELS - 1);
    const topCount = Math.max(1, Math.ceil(limit / topHalf));

    const makeNode = (level: number, cx: number, cz: number): HlodNode => ({
        cell: { level, cx, cz, half: halfAt(level) },
        box: new Box3(),
        object: null,
        children: null,
        items: [],
    });

    // 最上位セル（原点対称に敷き詰める）
    const roots: HlodNode[] = [];
    for (let iz = -topCount; iz < topCount; iz++) {
        for (let ix = -topCount; ix < topCount; ix++) {
            roots.push(makeNode(LEVELS - 1, (ix + 0.5) * topHalf * 2, (iz + 0.5) * topHalf * 2));
        }
    }

    const cellOf = (node: HlodNode, x: number, z: number): boolean =>
        Math.abs(x - node.cell.cx) <= node.cell.half && Math.abs(z - node.cell.cz) <= node.cell.half;

    // アイテムを配る（上位セル → 子セルへ再帰的に分配）
    const distribute = (node: HlodNode): void => {
        if (node.cell.level === 0 || node.items.length === 0) return;
        const half = node.cell.half / 2;
        node.children = [];
        for (const sz of [-1, 1]) {
            for (const sx of [-1, 1]) {
                node.children.push(
                    makeNode(node.cell.level - 1, node.cell.cx + sx * half, node.cell.cz + sz * half),
                );
            }
        }
        for (const index of node.items) {
            const p = positions[index];
            for (const child of node.children) {
                if (cellOf(child, p.x, p.z)) {
                    child.items.push(index);
                    break;
                }
            }
        }
        node.children = node.children.filter((c) => c.items.length > 0);
        for (const child of node.children) distribute(child);
    };

    for (let i = 0; i < positions.length; i++) {
        const p = positions[i];
        for (const root of roots) {
            if (cellOf(root, p.x, p.z)) {
                root.items.push(i);
                break;
            }
        }
    }
    for (const root of roots) distribute(root);

    // 段階ごとのメッシュを作る
    let cellCount = 0;
    const construct = (node: HlodNode): void => {
        if (node.items.length === 0) return;
        cellCount++;
        node.object = build(node.cell.level, node.items, node.cell);
        if (node.object) {
            node.object.visible = false;
            group.add(node.object);
            scratchBox.setFromObject(node.object, true);
            node.box.copy(scratchBox);
        } else {
            // 中身を作れなかったセルはセル範囲そのものを箱にしておく
            node.box.set(
                new Vector3(node.cell.cx - node.cell.half, -100, node.cell.cz - node.cell.half),
                new Vector3(node.cell.cx + node.cell.half, 900, node.cell.cz + node.cell.half),
            );
        }
        if (node.children) for (const child of node.children) construct(child);
    };
    for (const root of roots) construct(root);

    const drawn = new Int32Array(LEVELS);
    const hideSubtree = (node: HlodNode): void => {
        if (node.object) node.object.visible = false;
        if (node.children) for (const child of node.children) hideSubtree(child);
    };

    return {
        group,
        drawn,
        cellCount,
        update(cameraPos, frustum, nearDist, midDist, viewDist) {
            drawn.fill(0);
            stack.length = 0;
            for (const root of roots) if (root.items.length > 0) stack.push(root);
            while (stack.length > 0) {
                const node = stack.pop() as HlodNode;
                node.box.clampPoint(cameraPos, scratchVec);
                const dist = scratchVec.distanceTo(cameraPos);
                if (dist > viewDist || !frustum.intersectsBox(node.box)) {
                    hideSubtree(node);
                    continue;
                }
                const threshold = node.cell.level === 2 ? midDist : nearDist;
                const useThis = node.cell.level === 0 || dist > threshold || !node.children;
                if (useThis && node.object) {
                    node.object.visible = true;
                    drawn[node.cell.level]++;
                    if (node.children) for (const child of node.children) hideSubtree(child);
                    continue;
                }
                if (node.object) node.object.visible = false;
                if (node.children) for (const child of node.children) stack.push(child);
            }
        },
    };
}
