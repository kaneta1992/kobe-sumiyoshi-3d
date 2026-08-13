/**
 * 画面内 stats（?stats で表示）。fps / draw calls / triangles / GPUメモリ目安 に加えて
 * チャンク描画数・HLOD段階別の描画数・現在のレンダースケールを出す（追記2 検証項目）。
 *
 * 常時計測は軽量に: フレームごとにやるのは加算と EMA だけで、
 * DOM 更新と文字列生成は 250ms に1回。フレームループ内で new は作らない。
 */
import { Scene, type WebGPURenderer } from 'three/webgpu';

/** ワールド側が毎フレーム書き込むカウンタ。使い回しの単一オブジェクト（追記2-6） */
export const worldStats = {
    chunksDrawn: 0,
    chunksTotal: 0,
    hlod0: 0,
    hlod1: 0,
    hlod2: 0,
    treeNear: 0,
    treeMid: 0,
    treeFar: 0,
    /** 直近フレームの物理計算時間[ms]（契約04） */
    physicsMs: 0,
    /** いまの時刻[h]（昼夜サイクル・契約15） */
    hour: 15,
    /** 点灯中の実ポイントライト数（街灯プール + 提灯・契約15） */
    lights: 0,
};

export interface StatsOverlay {
    /** 毎フレーム呼ぶ。戻り値は平滑化フレーム時間[ms] */
    sample(dt: number, renderScale: number): number;
    /**
     * 平滑化フレーム時間を初期値へ戻す（E114）。
     * ロードとシェーダーコンパイルで荒れた計測を、遊び始めの判断に持ち込まないため
     */
    reset(): void;
    /** GPUメモリ目安を測り直す（ワールド構築後に1回） */
    measure(scene: Scene): void;
    readonly frameMs: number;
    readonly fps: number;
}

function formatMB(bytes: number): string {
    return `${(bytes / 1048576).toFixed(0)}MB`;
}

/** ジオメトリ属性とテクスチャのバイト数からVRAM使用量を概算する */
function estimateGpuBytes(scene: Scene): number {
    const geometries = new Set<object>();
    const textures = new Set<object>();
    let bytes = 0;
    scene.traverse((obj) => {
        const mesh = obj as unknown as {
            geometry?: { attributes?: Record<string, { array?: ArrayBufferView }>; index?: { array?: ArrayBufferView } };
            material?: unknown;
            instanceMatrix?: { array?: ArrayBufferView };
        };
        const geometry = mesh.geometry;
        if (geometry && !geometries.has(geometry)) {
            geometries.add(geometry);
            for (const attr of Object.values(geometry.attributes ?? {})) {
                bytes += attr.array?.byteLength ?? 0;
            }
            bytes += geometry.index?.array?.byteLength ?? 0;
        }
        if (mesh.instanceMatrix?.array) bytes += mesh.instanceMatrix.array.byteLength;
        const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const mat of materials) {
            if (!mat) continue;
            for (const value of Object.values(mat as Record<string, unknown>)) {
                const tex = value as { isTexture?: boolean; image?: { width?: number; height?: number } };
                if (!tex?.isTexture || textures.has(tex)) continue;
                textures.add(tex);
                const w = tex.image?.width ?? 0;
                const h = tex.image?.height ?? 0;
                bytes += w * h * 4 * 1.34; // ミップ込みの概算
            }
        }
    });
    return bytes;
}

export function createStatsOverlay(
    renderer: WebGPURenderer,
    label: () => string,
): StatsOverlay {
    const visible = new URLSearchParams(location.search).has('stats');
    let panel: HTMLDivElement | null = null;
    if (visible) {
        panel = document.createElement('div');
        panel.className = 'panel';
        panel.style.cssText = 'top:10px;right:10px;text-align:right;white-space:pre;font-variant-numeric:tabular-nums;';
        document.body.appendChild(panel);
    }

    let frameMs = 16.7;
    let acc = 0;
    let frames = 0;
    let sinceUpdate = 0;
    let gpuBytes = 0;
    let shownFps = 0;

    return {
        sample(dt, renderScale) {
            const ms = dt * 1000;
            // 極端な外れ値（タブ復帰など）は平滑化に混ぜない
            if (ms < 500) frameMs += (ms - frameMs) * 0.06;
            acc += dt;
            frames++;
            sinceUpdate += dt;
            if (sinceUpdate >= 0.25) {
                shownFps = frames / acc;
                acc = 0;
                frames = 0;
                sinceUpdate = 0;
                if (panel) {
                    const info = renderer.info.render;
                    panel.textContent =
                        `${shownFps.toFixed(0)} fps  (${frameMs.toFixed(1)} ms)\n` +
                        `draw ${info.drawCalls}   tri ${(info.triangles / 1000).toFixed(0)}k\n` +
                        `chunk ${worldStats.chunksDrawn}/${worldStats.chunksTotal}   ` +
                        `HLOD ${worldStats.hlod0}/${worldStats.hlod1}/${worldStats.hlod2}\n` +
                        `tree ${worldStats.treeNear}/${worldStats.treeMid}/${worldStats.treeFar}\n` +
                        `scale ${renderScale.toFixed(2)}   vram~${formatMB(gpuBytes)}   ` +
                        `phys ${worldStats.physicsMs.toFixed(1)}ms\n` +
                        `${Math.floor(worldStats.hour).toString().padStart(2, '0')}:` +
                        `${Math.floor((worldStats.hour % 1) * 60).toString().padStart(2, '0')}   ` +
                        `light ${worldStats.lights}\n` +
                        label();
                }
            }
            return frameMs;
        },
        reset() {
            frameMs = 16.7;
            acc = 0;
            frames = 0;
            sinceUpdate = 0;
        },
        measure(scene) {
            gpuBytes = estimateGpuBytes(scene);
        },
        get frameMs() {
            return frameMs;
        },
        get fps() {
            return shownFps;
        },
    };
}
