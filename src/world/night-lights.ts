/**
 * 夜間照明（契約15）。街灯とプレイヤー周辺の灯りを、描画予算を守りながら見せる。
 *
 * 2層構造にしている:
 *   (a) ハロー   全街灯・全キャラの灯りを1枚のビルボード群でまとめて描く。
 *                町全体ぶんで **ドローコール2**。遠くの尾根に灯りの列が見えるのも、
 *                夜道の向こうに「誰かいる」と分かるのもこれが担当する
 *   (b) 実ライト プレイヤー近傍にだけ PointLight を配る。路面・壁が実際に照らされる
 *
 * 実ライトの数は**起動時に固定**する（desktop 8 / mobile 6）。three のノードマテリアルは
 * シーンのライト構成でシェーダーを作り分けるので、途中で数を増減させると全マテリアルの
 * 再コンパイルが走る。使わないライトは intensity 0 で寝かせておき、**scene から出し入れも
 * visible の切り替えもしない**（プリウォーム済みのパイプラインをそのまま使い続ける）。
 *
 * 割り当ては距離のヒステリシス + フェードで切り替える（E106: 視界内で急に消えない）。
 */
import {
    AdditiveBlending,
    BufferAttribute,
    BufferGeometry,
    Color,
    Mesh,
    MeshBasicNodeMaterial,
    PointLight,
    Scene,
    Sphere,
    Vector3,
} from 'three/webgpu';
import {
    attribute,
    cameraProjectionMatrix,
    float,
    modelViewMatrix,
    positionLocal,
    saturate,
    smoothstep,
    vec3,
    vec4,
} from 'three/tsl';
import { AREA_HALF } from '../config';
import type { QualitySettings } from '../quality';
import { lampNode } from './sun';
import type { LampAnchor } from './props';

/**
 * 街灯へ配る実ライトの数。
 *
 * ライトはシーンに常駐する（下の設計上の理由）ので、**枠の数がそのまま昼夜を問わない
 * 固定費**になる。実測（Iris Xe 相当・夜間 desktop tier0）で 12灯 = +4.9ms/frame、
 * 1灯あたり約0.4ms。一方で住宅街を歩くと同時に点くのは 3〜4灯どまりだった
 * （電柱間隔31m に対して取得半径34m なので、視界内の街灯はもともと少ない）。
 * 余らせた枠は絵に何も足さずに払うだけなので、実測に合わせて絞ってある
 */
const LAMP_SLOTS = { desktop: 6, mobile: 4 } as const;
/** 人（自分・遠隔・BOT）へ配る実ライトの数。自分はいちばん近いので必ず1つ取る */
const LANTERN_SLOTS = { desktop: 2, mobile: 2 } as const;
/** ハローを出す人の上限（実ライトが届かない相手もここには載る） */
const LANTERN_HALOS = 24;

/** 街灯の実ライトを取りに行く距離[m] と 手放す距離[m]（ヒステリシス・E106） */
const LAMP_ACQUIRE = 34;
const LAMP_RELEASE = 46;
/** 人の灯りに実ライトを配る距離[m] */
const LANTERN_ACQUIRE = 40;
const LANTERN_RELEASE = 54;
/** 割り当ての見直し間隔[s]（毎フレームやる必要はない） */
const ASSIGN_INTERVAL = 0.12;
/** 点灯・消灯フェードの速さ[1/s]。0.4秒ぶん */
const FADE_RATE = 2.5;

/** 街灯の実ライト: 色・届く距離[m]・強さ・減衰 */
const LAMP_LIGHT_COLOR = 0xffd9a2;
const LAMP_LIGHT_RANGE = 24;
const LAMP_LIGHT_INTENSITY = 26;
const LAMP_LIGHT_DECAY = 1.35;
/** 提灯風のライト: 暖色・半径8m目安（契約15-3） */
const LANTERN_LIGHT_COLOR = 0xffc078;
const LANTERN_LIGHT_RANGE = 9;
const LANTERN_LIGHT_INTENSITY = 3.2;
const LANTERN_LIGHT_DECAY = 1.2;
/** 人の灯りを吊るす高さ[m]（足元から）。チビ体型の頭より上に置く */
const LANTERN_HEIGHT = 1.8;

/** ハロー: 近景での半径[m] / 遠くでも点として残る最小画角 / 描画距離の上限[m] */
const HALO_LAMP_SIZE = 1.5;
const HALO_LANTERN_SIZE = 0.5;
/**
 * ハローの明るさ。人の灯りは自分の頭上にも出るので控えめにする —
 * 近くで見たときに顔が潰れず、遠くでは最小画角の下支えで点として残る
 */
const HALO_LAMP_BRIGHT = 1;
const HALO_LANTERN_BRIGHT = 0.45;
const HALO_MIN_ANGULAR = 0.0048;
const HALO_FAR_MAX = 2400;
/**
 * ハローをカメラ側へ引き寄せる量[m]。灯具やアバターの頭で光の芯が
 * 抜かれてしまう（真ん中に黒い点が出る）のを防ぐ
 */
const HALO_PULL = 0.45;

export interface NightLights {
    /**
     * 街灯アンカーを渡す（ワールド構築後・シェーダープリウォームより前に1回）。
     * ここでハローのメッシュを作るので、プリウォームに間に合わせること
     */
    setLamps(lamps: readonly LampAnchor[]): void;
    /**
     * 毎フレーム。focus は実ライトを配る中心（プレイヤーの足元／?fly ならカメラ）。
     * self が null なら自分の提灯を出さない（?fly のデバッグ視点）。
     * peers は遠隔プレイヤー・BOT の巡回口（null なら誰も居ない）
     */
    update(
        dt: number,
        focus: { x: number; y: number; z: number },
        self: { x: number; y: number; z: number } | null,
        peers: {
            eachPeerPosition(visit: (id: string, x: number, y: number, z: number) => void): void;
        } | null,
    ): void;
    /** いま実際に点いているポイントライトの数（?stats 表示・実測用） */
    readonly activeLights: number;
    dispose(): void;
}

/** プールの1枠 */
interface Slot {
    light: PointLight;
    /** 割り当て先。街灯はアンカー番号、人は巡回順の番号。-1 = 空き */
    target: number;
    /** 0=消灯 1=全点灯。切り替えはここを介するので視界内で急に消えない（E106） */
    level: number;
    /** 手放し中（消えきってから別の相手を取りに行く） */
    releasing: boolean;
}

interface HaloLayer {
    mesh: Mesh;
    /** i 番目の光点を置く */
    set(i: number, x: number, y: number, z: number): void;
    /** used 個までを有効にして GPU へ送る（残りは不透明度 0 で潰す） */
    commit(used: number): void;
    dispose(): void;
}

/** 四隅（三角形2枚ぶん） */
const HALO_CORNERS = [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, -1],
    [1, 1],
    [-1, 1],
] as const;

/**
 * ビルボードのハロー層。1メッシュ = 1ドローコールで capacity 個の光点を描く。
 *
 * 頂点をビュー空間へ持ち上げてから四隅を広げるので常にカメラを向く。
 * 昼（lampNode=0）はサイズが 0 に潰れて三角形が消えるため、オーバードローは出ない。
 * 描画範囲は常に全体にしておく（プリウォームで確実にコンパイルさせるため）。
 */
function createHaloLayer(
    capacity: number,
    baseSize: number,
    color: Color,
    bright: number,
    far: number,
): HaloLayer {
    const position = new Float32Array(capacity * 6 * 3);
    const corner = new Float32Array(capacity * 6 * 2);
    const alpha = new Float32Array(capacity * 6);
    for (let i = 0; i < capacity; i++) {
        for (let k = 0; k < 6; k++) {
            corner[(i * 6 + k) * 2] = HALO_CORNERS[k][0];
            corner[(i * 6 + k) * 2 + 1] = HALO_CORNERS[k][1];
        }
    }

    const geometry = new BufferGeometry();
    const positionAttr = new BufferAttribute(position, 3);
    const alphaAttr = new BufferAttribute(alpha, 1);
    geometry.setAttribute('position', positionAttr);
    geometry.setAttribute('aCorner', new BufferAttribute(corner, 2));
    geometry.setAttribute('aAlpha', alphaAttr);
    // 中心座標を頂点に持たせて四隅はシェーダーで広げるので、既定のバウンディングでは
    // 足りない。エリア全体を覆う球を手で入れておく（毎フレーム計算しない）
    geometry.boundingSphere = new Sphere(new Vector3(0, 0, 0), AREA_HALF * 2);

    const cornerNode = attribute<'vec2'>('aCorner', 'vec2');
    const alphaNode = attribute<'float'>('aAlpha', 'float');
    const material = new MeshBasicNodeMaterial();

    // ビュー空間の中心。カメラは -z を向くので -z がそのまま距離になる
    const viewCenter = modelViewMatrix.mul(vec4(positionLocal, 1));
    const viewDist = viewCenter.z.negate().max(0.01);
    // 遠くでも点として残るよう、画面上の最小サイズを距離に比例させて下支えする。
    // 昼は lampNode=0 でサイズごと 0 に潰す（頂点が退化して描画されない）
    const size = float(baseSize)
        .max(viewDist.mul(HALO_MIN_ANGULAR))
        .mul(saturate(lampNode.mul(6)))
        .mul(smoothstep(far * 0.72, far, viewDist).oneMinus());
    // カメラは -z を向くので、z を足すと手前へ来る（灯具に芯を抜かれない）
    material.vertexNode = cameraProjectionMatrix.mul(
        vec4(
            viewCenter.xy.add(cornerNode.mul(size)),
            viewCenter.z.add(HALO_PULL),
            viewCenter.w,
        ),
    );
    // 中心が明るく縁が消える丸いにじみ。加算合成なので 色 × 不透明度 がそのまま光量になる
    const falloff = saturate(float(1).sub(cornerNode.length())).pow(2.2);
    material.colorNode = vec3(color.r, color.g, color.b);
    material.opacityNode = falloff.mul(alphaNode).mul(lampNode).mul(bright);
    material.transparent = true;
    material.blending = AdditiveBlending;
    material.depthWrite = false;
    material.fog = false;

    const mesh = new Mesh(geometry, material);
    mesh.name = 'night-halo';
    mesh.matrixAutoUpdate = false;
    mesh.renderOrder = 900;

    return {
        mesh,
        set(i, x, y, z) {
            const base = i * 6;
            for (let k = 0; k < 6; k++) {
                position[(base + k) * 3] = x;
                position[(base + k) * 3 + 1] = y;
                position[(base + k) * 3 + 2] = z;
            }
        },
        commit(used) {
            for (let i = 0; i < capacity; i++) {
                const on = i < used ? 1 : 0;
                for (let k = 0; k < 6; k++) alpha[i * 6 + k] = on;
            }
            positionAttr.needsUpdate = true;
            alphaAttr.needsUpdate = true;
        },
        dispose() {
            geometry.dispose();
            material.dispose();
        },
    };
}

/** 使い回しのスクラッチ（フレームループで new を作らない） */
const focusPoint = new Vector3();

export function createNightLights(scene: Scene, quality: QualitySettings): NightLights {
    const makeSlots = (count: number, color: number, range: number, decay: number): Slot[] => {
        const slots: Slot[] = [];
        for (let i = 0; i < count; i++) {
            const light = new PointLight(color, 0, range, decay);
            light.name = 'night-light';
            // 影は持たせない（シャドウマップが灯数ぶん増えると予算に収まらない）
            light.castShadow = false;
            scene.add(light);
            slots.push({ light, target: -1, level: 0, releasing: false });
        }
        return slots;
    };
    // ライトはここで作りきる。以後 scene から出し入れしない（再コンパイルを起こさない）
    const lampSlots = makeSlots(
        LAMP_SLOTS[quality.preset],
        LAMP_LIGHT_COLOR,
        LAMP_LIGHT_RANGE,
        LAMP_LIGHT_DECAY,
    );
    const lanternSlots = makeSlots(
        LANTERN_SLOTS[quality.preset],
        LANTERN_LIGHT_COLOR,
        LANTERN_LIGHT_RANGE,
        LANTERN_LIGHT_DECAY,
    );

    // 描画距離はワールドの打ち切りに合わせる（見えない灯りのオーバードローを出さない）
    const haloFar = Math.min(HALO_FAR_MAX, quality.viewDistance);
    let lamps: readonly LampAnchor[] = [];
    let lampHalo: HaloLayer | null = null;
    const lanternHalo = createHaloLayer(
        LANTERN_HALOS,
        HALO_LANTERN_SIZE,
        new Color(LANTERN_LIGHT_COLOR),
        HALO_LANTERN_BRIGHT,
        haloFar,
    );
    scene.add(lanternHalo.mesh);

    // 人の位置は毎フレーム詰め直す固定長バッファ（0 番目は自分）
    const lanternXyz = new Float32Array(LANTERN_HALOS * 3);
    let lanternTotal = 0;
    const pushLantern = (x: number, y: number, z: number): void => {
        if (lanternTotal >= LANTERN_HALOS) return;
        lanternXyz[lanternTotal * 3] = x;
        lanternXyz[lanternTotal * 3 + 1] = y + LANTERN_HEIGHT;
        lanternXyz[lanternTotal * 3 + 2] = z;
        lanternTotal++;
    };
    const collectPeer = (_id: string, x: number, y: number, z: number): void => {
        pushLantern(x, y, z);
    };

    /** 近い順に拾う作業配列。長さはプールの空き数までしか伸びない */
    const rankIndex: number[] = [];
    const rankDist: number[] = [];
    let assignTimer = ASSIGN_INTERVAL;
    let active = 0;

    /** 灯りの全体の明るさ（薄暮で 0→1・E104） */
    const lampLevel = (): number => lampNode.value as number;

    const dist2 = (x: number, y: number, z: number): number => {
        const dx = x - focusPoint.x;
        const dy = y - focusPoint.y;
        const dz = z - focusPoint.z;
        return dx * dx + dy * dy + dz * dz;
    };

    /**
     * 空いた枠へ近い順に割り当てる。すでに誰かが持っている相手は取らない。
     * 候補が数千あっても比較だけなので、8Hz で回して問題にならない。
     */
    const assign = (
        slots: Slot[],
        count: number,
        acquire: number,
        release: number,
        distanceOf: (i: number) => number,
    ): void => {
        // 遠ざかった相手は手放しにかかる（消えきってから次を取る・E106）
        let free = 0;
        for (const slot of slots) {
            if (slot.target < 0) {
                free++;
                continue;
            }
            if (!slot.releasing && (slot.target >= count || distanceOf(slot.target) > release * release)) {
                slot.releasing = true;
            }
        }
        if (free === 0) return;

        // 候補を近い順に free 件だけ拾う（挿入ソート・配列は伸ばさず上書きする）
        rankIndex.length = 0;
        rankDist.length = 0;
        const limit = acquire * acquire;
        for (let i = 0; i < count; i++) {
            const d = distanceOf(i);
            if (d > limit) continue;
            if (rankDist.length >= free && d >= rankDist[rankDist.length - 1]) continue;
            let at = rankDist.length < free ? rankDist.length : free - 1;
            if (rankDist.length < free) {
                rankDist.push(d);
                rankIndex.push(i);
            }
            while (at > 0 && rankDist[at - 1] > d) {
                rankDist[at] = rankDist[at - 1];
                rankIndex[at] = rankIndex[at - 1];
                at--;
            }
            rankDist[at] = d;
            rankIndex[at] = i;
        }
        for (const candidate of rankIndex) {
            let slot: Slot | null = null;
            for (const s of slots) {
                if (s.target === candidate) {
                    slot = null;
                    break;
                }
                if (!slot && s.target < 0) slot = s;
            }
            if (!slot) continue;
            slot.target = candidate;
            slot.releasing = false;
        }
    };

    /** フェードを進め、点いているライトを置き直す */
    const drive = (
        slots: Slot[],
        dt: number,
        intensity: number,
        positionOf: (i: number, out: Vector3) => boolean,
    ): void => {
        const step = FADE_RATE * dt;
        const brightness = lampLevel();
        for (const slot of slots) {
            const wanted = slot.target >= 0 && !slot.releasing;
            slot.level = wanted ? Math.min(1, slot.level + step) : Math.max(0, slot.level - step);
            // 手放し中は動かさない（別の相手の位置へ飛ぶと消えぎわに光が走る）
            if (wanted && !positionOf(slot.target, slot.light.position)) slot.releasing = true;
            if (slot.level <= 0 && slot.releasing) {
                slot.target = -1;
                slot.releasing = false;
            }
            slot.light.intensity = slot.level * intensity * brightness;
            if (slot.light.intensity > 0) active++;
        }
    };

    const lampDistance = (i: number): number => dist2(lamps[i].x, lamps[i].y, lamps[i].z);
    const lampPosition = (i: number, out: Vector3): boolean => {
        const a = lamps[i];
        if (!a) return false;
        // 灯体のすぐ下に置く。筐体の中に埋めると自分のジオメトリで光が削られる
        out.set(a.x, a.y - 0.25, a.z);
        return true;
    };
    const lanternDistance = (i: number): number =>
        dist2(lanternXyz[i * 3], lanternXyz[i * 3 + 1], lanternXyz[i * 3 + 2]);
    const lanternPosition = (i: number, out: Vector3): boolean => {
        if (i >= lanternTotal) return false;
        out.set(lanternXyz[i * 3], lanternXyz[i * 3 + 1], lanternXyz[i * 3 + 2]);
        return true;
    };

    return {
        setLamps(next) {
            lamps = next;
            if (lampHalo) {
                scene.remove(lampHalo.mesh);
                lampHalo.dispose();
                lampHalo = null;
            }
            if (next.length === 0) return;
            lampHalo = createHaloLayer(
                next.length,
                HALO_LAMP_SIZE,
                new Color(LAMP_LIGHT_COLOR),
                HALO_LAMP_BRIGHT,
                haloFar,
            );
            for (let i = 0; i < next.length; i++) lampHalo.set(i, next[i].x, next[i].y, next[i].z);
            lampHalo.commit(next.length);
            scene.add(lampHalo.mesh);
        },
        update(dt, focus, self, peers) {
            focusPoint.set(focus.x, focus.y, focus.z);

            // --- 人の灯り（自分 → 遠隔・BOT の順。並びは巡回元が決める） ---
            lanternTotal = 0;
            if (self) pushLantern(self.x, self.y, self.z);
            peers?.eachPeerPosition(collectPeer);
            for (let i = 0; i < lanternTotal; i++) {
                lanternHalo.set(i, lanternXyz[i * 3], lanternXyz[i * 3 + 1], lanternXyz[i * 3 + 2]);
            }
            lanternHalo.commit(lanternTotal);

            // 昼は割り当てを触らない（候補 0 件 = 全枠が消灯フェードへ向かう）
            assignTimer += dt;
            if (assignTimer >= ASSIGN_INTERVAL) {
                assignTimer = 0;
                const on = lampLevel() > 0.01;
                assign(lampSlots, on ? lamps.length : 0, LAMP_ACQUIRE, LAMP_RELEASE, lampDistance);
                assign(
                    lanternSlots,
                    on ? lanternTotal : 0,
                    LANTERN_ACQUIRE,
                    LANTERN_RELEASE,
                    lanternDistance,
                );
            }
            // 昼はハローを丸ごと外す。頂点は潰れていても submit はされるので、
            // 消しておかないと昼のドローコール予算に 2 本ぶん残ってしまう。
            // ライトと違ってマテリアルの作り分けには関わらないので、切っても再コンパイルは起きない
            const lit = lampLevel() > 0.002;
            lanternHalo.mesh.visible = lit;
            if (lampHalo) lampHalo.mesh.visible = lit;

            active = 0;
            drive(lampSlots, dt, LAMP_LIGHT_INTENSITY, lampPosition);
            drive(lanternSlots, dt, LANTERN_LIGHT_INTENSITY, lanternPosition);
        },
        get activeLights() {
            return active;
        },
        dispose() {
            for (const slot of lampSlots) scene.remove(slot.light);
            for (const slot of lanternSlots) scene.remove(slot.light);
            scene.remove(lanternHalo.mesh);
            lanternHalo.dispose();
            if (lampHalo) {
                scene.remove(lampHalo.mesh);
                lampHalo.dispose();
            }
        },
    };
}
