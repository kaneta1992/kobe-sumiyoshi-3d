/** src/shared/bvmap-roads.js の型。実体を変えたらこちらも直すこと。 */

import type { SharedPoint2 } from './bvmap-buildings.js';

export interface SharedRoadLine {
    points: SharedPoint2[];
    /** 幅員[m]（vt_rnkwidth / vt_width 由来） */
    width: number;
    /** 橋・高架部（vt_code 2703 / 2713 など） */
    bridge: boolean;
    code: number;
}

export declare function isBridgeCode(code: number): boolean;
export declare function parseWidth(props: Record<string, string | number | boolean>): number;
export declare function readRoadLines(buffer: ArrayBuffer, tx: number, ty: number): SharedRoadLine[];
