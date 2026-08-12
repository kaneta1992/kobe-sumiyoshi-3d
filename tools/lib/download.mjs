/**
 * 図郭ZIPのダウンロード（1個 250〜290MB・全8個で約2.2GB）。
 *
 * 前提: 1コマンドあたりの実行時間に上限がある環境で回す（契約02 E3）ので、
 * 途中で切られても進捗を捨てないこと。そのため
 *   - `.part` に落として curl -C - でレジューム
 *   - 完了サイズが Content-Length と一致したときだけ本名にリネーム
 *   - 本名のファイルがあれば何もしない（再実行は即座に終わる）
 * とし、何度呼んでも安全にする。
 */
import { spawn } from 'node:child_process';
import { existsSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { ZIP_DIR } from './paths.mjs';

/** 同時ダウンロード数 */
const PARALLEL = 3;

/** @param {string} url @returns {Promise<number>} Content-Length（不明なら -1） */
async function remoteSize(url) {
    const res = await fetch(url, { method: 'HEAD' });
    if (!res.ok) throw new Error(`HEAD ${res.status} ${url}`);
    const len = Number(res.headers.get('content-length'));
    return Number.isFinite(len) && len > 0 ? len : -1;
}

function run(cmd, args) {
    return new Promise((resolve) => {
        const p = spawn(cmd, args, { stdio: ['ignore', 'inherit', 'inherit'] });
        p.on('error', () => resolve(-1));
        p.on('close', (code) => resolve(code ?? -1));
    });
}

/** @param {import('./sheets.mjs').Sheet} sheet @returns {string} */
export function zipPath(sheet) {
    return join(ZIP_DIR, `${sheet.name}.zip`);
}

/**
 * 1図郭を取得する。既に完全なら何もしない。
 * @param {import('./sheets.mjs').Sheet} sheet
 * @returns {Promise<{ downloaded: number }>} 今回転送したバイト数（概算）
 */
async function fetchSheetZip(sheet) {
    const final = zipPath(sheet);
    const part = `${final}.part`;
    const expected = await remoteSize(sheet.url);

    if (existsSync(final)) {
        const have = statSync(final).size;
        if (expected < 0 || have === expected) return { downloaded: 0 };
        // サイズが合わない = 前回の中断や配信側の更新。取り直す
        console.warn(`[dl] ${sheet.name}: サイズ不一致 ${have}/${expected} — 取り直します`);
        unlinkSync(final);
    }

    const before = existsSync(part) ? statSync(part).size : 0;
    if (before > 0 && expected > 0 && before > expected) {
        // 壊れた残骸。レジュームすると復旧できないので捨てる
        unlinkSync(part);
    }

    // -C - でレジューム、--retry で瞬断を吸収。進捗はそのまま親の stderr に出す
    const code = await run('curl', [
        '-L',
        '--fail',
        '-C',
        '-',
        '--retry',
        '5',
        '--retry-delay',
        '2',
        '--retry-connrefused',
        '-o',
        part,
        sheet.url,
    ]);
    const after = existsSync(part) ? statSync(part).size : 0;

    if (expected > 0 && after !== expected) {
        throw new Error(
            `[dl] ${sheet.name}: 未完了（${after}/${expected} bytes, curl exit ${code}）。` +
                'もう一度 build:assets を実行すれば続きから再開します',
        );
    }
    if (code !== 0 && expected < 0) {
        throw new Error(`[dl] ${sheet.name}: curl exit ${code}`);
    }
    renameSync(part, final);
    return { downloaded: after - before };
}

/**
 * 全図郭を取得する（既取得はスキップ）。
 * @param {import('./sheets.mjs').Sheet[]} sheets
 * @returns {Promise<{ downloadedBytes: number, totalBytes: number }>}
 */
export async function downloadSheets(sheets) {
    const pending = sheets.filter((s) => !existsSync(zipPath(s)));
    if (pending.length === 0) {
        const totalBytes = sheets.reduce((a, s) => a + statSync(zipPath(s)).size, 0);
        console.log(`[dl] 全 ${sheets.length} 図郭はキャッシュ済み（${mb(totalBytes)}）`);
        return { downloadedBytes: 0, totalBytes };
    }
    console.log(`[dl] ${pending.length}/${sheets.length} 図郭を取得します（.cache/zip/）`);

    let downloadedBytes = 0;
    let cursor = 0;
    const lanes = Array.from({ length: Math.min(PARALLEL, pending.length) }, async () => {
        for (;;) {
            const i = cursor++;
            if (i >= pending.length) return;
            const r = await fetchSheetZip(pending[i]);
            downloadedBytes += r.downloaded;
            console.log(`[dl] ${pending[i].name} 完了`);
        }
    });
    await Promise.all(lanes);

    const totalBytes = sheets.reduce((a, s) => a + statSync(zipPath(s)).size, 0);
    console.log(`[dl] 今回転送 ${mb(downloadedBytes)} / 総容量 ${mb(totalBytes)}`);
    return { downloadedBytes, totalBytes };
}

function mb(b) {
    return `${(b / 1024 / 1024).toFixed(0)}MB`;
}
