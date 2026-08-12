/**
 * 空・太陽光・フォグ。
 * WebGPU/WebGL2 どちらのバックエンドでも同じ見た目になるよう、生シェーダーは使わず
 * 頂点カラーのグラデーションドームで空を作る（ShaderMaterial は WebGPU で動かない）。
 */
import {
    BackSide,
    BufferAttribute,
    Color,
    DirectionalLight,
    Fog,
    Group,
    HemisphereLight,
    Mesh,
    MeshBasicMaterial,
    SphereGeometry,
    Scene,
    Vector3,
} from 'three/webgpu';
import { AREA_HALF } from '../config';

const HORIZON = new Color().setHSL(0.58, 0.35, 0.82);
const ZENITH = new Color().setHSL(0.6, 0.6, 0.42);
const GROUND_HAZE = new Color().setHSL(0.09, 0.15, 0.62);
export const FOG_COLOR = new Color().setHSL(0.58, 0.3, 0.78);

/** 太陽の向き（原点から見た方向ベクトル）。南南西の高い位置 */
export const SUN_DIRECTION = new Vector3(0.45, 0.78, 0.44).normalize();

function createSkyDome(radius: number): Mesh {
    const geometry = new SphereGeometry(radius, 32, 24);
    const position = geometry.getAttribute('position');
    const colors = new Float32Array(position.count * 3);
    const c = new Color();
    for (let i = 0; i < position.count; i++) {
        const t = position.getY(i) / radius; // -1(下) 〜 1(上)
        if (t >= 0) c.copy(HORIZON).lerp(ZENITH, Math.pow(t, 0.6));
        else c.copy(HORIZON).lerp(GROUND_HAZE, Math.min(1, -t * 3));
        colors[i * 3] = c.r;
        colors[i * 3 + 1] = c.g;
        colors[i * 3 + 2] = c.b;
    }
    geometry.setAttribute('color', new BufferAttribute(colors, 3));
    const mesh = new Mesh(
        geometry,
        new MeshBasicMaterial({ vertexColors: true, side: BackSide, fog: false }),
    );
    mesh.name = 'sky';
    return mesh;
}

export interface Environment {
    group: Group;
    sun: DirectionalLight;
}

export function createEnvironment(scene: Scene): Environment {
    const group = new Group();
    group.name = 'environment';

    group.add(createSkyDome(12000));

    const hemi = new HemisphereLight(0xbcd6ff, 0x6b6250, 1.1);
    hemi.position.set(0, 1000, 0);
    group.add(hemi);

    const sun = new DirectionalLight(0xfff3e0, 3.0);
    sun.position.copy(SUN_DIRECTION).multiplyScalar(3000);
    sun.castShadow = true;
    sun.shadow.mapSize.set(4096, 4096);
    const cam = sun.shadow.camera;
    const extent = AREA_HALF * 1.6;
    cam.left = -extent;
    cam.right = extent;
    cam.top = extent;
    cam.bottom = -extent;
    cam.near = 100;
    cam.far = 8000;
    cam.updateProjectionMatrix();
    sun.shadow.bias = -0.0005;
    sun.shadow.normalBias = 1.0;
    group.add(sun);
    group.add(sun.target);

    // 標高レンジが大きい（50m〜450m超）ので遠景は霞ませて奥行きを出す
    scene.fog = new Fog(FOG_COLOR, 900, 6500);
    scene.background = FOG_COLOR.clone();

    scene.add(group);
    return { group, sun };
}
