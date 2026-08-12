/**
 * ワールド構築の入口。データ取得（net/data）と描画（world/*）を束ねる。
 *
 * 後続タスク（徒歩物理・車両・P2P同期）向けの契約:
 *   - `worldEvents` の 'progress' / 'ready' を購読すればロード完了を待てる（E2）
 *   - `World.getElevationAt(x, z)` で任意地点の地表標高[m]が取れる（スポーン位置・接地判定用）
 *   - `World.update(camera, quality)` を毎フレーム呼ぶと HLOD 選択・カリング・
 *     樹木インスタンスの詰め直しが走る
 */
import { Frustum, Group, Matrix4, Scene, Vector3, type PerspectiveCamera, type WebGPURenderer } from 'three/webgpu';
import { countDemTiles, loadElevationSampler } from '../data/dem';
import { countPhotoTiles, loadAerialImage } from '../data/photo';
import { loadBuildingHeights, loadGi, loadHeightmap, loadTrees } from '../data/terrain-assets';
import type { TreeInstance } from '../data/terrain-assets';
import { countVectorTiles, loadVectorFeatures } from '../data/vector';
import type { WaterShape } from '../data/vector';
import type { QualitySettings } from '../quality';
import { buildRoadProfiles, type RoadPath } from '../shared/road-profile.js';
import { worldStats } from '../ui/stats';
import { buildBridgeSpans, createBridges, type BridgeSpan } from './bridges';
import { createBuildings, type BuildingCollision } from './buildings';
import { buildOccupancy } from './occupancy';
import { createProps } from './props';
import { createRoads } from './roads';
import { createTerrain, type Terrain } from './terrain';
import { createVegetation, type Vegetation } from './vegetation';

/** 徒歩視点の立ち位置（原点にいちばん近い道路上の点と、その進行方向） */
export interface Spawn {
    x: number;
    z: number;
    dirX: number;
    dirZ: number;
}

export interface World {
    group: Group;
    terrain: Terrain;
    vegetation: Vegetation | null;
    spawn: Spawn;
    /**
     * 物理コライダーの素材（契約04）。描画に使ったのと同じ形状を渡すので、
     * 当たり判定と見た目がずれない
     */
    collision: {
        buildings: readonly BuildingCollision[];
        /** 縦断プロファイル付きの道路（描画リボンと同じ高さでコライダーを作る） */
        roads: readonly RoadPath[];
        bridges: readonly BridgeSpan[];
    };
    /**
     * 2Dマップ（契約09 / src/ui/map.ts）への受け渡し口。読み込み済みの配列を
     * そのまま参照させる（タイルを取り直さない・コピーも作らない）。
     * 地形の起伏は getElevationAt から直接サンプルする
     */
    mapFeatures: {
        roads: readonly RoadPath[];
        buildings: readonly BuildingCollision[];
        water: readonly WaterShape[];
        /** 前処理アセットが無い環境では空（緑地レイヤーが出ないだけ・E57） */
        trees: readonly TreeInstance[];
    };
    /** 地表標高[m]。エリア外は端の値にクランプされる */
    getElevationAt(x: number, z: number): number;
    /** 毎フレーム呼ぶ。HLOD 選択・距離/フラスタムカリング・樹木の詰め直し */
    update(camera: PerspectiveCamera, quality: QualitySettings, force?: boolean): void;
    /** 起動時のシェーダープリウォーム（追記2-8）。全パイプラインを一度コンパイルする */
    prewarm(renderer: WebGPURenderer, scene: Scene, camera: PerspectiveCamera): Promise<void>;
    stats: {
        buildings: number;
        /** 50cm DSM/DEM 由来の実測高さを適用できた建物数 */
        buildingsMeasured: number;
        roads: number;
        trees: number;
        vegetationItems: number;
        /** 高精細ハイトマップ（50cm DEM 由来）を使えたか */
        hiresTerrain: boolean;
        vectorTilesFailed: number;
        minElevation: number;
        maxElevation: number;
    };
}

export interface WorldProgress {
    loaded: number;
    total: number;
    phase: string;
}

/**
 * ロード進捗と完了の購読先。
 *   worldEvents.addEventListener('ready', (e) => (e as CustomEvent<World>).detail)
 */
export const worldEvents = new EventTarget();

let currentWorld: World | null = null;

/** 構築済みワールド。未完了なら null（'ready' を待つこと） */
export function getWorld(): World | null {
    return currentWorld;
}

// フレームループ内で確保しないためのスクラッチ（追記2-6）
const frustum = new Frustum();
const projScreen = new Matrix4();
const cameraPos = new Vector3();
const cameraDir = new Vector3();

/** 大きな生成を挟むたびに1フレーム譲ってローディング表示を止めない */
function nextFrame(): Promise<void> {
    return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

export async function buildWorld(
    scene: Scene,
    quality: QualitySettings,
    signal?: AbortSignal,
): Promise<World> {
    const total = countDemTiles() + countPhotoTiles() + countVectorTiles();
    let loaded = 0;
    let phase = '地形・航空写真・地物タイルを取得中';

    const emit = (): void => {
        worldEvents.dispatchEvent(
            new CustomEvent<WorldProgress>('progress', { detail: { loaded, total, phase } }),
        );
    };
    const onTile = (): void => {
        loaded++;
        emit();
    };
    emit();

    // タイル3系統と前処理アセット3種を並列に取得する。到着順は問わない（E3）。
    // 前処理アセットは無ければ null が返り、タイルだけで従来どおり組み上がる
    const [sampler, aerial, features, heightmap, gi, measuredHeights, treePoints] = await Promise.all([
        loadElevationSampler(onTile, signal),
        loadAerialImage(onTile, signal),
        loadVectorFeatures(onTile, signal),
        loadHeightmap(signal),
        loadGi(signal),
        loadBuildingHeights(signal),
        loadTrees(signal),
    ]);
    if (!gi) console.info('[world] ベイクGI が無いため実行時の粗い遮蔽で表示します（E58）');

    phase = '地形メッシュを生成中';
    emit();
    await nextFrame();
    const terrain = createTerrain(sampler, aerial, heightmap, gi, quality);

    phase = '道路の縦断を解いています';
    emit();
    await nextFrame();
    // 路面標高は前処理と同じソルバーで解く（src/shared/road-profile.js）。
    // 地形は前処理でこの縦断へカービング済みなので、通常部は地形標高そのまま
    // （pinned）= 路面と地面に段差が出ない。橋だけが両端の取付点を結ぶ直線になる（契約08）
    const profiled = buildRoadProfiles(features.roads, terrain.getElevationAt, { pinned: true });
    const bridgeSpans = buildBridgeSpans(profiled.paths);

    phase = '道路・建物の占有図を作成中';
    emit();
    await nextFrame();
    const occupancy = buildOccupancy(features.buildings, features.roads);

    phase = '建物と屋根を生成中';
    emit();
    await nextFrame();
    const buildings = createBuildings(
        features.buildings,
        terrain.getElevationAt,
        measuredHeights,
        gi,
        quality,
    );

    phase = '道路・歩道を生成中';
    emit();
    await nextFrame();
    const roads = createRoads(profiled.paths, gi, quality);
    const bridges = createBridges(bridgeSpans, terrain.getElevationAt, quality);
    if (bridgeSpans.length > 0) {
        console.info(
            `[world] 橋 ${bridges.count}本（RdCL セグメント ${profiled.stats.bridgePaths}本）/ 橋脚 ${bridges.piers}基 ` +
                `(三角形 ${bridges.triangles.toLocaleString()})`,
        );
    }

    phase = '電柱・ガードレールを配置中';
    emit();
    await nextFrame();
    const props = quality.props
        ? createProps(features.roads, occupancy, terrain.getElevationAt, quality)
        : null;

    phase = '植生を生成中';
    emit();
    await nextFrame();
    let vegetation: Vegetation | null = null;
    if (treePoints && treePoints.length > 0) {
        vegetation = createVegetation(
            treePoints,
            features.buildings,
            features.roads,
            occupancy,
            terrain.getElevationAt,
            gi,
            quality,
        );
    }

    const group = new Group();
    group.name = 'world';
    group.add(terrain.group, roads.hlod.group, bridges.group, buildings.hlod.group);
    if (props) group.add(props.group);
    if (vegetation) group.add(vegetation.group);
    scene.add(group);

    if (buildings.total > 0 && !measuredHeights) {
        console.info('[world] 建物実高さアセットが無いため階数ヒューリスティックで表示します');
    } else if (buildings.total > 0) {
        const rate = ((buildings.measured / buildings.total) * 100).toFixed(1);
        console.info(`[world] 建物実高さの一致率 ${rate}% (${buildings.measured}/${buildings.total})`);
    }

    const chunkTotal =
        terrain.chunkCount + buildings.hlod.cellCount + roads.hlod.cellCount + (props?.cellCount ?? 0);

    // 徒歩視点は道路上に立たせる（原点は斜面や建物の中に落ちることがある）。
    // ?spawn=x,z を付けるとその座標にいちばん近い道路上へ降りる（橋などの目視検証用）
    const wanted = { x: 0, z: 0 };
    const spawnParam = new URLSearchParams(location.search).get('spawn');
    if (spawnParam) {
        const [px, pz] = spawnParam.split(',').map(Number);
        if (Number.isFinite(px) && Number.isFinite(pz)) {
            wanted.x = px;
            wanted.z = pz;
        }
    }
    let spawn: Spawn = { x: wanted.x, z: wanted.z, dirX: 0, dirZ: -1 };
    let bestDistance = Infinity;
    for (const road of features.roads) {
        if (road.width < 4 || road.bridge) continue;
        for (let i = 0; i + 1 < road.points.length; i++) {
            const p = road.points[i];
            const d = (p.x - wanted.x) ** 2 + (p.z - wanted.z) ** 2;
            if (d >= bestDistance) continue;
            const q = road.points[i + 1];
            const len = Math.hypot(q.x - p.x, q.z - p.z) || 1;
            bestDistance = d;
            spawn = { x: p.x, z: p.z, dirX: (q.x - p.x) / len, dirZ: (q.z - p.z) / len };
        }
    }

    const world: World = {
        group,
        terrain,
        vegetation,
        spawn,
        collision: { buildings: buildings.collision, roads: profiled.paths, bridges: bridgeSpans },
        mapFeatures: {
            roads: profiled.paths,
            buildings: buildings.collision,
            water: features.water,
            trees: treePoints ?? [],
        },
        getElevationAt: terrain.getElevationAt,
        update(camera, q, force = false) {
            camera.updateMatrixWorld();
            projScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
            frustum.setFromProjectionMatrix(projScreen);
            camera.getWorldPosition(cameraPos);
            camera.getWorldDirection(cameraDir);

            terrain.update(cameraPos, frustum, q);
            buildings.hlod.update(cameraPos, frustum, q.hlodNear, q.hlodMid, q.viewDistance);
            roads.hlod.update(cameraPos, frustum, q.hlodNear, q.hlodMid, q.viewDistance);
            props?.update(cameraPos, frustum, q.propDistance * 0.45, q.propDistance, q.propDistance);
            vegetation?.update(cameraPos, cameraDir, frustum, q, force);

            worldStats.chunksTotal = chunkTotal;
            worldStats.chunksDrawn =
                terrain.drawn.count +
                buildings.hlod.drawn[0] +
                buildings.hlod.drawn[1] +
                buildings.hlod.drawn[2] +
                roads.hlod.drawn[0] +
                roads.hlod.drawn[1] +
                roads.hlod.drawn[2] +
                (props ? props.drawn[0] + props.drawn[1] + props.drawn[2] : 0);
            worldStats.hlod0 = buildings.hlod.drawn[0] + roads.hlod.drawn[0] + (props?.drawn[0] ?? 0);
            worldStats.hlod1 = buildings.hlod.drawn[1] + roads.hlod.drawn[1] + (props?.drawn[1] ?? 0);
            worldStats.hlod2 = buildings.hlod.drawn[2] + roads.hlod.drawn[2] + (props?.drawn[2] ?? 0);
            worldStats.treeNear = vegetation?.drawn[0] ?? 0;
            worldStats.treeMid = vegetation?.drawn[1] ?? 0;
            worldStats.treeFar = vegetation?.drawn[2] ?? 0;
        },
        async prewarm(renderer, warmScene, camera) {
            // 一時的に全段階を可視にして、全パイプラインをコンパイルさせる
            const hidden: { object: { visible: boolean }; was: boolean }[] = [];
            const counts: { mesh: { count: number }; was: number }[] = [];
            group.traverse((obj) => {
                const mesh = obj as unknown as { isInstancedMesh?: boolean; count: number };
                if (!obj.visible) {
                    hidden.push({ object: obj, was: obj.visible });
                    obj.visible = true;
                }
                if (mesh.isInstancedMesh && mesh.count === 0) {
                    counts.push({ mesh, was: mesh.count });
                    mesh.count = 1;
                }
            });
            const startedAt = performance.now();
            try {
                await renderer.compileAsync(warmScene, camera);
                console.info(`[world] シェーダーのプリウォーム ${Math.round(performance.now() - startedAt)}ms`);
            } catch (err) {
                console.warn('[world] シェーダーのプリウォームに失敗しました', err);
            }
            for (const entry of hidden) entry.object.visible = entry.was;
            for (const entry of counts) entry.mesh.count = entry.was;
        },
        stats: {
            buildings: features.buildings.length,
            buildingsMeasured: buildings.measured,
            roads: features.roads.length,
            trees: treePoints?.length ?? 0,
            vegetationItems: vegetation?.itemCount ?? 0,
            hiresTerrain: terrain.hires,
            vectorTilesFailed: features.tilesFailed,
            minElevation: terrain.minElevation,
            maxElevation: terrain.maxElevation,
        },
    };
    currentWorld = world;

    phase = 'ワールド準備完了';
    loaded = total;
    emit();
    worldEvents.dispatchEvent(new CustomEvent<World>('ready', { detail: world }));
    return world;
}
