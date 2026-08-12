/**
 * ワールド構築の入口。データ取得（net/data）と描画（world/*）を束ねる。
 *
 * 後続タスク（徒歩物理・車両・P2P同期）向けの契約:
 *   - `worldEvents` の 'progress' / 'ready' を購読すればロード完了を待てる（E2）
 *   - `World.getElevationAt(x, z)` で任意地点の地表標高[m]が取れる（スポーン位置・接地判定用）
 */
import { Group, Scene } from 'three/webgpu';
import { countDemTiles, loadElevationSampler } from '../data/dem';
import { countPhotoTiles, loadAerialImage } from '../data/photo';
import { loadBuildingHeights, loadHeightmap, loadTrees } from '../data/terrain-assets';
import { countVectorTiles, loadVectorFeatures } from '../data/vector';
import { createBuildings } from './buildings';
import { createRoads } from './roads';
import { createTerrain, type Terrain } from './terrain';
import { createTrees } from './trees';

export interface World {
    group: Group;
    terrain: Terrain;
    /** 地表標高[m]。エリア外は端の値にクランプされる */
    getElevationAt(x: number, z: number): number;
    stats: {
        buildings: number;
        /** 50cm DSM/DEM 由来の実測高さを適用できた建物数 */
        buildingsMeasured: number;
        roads: number;
        trees: number;
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

export async function buildWorld(scene: Scene, signal?: AbortSignal): Promise<World> {
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
    const [sampler, aerial, features, heightmap, measuredHeights, treePoints] = await Promise.all([
        loadElevationSampler(onTile, signal),
        loadAerialImage(onTile, signal),
        loadVectorFeatures(onTile, signal),
        loadHeightmap(signal),
        loadBuildingHeights(signal),
        loadTrees(signal),
    ]);

    phase = '地形メッシュを生成中';
    emit();
    const terrain = createTerrain(sampler, aerial, heightmap);

    phase = '建物・道路を生成中';
    emit();
    const buildings = createBuildings(features.buildings, terrain.getElevationAt, measuredHeights);
    const roads = createRoads(features.roads, terrain.getElevationAt);

    const group = new Group();
    group.name = 'world';
    group.add(terrain.mesh, roads, buildings.mesh);

    if (treePoints && treePoints.length > 0) {
        phase = '樹木を配置中';
        emit();
        const trees = createTrees(treePoints, terrain.getElevationAt);
        if (trees) group.add(trees);
    }
    scene.add(group);

    if (buildings.total > 0 && !measuredHeights) {
        console.info('[world] 建物実高さアセットが無いため階数ヒューリスティックで表示します');
    } else if (buildings.total > 0) {
        const rate = ((buildings.measured / buildings.total) * 100).toFixed(1);
        console.info(`[world] 建物実高さの一致率 ${rate}% (${buildings.measured}/${buildings.total})`);
    }

    const world: World = {
        group,
        terrain,
        getElevationAt: terrain.getElevationAt,
        stats: {
            buildings: features.buildings.length,
            buildingsMeasured: buildings.measured,
            roads: features.roads.length,
            trees: treePoints?.length ?? 0,
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
