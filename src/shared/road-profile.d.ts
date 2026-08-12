/** src/shared/road-profile.js の型。実体を変えたらこちらも直すこと。 */

import type { SharedPoint2 } from './bvmap-buildings.js';

export declare const PROFILE_STEP: number;

/** 縦断プロファイル付きの道路1本。points/dists/heights は同じ長さ */
export interface RoadPath {
    points: SharedPoint2[];
    /** 始点からの弧長[m] */
    dists: Float64Array;
    /** 路面（地表）標高[m] */
    heights: Float64Array;
    /** 幅員[m]（1.2〜30 にクランプ済み） */
    width: number;
    bridge: boolean;
    /** 全長[m] */
    length: number;
}

export interface RoadProfileStats {
    paths: number;
    vertices: number;
    junctions: number;
    bridgePaths: number;
    roadLength: number;
    bridgeLength: number;
    meanDeviation: number;
    p90Deviation: number;
    p99Deviation: number;
    maxDeviation: number;
}

export declare function resamplePolyline(points: readonly SharedPoint2[]): SharedPoint2[];

export declare function buildRoadProfiles(
    lines: readonly { points: readonly SharedPoint2[]; width: number; bridge: boolean }[],
    sampleElevation: (x: number, z: number) => number,
    /** pinned = 通常部は地形標高そのまま（カービング済み地形を持つクライアント側） */
    options?: { pinned?: boolean },
): { paths: RoadPath[]; stats: RoadProfileStats };

export declare function profileHeightAt(
    path: { dists: Float64Array; heights: Float64Array },
    d: number,
): number;
