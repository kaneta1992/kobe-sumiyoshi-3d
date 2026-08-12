/**
 * ポストプロセス。ACESトーンマップ（レンダラー側）+ GTAO + bloom + FXAA。
 *
 * mobile では GTAO を切り、bloom も弱くする（追記2-5: オーバードロー抑制）。
 * 生成に失敗した場合や、バックエンドが対応していない場合は null を返し、
 * 呼び出し側は素の renderer.render に落ちる（E5-b / E17）。
 */
import { PostProcessing, type PerspectiveCamera, type Scene, type WebGPURenderer } from 'three/webgpu';
import { float, mix, mrt, normalView, output, pass, renderOutput, vec3, vec4 } from 'three/tsl';
import { ao } from 'three/addons/tsl/display/GTAONode.js';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { fxaa } from 'three/addons/tsl/display/FXAANode.js';
import type { QualitySettings } from '../quality';

/** トーンカーブの効き（0=素のACES / 1=S字いっぱい） */
const GRADE_CONTRAST = 0.3;
/** 彩度（1=そのまま） */
const GRADE_SATURATION = 1.12;

export interface PostChain {
    render(): void;
    dispose(): void;
}

export function createPostProcessing(
    renderer: WebGPURenderer,
    scene: Scene,
    camera: PerspectiveCamera,
    quality: QualitySettings,
): PostChain | null {
    try {
        const post = new PostProcessing(renderer);
        const scenePass = pass(scene, camera);
        // 法線を MRT で受け取る（GTAO 用）
        scenePass.setMRT(mrt({ output, normal: normalView }));
        const color = scenePass.getTextureNode('output');

        const aoPass = quality.ao
            ? ao(scenePass.getTextureNode('depth'), scenePass.getTextureNode('normal'), camera)
            : null;
        if (aoPass) {
            // 半解像度で十分（ぼかして環境光にだけ効かせるため）
            aoPass.resolutionScale = 0.55;
            aoPass.radius.value = 1.1;
            aoPass.distanceExponent.value = 1.6;
            aoPass.distanceFallOff.value = 0.8;
            aoPass.scale.value = 1.15;
            aoPass.thickness.value = 1.2;
            aoPass.samples.value = quality.aoSamples;
        }
        // 直接光まで潰さないよう、遮蔽は環境光寄りに弱めて掛ける
        const lit = aoPass ? color.mul(mix(float(1), aoPass.getTextureNode().r, 0.8)) : color.mul(1);
        const strength = quality.preset === 'mobile' ? 0.26 : 0.42;
        const node = quality.bloom ? lit.add(bloom(lit, strength, 0.55, 0.86)) : lit;

        // トーンマップ + 出力色空間を自前の位置で掛け、その後にグレーディング → FXAA
        post.outputColorTransform = false;
        const toned = renderOutput(node);
        // フィルミックなトーンカーブ: 表示色に S 字を掛けて中間のコントラストを稼ぎ、
        // 白飛び側を寝かせる。UI は DOM なのでポストの外（E41）
        const c = toned.rgb;
        const sCurve = c.mul(c).mul(float(3).sub(c.mul(2)));
        const contrasted = mix(c, sCurve, float(GRADE_CONTRAST));
        // わずかな彩度上げ。フォトリアルに寄せすぎない範囲でリッチにする（候補6）
        const luma = contrasted.dot(vec3(0.2126, 0.7152, 0.0722));
        const graded = vec4(mix(vec3(luma), contrasted, float(GRADE_SATURATION)), toned.a);
        post.outputNode = quality.fxaa ? fxaa(graded) : graded;

        let broken = false;
        return {
            render() {
                if (broken) {
                    renderer.render(scene, camera);
                    return;
                }
                try {
                    post.render();
                } catch (err) {
                    console.warn('[post] ポストプロセスを無効化して直接描画に切り替えます', err);
                    broken = true;
                    renderer.render(scene, camera);
                }
            },
            dispose() {
                post.dispose();
            },
        };
    } catch (err) {
        console.warn('[post] ポストプロセスを初期化できませんでした', err);
        return null;
    }
}
