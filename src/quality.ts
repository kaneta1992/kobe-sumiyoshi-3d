/**
 * 品質プリセット。mobile / desktop を自動判定し、URL で強制もできる。
 *
 *   ?quality=mobile | desktop      プリセット強制
 *   ?tier=0|1|2                    プリセット内の段階を強制（動的降格を止める）
 *   ?stats                         画面内 stats を表示
 *   ?hour=15.5                     太陽の時刻
 *
 * 動的解像度スケーリング（追記2-2）と自動降格はここが持つ数値に従う。
 * 「性能が足りないときは段階的に落として止まらない」ことを最優先にする。
 */

export type QualityPreset = 'mobile' | 'desktop';

export interface QualitySettings {
    preset: QualityPreset;
    /** プリセット内の段階。0 が最良、増えるほど軽い */
    tier: number;
    /** 目標フレームレート（動的解像度スケーリングの基準） */
    targetFps: number;

    /** devicePixelRatio の上限 */
    maxPixelRatio: number;
    /** 動的解像度スケーリングの下限 */
    minRenderScale: number;

    shadows: boolean;
    shadowCascades: number;
    shadowMapSize: number;
    /** 影を落とす距離[m]。これを超えたらフォグと環境光でごまかす */
    shadowDistance: number;
    /** 太陽が動かない間はシャドウマップを毎フレーム描き直さない */
    staticShadows: boolean;

    ao: boolean;
    aoSamples: number;
    bloom: boolean;
    fxaa: boolean;

    /** HLOD: この距離までは個別ジオメトリ（L0） */
    hlodNear: number;
    /** HLOD: ここまでは簡略統合（L1）、超えたらセルプロキシ（L2） */
    hlodMid: number;
    /** 描画打ち切り距離[m] */
    viewDistance: number;

    /** 樹木LODの切り替え距離 */
    treeNear: number;
    treeMid: number;
    treeFar: number;
    /** LOD段階ごとのインスタンス上限（近・中・遠） */
    treeBudget: readonly [number, number, number];
    /** 近距離の樹木だけ影を落とす */
    treeShadowDistance: number;

    groundCover: boolean;
    groundCoverDistance: number;
    props: boolean;
    propDistance: number;

    /** 航空写真テクスチャの最大辺 */
    maxTextureSize: number;
    fogNear: number;
    fogFar: number;
    cameraFar: number;
}

const DESKTOP_TIERS: readonly Partial<QualitySettings>[] = [
    {},
    { shadowMapSize: 2048, aoSamples: 8, hlodNear: 260, treeNear: 90, treeMid: 320 },
    { shadowCascades: 2, shadowMapSize: 1536, ao: false, hlodNear: 200, hlodMid: 620, treeNear: 60, treeMid: 240, treeFar: 900 },
];

const MOBILE_TIERS: readonly Partial<QualitySettings>[] = [
    {},
    { shadowMapSize: 768, treeNear: 32, treeMid: 110, treeFar: 480, groundCover: false, viewDistance: 1500 },
    { shadows: false, bloom: false, fxaa: false, treeNear: 0, treeMid: 80, treeFar: 380, viewDistance: 1200, props: false },
];

function baseSettings(preset: QualityPreset): QualitySettings {
    if (preset === 'mobile') {
        return {
            preset,
            tier: 0,
            targetFps: 30,
            maxPixelRatio: 1.0,
            minRenderScale: 0.5,
            shadows: true,
            // mobile は近距離1カスケード + 静的キャッシュ（追記2-4）
            shadowCascades: 1,
            shadowMapSize: 1024,
            shadowDistance: 140,
            staticShadows: true,
            // GTAO は mobile 無効。代わりに読み込み時にベイクした頂点AOを使う（追記2-5）
            ao: false,
            aoSamples: 8,
            bloom: true,
            fxaa: true,
            hlodNear: 150,
            hlodMid: 480,
            viewDistance: 1900,
            treeNear: 45,
            treeMid: 150,
            treeFar: 620,
            treeBudget: [150, 1800, 8000],
            treeShadowDistance: 60,
            groundCover: true,
            groundCoverDistance: 42,
            props: true,
            propDistance: 220,
            maxTextureSize: 2048,
            fogNear: 220,
            fogFar: 2400,
            cameraFar: 12000,
        };
    }
    return {
        preset,
        tier: 0,
        targetFps: 60,
        maxPixelRatio: 2,
        minRenderScale: 0.6,
        shadows: true,
        shadowCascades: 3,
        shadowMapSize: 2048,
        shadowDistance: 600,
        staticShadows: false,
        ao: true,
        aoSamples: 16,
        bloom: true,
        fxaa: true,
        hlodNear: 340,
        hlodMid: 850,
        viewDistance: 4200,
        treeNear: 120,
        treeMid: 420,
        treeFar: 1500,
        treeBudget: [700, 6000, 22000],
        treeShadowDistance: 240,
        groundCover: true,
        groundCoverDistance: 85,
        props: true,
        propDistance: 520,
        maxTextureSize: 4096,
        fogNear: 500,
        fogFar: 6800,
        cameraFar: 26000,
    };
}

/** UA・メモリ・コア数からの自動判定。判定に失敗したら安全側（mobile）へ倒さず desktop */
export function detectPreset(): QualityPreset {
    const params = new URLSearchParams(location.search);
    const forced = params.get('quality');
    if (forced === 'mobile' || forced === 'desktop') return forced;
    if (params.has('mobile')) return 'mobile';
    if (params.has('desktop')) return 'desktop';

    const nav = navigator as Navigator & { deviceMemory?: number };
    const coarse = window.matchMedia?.('(pointer: coarse)').matches ?? false;
    const uaMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
    const lowMemory = (nav.deviceMemory ?? 8) <= 4;
    const fewCores = (navigator.hardwareConcurrency ?? 8) <= 4;
    if (uaMobile || (coarse && (lowMemory || fewCores))) return 'mobile';
    return 'desktop';
}

export function createQuality(preset: QualityPreset, tier: number): QualitySettings {
    const tiers = preset === 'mobile' ? MOBILE_TIERS : DESKTOP_TIERS;
    const clamped = Math.max(0, Math.min(tiers.length - 1, tier));
    return { ...baseSettings(preset), ...tiers[clamped], tier: clamped };
}

export function maxTier(preset: QualityPreset): number {
    return (preset === 'mobile' ? MOBILE_TIERS : DESKTOP_TIERS).length - 1;
}

/** URL で段階を固定しているか（している間は自動降格しない） */
export function tierIsPinned(): boolean {
    return new URLSearchParams(location.search).has('tier');
}

export function initialQuality(): QualitySettings {
    const preset = detectPreset();
    const pinned = Number(new URLSearchParams(location.search).get('tier'));
    return createQuality(preset, Number.isFinite(pinned) ? pinned : 0);
}

/** 太陽の時刻（デフォルトは昼下がり15時）。夜間も含む 0〜24 の全域が使える（E39） */
export function sunHour(): number {
    const value = new URLSearchParams(location.search).get('hour');
    if (value === null) return 15;
    const raw = Number(value);
    return Number.isFinite(raw) ? Math.max(0, Math.min(24, raw)) : 15;
}
