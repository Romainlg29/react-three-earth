import { useLayoutEffect, useMemo, type CSSProperties } from 'react'

import { AttributionControl as AttributionControlImpl, type AttributionControlOptions, type AttributionControlState } from '../controls/AttributionControl.js'
import { buttonProps, Controls, localeKey, useControlsContainer, useControlState, type ControlButtonProps } from './controls.js'
import { useEarth } from './context.js'

export interface UseAttributionControlOptions extends Omit<AttributionControlOptions, 'earth' | 'container'> {
  /** The element whose width decides the automatic compact mode. Default: the element around the canvas. */
  container?: HTMLElement | null
}

export interface AttributionControlResult extends AttributionControlState {
  control: AttributionControlImpl
  toggle: () => void
  /** Spread on the element around the credits: `role="group"`, its name, `hidden` when there is nothing to credit. */
  groupProps: { role: 'group'; 'aria-label': string; hidden: boolean }
  /** Spread on the compact mode's "ⓘ" button: name, `aria-expanded`, press, `hidden` when not compact. */
  toggleButtonProps: ControlButtonProps & { 'aria-expanded': boolean }
}

/**
 * The credits of the sources inside `<Earth>`, headless: the vanilla `AttributionControl`'s entries (text and safe
 * links) and compact mode. Render each entry's segments as text and `<a href>` elements, never as HTML.
 */
export function useAttributionControl(options: UseAttributionControlOptions = {}): AttributionControlResult {
  const earth = useEarth()
  const { container, compact, customAttribution, locale } = options
  const parent = useControlsContainer(container) ?? undefined
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const control = useMemo(() => new AttributionControlImpl({ earth, container: parent, compact, customAttribution, locale }), [earth, parent, localeKey(locale)])
  const customKey = typeof customAttribution === 'string' ? customAttribution : customAttribution?.join('\0')
  // Applied without rebuilding, so the user's expanded state stays
  useLayoutEffect(() => control.setCompact(compact), [control, compact])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => control.setCustomAttribution(customAttribution), [control, customKey])
  const state = useControlState(control)
  return {
    ...state,
    control,
    toggle: control.toggle,
    groupProps: { role: 'group', 'aria-label': state.groupLabel, hidden: !state.visible },
    toggleButtonProps: { ...buttonProps(state.toggleLabel, control.toggle, { hidden: !state.compact }), 'aria-expanded': state.textVisible },
  }
}

/** The credits as text and links, `separator` between entries. */
export function AttributionText({ entries, separator = ' | ' }: { entries: AttributionControlState['entries']; separator?: string }) {
  return (
    <>
      {entries.map((entry, index) => (
        <span key={index}>
          {index > 0 ? separator : null}
          {entry.map((segment, segmentIndex) =>
            segment.href === undefined ? (
              segment.text
            ) : (
              <a key={segmentIndex} href={segment.href} target="_blank" rel="noopener noreferrer">
                {segment.text}
              </a>
            ),
          )}
        </span>
      ))}
    </>
  )
}

export interface AttributionControlProps extends UseAttributionControlOptions {
  /** Class names for the control's element, added to `earthkit-attribution`. Place it with them. */
  className?: string
  /** Inline style of the control's element. */
  style?: CSSProperties
}

/**
 * The credits of the sources inside `<Earth>`, as unstyled HTML: a `role="group"` element with the text and links
 * (`.earthkit-attribution-text`) and, in compact mode, an "ⓘ" toggle (`.earthkit-attribution-toggle`).
 * No CSS ships: place and style it with `className`. For markup of your own, use `useAttributionControl`.
 */
export function AttributionControl({ className, style, container, ...options }: AttributionControlProps) {
  return (
    <Controls className={className === undefined ? 'earthkit-attribution' : `earthkit-attribution ${className}`} style={style} container={container}>
      <AttributionContent {...options} container={container} />
    </Controls>
  )
}

function AttributionContent(options: UseAttributionControlOptions) {
  const attribution = useAttributionControl(options)
  return (
    <div {...attribution.groupProps}>
      <span className="earthkit-attribution-text" hidden={!attribution.textVisible}>
        <AttributionText entries={attribution.entries} />
      </span>
      <button className="earthkit-attribution-toggle" {...attribution.toggleButtonProps}>
        ⓘ
      </button>
    </div>
  )
}
