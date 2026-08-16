import Type from 'typebox'

export type TUint8Array = Type.TUnsafe<globalThis.Uint8Array>

export function Uint8Array(): TUint8Array {
  return Type.Refine(
    Type.Unsafe<globalThis.Uint8Array>(Type.Any()),
    (value) => value instanceof globalThis.Uint8Array,
    () => 'not a Uint8Array'
  )
}