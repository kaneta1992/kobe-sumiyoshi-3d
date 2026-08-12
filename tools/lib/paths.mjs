/** 前処理の入出力パス。すべてリポジトリルート基準の絶対パスで返す。 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';

export const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

/** 巨大な中間物置き場。.gitignore 済みでコミットしない */
export const CACHE_DIR = join(ROOT, '.cache');
export const ZIP_DIR = join(CACHE_DIR, 'zip');
export const GRID_DIR = join(CACHE_DIR, 'grid');

/** 配信するアセット（コミット対象） */
export const OUT_DIR = join(ROOT, 'public', 'data');

export function ensureDirs() {
    for (const d of [CACHE_DIR, ZIP_DIR, GRID_DIR, OUT_DIR]) mkdirSync(d, { recursive: true });
}
