import { Vector2, Vector3 } from 'three'

/** Rec. 709 relative luminance of linear RGB. */
const LUMINANCE_COEFFICIENTS = /*#__PURE__*/ new Vector3(0.2126, 0.7152, 0.0722)

/** Sizes of the precomputed lookup textures, in texels. Larger is smoother and slower to generate. */
export interface AtmosphereTextureSizes {
  /** Transmittance: (view zenith cosine, altitude). */
  transmittance: Vector2
  /** Ground irradiance: (sun zenith cosine, altitude). */
  irradiance: Vector2
  /** Scattering, 4D packed into 3D: altitude samples (texture depth). */
  scatteringAltitude: number
  /** Scattering: view zenith cosine samples (texture height). Half for rays that hit the ground. */
  scatteringViewZenith: number
  /** Scattering: sun zenith cosine samples (part of the texture width). */
  scatteringSunZenith: number
  /** Scattering: view-sun angle cosine samples (the other part of the texture width). */
  scatteringViewSunAngle: number
}

/** The writable data fields of `AtmosphereParameters`, all optional: what `AtmosphereParameters.create` takes. */
export type AtmosphereParametersOverrides = Partial<{
  // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
  [Key in keyof AtmosphereParameters as AtmosphereParameters[Key] extends Function ? never : Key]: AtmosphereParameters[Key]
}>

/**
 * The physical description of a planet's atmosphere, in SI units, for the Bruneton 2017 precomputed
 * scattering model. Spectral quantities are given at three wavelengths (red, green, blue; see
 * `wavelengthsNanometers`). The defaults describe Earth, following Bruneton's reference implementation.
 *
 * Density profiles are exponential for air molecules (Rayleigh) and aerosols (Mie), and a tent centred on
 * `ozoneCenterAltitudeMeters` for ozone, which absorbs and does not scatter.
 *
 * Create with `new AtmosphereParameters()` and assign fields, or `AtmosphereParameters.create({ ... })`.
 * Parameters are compiled into the shaders: change them before handing them to an `Atmosphere`.
 */
export class AtmosphereParameters {
  /** A new instance (of the subclass it is called on) with the given fields replaced. */
  static create<Instance extends AtmosphereParameters>(this: new () => Instance, overrides: AtmosphereParametersOverrides = {}): Instance {
    return Object.assign(new this(), overrides)
  }

  /** Distance from the planet centre to the ground, where the atmosphere starts. */
  bottomRadiusMeters = 6_360_000
  /** Distance from the planet centre to the top of the atmosphere. */
  topRadiusMeters = 6_420_000
  /**
   * Semi-axes of the planet's actual shape (WGS84 by default). The model's planet is a sphere; positions
   * are moved radially so that their height above this ellipsoid is their altitude in the model.
   */
  ellipsoidRadiiMeters = new Vector3(6_378_137, 6_378_137, 6_356_752.314245)

  /** Wavelengths that the three colour channels sample. Informational: the coefficients below are given at these. */
  wavelengthsNanometers = new Vector3(680, 550, 440)
  /** Solar spectral irradiance at the top of the atmosphere. */
  solarIrradianceWattsPerSquareMeterNanometer = new Vector3(1.474, 1.8504, 1.91198)
  /** Apparent angular radius of the sun disk. */
  sunAngularRadiusRadians = 0.004675

  /** Rayleigh scattering coefficient at the ground. */
  rayleighScatteringPerMeter = new Vector3(5.802e-6, 13.558e-6, 33.1e-6)
  /** Altitude over which air density falls by a factor e. */
  rayleighScaleHeightMeters = 8000

  /** Mie (aerosol) scattering coefficient at the ground. */
  mieScatteringPerMeter = new Vector3(3.996e-6, 3.996e-6, 3.996e-6)
  /** Mie extinction (scattering plus absorption) coefficient at the ground. */
  mieExtinctionPerMeter = new Vector3(4.44e-6, 4.44e-6, 4.44e-6)
  /** Altitude over which aerosol density falls by a factor e. */
  mieScaleHeightMeters = 1200
  /** Asymmetry factor g of the Cornette-Shanks Mie phase function: 0 is isotropic, near 1 strongly forward. */
  miePhaseAsymmetry = 0.8

  /** Ozone absorption coefficient where ozone is densest. */
  ozoneAbsorptionPerMeter = new Vector3(0.65e-6, 1.881e-6, 0.085e-6)
  /** Altitude of the densest ozone. */
  ozoneCenterAltitudeMeters = 25_000
  /** Ozone density falls linearly to zero this far above and below the centre. */
  ozoneHalfWidthMeters = 15_000

  /** Average diffuse reflectance of the ground (dimensionless), lighting the atmosphere from below. */
  groundAlbedo = new Vector3(0.1, 0.1, 0.1)
  /** Largest sun zenith angle precomputed. Past it (sun well below the horizon) the sky is treated as dark. */
  maximumSunZenithAngleRadians = (120 * Math.PI) / 180

  /** Converts sun radiance at the three wavelengths to luminance, for the default spectrum. */
  sunRadianceToLuminanceLumensPerWatt = new Vector3(98242.786222, 69954.398112, 66475.012354)
  /** Converts sky radiance at the three wavelengths to luminance, for the default spectrum. */
  skyRadianceToLuminanceLumensPerWatt = new Vector3(114974.91644, 71305.954816, 65310.548555)

  /** Number of scattering orders precomputed: 1 is single scattering only. Four is visually converged. */
  scatteringOrders = 4

  /**
   * Zenith directions sampled when integrating the light scattered at each point for orders 2 and up
   * (twice as many azimuths). Bruneton uses 16 (512 directions); 8 (128 directions) is four times
   * cheaper to precompute and indistinguishable on screen, since multiply scattered light is smooth.
   */
  scatteringDensityAngularSamples = 8

  /**
   * Lookup texture sizes. The defaults are Bruneton's. The 3D scattering texture is 256 × 128 × 32
   * texels: 8 MB in half floats (used on most phones) or 16 MB in 32-bit floats. Generation needs three
   * more textures of that size for a moment (+24 MB or +48 MB at peak), freed when it finishes.
   */
  textureSizesTexels: AtmosphereTextureSizes = {
    transmittance: new Vector2(256, 64),
    irradiance: new Vector2(64, 16),
    scatteringAltitude: 32,
    scatteringViewZenith: 128,
    scatteringSunZenith: 32,
    scatteringViewSunAngle: 8,
  }

  /** Width, height and depth of the 3D scattering texture, in texels. */
  getScatteringTextureSizeTexels(target = new Vector3()): Vector3 {
    const sizes = this.textureSizesTexels
    return target.set(sizes.scatteringViewSunAngle * sizes.scatteringSunZenith, sizes.scatteringViewZenith, sizes.scatteringAltitude)
  }

  /**
   * Scale applied to all luminances so that values stay in a comfortable range for half floats and
   * exposure: the luminance of a unit spectral radiance at the sun's colour is 1.
   */
  getLuminanceScale(): number {
    return 1 / this.sunRadianceToLuminanceLumensPerWatt.dot(LUMINANCE_COEFFICIENTS)
  }
}
