/**
 * 最小限の PNG エンコーダ（8bit RGB, 非インターレース）。
 *
 * 高さは 16bit の精度が要るが、ブラウザの canvas は 16bit PNG を 8bit に
 * 落として読み込むため、値を R=上位バイト / G=下位バイト に分けた 8bit RGB として
 * 書き出す。こうすればどのブラウザでもビット単位で元の値を復元できる。
 *
 * 行フィルタは None/Sub/Up/Paeth を1行ごとに試して絶対値和が最小のものを選ぶ
 * （地形は隣接値が近いので Up/Paeth がよく効き、生の 1/3 程度まで縮む）。
 */
import { deflateSync, inflateSync } from 'node:zlib';

const CRC_TABLE = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c;
    }
    return t;
})();

function crc32(buf) {
    let c = -1;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
}

function chunk(type, data) {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, 'ascii');
    data.copy(out, 8);
    out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
}

function paeth(a, b, c) {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    if (pa <= pb && pa <= pc) return a;
    return pb <= pc ? b : c;
}

/**
 * @param {Uint8Array} rgb 幅*高さ*3 バイトの RGB データ
 * @param {number} width @param {number} height
 * @returns {Buffer} PNG バイト列
 */
export function encodePngRgb(rgb, width, height) {
    const BPP = 3;
    const stride = width * BPP;
    const raw = Buffer.alloc((stride + 1) * height);
    const cand = [Buffer.alloc(stride), Buffer.alloc(stride), Buffer.alloc(stride), Buffer.alloc(stride)];
    let prev = new Uint8Array(stride);

    for (let y = 0; y < height; y++) {
        const row = rgb.subarray(y * stride, (y + 1) * stride);
        const sums = [0, 0, 0, 0];
        for (let i = 0; i < stride; i++) {
            const a = i >= BPP ? row[i - BPP] : 0;
            const b = prev[i];
            const c = i >= BPP ? prev[i - BPP] : 0;
            const v0 = row[i];
            const v1 = (row[i] - a) & 0xff;
            const v2 = (row[i] - b) & 0xff;
            const v3 = (row[i] - paeth(a, b, c)) & 0xff;
            cand[0][i] = v0;
            cand[1][i] = v1;
            cand[2][i] = v2;
            cand[3][i] = v3;
            // 符号付きとして小さいものほど圧縮が効く
            sums[0] += v0 < 128 ? v0 : 256 - v0;
            sums[1] += v1 < 128 ? v1 : 256 - v1;
            sums[2] += v2 < 128 ? v2 : 256 - v2;
            sums[3] += v3 < 128 ? v3 : 256 - v3;
        }
        let best = 0;
        for (let f = 1; f < 4; f++) if (sums[f] < sums[best]) best = f;
        // cand の並びは None/Sub/Up/Paeth。PNG の Paeth は 3 ではなく 4
        raw[y * (stride + 1)] = best === 3 ? 4 : best;
        cand[best].copy(raw, y * (stride + 1) + 1);
        prev = row;
    }

    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8; // bit depth
    ihdr[9] = 2; // color type: truecolor RGB
    ihdr[10] = 0;
    ihdr[11] = 0;
    ihdr[12] = 0;

    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr),
        chunk('IDAT', deflateSync(raw, { level: 9 })),
        chunk('IEND', Buffer.alloc(0)),
    ]);
}

/**
 * PNG デコード（8bit・非インターレース・カラータイプ 0/2/4/6 のみ）。
 * 地理院標高タイルを Node 側で読むためだけのもの。想定外の形式は例外にする。
 *
 * @param {Buffer} png
 * @returns {{ width: number, height: number, channels: number, data: Uint8Array }}
 */
export function decodePng(png) {
    if (png.readUInt32BE(0) !== 0x89504e47) throw new Error('PNG シグネチャが不正です');
    let off = 8;
    let width = 0;
    let height = 0;
    let channels = 0;
    const idat = [];
    while (off < png.length) {
        const len = png.readUInt32BE(off);
        const type = png.toString('ascii', off + 4, off + 8);
        const body = png.subarray(off + 8, off + 8 + len);
        if (type === 'IHDR') {
            width = body.readUInt32BE(0);
            height = body.readUInt32BE(4);
            const depth = body[8];
            const color = body[9];
            if (depth !== 8) throw new Error(`未対応のビット深度: ${depth}`);
            if (body[12] !== 0) throw new Error('インターレース PNG は未対応です');
            channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[color];
            if (!channels) throw new Error(`未対応のカラータイプ: ${color}`);
        } else if (type === 'IDAT') {
            idat.push(body);
        } else if (type === 'IEND') {
            break;
        }
        off += 12 + len;
    }
    const raw = inflateSync(Buffer.concat(idat));
    const stride = width * channels;
    const out = new Uint8Array(stride * height);
    let prevRow = new Uint8Array(stride);
    for (let y = 0; y < height; y++) {
        const filter = raw[y * (stride + 1)];
        const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
        const row = out.subarray(y * stride, (y + 1) * stride);
        for (let i = 0; i < stride; i++) {
            const a = i >= channels ? row[i - channels] : 0;
            const b = prevRow[i];
            const c = i >= channels ? prevRow[i - channels] : 0;
            let v = src[i];
            if (filter === 1) v += a;
            else if (filter === 2) v += b;
            else if (filter === 3) v += (a + b) >> 1;
            else if (filter === 4) v += paeth(a, b, c);
            else if (filter !== 0) throw new Error(`未対応の行フィルタ: ${filter}`);
            row[i] = v & 0xff;
        }
        prevRow = row;
    }
    return { width, height, channels, data: out };
}
