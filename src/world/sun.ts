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

/**
 * ベイクGI（契約07 追記1）の変調色。
 *   ambientColor = 空からの環境光（ベイクの空可視率が掛かる先）
 *   bounceColor  = 地面・壁からの1バウンス光（ベイクのバウンス項に掛ける）
 * 時刻で変わるのはこの色だけ。ベイク値そのものは時刻に依存しない。
 */
export const ambientColor = new Color();
export const bounceColor = new Color();

/** 直射日光（夜は月光）の強さ・環境光の強さ。環境構築時に読む */
export const lighting = { sun: 3.2, ambient: 0.9, night: 0 };

export const sunDirNode = uniform(sunDirection);
export const sunColorNode = uniform(sunColor);
export const fogColorNode = uniform(fogColor);
export const hazeSunNode = uniform(hazeSunColor);
export const skyZenithNode = uniform(skyZenith);
export const skyHorizonNode = uniform(skyHorizon);
export const groundHazeNode = uniform(groundHaze);
export const ambientColorNode = uniform(ambientColor);
export const bounceColorNode = uniform(bounceColor);
/** 夜の度合い（0=昼 / 1=夜）。窓明かりなどの点灯に使う */
export const nightNode = uniform(0);

/**
 * ベイクGIの効き。1 で焼いた値そのまま、0 で無効。
 * aoNode は環境光（間接）にだけ掛かるので、直射日光は削らない。
 */
export const GI_AO_STRENGTH = 0.86;
/** バウンス項の格納スケール（tools/lib/gi.mjs の BOUNCE_SCALE と対応させること） */
export const GI_BOUNCE_SCALE = 0.3;

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

/** 0..1 に収めた smoothstep */
function smoothstep01(edge0: number, edge1: number, x: number): number {
    const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
    return t * t * (3 - 2 * t);
}

/**
 * 時刻[h]から太陽の向きと大気の色を決める。0〜24 の全域で成立する（E39）。
 * 正確な天文計算ではなく「日本の空に見える」ことを狙った近似。
 *
 * 夜は太陽を月光へ置き換える: 向きは太陽の方位を保ったまま高度だけ床で止め、
 * 色と強さを月明かりへ寄せる。向きが飛ばないので夕暮れから夜へ連続に繋がる。
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
    // 高度には床を設ける。夜も影の向きが決まり、地平の真横から照らさない
    sunDirection
        .set(-Math.sin(az) * cosAlt, Math.max(0.09, sinAlt), Math.cos(az) * cosAlt)
        .normalize();

    // day = 昼の度合い（薄明を挟んで 0↔1）/ night = その逆
    const day = smoothstep01(-0.075, 0.12, sinAlt);
    const night = 1 - day;
    lighting.night = night;
    // 太陽高度が低いほど赤く弱く
    const t = Math.max(0, Math.min(1, sinAlt));
    const warm = Math.pow(1 - t, 2.2);

    sunColor.setRGB(1, 0.97 - warm * 0.22, 0.9 - warm * 0.44);
    // 月光は青白く、色としては太陽の位置に置いたまま強さだけ落とす
    sunColor.lerp(MOON_COLOR, night);
    lighting.sun = 3.4 * (0.12 + 0.88 * Math.pow(day, 0.75)) * (1 - night * 0.955) + 0.09;

    skyZenith.setHSL(0.6, 0.55 - warm * 0.2, 0.34 + t * 0.12);
    skyHorizon.setHSL(0.58 - warm * 0.08, 0.34 + warm * 0.2, 0.74 - warm * 0.1);
    groundHaze.setHSL(0.09, 0.14 + warm * 0.1, 0.5 + t * 0.1);
    // 夜空: 真っ黒にはせず、街明かりの照り返しを地平に残す（E39）
    skyZenith.lerp(NIGHT_ZENITH, night);
    skyHorizon.lerp(NIGHT_HORIZON, night);
    groundHaze.lerp(NIGHT_HORIZON, night * 0.85);
    fogColor.copy(skyHorizon).lerp(skyZenith, 0.18);
    hazeSunColor.copy(skyHorizon).lerp(sunColor, 0.45 + warm * 0.2);

    // --- ベイクGI の変調色（追記1） ---
    // 環境光は空の色そのもの。強さは昼夜で大きく変える
    ambientColor.copy(skyHorizon).lerp(skyZenith, 0.4);
    lighting.ambient = 1.05 * (0.1 + 0.9 * day);
    // 1バウンスは「日の当たった地面・壁の色」。太陽が高いほど強く、夜はほぼ消える
    bounceColor.copy(sunColor).multiplyScalar(0.75 * Math.pow(t, 0.6) + 0.05);
    bounceColor.r += ambientColor.r * 0.35;
    bounceColor.g += ambientColor.g * 0.35;
    bounceColor.b += ambientColor.b * 0.35;
    bounceColor.multiply(GROUND_ALBEDO).multiplyScalar(0.25 + 0.75 * day);

    nightNode.value = night;
}

/** 月光の色（青白い） */
const MOON_COLOR = new Color(0.62, 0.72, 1);
/** 夜空（天頂 / 地平）。地平は市街地の照り返しでわずかに暖かい */
const NIGHT_ZENITH = new Color(0.012, 0.018, 0.038);
const NIGHT_HORIZON = new Color(0.055, 0.058, 0.075);
/** 1バウンスの反射色（アスファルト・土・モルタルのならし） */
const GROUND_ALBEDO = new Color(1, 0.94, 0.82);

setSunHour(15);
