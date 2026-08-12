/**
 * エントリポイント。レンダラー初期化 → 環境構築 → ワールド読み込み → 描画ループ。
 * レンダラーは WebGPURenderer を使う。WebGPU 非対応環境では three が
 * WebGL2 バックエンドへ自動フォールバックする（E5-b）。
 */
import { ACESFilmicToneMapping, PCFSoftShadowMap, PerspectiveCamera, Scene, Vector3, WebGPURenderer } from 'three/webgpu';
import { createFlyCamera } from './camera';
import { hideLoading, setLoadingProgress, setStatus, showFatal } from './ui/loading';
import { createEnvironment } from './world/environment';
import { buildWorld, worldEvents, type World, type WorldProgress } from './world';

async function start(): Promise<void> {
    const container = document.getElementById('app');
    if (!container) throw new Error('#app が見つかりません');

    // ?webgl を付けると WebGL2 バックエンドを強制する（E5-b のフォールバック確認用）
    const forceWebGL = new URLSearchParams(location.search).has('webgl');
    const renderer = new WebGPURenderer({ antialias: true, forceWebGL });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.toneMapping = ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.95;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = PCFSoftShadowMap;
    await renderer.init();
    container.appendChild(renderer.domElement);

    const backend = (renderer.backend as unknown as { isWebGPUBackend?: boolean }).isWebGPUBackend
        ? 'WebGPU'
        : 'WebGL2';

    const scene = new Scene();
    const camera = new PerspectiveCamera(60, window.innerWidth / window.innerHeight, 1, 30000);
    camera.position.set(0, 700, 900);
    const controls = createFlyCamera(camera, renderer.domElement);
    controls.setView(new Vector3(0, 700, 900), new Vector3(0, 250, -300));

    createEnvironment(scene);

    const onResize = (): void => {
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
    };
    window.addEventListener('resize', onResize);

    worldEvents.addEventListener('progress', (e) => {
        const p = (e as CustomEvent<WorldProgress>).detail;
        setLoadingProgress(p.loaded, p.total, p.phase);
    });
    worldEvents.addEventListener('ready', (e) => {
        const world = (e as CustomEvent<World>).detail;
        const groundY = world.getElevationAt(0, 0);
        controls.setView(
            new Vector3(0, groundY + 330, 780),
            new Vector3(0, groundY + 60, -260),
        );
        hideLoading();
        const s = world.stats;
        setStatus(
            `${backend}　建物 ${s.buildings}（実測高さ ${s.buildingsMeasured}）　道路 ${s.roads}　` +
                `樹木 ${s.trees}　標高 ${s.minElevation.toFixed(0)}〜${s.maxElevation.toFixed(0)}m` +
                `　地形 ${s.hiresTerrain ? '50cm' : 'DEM5A'}` +
                (s.vectorTilesFailed > 0 ? `　欠損タイル ${s.vectorTilesFailed}` : ''),
        );
    });

    let last = performance.now();
    renderer.setAnimationLoop((now: number) => {
        const dt = Math.min(0.1, (now - last) / 1000);
        last = now;
        controls.update(dt);
        renderer.render(scene, camera);
    });

    try {
        await buildWorld(scene);
    } catch (err) {
        console.error(err);
        showFatal(`ワールドの読み込みに失敗しました: ${String(err)}`);
    }
}

start().catch((err: unknown) => {
    console.error(err);
    showFatal(
        `描画を開始できませんでした（WebGPU/WebGL2 のどちらも利用できない可能性があります）: ${String(err)}`,
    );
});
