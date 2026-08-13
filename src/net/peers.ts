/**
 * ピアの識別まわり（契約05 / 契約12）。色と BOT の仮想ピアIDだけを持つ小さな module。
 *
 * multiplayer.ts から切り出してあるのは、**ソロ（?solo）でも読めるようにする**ため。
 * multiplayer.ts は trystero を引き込むので、マッチ側から直接は参照しない。
 */
import { Color } from 'three/webgpu';

/** BOT 1体ぶんの状態（ホスト側の思考が毎フレーム書き換えて配る） */
export interface BotState {
    index: number;
    /** 移動状態（0 徒歩 / 1 運転 / 2 ヘリ / 3 イノシシ） */
    mode: number;
    x: number;
    y: number;
    z: number;
    yaw: number;
    speed: number;
}

/** ピアIDのハッシュで決まる色。乱数は使わないので、同じ相手はどのタブでも同じ色になる */
const hsl = new Color();
export function peerColor(id: string): number {
    let hash = 0x811c9dc5;
    for (let i = 0; i < id.length; i++) {
        hash ^= id.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    const hue = ((hash >>> 0) % 360) / 360;
    return hsl.setHSL(hue, 0.58, 0.5).getHex();
}

/** BOT の仮想ピアID（色・名前・裁定の識別子はすべてこれ） */
export function botPeerId(index: number): string {
    return `bot${index}`;
}

/** 仮想ピアIDか（ホスト選出・人数から外すために使う・E91） */
export function isBotId(id: string): boolean {
    return id.length === 4 && id.startsWith('bot') && id.charCodeAt(3) >= 48 && id.charCodeAt(3) <= 57;
}
