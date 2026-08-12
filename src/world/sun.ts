/**
 * 太陽・大気・風の共有パラメータ。マテリアル側（葉の透過光・ハイトフォグ・空）が
 * 同じ uniform を参照できるよう、シーングラフから切り離してここに置く。
 *
 * 時刻はパラメータ化（?hour=）。値は決定的なので全クライアントで同じ空になる。
 */
import { Color, SRGBColorSpace, Vector2, Vector3 } from 'three/webgpu';
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
/** 夕景の度合い（0=高い太陽 / 1=地平近く）。太陽まわりのにじみの広さに使う */
export const duskNode = uniform(0);

/**
 * ベイクGIの効き。1 で焼いた値そのまま、0 で無効。
 * aoNode は環境光（間接）にだけ掛かるので、直射日光は削らない。
 */
export const GI_AO_STRENGTH = 0.78;
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
 * 時刻のカラースクリプト（昼白 → 夕橙 → 夜青）。
 *
 * キーは太陽高度の sin（1=天頂 / 0=地平線 / 負=地平線下）。時刻ではなく高度で引くので、
 * 季節や緯度を変えても「同じ高さの太陽なら同じ色」になる。
 *   sun     直射光の色 / sunI  直射光の強さ
 *   zenith  天頂の空 / horizon 太陽と反対側の地平 / haze 太陽側の地平（夕焼けのオレンジ）
 *   amb     環境光（空からの光）の強さ
 * 色は **sRGB** で置いてある（絵として読みやすいため）。Color.setRGB で線形へ変換する。
 */
const SKY_SCRIPT = [
    { alt: 0.9, sun: [1, 0.98, 0.94], sunI: 3.6, zenith: [0.19, 0.39, 0.78], horizon: [0.72, 0.82, 0.95], haze: [0.86, 0.89, 0.96], amb: 1.05 },
    { alt: 0.55, sun: [1, 0.94, 0.84], sunI: 3.35, zenith: [0.17, 0.35, 0.74], horizon: [0.7, 0.79, 0.93], haze: [0.95, 0.88, 0.78], amb: 0.98 },
    { alt: 0.3, sun: [1, 0.8, 0.54], sunI: 2.75, zenith: [0.13, 0.27, 0.64], horizon: [0.64, 0.68, 0.84], haze: [1, 0.76, 0.48], amb: 0.82 },
    { alt: 0.15, sun: [1, 0.63, 0.3], sunI: 2.05, zenith: [0.1, 0.19, 0.54], horizon: [0.56, 0.56, 0.76], haze: [1, 0.58, 0.25], amb: 0.62 },
    { alt: 0.05, sun: [1, 0.45, 0.17], sunI: 1.2, zenith: [0.07, 0.12, 0.42], horizon: [0.45, 0.44, 0.66], haze: [1, 0.4, 0.14], amb: 0.44 },
    { alt: -0.04, sun: [0.86, 0.42, 0.3], sunI: 0.38, zenith: [0.05, 0.07, 0.27], horizon: [0.26, 0.26, 0.43], haze: [0.72, 0.28, 0.14], amb: 0.24 },
    { alt: -0.14, sun: [0.55, 0.66, 1], sunI: 0.16, zenith: [0.02, 0.03, 0.08], horizon: [0.09, 0.1, 0.16], haze: [0.11, 0.12, 0.19], amb: 0.1 },
] as const;

/** カラースクリプトを太陽高度で引く。区間の外は端の値で止める */
function gradeAt(sinAlt: number): {
    sun: number[];
    sunI: number;
    zenith: number[];
    horizon: number[];
    haze: number[];
    amb: number;
} {
    let i = 0;
    while (i < SKY_SCRIPT.length - 2 && sinAlt < SKY_SCRIPT[i + 1].alt) i++;
    const a = SKY_SCRIPT[i];
    const b = SKY_SCRIPT[i + 1];
    const t = Math.max(0, Math.min(1, (a.alt - sinAlt) / (a.alt - b.alt)));
    const mix3 = (p: readonly number[], q: readonly number[]): number[] => [
        p[0] + (q[0] - p[0]) * t,
        p[1] + (q[1] - p[1]) * t,
        p[2] + (q[2] - p[2]) * t,
    ];
    return {
        sun: mix3(a.sun, b.sun),
        sunI: a.sunI + (b.sunI - a.sunI) * t,
        zenith: mix3(a.zenith, b.zenith),
        horizon: mix3(a.horizon, b.horizon),
        haze: mix3(a.haze, b.haze),
        amb: a.amb + (b.amb - a.amb) * t,
    };
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
    const day = smoothstep01(-0.09, 0.06, sinAlt);
    const night = 1 - day;
    lighting.night = night;
    // dusk = 夕景の度合い。太陽が低いほど 1（空のにじみを広く暖かくする）
    const dusk = smoothstep01(0.58, 0.04, sinAlt);

    const g = gradeAt(sinAlt);
    sunColor.setRGB(g.sun[0], g.sun[1], g.sun[2], SRGBColorSpace);
    lighting.sun = g.sunI;
    skyZenith.setRGB(g.zenith[0], g.zenith[1], g.zenith[2], SRGBColorSpace);
    skyHorizon.setRGB(g.horizon[0], g.horizon[1], g.horizon[2], SRGBColorSpace);
    hazeSunColor.setRGB(g.haze[0], g.haze[1], g.haze[2], SRGBColorSpace);
    // 地平線より下（空ドームの下半分）は地表のかすみ。夕方は路面の照り返しで暖かい
    groundHaze.copy(skyHorizon).lerp(hazeSunColor, 0.35).multiplyScalar(0.72);
    // 距離フォグは「空と同じ色」でないと山並みが浮く。太陽側の暖かさは
    // materials 側（hazeSunNode）が視線方向で足す
    fogColor.copy(skyHorizon).lerp(skyZenith, 0.22);

    // --- ベイクGI の変調色（追記1） ---
    // 環境光は空の色そのもの（天頂寄り）。強さはカラースクリプトが持つ
    ambientColor.copy(skyZenith).lerp(skyHorizon, 0.55);
    lighting.ambient = g.amb;
    // 1バウンスは「日の当たった地面・壁の色」。夕方はオレンジの照り返しになる
    bounceColor.copy(sunColor).multiplyScalar(0.6 * Math.pow(Math.max(0, sinAlt), 0.45) + 0.06);
    bounceColor.r += ambientColor.r * 0.4;
    bounceColor.g += ambientColor.g * 0.4;
    bounceColor.b += ambientColor.b * 0.4;
    bounceColor.multiply(GROUND_ALBEDO).multiplyScalar(0.3 + 0.7 * day);

    nightNode.value = night;
    duskNode.value = dusk;
}

/** 1バウンスの反射色（アスファルト・土・モルタルのならし） */
const GROUND_ALBEDO = new Color(1, 0.94, 0.82);

setSunHour(15);
