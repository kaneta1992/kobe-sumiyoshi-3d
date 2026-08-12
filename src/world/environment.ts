/**
 * 空・太陽光・影・ハイトフォグ。
 *
 * 空は TSL（three/tsl）のノードマテリアルで描く。TSL は WebGPU / WebGL2 の
 * どちらのバックエンドでも同じグラフから生成されるので、生の GLSL/WGSL を書かずに
 * 太陽の位置に追従する空とハイトフォグが作れる。
 *
 * 影の戦略（追記2-4）:
 *   desktop = CSM（カスケード3枚）
 *   mobile  = 近距離1枚 + 静的キャッシュ（カメラが一定距離動いたときだけ描き直す）
 */
import {
    BackSide,
    DirectionalLight,
    Group,
    HemisphereLight,
    Mesh,
    MeshBasicNodeMaterial,
    type PerspectiveCamera,
    Scene,
    SphereGeometry,
    Vector3,
} from 'three/webgpu';
import { CSMShadowNode } from 'three/addons/csm/CSMShadowNode.js';
import { exp, float, mix, positionLocal, positionView, positionWorld, cameraPosition, fog, saturate, smoothstep } from 'three/tsl';
import type { QualitySettings } from '../quality';
import {
    ambientColor,
    duskNode,
    fogColorNode,
    fogHeightNode,
    fogRangeNode,
    groundHazeNode,
    hazeSunNode,
    lighting,
    skyHorizonNode,
    skyZenithNode,
    sunColor,
    sunColorNode,
    sunDirNode,
    sunDirection,
} from './sun';

/** 影を描き直すカメラ移動量[m]（mobile の静的シャドウキャッシュ） */
const SHADOW_REFRESH_DISTANCE = 14;

function createSkyDome(): Mesh {
    const dir = positionLocal.normalize();
    const up = dir.y;
    const sunDot = dir.dot(sunDirNode);

    // 地平は方位で色が変わる: 太陽側は夕焼けのオレンジ、反対側は冷たい青。
    // 「地平線オレンジ → 天頂群青」のグラデはここで作る
    const towardSun = saturate(sunDot.mul(0.5).add(0.5).mul(1.3).sub(0.3));
    const horizon = mix(skyHorizonNode, hazeSunNode, towardSun.pow(2.2));
    const above = mix(horizon, skyZenithNode, saturate(up).pow(mix(float(0.55), float(0.42), duskNode)));
    const below = mix(horizon, groundHazeNode, saturate(up.negate().mul(3)));
    const base = mix(below, above, smoothstep(-0.03, 0.03, up));
    // 太陽まわりのミー散乱風のにじみ。夕方は広く暖かく広がる
    const glowColor = mix(sunColorNode, hazeSunNode, duskNode.mul(0.65));
    const glow = glowColor.mul(
        saturate(sunDot).pow(mix(float(8), float(2.4), duskNode)).mul(mix(float(0.3), float(0.95), duskNode)),
    );
    // 太陽本体（トーンマップとブルームに載せる）。夕方は本体もオレンジに寄せる
    const disc = mix(sunColorNode, hazeSunNode, duskNode.mul(0.8)).mul(
        smoothstep(0.9982, 0.99945, sunDot).mul(mix(float(12), float(17), duskNode)),
    );

    const material = new MeshBasicNodeMaterial();
    material.colorNode = base.add(glow).add(disc);
    material.side = BackSide;
    material.fog = false;
    material.depthWrite = false;

    const mesh = new Mesh(new SphereGeometry(1, 32, 20), material);
    mesh.name = 'sky';
    mesh.frustumCulled = false;
    mesh.renderOrder = -1000;
    mesh.scale.setScalar(9000);
    return mesh;
}

/** 距離 + 高度でかかるフォグ。山の空気遠近感と、LOD切替のポップ隠しを兼ねる（追記2-3） */
function createFogNode(): unknown {
    const viewDist = positionView.length();
    const byDistance = smoothstep(fogRangeNode.x, fogRangeNode.y, viewDist);
    const byHeight = exp(positionWorld.y.sub(fogHeightNode.x).max(0).mul(fogHeightNode.y).negate());
    const factor = saturate(byDistance.mul(mix(float(0.34), float(1), byHeight)));
    const view = positionWorld.sub(cameraPosition).normalize();
    const towardSun = saturate(view.dot(sunDirNode)).pow(3.5);
    return fog(mix(fogColorNode, hazeSunNode, towardSun.mul(0.7)), factor);
}

export interface Environment {
    group: Group;
    sun: DirectionalLight;
    /** 毎フレーム呼ぶ。空をカメラに追従させ、影の更新要否を決める */
    update(camera: PerspectiveCamera): void;
}

export function createEnvironment(scene: Scene, quality: QualitySettings): Environment {
    const group = new Group();
    group.name = 'environment';

    const sky = createSkyDome();
    group.add(sky);

    // 環境光の色・強さは時刻で決まる（sun.ts）。ベイクGIの空可視率はこの光を
    // 遮る形で効く（materials 側の aoNode）ので、ここは「開けた空の下の明るさ」
    const hemi = new HemisphereLight(0x000000, 0x000000, lighting.ambient * (quality.ao ? 0.82 : 1));
    hemi.color.copy(ambientColor);
    hemi.groundColor.copy(ambientColor).multiplyScalar(0.42).offsetHSL(-0.06, -0.1, 0.02);
    hemi.position.set(0, 1000, 0);
    group.add(hemi);

    const sun = new DirectionalLight(0xffffff, lighting.sun);
    sun.color.copy(sunColor);
    sun.position.copy(sunDirection).multiplyScalar(2500);
    sun.castShadow = quality.shadows;
    sun.shadow.mapSize.set(quality.shadowMapSize, quality.shadowMapSize);
    // 急斜面 + カスケードでアクネ／ピーターパンが出やすい（E13）。
    // bias は控えめにして normalBias 側で逃がす（法線方向にずらすので接地影が浮きにくい）
    sun.shadow.bias = -0.00018;
    sun.shadow.normalBias = 0.35;
    sun.shadow.intensity = 0.92;
    group.add(sun);
    group.add(sun.target);

    let csm: CSMShadowNode | null = null;
    if (quality.shadows && quality.shadowCascades > 1) {
        try {
            csm = new CSMShadowNode(sun, {
                cascades: quality.shadowCascades,
                maxFar: quality.shadowDistance,
                mode: 'practical',
                lightMargin: 260,
            });
            (sun.shadow as unknown as { shadowNode: unknown }).shadowNode = csm;
        } catch (err) {
            // CSM が使えなくても影なしにはしない（E5-b）
            console.warn('[env] CSM を初期化できませんでした。単一シャドウにフォールバックします', err);
            csm = null;
        }
    }
    if (!csm) {
        const cam = sun.shadow.camera;
        const extent = quality.shadowDistance;
        cam.left = -extent;
        cam.right = extent;
        cam.top = extent;
        cam.bottom = -extent;
        cam.near = 10;
        cam.far = extent * 6;
        cam.updateProjectionMatrix();
    }
    // 太陽が動かない構成では毎フレーム描き直さない（追記2-4）
    if (quality.staticShadows && !csm) {
        sun.shadow.autoUpdate = false;
        sun.shadow.needsUpdate = true;
    }

    (scene as unknown as { fogNode: unknown }).fogNode = createFogNode();
    scene.background = null;
    scene.add(group);

    const lastShadowAnchor = new Vector3(Infinity, Infinity, Infinity);

    return {
        group,
        sun,
        update(camera) {
            sky.position.copy(camera.position);
            if (csm) return;
            // 単一シャドウはカメラ前方に箱を置いて追従させる（近距離だけ担当する）
            const anchor = camera.position;
            if (anchor.distanceTo(lastShadowAnchor) < SHADOW_REFRESH_DISTANCE) return;
            lastShadowAnchor.copy(anchor);
            sun.target.position.copy(anchor);
            sun.position.copy(anchor).addScaledVector(sunDirection, 900);
            sun.target.updateMatrixWorld();
            sun.updateMatrixWorld();
            if (quality.staticShadows) sun.shadow.needsUpdate = true;
        },
    };
}
