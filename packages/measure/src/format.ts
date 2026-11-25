/** Metric (metres, kilometres, hectares) or imperial (feet, miles, acres). */
export type UnitSystem = 'metric' | 'imperial'

export interface FormatOptions {
  /** Default: 'metric'. */
  unitSystem?: UnitSystem
  /** A BCP 47 locale for the digits and the unit's name, such as 'fr-FR'. Default: the browser's. */
  locale?: string
  /** Significant digits kept. Default: 3 (`1.23 km`, `12.3 km`, `123 km`), whole metres and feet below a kilometre or mile. */
  significantDigits?: number
}

const METERS_PER_FOOT = 0.3048
const METERS_PER_MILE = 1609.344
const SQUARE_METERS_PER_HECTARE = 10_000
const SQUARE_METERS_PER_SQUARE_KILOMETER = 1_000_000
const SQUARE_METERS_PER_SQUARE_FOOT = METERS_PER_FOOT * METERS_PER_FOOT
const SQUARE_METERS_PER_ACRE = 4046.8564224
const SQUARE_METERS_PER_SQUARE_MILE = METERS_PER_MILE * METERS_PER_MILE

/**
 * A length for a label: `850 m`, `1.23 km`, or with `unitSystem: 'imperial'` `920 ft`, `4.56 mi`. Units are the
 * locale's (`Intl.NumberFormat`), so `fr-FR` writes `1,23 km`.
 */
export function formatLength(lengthMeters: number, { unitSystem = 'metric', locale, significantDigits = 3 }: FormatOptions = {}): string {
  check('formatLength', lengthMeters, significantDigits)
  if (unitSystem === 'imperial') {
    const feet = lengthMeters / METERS_PER_FOOT
    if (Math.round(Math.abs(feet)) < 5280) return format(feet, 'foot', locale, null)
    return format(lengthMeters / METERS_PER_MILE, 'mile', locale, significantDigits)
  }
  if (Math.round(Math.abs(lengthMeters)) < 1000) return format(lengthMeters, 'meter', locale, null)
  return format(lengthMeters / 1000, 'kilometer', locale, significantDigits)
}

/**
 * An area for a label: `950 m²`, `4.2 ha` (from a hectare), `12.3 km²` (from a square kilometre), or with
 * `unitSystem: 'imperial'` `ft²`, `ac` (from an acre) and `mi²` (from a square mile).
 */
export function formatArea(areaSquareMeters: number, { unitSystem = 'metric', locale, significantDigits = 3 }: FormatOptions = {}): string {
  check('formatArea', areaSquareMeters, significantDigits)
  const area = Math.abs(areaSquareMeters)
  if (unitSystem === 'imperial') {
    if (Math.round(area / SQUARE_METERS_PER_SQUARE_FOOT) * SQUARE_METERS_PER_SQUARE_FOOT < SQUARE_METERS_PER_ACRE) return withSuffix(areaSquareMeters / SQUARE_METERS_PER_SQUARE_FOOT, 'ft²', locale, null)
    if (area < SQUARE_METERS_PER_SQUARE_MILE) return format(areaSquareMeters / SQUARE_METERS_PER_ACRE, 'acre', locale, significantDigits)
    return withSuffix(areaSquareMeters / SQUARE_METERS_PER_SQUARE_MILE, 'mi²', locale, significantDigits)
  }
  if (Math.round(area) < SQUARE_METERS_PER_HECTARE) return withSuffix(areaSquareMeters, 'm²', locale, null)
  if (area < SQUARE_METERS_PER_SQUARE_KILOMETER) return format(areaSquareMeters / SQUARE_METERS_PER_HECTARE, 'hectare', locale, significantDigits)
  return withSuffix(areaSquareMeters / SQUARE_METERS_PER_SQUARE_KILOMETER, 'km²', locale, significantDigits)
}

function check(name: string, value: number, significantDigits: number): void {
  if (!Number.isFinite(value)) throw new Error(`${name}: the value must be a finite number of metres or square metres, got ${value}.`)
  if (!Number.isInteger(significantDigits) || significantDigits < 1 || significantDigits > 21) throw new Error(`${name}: significantDigits must be a whole number from 1 to 21, got ${significantDigits}.`)
}

const formatters = new Map<string, Intl.NumberFormat>()

function numberFormat(locale: string | undefined, options: Intl.NumberFormatOptions): Intl.NumberFormat {
  const key = `${locale ?? ''}|${JSON.stringify(options)}`
  let formatter = formatters.get(key)
  if (formatter === undefined) {
    formatter = new Intl.NumberFormat(locale, options)
    if (formatters.size > 64) formatters.clear()
    formatters.set(key, formatter)
  }
  return formatter
}

/** Whole numbers when `significantDigits` is null, else that many significant digits. */
function digits(significantDigits: number | null): Intl.NumberFormatOptions {
  return significantDigits === null ? { maximumFractionDigits: 0 } : { maximumSignificantDigits: significantDigits }
}

function format(value: number, unit: string, locale: string | undefined, significantDigits: number | null): string {
  return numberFormat(locale, { style: 'unit', unit, unitDisplay: 'short', ...digits(significantDigits) }).format(value)
}

/** Square units are not in `Intl`'s list: the number in the locale's digits, then the symbol. */
function withSuffix(value: number, symbol: string, locale: string | undefined, significantDigits: number | null): string {
  return `${numberFormat(locale, digits(significantDigits)).format(value)} ${symbol}`
}
