/**
 * エントリポイント。レンダラー初期化 → 環境構築 → ワールド読み込み → 描画ループ。
 * レンダラーは WebGPURenderer を使う。WebGPU 非対応環境では three が
 * WebGL2 バックエンドへ自動フォールバックする（E5-b）。
 *
 * 既定は三人称の徒歩（契約04）。物理・入力・カメラは src/game が持つ。
 *
 * URL パラメータ:
 *   ?webgl              WebGL2 バックエンドを強制（フォールバック確認用）
 *   ?quality=mobile|desktop / ?tier=0..2   品質プリセットの強制
 *   ?stats              画面内 stats（fps / draw / tri / chunk / HLOD / scale / phys）
 *   ?fly                自由カメラ（デバッグ用。物理を読み込まない）
 *   ?hour=15.5          太陽の時刻（0〜24。夜は月光になる）
 *   ?shot=1..6          画作りレビュー用の定点カメラ（契約07）
 *   ?spawn=x,z          指定座標にいちばん近い道路上から開始（橋などの目視検証用）
 *   ?room=名前          マルチプレイのルーム（既定 kobe-sumiyoshi-3d-v1）
 *   ?solo               マルチプレイを使わない
 *
 * 性能規律（契約03 追記2）:
 *   - フレームループ内で new を作らない
 *   - フレームタイムの EMA を見てレンダースケールを段階降格 / 復帰
 *   - それでも足りなければ品質段階（tier）を1段ずつ落とす（戻さない）
 */
import { ACESFilmicToneMapping, PCFSoftShadowMap, PerspectiveCamera, Scene, Vector3, WebGPURenderer } from 'three/webgpu';
import { createFlyCamera, shotHour, shotIndex, shotView, type ShotView } from './camera';
import type { Game } from './game';
import type { Multiplayer } from './net/multiplayer';
import { createQuality, initialQuality, maxTier, sunHour, tierIsPinned, type QualitySettings } from './quality';
import { createPostProcessing, type PostChain } from './render/post';
import { createStatsOverlay } from './ui/stats';
import { createMapOverlay, type MapOverlay } from './ui/map';
import { hideLoading, setHelp, setLoadingProgress, setStatus, showFatal } from './ui/loading';
import { createEnvironment } from './world/environment';
import { fogRangeNode, setSunHour } from './world/sun';
import { buildWorld, worldEvents, type World, type WorldProgress } from './world';

/** 動的解像度スケーリングの段階 */
const RENDER_SCALES = [1, 0.85, 0.72, 0.6, 0.5];
/** レンダースケールを見直す間隔[s]（頻繁に変えるとバッファ再確保でかえって重い） */
const SCALE_INTERVAL = 1.4;
/** 品質段階を落とすまでに我慢する時間[s] */
const TIER_PATIENCE = 6;

async function start(): Promise<void> {
    const container = document.getElementById('app');
    if (!container) throw new Error('#app が見つかりません');

    let quality: QualitySettings = initialQuality();
    // ?webgl を付けると WebGL2 バックエンドを強制する（E5-b のフォールバック確認用）
    const params = new URLSearchParams(location.search);
    // 定点カメラ（?shot）は画に固有の時刻を持つ。?hour が明示されていればそちらを優先。
    // 太陽光の色・強さは環境の構築時に読むので、ここで確定させておく
    const shot = shotIndex();
    const forcedHour = params.has('hour') ? null : shotHour(shot);
    setSunHour(forcedHour ?? sunHour());
    const forceWebGL = params.has('webgl');
    const renderer = new WebGPURenderer({ antialias: false, forceWebGL });
    const basePixelRatio = Math.min(window.devicePixelRatio, quality.maxPixelRatio);
    let scaleIndex = 0;
    renderer.setPixelRatio(basePixelRatio);
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.toneMapping = ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.shadowMap.enabled = quality.shadows;
    renderer.shadowMap.type = PCFSoftShadowMap;
    // ポストプロセスは1フレームに複数回 render するので、自動リセットを止めて
    // フレーム全体の draw call / triangle を積算する（stats の実測値のため）
    renderer.info.autoReset = false;
    await renderer.init();
    container.appendChild(renderer.domElement);

    const backend = (renderer.backend as unknown as { isWebGPUBackend?: boolean }).isWebGPUBackend
        ? 'WebGPU'
        : 'WebGL2';

    const scene = new Scene();
    const camera = new PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.35, quality.cameraFar);
    camera.position.set(0, 700, 900);

    // 既定は三人称の操作系。?fly のときだけ従来の自由カメラを使う（契約04 追記2）
    const freeCamera = params.has('fly');
    const controls = freeCamera ? createFlyCamera(camera, renderer.domElement) : null;
    controls?.setView(new Vector3(0, 700, 900), new Vector3(0, 250, -300));
    // WASM のロードはタイル取得と並行して先に始めておく
    const gameModule = freeCamera
        ? null
        : import('./game').then(async (module) => {
              await module.initPhysics();
              return module;
          });
    let game: Game | null = null;
    let multiplayer: Multiplayer | null = null;
    let map: MapOverlay | null = null;

    /**
     * P2Pマルチプレイ（契約05）。読み込みを待たせないよう遅延インポートし、
     * 接続できなくても単独プレイとして動き続ける（E28）。?fly では使わない
     */
    const startMultiplayer = (active: Game): void => {
        if (params.has('solo')) return;
        void import('./net/multiplayer')
            .then(({ createMultiplayer }) => {
                multiplayer = createMultiplayer({ scene, quality, state: active.state });
            })
            .catch((err: unknown) => {
                console.warn('[net] マルチプレイを開始できませんでした', err);
            });
    };

    const environment = createEnvironment(scene, quality);
    fogRangeNode.value.set(quality.fogNear, quality.fogFar);

    let post: PostChain | null = createPostProcessing(renderer, scene, camera, quality);
    const stats = createStatsOverlay(
        renderer,
        () => `${backend} / ${quality.preset} t${quality.tier}`,
    );

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

    let world: World | null = null;
    /**
     * 定点カメラの視点（?shot）。操作系・物理はそのまま動かしたまま、
     * 毎フレームこの姿勢でカメラを上書きする（E59）
     */
    let shotPose: ShotView | null = null;

    /** ワールドが揃ってから物理・操作系を作る（E2: ロード完了前にスポーンしない） */
    const onWorldReady = async (ready: World): Promise<void> => {
        const spawn = ready.spawn;
        const groundY = ready.getElevationAt(spawn.x, spawn.z);
        controls?.setView(
            new Vector3(spawn.x, groundY + 70, spawn.z + 190),
            new Vector3(spawn.x, groundY + 10, spawn.z - 160),
        );
        if (freeCamera) setHelp('ドラッグ: 視点回転　WASD: 移動　Space/C: 上下　Shift: 加速　ホイール: 速度');

        if (gameModule) {
            setLoadingProgress(1, 1, '物理コライダーを生成中');
            try {
                const { createGame } = await gameModule;
                game = createGame({
                    scene,
                    camera,
                    element: renderer.domElement,
                    world: ready,
                    quality,
                });
                game.update(0); // カメラをプレイヤーの後方へ置いてから可視判定する
                startMultiplayer(game);
                // ミニマップ + 全体マップ（契約09）。ベース地図の生成が入るので
                // ローディング表示が出ているうちに作る
                setLoadingProgress(1, 1, 'マップを描画中');
                const active = game;
                map = createMapOverlay({
                    world: ready,
                    quality,
                    state: active.state,
                    // ?solo や未接続なら誰も渡らない（E52）
                    eachRemote: (visit) => multiplayer?.eachPlayer(visit),
                    // マップ表示中はゲーム入力を止める（E49）
                    onToggle: (open) => active.setInputSuspended(open),
                });
            } catch (err) {
                // 物理を用意できなくても真っ白にはしない（E25）
                console.error('[game] 物理の初期化に失敗しました', err);
                setHelp('物理の初期化に失敗したため自由カメラで表示しています');
            }
        }

        if (shot > 0) {
            shotPose = shotView(shot, {
                spawn,
                getElevationAt: ready.getElevationAt,
                minElevation: ready.stats.minElevation,
                maxElevation: ready.stats.maxElevation,
            });
            if (shotPose) {
                camera.position.copy(shotPose.eye);
                camera.lookAt(shotPose.target);
                setHelp(`定点カメラ ?shot=${shot}　${shotPose.label}`);
            }
        }

        world = ready;
        world.update(camera, quality, true);
        stats.measure(scene);
        const s = world.stats;
        setStatus(
            `${backend}　${quality.preset}　建物 ${s.buildings}（実測高さ ${s.buildingsMeasured}）　道路 ${s.roads}　` +
                `樹木 ${s.trees}　植生 ${s.vegetationItems}　標高 ${s.minElevation.toFixed(0)}〜${s.maxElevation.toFixed(0)}m` +
                `　地形 ${s.hiresTerrain ? '50cm' : 'DEM5A'}` +
                (s.vectorTilesFailed > 0 ? `　欠損タイル ${s.vectorTilesFailed}` : ''),
        );
        // 全パイプラインを先にコンパイルしてから表示する（初回視界移動のカクつき防止）。
        // 数十のパイプラインを作るので時間がかかる。何をしているかは表示しておく
        setLoadingProgress(1, 1, 'シェーダーを準備中');
        await world.prewarm(renderer, scene, camera);
        hideLoading();
    };
    worldEvents.addEventListener('ready', (e) => {
        void onWorldReady((e as CustomEvent<World>).detail);
    });

    /** 品質段階を1段落とす。ジオメトリは作り直さず、距離・影・ポストだけ効かせる */
    const downgrade = (): void => {
        if (tierIsPinned() || quality.tier >= maxTier(quality.preset)) return;
        quality = createQuality(quality.preset, quality.tier + 1);
        renderer.shadowMap.enabled = quality.shadows;
        environment.sun.castShadow = quality.shadows;
        fogRangeNode.value.set(quality.fogNear, quality.fogFar);
        post?.dispose();
        post = createPostProcessing(renderer, scene, camera, quality);
        world?.update(camera, quality, true);
        console.info(`[quality] 段階を ${quality.tier} に落としました`);
    };

    let last = performance.now();
    let scaleTimer = 0;
    let slowTimer = 0;
    renderer.setAnimationLoop((now: number) => {
        const dt = Math.min(0.1, (now - last) / 1000);
        last = now;
        renderer.info.reset();
        if (game) game.update(dt);
        else controls?.update(dt);
        // 定点カメラは操作系のあとに上書きする（物理・アバターはそのまま動く）
        if (shotPose) {
            camera.position.copy(shotPose.eye);
            camera.lookAt(shotPose.target);
        }
        multiplayer?.update(dt);
        map?.update(dt); // 中で10Hzに間引く（マーカー層だけ描き直す）
        environment.update(camera);
        world?.update(camera, quality);

        if (post) post.render();
        else renderer.render(scene, camera);

        const frameMs = stats.sample(dt, RENDER_SCALES[scaleIndex]);
        // ロード中・プリウォーム中の重さで品質を落とさない
        if (!world) return;
        const targetMs = 1000 / quality.targetFps;

        // --- 動的解像度スケーリング（追記2-2） ---
        // vsync では frameMs が target を下回らないので、復帰判定は target 直上に置く
        scaleTimer += dt;
        if (scaleTimer >= SCALE_INTERVAL) {
            scaleTimer = 0;
            const minIndex = RENDER_SCALES.findIndex((s) => s <= quality.minRenderScale);
            const lastIndex = minIndex < 0 ? RENDER_SCALES.length - 1 : minIndex;
            if (frameMs > targetMs * 1.25 && scaleIndex < lastIndex) {
                scaleIndex++;
                renderer.setPixelRatio(basePixelRatio * RENDER_SCALES[scaleIndex]);
            } else if (frameMs < targetMs * 1.06 && scaleIndex > 0) {
                scaleIndex--;
                renderer.setPixelRatio(basePixelRatio * RENDER_SCALES[scaleIndex]);
            }
        }

        // --- それでも足りなければ品質段階を落とす（一方通行・振動しない） ---
        slowTimer = frameMs > targetMs * 1.4 ? slowTimer + dt : 0;
        if (slowTimer > TIER_PATIENCE) {
            slowTimer = 0;
            downgrade();
        }
    });

    try {
        await buildWorld(scene, quality);
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
