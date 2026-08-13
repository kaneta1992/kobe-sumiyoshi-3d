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
import type { World } from '../world';
import { DRIVER_SEAT, createCarAvatar, createPlayerAvatar } from './avatar';
import { CHARACTER_CENTER_OFFSET, createCharacter } from './character';
import { createFollowCamera } from './follow-camera';
import { createInput, LOOK_SPEED } from './input';
import { createPhysics, type Physics } from './physics';
import { createSkydive, type SkyState } from './skydive';
import { CHASSIS_HALF, VEHICLE_GROUND_OFFSET, createVehicle } from './vehicle';

export { initPhysics } from './physics';

/** 乗車できる距離[m]（車体中心から。全長4.1mの車なのでバンパーから約1m） */
const ENTER_RADIUS = 5;
/** 地形からこれだけ下に落ちたらリスポーン[m]（E19） */
const FALL_LIMIT = 20;
/** カメラの追従距離[m] */
const WALK_DISTANCE = 5;
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
    'WASD: 移動　Shift: 走る　Space: ジャンプ　ドラッグ/マウス: 視点　F: 乗車　R: 位置リセット';
const HELP_DRIVE = 'W/S: アクセル・後退　A/D: ハンドル　Space: ブレーキ　F: 降車　R: 姿勢リセット';
const HELP_FLY = '★スーパーマン　W: 前進　Shift: ブースト　Space/C: 上下　視点で方向転換　G: 解除';
const HELP_SUPERMAN = '　G: スーパーマン';
const HELP_NEAR_CAR = '　★ F で乗車';
const HELP_RIDE = '★輸送機　Space: 飛び降りる　ドラッグ/マウス: 視点';
const HELP_FALL = '★降下中　WASD: 移動　高度 110m で自動的に傘が開く';

/** 'sky' は輸送機からの降下中（契約10）。同期上は徒歩と同じ扱い */
export type PlayerMode = 'walk' | 'drive' | 'sky';

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
    vehicle: {
        x: number;
        y: number;
        z: number;
        /** 車体の yaw[rad] */
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
    /**
     * 空中での補助（契約11 のマント・傘）。sink = 落下速度の上限[m/s]、
     * speed = 水平の目標速度[m/s]。どちらも 0 で通常の落下に戻る
     */
    setAirAssist(sink: number, speed: number): void;
    /** 韋駄天の地下足袋（契約11）。急坂でも登れる・滑り落ちない */
    setSlopePower(on: boolean): void;
    /**
     * 指定座標の地表へ立たせる（契約11 のどこでもドア）。warpTo と違い
     * R の戻り先は変えない（通常フローのリスポーンは spawn のまま）
     */
    teleportTo(x: number, z: number, yaw: number): void;
    /** カメラの向き[rad]（HUD の方角矢印を画面基準へ直すのに使う・契約11） */
    readonly viewYaw: number;
    /** ジャンプを押しっぱなしか（マントの滑空・契約11） */
    readonly jumpHeld: boolean;
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

    let mode: PlayerMode = 'walk';
    let sinceLook = 10;
    let helpText = '';
    let interactEnabled = false;
    /** 入力を止めている理由（マップ / マッチのパネル）。1つでもあれば止める */
    const suspendReasons = new Set<string>();
    /** 踏み切りまでの残り時間[s]（負 = 待機なし） */
    let jumpPending = -1;
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

    /** 指定座標の地表へ立たせる（デバッグ移動の共通処理）。乗車・飛行・降下中でも徒歩へ戻す */
    const placeAt = (x: number, z: number, yaw: number): void => {
        if (mode === 'sky') endSky();
        if (flying) stopFlying(world.getElevationAt(flyPos.x, flyPos.z));
        if (mode === 'drive') exitVehicle();
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
            cancel() {
                endSky();
            },
        },
        update(dt) {
            input.beginFrame();
            const keys = input.state;

            if (keys.lookX !== 0 || keys.lookY !== 0) {
                follow.look(keys.lookX, keys.lookY, LOOK_SPEED);
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

            const near =
                !flying &&
                !sky &&
                mode === 'walk' &&
                Math.hypot(
                    vehicle.position.x - character.current.x,
                    vehicle.position.z - character.current.z,
                ) < ENTER_RADIUS &&
                Math.abs(vehicle.position.y - character.current.y) < 3;
            if (keys.interact && !sky) {
                if (mode === 'drive') exitVehicle();
                else if (near) enterVehicle();
            }
            const canInteract = mode === 'drive' || near;
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

            // --- ジャンプ: 入力で沈み込み、少し溜めてから踏み切る（アンティシペーション） ---
            if (keys.jump && !driving && !flying && !sky && character.grounded && jumpPending < 0) {
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
                if (driving) character.fixedUpdate(fixed, 0, 0, false);
                else character.fixedUpdate(fixed, moveDir.x, moveDir.z, keys.run);
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
            } else {
                feet.copy(character.position);
                feet.y -= CHARACTER_CENTER_OFFSET;
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
            } else {
                follow.update(dt, feet, WALK_FOCUS, WALK_DISTANCE);
            }

            // --- 落下・エリア外からの復帰（E19。降下中は空にいるのが正常なので見ない） ---
            if (!flying && mode !== 'sky') {
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
                        : (near ? HELP_WALK + HELP_NEAR_CAR : HELP_WALK) +
                          (superman ? HELP_SUPERMAN : ''),
            );

            // --- 外部から読む状態（飛行・降下中も座標だけで表現する。同期項目は増やさない） ---
            state.mode = mode;
            state.x = feet.x;
            state.y = feet.y;
            state.z = feet.z;
            state.yaw = mode === 'sky' ? skydive.yaw : flying ? flyYaw : character.yaw;
            state.speed = mode === 'sky' ? 0 : flying ? Math.min(flySpeed, 6) : character.speed;
            state.running = keys.run;
            state.grounded = !flying && mode !== 'sky' && character.grounded;
            state.vehicle.x = vehicle.position.x;
            state.vehicle.y = vehicle.position.y;
            state.vehicle.z = vehicle.position.z;
            state.vehicle.yaw = vehicle.bodyYaw;
            state.vehicle.speed = vehicle.speed;
            state.vehicle.occupied = driving;

            input.endFrame();
        },
        setInputSuspended(value, reason = 'map') {
            if (value) suspendReasons.add(reason);
            else suspendReasons.delete(reason);
            input.setSuspended(suspendReasons.size > 0);
        },
        setSpeedScale(scale) {
            character.setSpeedScale(scale);
        },
        knockback(dirX, dirZ, distance) {
            if (mode === 'walk') character.knockback(dirX, dirZ, distance);
        },
        setAirAssist(sink, speed) {
            character.setAirAssist(sink, speed);
        },
        setSlopePower(on) {
            character.setSlopePower(on);
        },
        teleportTo(x, z, yaw) {
            placeAt(x, z, yaw);
        },
        get viewYaw() {
            return follow.yaw;
        },
        get jumpHeld() {
            return input.state.jumpHeld;
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
            physics.world.free();
        },
    };
}
