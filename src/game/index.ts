/**
 * 操作系の入口（契約04）。徒歩と運転、そのあいだの乗降を持つ。
 *
 * 呼び出し側（main.ts）の約束:
 *   1. ワールドの 'ready' 後に createGame する（物理コライダーはワールド形状から作るため・E2）
 *   2. 毎フレーム game.update(dt) を呼ぶ。カメラはこの中で動く
 *   3. game.state は毎フレーム更新される単一オブジェクト。後続のマルチプレイは
 *      これを読んで送信すればよい（追記2-3）
 */
import { Vector3, type PerspectiveCamera, type Scene } from 'three/webgpu';
import { AREA_HALF } from '../config';
import type { QualitySettings } from '../quality';
import { setHelp } from '../ui/loading';
import { worldStats } from '../ui/stats';
import { OCC_BUILDING } from '../world/occupancy';
import type { World } from '../world';
import {
    BOAR_SEAT,
    DRIVER_SEAT,
    HELI_SEAT,
    createBoarAvatar,
    createCarAvatar,
    createHeliAvatar,
    createPlayerAvatar,
    type BoarAvatar,
    type HeliAvatar,
} from './avatar';
import { CHARACTER_CENTER_OFFSET, createCharacter } from './character';
import { createFollowCamera } from './follow-camera';
import { createHelicopter, type Helicopter } from './helicopter';
import { createInput, lookSpeed } from './input';
import { createPhysics, type Physics } from './physics';
import { createSkydive, type SkyState } from './skydive';
import { CHASSIS_HALF, VEHICLE_GROUND_OFFSET, createVehicle } from './vehicle';

export { initPhysics } from './physics';

/** 乗車できる距離[m]（車体中心から。全長4.1mの車なのでバンパーから約1m） */
const ENTER_RADIUS = 5;
/**
 * 建物の中から逃がすときに調べる半径[m]と方位数。
 * マンションのフットプリントでも抜けられるよう 32m まで広げてある
 */
const ESCAPE_RINGS = [3, 5, 8, 12, 17, 23, 32];
const ESCAPE_STEPS = 12;
/** 地形からこれだけ下に落ちたらリスポーン[m]（E19） */
const FALL_LIMIT = 20;
/**
 * カメラの追従距離[m]。徒歩の既定速度を上げた（契約13-12）ので、
 * 画面内に前方の道が入るよう少し引いてある
 */
const WALK_DISTANCE = 6.6;
/** 徒歩の注視点の追従の速さ[1/s]。速度が上がったぶん既定（16）より強く追わせる */
const WALK_FOLLOW_RATE = 26;
const DRIVE_DISTANCE = 8.4;
/** カメラの注視点の高さ[m]（チビ体型の胸〜頭のあたり・契約06） */
const WALK_FOCUS = 1;
/** 車のスポーン位置（スポーン地点から進行方向へ）[m] */
const CAR_AHEAD = 9;

/** 踏み切りまでの溜め[s]（アンティシペーション。長くすると操作が重くなる） */
const JUMP_ANTICIPATION = 0.07;

// --- スーパーマンモード（デバッグ・?superman で解放。契約06 追記2） ---
/** 通常の飛行速度[m/s] */
const FLY_SPEED = 42;
/** ブースト時[m/s]。2.4km四方を十数秒で横断できる速さ */
const FLY_BOOST = 155;
/** 速度の追従の速さ[1/s] */
const FLY_ACCEL = 3.6;
/** 地形からの最低クリアランス[m]（衝突は地形のみ。建物はすり抜ける） */
const FLY_CLEARANCE = 1.1;
/** 飛行中のカメラ距離[m] */
const FLY_DISTANCE = 7;
/** 降下中のカメラ距離[m]（契約10。空では引いたほうが地形が読める） */
const SKY_DISTANCE = 9;
/** 降下中の注視点の追従の速さ[1/s]。落下が速いので徒歩より強く追わせる */
const SKY_FOLLOW_RATE = 55;
/** 降下に入るときの最低の見下ろし角[rad]（着地点を見ながら降りられるように） */
const SKY_PITCH = -0.5;

const HELP_WALK =
    'WASD: 移動　Shift: 歩く（ゆっくり）　Space: ジャンプ　ドラッグ/マウス: 視点　F: 乗車　E: 回収　R: 位置リセット';
const HELP_DRIVE = 'W/S: アクセル・後退　A/D: ハンドル　Space: ブレーキ　F: 降車　R: 姿勢リセット';
const HELP_HELI =
    '★ヘリ　W/S: 前後　A/D: バンク旋回　Space: 上昇　C: 下降　Shift: ブースト　F: 着陸して降りる';
const HELP_BOAR = '★イノシシ騎乗　WASD: 移動　急坂に強い　F: 降りる';
const HELP_FLY = '★スーパーマン　W: 前進　Shift: ブースト　Space/C: 上下　視点で方向転換　G: 解除';
const HELP_SUPERMAN = '　G: スーパーマン';
const HELP_NEAR_CAR = '　★ F で乗車';
const HELP_NEAR_HELI = '　★ F でヘリに乗る';
const HELP_RIDE = '★輸送機　Space: 飛び降りる　ドラッグ/マウス: 視点';
const HELP_FALL =
    '★降下中　WASD/スティック: 前傾で水平へ大きく滑る　ドラッグ/マウス: 見回し';

/** ヘリに乗れる距離[m]（機体中心から。全長8mのローターの下に立てば乗れる） */
const HELI_ENTER_RADIUS = 7;
/** ヘリの追従カメラ距離[m] と 注視点の高さ[m] */
const HELI_DISTANCE = 13;
const HELI_FOCUS = 1.6;
/**
 * イノシシ騎乗中のカメラ距離[m] と 移動速度の倍率（契約12）。
 * 徒歩の既定が速くなった（契約13-12）ので、倍率は控えめに直した
 * （イノシシの取り柄は速さより「急坂に強い」ことへ寄せる）
 */
const BOAR_DISTANCE = 7.4;
const BOAR_SPEED_SCALE = 1.15;

/**
 * 'sky' は輸送機からの降下中（契約10）。同期上は徒歩と同じ扱い。
 * 'heli' はヘリコプター操縦中、'boar' はイノシシ騎乗中（契約12）
 */
export type PlayerMode = 'walk' | 'drive' | 'sky' | 'heli' | 'boar';

/** 外（マルチプレイ同期・UI）から読むための状態。毎フレーム同じオブジェクトを書き換える */
export interface GameState {
    mode: PlayerMode;
    /** プレイヤーの足元位置 */
    x: number;
    y: number;
    z: number;
    /** プレイヤーの向き[rad] */
    yaw: number;
    /** 水平速度[m/s] */
    speed: number;
    running: boolean;
    grounded: boolean;
    /**
     * いま乗っている乗り物（車・ヘリ・イノシシ）の座標。mode が 'walk' / 'sky' の
     * ときは最後に乗っていた車のもので、同期・マップは参照しない（契約12）
     */
    vehicle: {
        x: number;
        y: number;
        z: number;
        /** 車体・機体の yaw[rad] */
        yaw: number;
        speed: number;
        occupied: boolean;
    };
}

/**
 * 輸送機からの降下（契約10）。経路はマッチ側がシードから決めて毎フレーム座席の姿勢を渡し、
 * 落下・傘・着地の物理はこちらが持つ
 */
export interface GameSky {
    readonly state: SkyState;
    /** 座席の姿勢を与える（off から呼ぶと搭乗開始） */
    ride(x: number, y: number, z: number, yaw: number): void;
    /** 飛び降りる（搭乗中に Space を押しても同じことが起きる） */
    leave(): void;
    /**
     * いまの足元から height[m] 上空へ打ち上げて降下に入る（マント・契約15 追記10）。
     * 輸送機からの降下と違い**傘は開かない**ので、着地点は滑空で決める
     */
    launch(height: number): void;
    /** 途中で打ち切って地上へ戻す（リマッチ・E67） */
    cancel(): void;
}

export interface Game {
    state: GameState;
    physics: Physics;
    sky: GameSky;
    update(dt: number): void;
    /**
     * ゲーム入力を止める（E49）。物理と描画はそのまま進む。
     * 止める理由ごとに数えるので、マップとマッチのパネルが同時に開いても取り合わない
     */
    setInputSuspended(suspended: boolean, reason?: string): void;
    /** 徒歩の移動速度倍率（安置の外での減速・契約10 / アイテムの加速・契約11） */
    setSpeedScale(scale: number): void;
    /** 体当たりで押し飛ばされる（契約10） */
    knockback(dirX: number, dirZ: number, distance: number): void;
    /** 韋駄天の地下足袋（契約11）。急坂でも登れる・滑り落ちない */
    setSlopePower(on: boolean): void;
    /**
     * 指定座標の地表へ立たせる（契約11 のどこでもドア）。warpTo と違い
     * R の戻り先は変えない（通常フローのリスポーンは spawn のまま）
     */
    teleportTo(x: number, z: number, yaw: number): void;
    /** カメラの向き[rad]（HUD の方角矢印を画面基準へ直すのに使う・契約11） */
    readonly viewYaw: number;
    /**
     * ヘリコプターの発着地点を置く（契約12）。マッチがシードから決めた座標を渡す。
     * 空配列で機体を片付ける（リマッチ・E87）
     */
    setHelipads(pads: readonly { x: number; z: number; yaw: number }[]): void;
    /** 置いてあるヘリコプターを巡回する（2Dマップの目印・契約12） */
    eachHeli(visit: (x: number, z: number, yaw: number, occupied: boolean) => void): void;
    /** イノシシ騎乗（契約12）。笛の使用・野生個体への乗車の両方がここへ来る */
    mountBoar(seconds: number): void;
    /** 騎乗の残り[s]（0 = 乗っていない）。HUD に出す */
    readonly boarSeconds: number;
    /**
     * 徒歩で F を押したとき、車・ヘリのどちらにも乗らなかったら呼ばれる（契約12）。
     * true を返すと「何かに乗った」ことにして、以降の処理をしない（野生イノシシ）
     */
    setMountHook(hook: ((x: number, z: number) => boolean) | null): void;
    /** 乗り物から降ろして機体を発着地点へ戻す（マッチのリセット・E87 / E89） */
    dismountAll(): void;
    /**
     * デバッグ用の瞬間移動（契約10 追記の ?matchgoto）。指定座標の地表へ立たせ、
     * 以後は R の位置リセットもここへ戻す（＝目標の手前へ何度でも戻れる）。
     * ?matchgoto を付けたときにしか呼ばれない — 通常フローの挙動は変わらない
     */
    warpTo(x: number, z: number, yaw: number): void;
    dispose(): void;
}

export interface GameOptions {
    scene: Scene;
    camera: PerspectiveCamera;
    element: HTMLElement;
    world: World;
    quality: QualitySettings;
}

export function createGame(options: GameOptions): Game {
    const { scene, camera, element, world, quality } = options;
    const physics = createPhysics({
        getElevationAt: world.getElevationAt,
        buildings: world.collision.buildings,
        roads: world.collision.roads,
        bridges: world.collision.bridges,
        minElevation: world.stats.minElevation,
        maxElevation: world.stats.maxElevation,
    });
    console.info(
        `[physics] コライダー ${physics.stats.colliders}（三角形 ${physics.stats.triangles.toLocaleString()}）`,
    );

    const spawn = world.spawn;
    const spawnYaw = Math.atan2(-spawn.dirX, -spawn.dirZ);
    const spawnFeet = physics.surfaceHeight(spawn.x, spawn.z);

    const character = createCharacter(
        physics,
        spawn.x,
        spawnFeet + CHARACTER_CENTER_OFFSET + 0.05,
        spawn.z,
        spawnYaw,
    );

    const carX = spawn.x + spawn.dirX * CAR_AHEAD;
    const carZ = spawn.z + spawn.dirZ * CAR_AHEAD;
    const vehicle = createVehicle(
        physics,
        carX,
        physics.surfaceHeight(carX, carZ) + VEHICLE_GROUND_OFFSET + 0.1,
        carZ,
        // 車体ローカルの +z が正面。道の進行方向へ向ける
        Math.atan2(spawn.dirX, spawn.dirZ),
    );

    const player = createPlayerAvatar(quality);
    const car = createCarAvatar(quality);
    scene.add(player.group, car.group);

    const input = createInput(element);
    const follow = createFollowCamera(camera, physics);
    follow.yaw = spawnYaw;
    const skydive = createSkydive();

    const feet = new Vector3();
    const spot = new Vector3();
    const moveDir = new Vector3();
    const forward = new Vector3();
    const right = new Vector3();
    const wheelOffset = new Vector3();
    const flyPos = new Vector3();
    const flyVel = new Vector3();
    const flyDir = new Vector3();
    const flyWanted = new Vector3();
    // フレームループで new を作らないための使い回し
    const vehicleInput = { throttle: 0, steer: 0, brake: true };
    const state: GameState = {
        mode: 'walk',
        x: spawn.x,
        y: spawnFeet,
        z: spawn.z,
        yaw: spawnYaw,
        speed: 0,
        running: false,
        grounded: true,
        vehicle: { x: carX, y: 0, z: carZ, yaw: 0, speed: 0, occupied: false },
    };

    // --- ヘリコプター・イノシシ（契約12。使うときになってから作る） ---
    /** 機体は「発着地点を置かれたぶん」だけ作る（自由散策では1機も作らない） */
    const helis: { craft: Helicopter; avatar: HeliAvatar }[] = [];
    const helipads: { x: number; z: number; yaw: number }[] = [];
    /** 操縦中の機体の番号（-1 = 乗っていない） */
    let heliIndex = -1;
    const heliInput = { pitch: 0, roll: 0, collective: 0, boost: false, active: false };
    let boar: BoarAvatar | null = null;
    /** イノシシ騎乗の残り[s]（実時間） */
    let boarLeft = 0;
    let mountHook: ((x: number, z: number) => boolean) | null = null;

    let mode: PlayerMode = 'walk';
    let sinceLook = 10;
    let helpText = '';
    let interactEnabled = false;
    /** 入力を止めている理由（マップ / マッチのパネル）。1つでもあれば止める */
    const suspendReasons = new Set<string>();
    /** 踏み切りまでの残り時間[s]（負 = 待機なし） */
    let jumpPending = -1;
    /** 外から与えられた移動倍率（安置の外の減速・アイテムの加速） */
    let speedScale = 1;
    /** 韋駄天の地下足袋を持っているか（騎乗中は騎乗ぶんが上書きするので別に覚える） */
    let slopePowerWanted = false;
    const superman = new URLSearchParams(location.search).has('superman');
    let flying = false;
    let flyYaw = spawnYaw;
    /** デバッグの行き先（?matchgoto）。一度飛ぶと R の戻り先になる */
    let warped = false;
    let warpX = 0;
    let warpZ = 0;
    let warpYaw = 0;

    const showHelp = (text: string): void => {
        if (text === helpText) return;
        helpText = text;
        setHelp(text);
    };

    /** 降車位置を車の周りから探す。壁で塞がっていない最初の候補を使う（E21） */
    const exitPosition = (out: Vector3): void => {
        const side = CHASSIS_HALF.x + 0.9;
        const back = CHASSIS_HALF.z + 1.1;
        const candidates: [number, number, number][] = [
            [side, 0, 0],
            [-side, 0, 0],
            [0, 0, -back],
            [0, 0, back],
        ];
        const center = vehicle.position;
        for (const [lx, ly, lz] of candidates) {
            vehicle.localToWorld(lx, ly, lz, out);
            const dx = out.x - center.x;
            const dy = out.y - center.y;
            const dz = out.z - center.z;
            const distance = Math.hypot(dx, dy, dz);
            const reach = physics.castStatic(
                center.x,
                center.y + 0.2,
                center.z,
                dx / distance,
                dy / distance,
                dz / distance,
                distance,
            );
            if (reach < distance - 0.05) continue; // 途中に壁がある
            out.y = physics.surfaceHeight(out.x, out.z);
            return;
        }
        // どこも塞がっていたら車の真上へ出す
        out.copy(center);
        out.y += CHASSIS_HALF.y + 0.6;
    };

    const enterVehicle = (): void => {
        mode = 'drive';
        vehicle.setOccupied(true);
        character.setActive(false);
        // 車の子にして運転席へ座らせる（車体のロール・ピッチもそのまま受ける）。
        // キャラは -z 正面・車体は +z 正面なので 180°回す
        car.group.add(player.group);
        player.group.position.copy(DRIVER_SEAT);
        player.group.rotation.set(0, Math.PI, 0);
        player.setRiding(true);
        input.setMode('drive');
        follow.snap();
        sinceLook = 0;
    };

    const exitVehicle = (): void => {
        exitPosition(spot);
        mode = 'walk';
        vehicle.setOccupied(false);
        character.teleport(
            spot.x,
            spot.y + CHARACTER_CENTER_OFFSET + 0.05,
            spot.z,
            vehicle.viewYaw,
        );
        character.setActive(true);
        scene.add(player.group);
        player.group.rotation.set(0, 0, 0);
        player.setRiding(false);
        input.setMode('walk');
        follow.snap();
    };

    /** 徒歩の移動倍率を掛け直す（騎乗中はイノシシのぶんを上乗せする） */
    const applySpeedScale = (): void => {
        character.setSpeedScale(speedScale * (mode === 'boar' ? BOAR_SPEED_SCALE : 1));
    };

    // --- ヘリコプター（契約12） ---

    /** いちばん近い機体（乗れる距離にあるもの）。無ければ -1 */
    const nearestHeli = (): number => {
        let best = -1;
        let bestDistance = HELI_ENTER_RADIUS;
        // 発着地点を与えられていない機体（片付け済み）は乗車の対象にしない
        for (let i = 0; i < Math.min(helis.length, helipads.length); i++) {
            const craft = helis[i].craft;
            if (craft.crashed) continue;
            const distance = Math.hypot(
                craft.position.x - character.current.x,
                craft.position.z - character.current.z,
            );
            if (distance > bestDistance) continue;
            if (Math.abs(craft.position.y - (character.current.y - CHARACTER_CENTER_OFFSET)) > 4) continue;
            best = i;
            bestDistance = distance;
        }
        return best;
    };

    const enterHeli = (index: number): void => {
        const entry = helis[index];
        heliIndex = index;
        mode = 'heli';
        character.setActive(false);
        jumpPending = -1;
        // 機体の子にして操縦席へ座らせる（機体のバンク・ピッチもそのまま受ける）
        entry.avatar.group.add(player.group);
        player.group.position.copy(HELI_SEAT);
        player.group.rotation.set(0, Math.PI, 0);
        player.setRiding(true);
        input.setMode('heli');
        follow.yaw = entry.craft.viewYaw;
        // 少し見下ろす角度から始める（真横だと機体の中にカメラが入る）
        follow.pitch = Math.min(follow.pitch, -0.18);
        follow.snap();
        sinceLook = 0;
    };

    const exitHeli = (): void => {
        if (heliIndex < 0) return;
        const entry = helis[heliIndex];
        const craft = entry.craft;
        // 機体の右横へ降ろす（足場が無ければ機体の真下）
        const side = 2.6;
        const x = craft.position.x + Math.cos(craft.yaw) * side;
        const z = craft.position.z - Math.sin(craft.yaw) * side;
        heliIndex = -1;
        mode = 'walk';
        scene.add(player.group);
        player.group.rotation.set(0, 0, 0);
        player.setRiding(false);
        character.teleport(
            x,
            physics.surfaceHeight(x, z) + CHARACTER_CENTER_OFFSET + 0.05,
            z,
            craft.viewYaw,
        );
        character.setActive(true);
        input.setMode('walk');
        applySpeedScale();
        follow.snap();
    };

    // --- イノシシ騎乗（契約12。徒歩の物理のまま速度と登坂力だけ変える・E85） ---

    const mountBoar = (seconds: number): void => {
        if (mode === 'sky') return;
        if (mode === 'drive') exitVehicle();
        if (mode === 'heli') exitHeli();
        if (!boar) {
            boar = createBoarAvatar(quality);
            scene.add(boar.group);
        }
        boar.group.visible = true;
        mode = 'boar';
        boarLeft = Math.max(boarLeft, seconds);
        character.setSlopePower(true);
        player.setRiding(true);
        input.setMode('boar');
        applySpeedScale();
        follow.snap();
    };

    const dismountBoar = (): void => {
        if (mode !== 'boar') return;
        mode = 'walk';
        boarLeft = 0;
        if (boar) boar.group.visible = false;
        character.setSlopePower(slopePowerWanted);
        player.setRiding(false);
        input.setMode('walk');
        applySpeedScale();
        follow.snap();
    };

    /**
     * スーパーマンモードの出入り（デバッグ用）。物理から切り離して自前で飛ばし、
     * 地形とだけ当たる。同期は座標のまま（遠隔からは浮いて見える・契約06 追記3）
     */
    const startFlying = (): void => {
        flying = true;
        flyPos.copy(character.current);
        flyPos.y += 1.2 - CHARACTER_CENTER_OFFSET;
        flyVel.set(0, 0, 0);
        flyYaw = character.yaw;
        character.setActive(false);
        jumpPending = -1;
    };

    const stopFlying = (groundY: number): void => {
        flying = false;
        character.teleport(flyPos.x, groundY + CHARACTER_CENTER_OFFSET + 0.05, flyPos.z, flyYaw);
        character.setActive(true);
        player.setFlying(false, 0);
    };

    /**
     * 降下の開始／終了（契約10）。開始時は物理キャラを止め、着地したらその場へ戻す。
     * 着地の高さは足場（道路・建物の上面も拾う）から取るので屋根の上にも降りられる（E66）
     */
    const startSky = (): void => {
        if (mode === 'sky') return;
        if (flying) stopFlying(world.getElevationAt(flyPos.x, flyPos.z));
        if (mode === 'drive') exitVehicle();
        mode = 'sky';
        character.setActive(false);
        jumpPending = -1;
        input.setMode('walk');
        follow.pitch = Math.min(follow.pitch, SKY_PITCH);
        follow.snap();
    };

    const endSky = (): void => {
        if (mode !== 'sky') return;
        const { x, z } = skydive.position;
        character.teleport(
            x,
            physics.surfaceHeight(x, z) + CHARACTER_CENTER_OFFSET + 0.05,
            z,
            skydive.yaw,
        );
        character.setActive(true);
        skydive.stop();
        mode = 'walk';
        player.setFlying(false, 0);
        follow.snap();
    };

    /**
     * 建物のフットプリントの外へ逃がす（ユーザー報告 2026-08-13）。
     *
     * どこでもドアの着地補正も R の復帰も、建物の中を指してしまうと壁コライダーに
     * 囲まれて出られなくなる。占有グリッドを外へ向かって舐めて、いちばん近い
     * 「建物でない」地点へずらす。**すべてのテレポートが placeAt を通る**ので、
     * ここ1か所で ドア・warpTo・R の全部が救われる
     */
    const escapeSpot = { x: 0, z: 0 };
    const escapeBuildings = (x: number, z: number): { x: number; z: number } => {
        escapeSpot.x = x;
        escapeSpot.z = z;
        if ((world.occupancy.at(x, z) & OCC_BUILDING) === 0) return escapeSpot;
        for (const radius of ESCAPE_RINGS) {
            for (let i = 0; i < ESCAPE_STEPS; i++) {
                const angle = (i / ESCAPE_STEPS) * Math.PI * 2;
                const cx = x + Math.cos(angle) * radius;
                const cz = z + Math.sin(angle) * radius;
                if ((world.occupancy.at(cx, cz) & OCC_BUILDING) !== 0) continue;
                escapeSpot.x = cx;
                escapeSpot.z = cz;
                return escapeSpot;
            }
        }
        // 逃げ場が見つからないほど建物が密なら諦めて元の座標。
        // 屋根コライダーが入ったので、少なくとも上から出られる
        return escapeSpot;
    };

    /** 指定座標の地表へ立たせる（デバッグ移動の共通処理）。乗車・飛行・降下中でも徒歩へ戻す */
    const placeAt = (rawX: number, rawZ: number, yaw: number): void => {
        if (mode === 'sky') endSky();
        if (flying) stopFlying(world.getElevationAt(flyPos.x, flyPos.z));
        if (mode === 'drive') exitVehicle();
        if (mode === 'heli') exitHeli();
        if (mode === 'boar') dismountBoar();
        const spot = escapeBuildings(rawX, rawZ);
        const x = spot.x;
        const z = spot.z;
        character.teleport(
            x,
            physics.surfaceHeight(x, z) + CHARACTER_CENTER_OFFSET + 0.05,
            z,
            yaw,
        );
        follow.yaw = yaw;
        follow.snap();
    };

    const respawn = (): void => {
        // デバッグの行き先があるあいだは R もそこへ戻す（?matchgoto の「R で再実行」）
        if (warped) {
            placeAt(warpX, warpZ, warpYaw);
            return;
        }
        if (mode === 'sky') endSky();
        if (flying) stopFlying(world.getElevationAt(flyPos.x, flyPos.z));
        if (mode === 'heli' && heliIndex >= 0) {
            // 操縦中の R は機体の立て直し（車の姿勢リセットと同じ扱い・E84）
            const craft = helis[heliIndex].craft;
            craft.place(
                craft.position.x,
                physics.surfaceHeight(craft.position.x, craft.position.z),
                craft.position.z,
                craft.yaw,
            );
            follow.snap();
            return;
        }
        if (mode === 'boar') {
            dismountBoar();
        }
        if (mode === 'drive') {
            // 乗車中は姿勢を立て直すだけ（エリア外へ落ちていたら道路へ戻す）
            const edge = AREA_HALF - 10;
            const inside = Math.abs(vehicle.position.x) < edge && Math.abs(vehicle.position.z) < edge;
            const x = inside ? vehicle.position.x : carX;
            const z = inside ? vehicle.position.z : carZ;
            vehicle.reset(
                x,
                physics.surfaceHeight(x, z) + VEHICLE_GROUND_OFFSET + 0.15,
                z,
                inside ? vehicle.bodyYaw : Math.atan2(spawn.dirX, spawn.dirZ),
            );
        } else {
            character.teleport(
                spawn.x,
                physics.surfaceHeight(spawn.x, spawn.z) + CHARACTER_CENTER_OFFSET + 0.05,
                spawn.z,
                spawnYaw,
            );
        }
        follow.snap();
    };

    return {
        state,
        physics,
        sky: {
            get state() {
                return skydive.state;
            },
            ride(x, y, z, seatYaw) {
                // 搭乗した瞬間だけカメラを機首方向へ向ける（そうしないと胴体の中に入る）
                const boarding = mode !== 'sky';
                startSky();
                if (boarding) follow.yaw = seatYaw;
                skydive.ride(x, y, z, seatYaw);
            },
            leave() {
                skydive.leave();
            },
            launch(height) {
                // 打ち上げ前の足元をそのまま真上へ持ち上げる。カメラは startSky が
                // 見下ろしへ寄せるので、上がりきった瞬間に着地点を探せる
                const x = state.x;
                const z = state.z;
                const yaw = state.yaw;
                startSky();
                follow.yaw = yaw;
                skydive.launch(x, physics.surfaceHeight(x, z) + height, z, yaw);
            },
            cancel() {
                endSky();
            },
        },
        update(dt) {
            input.beginFrame();
            const keys = input.state;

            if (keys.lookX !== 0 || keys.lookY !== 0) {
                follow.look(keys.lookX, keys.lookY, lookSpeed());
                sinceLook = 0;
            } else {
                sinceLook += dt;
            }
            if (keys.respawn) respawn();
            if (superman && keys.toggleFly && mode === 'walk') {
                if (flying) stopFlying(world.getElevationAt(flyPos.x, flyPos.z));
                else startFlying();
            }

            const sky = mode === 'sky';
            // 搭乗中は Space が「飛び降りる」になる（ジャンプの踏み切りは走らせない）
            if (sky && keys.jump && skydive.state === 'ride') skydive.leave();

            const onFoot = !flying && !sky && mode === 'walk';
            const near =
                onFoot &&
                Math.hypot(
                    vehicle.position.x - character.current.x,
                    vehicle.position.z - character.current.z,
                ) < ENTER_RADIUS &&
                Math.abs(vehicle.position.y - character.current.y) < 3;
            const nearHeliIndex = onFoot && !near ? nearestHeli() : -1;
            if (keys.interact && !sky) {
                if (mode === 'drive') exitVehicle();
                else if (mode === 'boar') dismountBoar();
                // 着陸していない機体からは降りられない（緩判定なので接地寸前でも降りられる）
                else if (mode === 'heli') {
                    if (heliIndex >= 0 && helis[heliIndex].craft.landed) exitHeli();
                } else if (near) enterVehicle();
                else if (nearHeliIndex >= 0) enterHeli(nearHeliIndex);
                // 車もヘリも無ければ、野生のイノシシに乗れるか外へ聞く（契約12）
                else if (onFoot) mountHook?.(character.current.x, character.current.z);
            }
            const canInteract =
                mode === 'drive' || mode === 'heli' || mode === 'boar' || near || nearHeliIndex >= 0;
            if (canInteract !== interactEnabled) {
                interactEnabled = canInteract;
                input.setInteractEnabled(canInteract);
            }

            // 入力をカメラ基準のワールド方向へ（毎ステップ同じ値を使う）
            follow.forward(forward);
            follow.right(right);
            moveDir
                .copy(forward)
                .multiplyScalar(keys.moveZ)
                .addScaledVector(right, keys.moveX);
            const driving = mode === 'drive';
            const piloting = mode === 'heli';
            const riding = mode === 'boar';

            // --- ジャンプ: 入力で沈み込み、少し溜めてから踏み切る（アンティシペーション） ---
            if (keys.jump && !driving && !piloting && !flying && !sky && character.grounded && jumpPending < 0) {
                jumpPending = JUMP_ANTICIPATION;
                player.anticipateJump();
            }
            if (jumpPending >= 0) {
                jumpPending -= dt;
                if (jumpPending < 0) character.jump();
            }

            // 後退はスティック/Sキーのみ。前進はアクセルボタン（= run）でも出せる
            vehicleInput.throttle = !driving
                ? 0
                : keys.moveZ < 0
                  ? keys.moveZ
                  : Math.max(keys.moveZ, keys.run ? 1 : 0);
            vehicleInput.steer = driving ? keys.moveX : 0;
            // 降車中は常にパーキングブレーキ
            vehicleInput.brake = driving ? keys.brake : true;

            physics.step(dt, (fixed) => {
                // 契約13-9: 既定が全力。Shift・「歩く」ボタンを押している間だけ遅くする。
                // 騎乗中は常に全力（イノシシの脚は歩かない）
                if (driving || piloting) character.fixedUpdate(fixed, 0, 0, false);
                else character.fixedUpdate(fixed, moveDir.x, moveDir.z, keys.run && !riding);
                vehicle.fixedUpdate(fixed, vehicleInput);
            });
            worldStats.physicsMs = physics.lastStepMs;

            character.interpolate(physics.alpha);
            vehicle.interpolate(physics.alpha);

            // --- スーパーマン飛行（物理を通さず自前で動かす。地形とだけ当たる） ---
            let flySpeed = 0;
            let flyPitch = 0;
            if (flying) {
                const cp = Math.cos(follow.pitch);
                flyDir.set(-Math.sin(follow.yaw) * cp, Math.sin(follow.pitch), -Math.cos(follow.yaw) * cp);
                flyWanted.set(0, 0, 0);
                flyWanted.addScaledVector(flyDir, keys.moveZ);
                flyWanted.addScaledVector(right, keys.moveX);
                flyWanted.y += (keys.brake ? 1 : 0) - (keys.down ? 1 : 0);
                const length = flyWanted.length();
                if (length > 1) flyWanted.multiplyScalar(1 / length);
                flyWanted.multiplyScalar(keys.run ? FLY_BOOST : FLY_SPEED);
                const factor = 1 - Math.exp(-FLY_ACCEL * dt);
                flyVel.x += (flyWanted.x - flyVel.x) * factor;
                flyVel.y += (flyWanted.y - flyVel.y) * factor;
                flyVel.z += (flyWanted.z - flyVel.z) * factor;
                flyPos.addScaledVector(flyVel, dt);

                const limit = AREA_HALF - 6;
                flyPos.x = Math.max(-limit, Math.min(limit, flyPos.x));
                flyPos.z = Math.max(-limit, Math.min(limit, flyPos.z));
                const groundY = world.getElevationAt(flyPos.x, flyPos.z);
                if (flyPos.y < groundY + FLY_CLEARANCE) {
                    flyPos.y = groundY + FLY_CLEARANCE;
                    // はっきり降りようとしたときだけ着地して通常へ戻す（低空飛行では戻さない）
                    if (flyVel.y < -2.5) stopFlying(groundY);
                    else flyVel.y = Math.max(0, flyVel.y);
                }
            }

            // --- ヘリコプター（契約12。アーケード飛行なので物理ステップの外で動かす） ---
            if (helis.length > 0) {
                heliInput.pitch = piloting ? keys.moveZ : 0;
                heliInput.roll = piloting ? keys.moveX : 0;
                // Space = 上昇 / C = 下降（徒歩のジャンプ・運転のブレーキと同じキー）
                heliInput.collective = piloting ? (keys.brake ? 1 : 0) - (keys.down ? 1 : 0) : 0;
                heliInput.boost = piloting && keys.run;
                for (let i = 0; i < helis.length; i++) {
                    heliInput.active = piloting && i === heliIndex;
                    helis[i].craft.update(dt, heliInput, physics.surfaceHeight, Math.max(0.35, speedScale));
                    const craft = helis[i].craft;
                    const group = helis[i].avatar.group;
                    group.position.copy(craft.position);
                    group.rotation.y = craft.yaw;
                    group.rotation.x = craft.pitch;
                    group.rotation.z = craft.roll;
                    helis[i].avatar.update(craft.lift, dt);
                }
                // 墜落から復帰した機体に乗っていたら、いったん降ろす（E84）
                if (piloting && heliIndex >= 0 && helis[heliIndex].craft.crashed) exitHeli();
            }

            // --- イノシシ騎乗の残り時間（実時間。90秒で山へ帰る・契約12） ---
            if (riding) {
                boarLeft -= dt;
                if (boarLeft <= 0) {
                    dismountBoar();
                    setHelp('');
                }
            }

            // --- 降下（契約10。搭乗中は ride() で与えられた座席姿勢に張り付く） ---
            if (sky && skydive.state !== 'ride') {
                const surface = physics.surfaceHeight(skydive.position.x, skydive.position.z);
                if (skydive.update(dt, moveDir.x, moveDir.z, surface)) endSky();
            }

            // --- 描画の更新 ---
            if (mode === 'sky') {
                player.setFlying(skydive.state !== 'ride', skydive.pitch);
                feet.copy(skydive.position);
                player.update(feet, skydive.yaw, 0, dt, true);
            } else if (flying) {
                flySpeed = Math.hypot(flyVel.x, flyVel.z);
                const target = flySpeed > 0.8 ? Math.atan2(-flyVel.x, -flyVel.z) : follow.yaw;
                const diff = Math.atan2(Math.sin(target - flyYaw), Math.cos(target - flyYaw));
                flyYaw += diff * Math.min(1, 8 * dt);
                flyPitch = flySpeed > 0.5 ? Math.atan2(flyVel.y, flySpeed) : 0;
                player.setFlying(true, flyPitch);
                feet.copy(flyPos);
                player.update(feet, flyYaw, Math.min(flySpeed, 6), dt, true);
            } else if (piloting) {
                // 人型は機体の子（座席）にいるので、位置は書かず姿勢だけ進める
                feet.copy(helis[heliIndex].craft.position);
                player.update(feet, helis[heliIndex].craft.yaw, 0, dt);
            } else {
                feet.copy(character.position);
                feet.y -= CHARACTER_CENTER_OFFSET;
                if (riding && boar) {
                    boar.group.position.copy(feet);
                    boar.group.rotation.y = character.yaw;
                    boar.update(character.speed, dt);
                    // 乗り手は背の上（乗車ポーズのまま、位置はこちらで置く・E85）
                    player.group.position.set(feet.x, feet.y + BOAR_SEAT.y, feet.z);
                    player.group.rotation.set(0, character.yaw, 0);
                }
                player.update(feet, character.yaw, character.speed, dt, !character.grounded);
            }
            car.group.position.copy(vehicle.position);
            car.group.quaternion.copy(vehicle.quaternion);
            let steering = 0;
            for (let i = 0; i < 4; i++) {
                const wheel = vehicle.wheelTransform(i, wheelOffset);
                car.setWheel(i, wheelOffset, wheel.steering, wheel.rotation);
                if (i === 0) steering = wheel.steering;
            }
            car.update(vehicle.speed, steering, vehicleInput.brake && driving, dt);

            // --- カメラ ---
            if (mode === 'sky') {
                // 60m/s で落ちるので、既定の追従では対象が画面外へ流れる
                follow.update(dt, feet, WALK_FOCUS, SKY_DISTANCE, SKY_FOLLOW_RATE);
            } else if (flying) {
                follow.update(dt, feet, WALK_FOCUS, FLY_DISTANCE);
            } else if (driving) {
                // 走っている間、視点操作が無ければ進行方向へ向き直す
                if (sinceLook > 0.5 && Math.abs(vehicle.speed) > 2.5) {
                    follow.alignTo(vehicle.viewYaw, 1.5, dt);
                }
                follow.update(dt, vehicle.position, 1, DRIVE_DISTANCE);
            } else if (piloting) {
                const craft = helis[heliIndex].craft;
                if (sinceLook > 0.5 && Math.abs(craft.speed) > 2.5) {
                    follow.alignTo(craft.viewYaw, 1.5, dt);
                }
                follow.update(dt, craft.position, HELI_FOCUS, HELI_DISTANCE);
            } else if (riding) {
                follow.update(dt, feet, WALK_FOCUS + BOAR_SEAT.y, BOAR_DISTANCE, WALK_FOLLOW_RATE);
            } else {
                follow.update(dt, feet, WALK_FOCUS, WALK_DISTANCE, WALK_FOLLOW_RATE);
            }

            // --- 落下・エリア外からの復帰（E19。降下・飛行中は空にいるのが正常なので見ない） ---
            if (!flying && mode !== 'sky' && mode !== 'heli') {
                const active = driving ? vehicle.position : character.position;
                if (active.y < world.getElevationAt(active.x, active.z) - FALL_LIMIT) respawn();
            }

            showHelp(
                mode === 'sky'
                    ? skydive.state === 'ride'
                        ? HELP_RIDE
                        : HELP_FALL
                    : flying
                      ? HELP_FLY
                      : driving
                        ? HELP_DRIVE
                        : piloting
                          ? HELP_HELI
                          : riding
                            ? `${HELP_BOAR}（残り ${Math.ceil(boarLeft)}秒）`
                            : (near
                                  ? HELP_WALK + HELP_NEAR_CAR
                                  : nearHeliIndex >= 0
                                    ? HELP_WALK + HELP_NEAR_HELI
                                    : HELP_WALK) + (superman ? HELP_SUPERMAN : ''),
            );

            // --- 外部から読む状態（飛行・降下中も座標だけで表現する。同期項目は増やさない） ---
            state.mode = mode;
            state.x = feet.x;
            state.y = feet.y;
            state.z = feet.z;
            state.yaw = mode === 'sky' ? skydive.yaw : flying ? flyYaw : character.yaw;
            state.speed = mode === 'sky' ? 0 : flying ? Math.min(flySpeed, 6) : character.speed;
            // 「全力で動いているか」。既定が全力なので Shift（歩く）を押していない間が true
            state.running = !keys.run;
            state.grounded = !flying && mode !== 'sky' && character.grounded;
            // 乗り物の座標（同期とマップが読む）。乗っている物によって中身が入れ替わる
            if (piloting) {
                const craft = helis[heliIndex].craft;
                state.vehicle.x = craft.position.x;
                state.vehicle.y = craft.position.y;
                state.vehicle.z = craft.position.z;
                state.vehicle.yaw = craft.yaw;
                state.vehicle.speed = craft.speed;
            } else if (riding) {
                state.vehicle.x = feet.x;
                state.vehicle.y = feet.y;
                state.vehicle.z = feet.z;
                state.vehicle.yaw = character.yaw;
                state.vehicle.speed = character.speed;
            } else {
                state.vehicle.x = vehicle.position.x;
                state.vehicle.y = vehicle.position.y;
                state.vehicle.z = vehicle.position.z;
                state.vehicle.yaw = vehicle.bodyYaw;
                state.vehicle.speed = vehicle.speed;
            }
            state.vehicle.occupied = driving || piloting || riding;

            input.endFrame();
        },
        setInputSuspended(value, reason = 'map') {
            if (value) suspendReasons.add(reason);
            else suspendReasons.delete(reason);
            input.setSuspended(suspendReasons.size > 0);
        },
        setSpeedScale(scale) {
            speedScale = scale;
            applySpeedScale();
        },
        knockback(dirX, dirZ, distance) {
            // 騎乗中も押し出しは効く（体当たりでイノシシごとよろける）
            if (mode === 'walk' || mode === 'boar') character.knockback(dirX, dirZ, distance);
        },
        setSlopePower(on) {
            slopePowerWanted = on;
            character.setSlopePower(on || mode === 'boar');
        },
        setHelipads(pads) {
            if (mode === 'heli') exitHeli();
            helipads.length = 0;
            for (const pad of pads) helipads.push({ x: pad.x, z: pad.z, yaw: pad.yaw });
            // 足りないぶんだけ機体を作る（自由散策では1機も作らない）
            while (helis.length < helipads.length) {
                const avatar = createHeliAvatar(quality);
                scene.add(avatar.group);
                helis.push({ craft: createHelicopter(), avatar });
            }
            for (let i = 0; i < helis.length; i++) {
                const pad = helipads[i];
                helis[i].avatar.group.visible = !!pad;
                if (!pad) continue;
                helis[i].craft.place(pad.x, physics.surfaceHeight(pad.x, pad.z), pad.z, pad.yaw);
            }
        },
        eachHeli(visit) {
            for (let i = 0; i < Math.min(helis.length, helipads.length); i++) {
                const craft = helis[i].craft;
                visit(craft.position.x, craft.position.z, craft.yaw, i === heliIndex);
            }
        },
        mountBoar(seconds) {
            mountBoar(seconds);
        },
        get boarSeconds() {
            return mode === 'boar' ? boarLeft : 0;
        },
        setMountHook(hook) {
            mountHook = hook;
        },
        dismountAll() {
            if (mode === 'heli') exitHeli();
            if (mode === 'boar') dismountBoar();
            for (let i = 0; i < helis.length; i++) {
                const pad = helipads[i];
                if (!pad) continue;
                helis[i].craft.place(pad.x, physics.surfaceHeight(pad.x, pad.z), pad.z, pad.yaw);
            }
        },
        teleportTo(x, z, yaw) {
            placeAt(x, z, yaw);
        },
        get viewYaw() {
            return follow.yaw;
        },
        warpTo(x, z, yaw) {
            warped = true;
            warpX = x;
            warpZ = z;
            warpYaw = yaw;
            placeAt(x, z, yaw);
        },
        dispose() {
            input.dispose();
            scene.remove(player.group, car.group);
            for (const entry of helis) scene.remove(entry.avatar.group);
            if (boar) scene.remove(boar.group);
            physics.world.free();
        },
    };
}
