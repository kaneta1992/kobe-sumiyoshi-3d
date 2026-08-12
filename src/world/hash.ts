/**
 * 決定的ハッシュ。配置・色・形状の「ゆらぎ」はすべてここから取る。
 *
 * 実行時乱数は禁止（data-spec.md §4）: マルチプレイで全クライアントが
 * 同じ町を見る必要があるため、値は座標・インデックスから一意に決まること。
 */

/** 32bit 整数ハッシュ。同じ入力なら常に同じ値 */
export function hashInt(a: number, b: number, salt: number): number {
    let h = Math.imul((a | 0) ^ 0x9e3779b9, 0x85ebca6b);
    h = Math.imul(h ^ ((b | 0) + 0x165667b1), 0xc2b2ae35);
    h = Math.imul(h ^ (salt | 0), 0x27d4eb2f);
    h ^= h >>> 15;
    h = Math.imul(h, 0x2545f491);
    h ^= h >>> 16;
    return h >>> 0;
}

/** 座標由来の 0〜1。cm 単位で量子化するので浮動小数の誤差に強い */
export function hash01(x: number, z: number, salt = 0): number {
    return hashInt(Math.round(x * 100), Math.round(z * 100), salt) / 4294967296;
}

/** 整数インデックス由来の 0〜1 */
export function hashIndex01(i: number, salt = 0): number {
    return hashInt(i, 0x51ed270b, salt) / 4294967296;
}

/**
 * 方向ベクトル由来の 0〜1。非インデックスジオメトリで同じ位置の頂点が
 * 複数回現れても同じ値になる（= 変形しても割れない）。
 */
export function hashDir01(x: number, y: number, z: number, salt = 0): number {
    const a = hashInt(Math.round(x * 4096), Math.round(y * 4096), salt);
    return hashInt(a, Math.round(z * 4096), salt ^ 0x2f6b) / 4294967296;
}

/** -1〜1 の値を返す簡易版 */
export function hashSigned(x: number, z: number, salt = 0): number {
    return hash01(x, z, salt) * 2 - 1;
}
