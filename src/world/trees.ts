/**
 * 樹木の仮表示。前処理が nDSM から抜き出した樹木点を、インスタンス円錐で置く。
 * 本格的な植生描画は後続契約の担当なので、ここは位置・高さ・冠幅が正しいことを
 * 目で確かめられる最小限にとどめる。色は座標由来の決定的ハッシュ（乱数禁止）。
 */
import {
    Color,
    ConeGeometry,
    InstancedMesh,
    Matrix4,
    MeshStandardMaterial,
    Object3D,
} from 'three/webgpu';
import type { TreeInstance } from '../data/terrain-assets';

/** 幹に相当する下側の割合（円錐はこの高さから生やす） */
const TRUNK_RATIO = 0.18;

function hash01(x: number, z: number): number {
    let h = Math.imul((Math.round(x * 10) | 0) ^ 0x27d4eb2f, 0x9e3779b1);
    h ^= Math.imul((Math.round(z * 10) | 0) + 0x165667b1, 0x85ebca6b);
    h ^= h >>> 15;
    h = Math.imul(h, 0x2545f491);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
}

export function createTrees(
    trees: readonly TreeInstance[],
    getElevationAt: (x: number, z: number) => number,
): InstancedMesh | null {
    if (trees.length === 0) return null;

    // 底面中心が原点に来る単位円錐。インスタンスごとに冠幅・樹高でスケールする
    const geometry = new ConeGeometry(1, 1, 7, 1, false);
    geometry.translate(0, 0.5, 0);

    const mesh = new InstancedMesh(
        geometry,
        new MeshStandardMaterial({ roughness: 0.95, metalness: 0, flatShading: true }),
        trees.length,
    );
    mesh.name = 'trees';
    mesh.castShadow = true;
    mesh.receiveShadow = true;

    const matrix = new Matrix4();
    const dummy = new Object3D();
    const color = new Color();
    for (let i = 0; i < trees.length; i++) {
        const t = trees[i];
        const r = hash01(t.x, t.z);
        const ground = getElevationAt(t.x, t.z);
        dummy.position.set(t.x, ground + t.height * TRUNK_RATIO, t.z);
        dummy.rotation.set(0, r * Math.PI * 2, 0);
        dummy.scale.set(t.crown, t.height * (1 - TRUNK_RATIO), t.crown);
        dummy.updateMatrix();
        matrix.copy(dummy.matrix);
        mesh.setMatrixAt(i, matrix);
        // 常緑〜落葉の幅を持たせた緑。彩度・明度だけ振る
        color.setHSL(0.25 + r * 0.07, 0.3 + r * 0.22, 0.16 + r * 0.12);
        mesh.setColorAt(i, color);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
    return mesh;
}
