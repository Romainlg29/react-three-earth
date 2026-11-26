import type { Earth as EarthImpl } from '@earthkit/globe'

const HOURS_PER_DAY = 24
const DEGREES_PER_HOUR = 360 / HOURS_PER_DAY

/** The local solar time, in hours from 0 to 24, at a longitude: noon is when the sun crosses that meridian. */
export function localSolarHours(date: Date, longitudeDegrees: number): number {
  const utcHours = date.getUTCHours() + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3600
  return wrapHours(utcHours + longitudeDegrees / DEGREES_PER_HOUR)
}

/** The instant, on `day`'s UTC date (the sun barely differs a day either side), when the local solar time at a longitude reads `hours`. */
export function dateAtLocalSolarHours(hours: number, longitudeDegrees: number, day: Date = new Date()): Date {
  const utcMinutes = Math.round(wrapHours(hours - longitudeDegrees / DEGREES_PER_HOUR) * 60)
  return new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), 0, utcMinutes))
}

/** `HH:MM` (or `H:MM`) as hours, or null when it is not a time of day. */
export function parseTimeOfDay(text: string | null): number | null {
  const match = text?.match(/^(\d{1,2}):(\d{2})$/)
  if (!match) return null
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (hours > 23 || minutes > 59) return null
  return hours + minutes / 60
}

/** Hours as `HH:MM`. */
export function formatTimeOfDay(hours: number): string {
  const totalMinutes = Math.round(hours * 60) % (HOURS_PER_DAY * 60)
  return `${String(Math.floor(totalMinutes / 60)).padStart(2, '0')}:${String(totalMinutes % 60).padStart(2, '0')}`
}

function wrapHours(hours: number): number {
  return ((hours % HOURS_PER_DAY) + HOURS_PER_DAY) % HOURS_PER_DAY
}

export interface TimeOfDayProps {
  /** The sun's time now shown. */
  date: Date
  onChange: (date: Date) => void
  /** Where the camera looks: the slider reads local solar time there. */
  longitudeDegrees: number
}

/**
 * The time-of-day slider every example shares: local solar time where the camera looks, so 12:00 puts the sun
 * overhead on the map's meridian and 21:00 shows the night side, wherever the example is.
 */
export function TimeOfDay({ date, onChange, longitudeDegrees }: TimeOfDayProps) {
  const hours = localSolarHours(date, longitudeDegrees)
  return (
    <div className="example-field example-time">
      <label htmlFor="example-time-of-day">Time of day</label>
      <input
        id="example-time-of-day"
        type="range"
        min={0}
        max={23.75}
        step={0.25}
        value={(Math.round(hours * 4) / 4) % HOURS_PER_DAY}
        aria-valuetext={`${formatTimeOfDay(hours)} local solar time`}
        onChange={event => onChange(dateAtLocalSolarHours(Number(event.target.value), longitudeDegrees, date))}
      />
      <output htmlFor="example-time-of-day">{formatTimeOfDay(hours)}</output>
      <button type="button" className="example-time-now" aria-label="Set the time of day to now" onClick={() => onChange(new Date())}>
        Now
      </button>
    </div>
  )
}

/** The longitude the camera looks at, or `fallbackDegrees` before the first frame. */
export function cameraLongitude(earth: EarthImpl | null, fallbackDegrees: number): number {
  return earth?.camera.ready ? earth.camera.getView().longitudeDegrees : fallbackDegrees
}
