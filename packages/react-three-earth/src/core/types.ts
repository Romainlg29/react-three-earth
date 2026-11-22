/** Narrows a value's type without a runtime check. Use only where the type is known by construction. */
export function reinterpretType<T>(_value: unknown): asserts _value is T {}
