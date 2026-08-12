/**
 * 太陽・大気・風の共有パラメータ。マテリアル側（葉の透過光・ハイトフォグ・空）が
 * 同じ uniform を参照できるよう、シーングラフから切り離してここに置く。
 *
 * 時刻はパラメータ化（?hour=）。値は決定的なので全クライアントで同じ空になる。
 */
import { Color, Vector2, Vector3 } from 'three/webgpu';
import { uniform } from 'three/tsl';

/** 原点から太陽へ向かう単位ベクトル */
export const sunDirection = new Vector3(0.45, 0.78, 0.44).normalize();
export const sunColor = new Color(1, 0.96, 0.88);
export const skyZenith = new Color();
export const skyHorizon = new Color();
export const groundHaze = new Color();
export const fogColor = new Color();
/** 太陽側のヘイズ色（空気遠近感の暖かい抜け） */
export const hazeSunColor = new Color();

export const sunDirNode = uniform(sunDirection);
export const sunColorNode = uniform(sunColor);
export const fogColorNode = uniform(fogColor);
export const hazeSunNode = uniform(hazeSunColor);
export const skyZenithNode = uniform(skyZenith);
export const skyHorizonNode = uniform(skyHorizon);
export const groundHazeNode = uniform(groundHaze);

/** 風: xy = 水平方向、強さは別 uniform */
export const windDir = new Vector2(0.82, 0.57).normalize();
export const windDirNode = uniform(windDir);
export const windStrengthNode = uniform(1.0);

/** フォグの効き始め・効き切りとハイトフォグの減衰高度 */
export const fogRangeNode = uniform(new Vector2(500, 6800));
export const fogHeightNode = uniform(new Vector2(60, 0.0016));

const DEG = Math.PI / 180;
const LATITUDE = 34.740726 * DEG;
/** 5月中旬相当の赤緯。季節を固定して決定性を保つ */
const DECLINATION = 18.8 * DEG;

/**
 * 時刻[h]から太陽の向きと大気の色を決める。
 * 正確な天文計算ではなく「日本の昼下がりに見える空」を狙った近似。
 */
export function setSunHour(hour: number): void {
    const H = (hour - 12) * 15 * DEG;
    const sinAlt = Math.min(
        1,
        Math.max(
            -1,
            Math.sin(LATITUDE) * Math.sin(DECLINATION) +
                Math.cos(LATITUDE) * Math.cos(DECLINATION) * Math.cos(H),
        ),
    );
    const alt = Math.asin(sinAlt);
    const az = Math.atan2(
        Math.sin(H),
        Math.cos(H) * Math.sin(LATITUDE) - Math.tan(DECLINATION) * Math.cos(LATITUDE),
    );
    // 南 = +z / 西 = -x（x が東・-z が北）
    const cosAlt = Math.cos(alt);
    sunDirection.set(-Math.sin(az) * cosAlt, Math.max(0.02, sinAlt), Math.cos(az) * cosAlt).normalize();

    // 太陽高度が低いほど赤く弱く
    const t = Math.max(0, Math.min(1, sunDirection.y));
    const warm = Math.pow(1 - t, 2.2);
    sunColor.setRGB(1, 0.97 - warm * 0.22, 0.9 - warm * 0.44).multiplyScalar(1);
    skyZenith.setHSL(0.6, 0.55 - warm * 0.2, 0.34 + t * 0.12);
    skyHorizon.setHSL(0.58 - warm * 0.08, 0.34 + warm * 0.2, 0.74 - warm * 0.1);
    groundHaze.setHSL(0.09, 0.14 + warm * 0.1, 0.5 + t * 0.1);
    fogColor.copy(skyHorizon).lerp(skyZenith, 0.18);
    hazeSunColor.copy(skyHorizon).lerp(sunColor, 0.45 + warm * 0.2);
}

setSunHour(15);
