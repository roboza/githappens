/** Growable typed-array helpers (amortized doubling). */

export type NumericArray = Uint8Array | Uint16Array | Uint32Array | Int32Array;

/** Returns `a` if it already holds `need` elements, otherwise a larger copy. */
export function grow<T extends NumericArray>(a: T, need: number): T {
  if (need <= a.length) return a;
  let cap = Math.max(64, a.length * 2);
  while (cap < need) cap *= 2;
  const Ctor = a.constructor as new (n: number) => T;
  const b = new Ctor(cap);
  (b as unknown as { set(src: ArrayLike<number>): void }).set(a);
  return b;
}
