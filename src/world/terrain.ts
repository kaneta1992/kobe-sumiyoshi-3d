/**
 * 地形メッシュ。ハイトフィールドを作り、航空写真を貼る。
 *
 * 標高は 兵庫県 50cmメッシュ DEM 由来の高精細ハイトマップを優先し、それが無い／
 * 欠けている箇所だけ地理院 DEM5A(5m) で埋める（契約02 E1）。
 * ハイトフィールドは後続タスク（物理コライダー生成）から再利用できるよう
 * getElevationAt(x, z) として公開する。
 *
 * 描画は 8×8 のチャンクに割ってフラスタムカリングを効かせ、距離で
 * インデックスLOD（1/2/4/8 間引き）を切り替える。チャンク境界の割れは
 * スカート（外周を下へ垂らした面）で隠す（追記2-3 / 追記2「地形の連続LOD」代替）。
 *
 * 環境光の遮蔽は起動時に頂点へ焼く（追記2-5 の GTAO 代替）。尾根と谷の
 * コントラストが出るので、モバイルでポストを切っても立体感が残る。
 */
import {
    BufferAttribute,
    BufferGeometry,
    CanvasTexture,
    Frustum,
    Group,
    LinearFilter,
    LinearMipmapLinearFilter,
    Mesh,
    MeshStandardNodeMaterial,
    SRGBColorSpace,
    Vector3,
    type Texture,
} from 'three/webgpu';
import { attribute, float, mix, mx_noise_float, positionView, positionWorld, saturate, smoothstep, texture as textureNode, uv, vec3 } from 'three/tsl';
import { AREA_HALF, TERRAIN_VERTS } from '../config';
import { latToTileY, lonToTileX, xToLon, zToLat } from '../geo';
import type { QualitySettings } from '../quality';
import type { ElevationSampler } from '../data/dem';
import type { AerialImage } from '../data/photo';
import type { GiMap, Heightmap } from '../data/terrain-assets';
import { GI_AO_STRENGTH, GI_BOUNCE_SCALE, bounceColorNode } from './sun';

export interface Terrain {
    group: Group;
    /** ハイトフィールドを双線形補間して標高[m]を返す。エリア外は端の値にクランプ */
    getElevationAt(x: number, z: number): number;
    minElevation: number;
    maxElevation: number;
    /** 高精細ハイトマップを使えたか（使えなければ DEM5A のみ） */
    hires: boolean;
    /** 描画中のチャンク数（stats 用） */
    readonly drawn: { count: number };
    chunkCount: number;
    update(cameraPos: Vector3, frustum: Frustum, quality: QualitySettings): void;
}

const N = TERRAIN_VERTS;
const STEP = (AREA_HALF * 2) / (N - 1);
/** 1辺のチャンク数。N-1 = 1024 を割り切ること */
const CHUNKS = 8;
const CHUNK_CELLS = (N - 1) / CHUNKS;
/** スカートの垂らし量[m]。隣接LOD差で開く隙間より深ければよい */
const SKIRT_DEPTH = 14;
/** LOD 段階ごとの間引き幅 */
const LOD_STRIDES = [1, 2, 4, 8];
/** LOD 切替距離[m]（チャンク境界までの距離） */
const LOD_DISTANCES = [170, 430, 950];

/** 環境遮蔽を焼く粗グリッドの1辺 */
const AO_GRID = 257;
const AO_DIRECTIONS = 8;
const AO_STEPS = [3, 7, 15, 32, 70, 150];

interface Chunk {
    mesh: Mesh;
    geometry: BufferGeometry;
    indices: BufferAttribute[];
    center: Vector3;
    /** チャンクの水平半径 + 高低差を含めた粗い半径 */
    radius: number;
    lod: number;
}

/** ハイトフィールドから空の見えやすさ（1 = 開けている）を粗グリッドに焼く */
function bakeAmbientOcclusion(heights: Float32Array): Float32Array {
    const ao = new Float32Array(AO_GRID * AO_GRID);
    const gridStep = (AREA_HALF * 2) / (AO_GRID - 1);
    const sampleHeight = (x: number, z: number): number => {
        const fx = Math.min(Math.max((x + AREA_HALF) / STEP, 0), N - 1);
        const fz = Math.min(Math.max((z + AREA_HALF) / STEP, 0), N - 1);
        return heights[Math.round(fz) * N + Math.round(fx)];
    };
    const dirs: number[] = [];
    for (let d = 0; d < AO_DIRECTIONS; d++) {
        const a = (d / AO_DIRECTIONS) * Math.PI * 2;
        dirs.push(Math.cos(a), Math.sin(a));
    }
    for (let row = 0; row < AO_GRID; row++) {
        const z = -AREA_HALF + row * gridStep;
        for (let col = 0; col < AO_GRID; col++) {
            const x = -AREA_HALF + col * gridStep;
            const h0 = sampleHeight(x, z);
            let occ = 0;
            for (let d = 0; d < AO_DIRECTIONS; d++) {
                const dx = dirs[d * 2];
                const dz = dirs[d * 2 + 1];
                let maxSlope = 0;
                for (const dist of AO_STEPS) {
                    const slope = (sampleHeight(x + dx * dist, z + dz * dist) - h0) / dist;
                    if (slope > maxSlope) maxSlope = slope;
                }
                occ += maxSlope / (maxSlope + 1);
            }
            // 谷筋を締めるのが目的なので効きは控えめに（暗くしすぎると近景が潰れる）
            ao[row * AO_GRID + col] = 1 - (occ / AO_DIRECTIONS) * 0.62;
        }
    }
    return ao;
}

/** 航空写真キャンバスを上限サイズに収める（mobile のテクスチャ予算・追記2-7） */
function toTexture(canvas: HTMLCanvasElement, maxSize: number): Texture {
    let source = canvas;
    const longest = Math.max(canvas.width, canvas.height);
    if (longest > maxSize) {
        const scale = maxSize / longest;
        const small = document.createElement('canvas');
        small.width = Math.round(canvas.width * scale);
        small.height = Math.round(canvas.height * scale);
        const ctx = small.getContext('2d');
        if (ctx) {
            ctx.imageSmoothingQuality = 'high';
            ctx.drawImage(canvas, 0, 0, small.width, small.height);
            source = small;
        }
    }
    const tex = new CanvasTexture(source);
    tex.colorSpace = SRGBColorSpace;
    tex.minFilter = LinearMipmapLinearFilter;
    tex.magFilter = LinearFilter;
    tex.anisotropy = 8;
    tex.generateMipmaps = true;
    return tex;
}

function createMaterial(map: Texture, quality: QualitySettings): MeshStandardNodeMaterial {
    const material = new MeshStandardNodeMaterial({ roughness: 0.96, metalness: 0 });
    // x = ベイクGIの空可視率 / y = 傾斜 / z = ベイクGIの1バウンス受光量
    const baked = attribute<'vec3'>('aGround', 'vec3');
    const albedo = textureNode(map, uv()).rgb;
    // 傾斜が急なところは土肌寄りに寄せて、写真ののっぺり感を崩す。
    // ほぼ垂直な面は擁壁・法面ブロックなので、コンクリート寄りの色にする
    // （50cm DEM は擁壁を地形の段差としてそのまま持っているため、別ジオメトリは足さない）
    const soil = vec3(0.34, 0.27, 0.2);
    const wall = vec3(0.3, 0.295, 0.28);
    const slope = saturate(baked.y.sub(0.42).mul(1.9));
    const cliff = saturate(baked.y.sub(0.74).mul(3.4));
    const soiled = mix(albedo, albedo.mul(0.55).add(soil.mul(0.45)), slope);
    const tinted = mix(soiled, albedo.mul(0.3).add(wall.mul(0.7)), cliff);
    // 近景だけ高周波のムラを足す（航空写真が甘くなる 1.6m 視点対策）
    const closeness = smoothstep(20, 150, positionView.length()).oneMinus();
    const grain = mx_noise_float(positionWorld.mul(0.85)).mul(0.5).add(0.5);
    const coarse = mx_noise_float(positionWorld.mul(0.13)).mul(0.5).add(0.5);
    const base =
        quality.preset === 'desktop'
            ? tinted.mul(mix(float(1), mix(float(0.72), float(1.3), grain.mul(0.6).add(coarse.mul(0.4))), closeness))
            : tinted;
    material.colorNode = base;
    // ベイクGI（追記1）: 空可視率は環境光だけを削り、直射日光は削らない。
    // 塞がれたぶんは1バウンスで拾い直すので谷筋・林床が黒く潰れない
    material.aoNode = mix(float(1), baked.x, GI_AO_STRENGTH);
    material.emissiveNode = base.mul(bounceColorNode).mul(baked.z.mul(GI_BOUNCE_SCALE));
    material.roughnessNode = mix(float(0.99), float(0.86), baked.y);
    return material;
}

export function createTerrain(
    sample: ElevationSampler,
    aerial: AerialImage,
    heightmap: Heightmap | null,
    gi: GiMap | null,
    quality: QualitySettings,
): Terrain {
    const heights = new Float32Array(N * N);
    const { range } = aerial;
    let minElevation = Infinity;
    let maxElevation = -Infinity;

    for (let row = 0; row < N; row++) {
        const z = -AREA_HALF + row * STEP;
        const lat = zToLat(z);
        for (let col = 0; col < N; col++) {
            const x = -AREA_HALF + col * STEP;
            // 50cm 由来の値を優先し、無い箇所だけ DEM5A で埋める（E1）
            let h = heightmap ? heightmap.sampleAt(x, z) : NaN;
            if (!Number.isFinite(h)) h = sample(xToLon(x), lat);
            heights[row * N + col] = h;
            if (h < minElevation) minElevation = h;
            if (h > maxElevation) maxElevation = h;
        }
    }

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
        return h00 * (1 - tx) * (1 - tz) + h10 * tx * (1 - tz) + h01 * (1 - tx) * tz + h11 * tx * tz;
    };

    // 前処理のベイクGI（追記1）が使えればそれを使う。無ければ起動時に
    // 地形だけの粗い遮蔽を焼く（従来動作へのフォールバック・E58）
    const ao = gi ? null : bakeAmbientOcclusion(heights);
    const aoStep = (AREA_HALF * 2) / (AO_GRID - 1);
    const sampleFallbackAO = (x: number, z: number): number => {
        if (!ao) return 1;
        const fx = Math.min(Math.max((x + AREA_HALF) / aoStep, 0), AO_GRID - 1);
        const fz = Math.min(Math.max((z + AREA_HALF) / aoStep, 0), AO_GRID - 1);
        const c = Math.min(Math.floor(fx), AO_GRID - 2);
        const r = Math.min(Math.floor(fz), AO_GRID - 2);
        const tx = fx - c;
        const tz = fz - r;
        return (
            ao[r * AO_GRID + c] * (1 - tx) * (1 - tz) +
            ao[r * AO_GRID + c + 1] * tx * (1 - tz) +
            ao[(r + 1) * AO_GRID + c] * (1 - tx) * tz +
            ao[(r + 1) * AO_GRID + c + 1] * tx * tz
        );
    };

    // 全体の法線（チャンクをまたいでも継ぎ目が出ないよう中央差分で作る）
    const normalAt = (col: number, row: number, out: Vector3): Vector3 => {
        const c0 = Math.max(0, col - 1);
        const c1 = Math.min(N - 1, col + 1);
        const r0 = Math.max(0, row - 1);
        const r1 = Math.min(N - 1, row + 1);
        const dx = (heights[row * N + c1] - heights[row * N + c0]) / ((c1 - c0) * STEP);
        const dz = (heights[r1 * N + col] - heights[r0 * N + col]) / ((r1 - r0) * STEP);
        return out.set(-dx, 1, -dz).normalize();
    };

    const material = createMaterial(toTexture(aerial.canvas, quality.maxTextureSize), quality);
    const group = new Group();
    group.name = 'terrain';
    const chunks: Chunk[] = [];
    const scratchNormal = new Vector3();

    const side = CHUNK_CELLS + 1;
    for (let cz = 0; cz < CHUNKS; cz++) {
        for (let cx = 0; cx < CHUNKS; cx++) {
            const col0 = cx * CHUNK_CELLS;
            const row0 = cz * CHUNK_CELLS;
            const total = side * side + side * 4;
            const positions = new Float32Array(total * 3);
            const normals = new Int16Array(total * 3);
            const uvs = new Float32Array(total * 2);
            const ground = new Float32Array(total * 3);
            let cMin = Infinity;
            let cMax = -Infinity;

            const writeVertex = (target: number, col: number, row: number, drop: number): void => {
                const x = -AREA_HALF + col * STEP;
                const z = -AREA_HALF + row * STEP;
                const h = heights[row * N + col];
                positions[target * 3] = x;
                positions[target * 3 + 1] = h - drop;
                positions[target * 3 + 2] = z;
                normalAt(col, row, scratchNormal);
                normals[target * 3] = Math.round(scratchNormal.x * 32767);
                normals[target * 3 + 1] = Math.round(scratchNormal.y * 32767);
                normals[target * 3 + 2] = Math.round(scratchNormal.z * 32767);
                const lon = xToLon(x);
                uvs[target * 2] = (lonToTileX(lon, range.z) - range.x0) / range.nx;
                // テクスチャは flipY されるので v を反転する
                uvs[target * 2 + 1] = 1 - (latToTileY(zToLat(z), range.z) - range.y0) / range.ny;
                ground[target * 3] = gi ? gi.skyAt(x, z, 0) : sampleFallbackAO(x, z);
                ground[target * 3 + 1] = 1 - scratchNormal.y;
                ground[target * 3 + 2] = gi ? gi.bounceAt(x, z) : 0;
                if (h < cMin) cMin = h;
                if (h > cMax) cMax = h;
            };

            for (let r = 0; r < side; r++) {
                for (let c = 0; c < side; c++) writeVertex(r * side + c, col0 + c, row0 + r, 0);
            }
            // スカート: 4辺ぶん、本体の外周頂点を SKIRT_DEPTH だけ下げて複製する
            const skirtBase = side * side;
            for (let i = 0; i < side; i++) {
                writeVertex(skirtBase + i, col0 + i, row0, SKIRT_DEPTH); // 北(-z)
                writeVertex(skirtBase + side + i, col0 + i, row0 + CHUNK_CELLS, SKIRT_DEPTH); // 南
                writeVertex(skirtBase + side * 2 + i, col0, row0 + i, SKIRT_DEPTH); // 西
                writeVertex(skirtBase + side * 3 + i, col0 + CHUNK_CELLS, row0 + i, SKIRT_DEPTH); // 東
            }

            const geometry = new BufferGeometry();
            geometry.setAttribute('position', new BufferAttribute(positions, 3));
            geometry.setAttribute('normal', new BufferAttribute(normals, 3, true));
            geometry.setAttribute('uv', new BufferAttribute(uvs, 2));
            geometry.setAttribute('aGround', new BufferAttribute(ground, 3));

            const indices: BufferAttribute[] = [];
            for (const stride of LOD_STRIDES) {
                const cells = CHUNK_CELLS / stride;
                const idx = new Uint32Array(cells * cells * 6 + cells * 4 * 6);
                let k = 0;
                for (let r = 0; r < cells; r++) {
                    for (let c = 0; c < cells; c++) {
                        const a = r * stride * side + c * stride;
                        const b = a + stride;
                        const d = a + stride * side;
                        const e = d + stride;
                        idx[k++] = a;
                        idx[k++] = d;
                        idx[k++] = b;
                        idx[k++] = b;
                        idx[k++] = d;
                        idx[k++] = e;
                    }
                }
                // スカート（外向きの巻き方向は片面でよいので裏表は気にしない）
                for (let i = 0; i < cells; i++) {
                    const i0 = i * stride;
                    const i1 = (i + 1) * stride;
                    const pairs: [number, number, number, number][] = [
                        [i0, i1, skirtBase + i0, skirtBase + i1],
                        [CHUNK_CELLS * side + i0, CHUNK_CELLS * side + i1, skirtBase + side + i0, skirtBase + side + i1],
                        [i0 * side, i1 * side, skirtBase + side * 2 + i0, skirtBase + side * 2 + i1],
                        [i0 * side + CHUNK_CELLS, i1 * side + CHUNK_CELLS, skirtBase + side * 3 + i0, skirtBase + side * 3 + i1],
                    ];
                    for (const [t0, t1, b0, b1] of pairs) {
                        idx[k++] = t0;
                        idx[k++] = b0;
                        idx[k++] = t1;
                        idx[k++] = t1;
                        idx[k++] = b0;
                        idx[k++] = b1;
                    }
                }
                indices.push(new BufferAttribute(idx, 1));
            }

            geometry.setIndex(indices[0]);
            const halfSpan = (CHUNK_CELLS * STEP) / 2;
            const center = new Vector3(
                -AREA_HALF + (col0 + CHUNK_CELLS / 2) * STEP,
                (cMin + cMax) / 2,
                -AREA_HALF + (row0 + CHUNK_CELLS / 2) * STEP,
            );
            geometry.boundingSphere = null;
            geometry.computeBoundingSphere();

            const mesh = new Mesh(geometry, material);
            mesh.name = `terrain-${cx}-${cz}`;
            mesh.receiveShadow = true;
            mesh.castShadow = true;
            mesh.matrixAutoUpdate = false;
            mesh.updateMatrix();
            group.add(mesh);
            chunks.push({
                mesh,
                geometry,
                indices,
                center,
                radius: Math.hypot(halfSpan, halfSpan) + (cMax - cMin) / 2,
                lod: 0,
            });
        }
    }

    const drawn = { count: 0 };
    const scratch = new Vector3();

    return {
        group,
        getElevationAt,
        minElevation: Number.isFinite(minElevation) ? minElevation : 0,
        maxElevation: Number.isFinite(maxElevation) ? maxElevation : 0,
        hires: heightmap !== null,
        drawn,
        chunkCount: chunks.length,
        update(cameraPos, frustum, quality) {
            drawn.count = 0;
            const bias = quality.preset === 'mobile' ? 0.55 : 1;
            for (const chunk of chunks) {
                const dist = Math.max(0, scratch.copy(chunk.center).distanceTo(cameraPos) - chunk.radius);
                if (dist > quality.viewDistance || !frustum.intersectsSphere(chunk.geometry.boundingSphere!)) {
                    chunk.mesh.visible = false;
                    continue;
                }
                chunk.mesh.visible = true;
                drawn.count++;
                let lod = LOD_STRIDES.length - 1;
                for (let i = 0; i < LOD_DISTANCES.length; i++) {
                    if (dist < LOD_DISTANCES[i] * bias) {
                        lod = i;
                        break;
                    }
                }
                if (lod !== chunk.lod) {
                    chunk.lod = lod;
                    chunk.geometry.setIndex(chunk.indices[lod]);
                }
            }
        },
    };
}
