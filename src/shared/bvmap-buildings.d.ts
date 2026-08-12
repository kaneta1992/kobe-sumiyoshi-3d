/** src/shared/bvmap-buildings.js の型。実体を変えたらこちらも直すこと。 */

export interface SharedPoint2 {
    x: number;
    z: number;
}

export interface SharedBuildingShape {
    /** rings[0] が外周、rings[1..] が穴 */
    rings: SharedPoint2[][];
    code: number;
}

export declare function readBuildingShapes(
    buffer: ArrayBuffer,
    tx: number,
    ty: number,
): SharedBuildingShape[];
