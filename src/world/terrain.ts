/**
 * 地形メッシュ。DEM から 512×512 のハイトフィールドを作り、航空写真を貼る。
 * ハイトフィールドは後続タスク（物理コライダー生成）から再利用できるよう
 * getElevationAt(x, z) として公開する。
 */
import {
    BufferAttribute,
    BufferGeometry,
    CanvasTexture,
    LinearFilter,
    LinearMipmapLinearFilter,
    Mesh,
    MeshStandardMaterial,
    SRGBColorSpace,
} from 'three/webgpu';
import { AREA_HALF, TERRAIN_VERTS } from '../config';
import { latToTileY, lonToTileX, xToLon, zToLat } from '../geo';
import type { ElevationSampler } from '../data/dem';
import type { AerialImage } from '../data/photo';

export interface Terrain {
    mesh: Mesh;
    /** ハイトフィールドを双線形補間して標高[m]を返す。エリア外は端の値にクランプ */
    getElevationAt(x: number, z: number): number;
    minElevation: number;
    maxElevation: number;
}

const N = TERRAIN_VERTS;
const STEP = (AREA_HALF * 2) / (N - 1);

export function createTerrain(sample: ElevationSampler, aerial: AerialImage): Terrain {
    const heights = new Float32Array(N * N);
    const positions = new Float32Array(N * N * 3);
    const uvs = new Float32Array(N * N * 2);

    const { range } = aerial;
    let minElevation = Infinity;
    let maxElevation = -Infinity;

    for (let row = 0; row < N; row++) {
        const z = -AREA_HALF + row * STEP;
        const lat = zToLat(z);
        const ty = (latToTileY(lat, range.z) - range.y0) / range.ny;
        for (let col = 0; col < N; col++) {
            const x = -AREA_HALF + col * STEP;
            const lon = xToLon(x);
            const h = sample(lon, lat);
            const i = row * N + col;
            heights[i] = h;
            if (h < minElevation) minElevation = h;
            if (h > maxElevation) maxElevation = h;
            positions[i * 3] = x;
            positions[i * 3 + 1] = h;
            positions[i * 3 + 2] = z;
            uvs[i * 2] = (lonToTileX(lon, range.z) - range.x0) / range.nx;
            // テクスチャは flipY されるので v を反転する
            uvs[i * 2 + 1] = 1 - ty;
        }
    }

    const quads = (N - 1) * (N - 1);
    const indices = N * N > 65536 ? new Uint32Array(quads * 6) : new Uint16Array(quads * 6);
    let k = 0;
    for (let row = 0; row < N - 1; row++) {
        for (let col = 0; col < N - 1; col++) {
            const a = row * N + col;
            const b = a + 1;
            const c = a + N;
            const d = c + 1;
            // 上から見て反時計回り（法線 +Y）になる並び
            indices[k++] = a;
            indices[k++] = c;
            indices[k++] = b;
            indices[k++] = b;
            indices[k++] = c;
            indices[k++] = d;
        }
    }

    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new BufferAttribute(uvs, 2));
    geometry.setIndex(new BufferAttribute(indices, 1));
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();

    const texture = new CanvasTexture(aerial.canvas);
    texture.colorSpace = SRGBColorSpace;
    texture.minFilter = LinearMipmapLinearFilter;
    texture.magFilter = LinearFilter;
    texture.anisotropy = 8;
    texture.generateMipmaps = true;

    const mesh = new Mesh(
        geometry,
        new MeshStandardMaterial({ map: texture, roughness: 0.95, metalness: 0 }),
    );
    mesh.name = 'terrain';
    mesh.receiveShadow = true;
    mesh.castShadow = true;

    const getElevationAt = (x: number, z: number): number => {
        const fx = Math.min(Math.max((x + AREA_HALF) / STEP, 0), N - 1);
        const fz = Math.min(Math.max((z + AREA_HALF) / STEP, 0), N - 1);
        const col = Math.min(Math.floor(fx), N - 2);
        const row = Math.min(Math.floor(fz), N - 2);
        const tx = fx - col;
        const tz = fz - row;
        const h00 = heights[row * N + col];
        const h10 = heights[row * N + col + 1];
        const h01 = heights[(row + 1) * N + col];
        const h11 = heights[(row + 1) * N + col + 1];
        return (
            h00 * (1 - tx) * (1 - tz) + h10 * tx * (1 - tz) + h01 * (1 - tx) * tz + h11 * tx * tz
        );
    };

    return {
        mesh,
        getElevationAt,
        minElevation: Number.isFinite(minElevation) ? minElevation : 0,
        maxElevation: Number.isFinite(maxElevation) ? maxElevation : 0,
    };
}
