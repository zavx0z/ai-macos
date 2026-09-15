export interface FixtureDeferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
}

export function createFixtureDeferred<T>(): FixtureDeferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => {
    resolve = next
  })

  return { promise, resolve }
}
