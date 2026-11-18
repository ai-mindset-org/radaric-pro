export type ProcessFn<T> = (item: T) => Promise<void>

export class ProcessingQueue<T> {
  private _queue: T[] = []
  private _processing = false
  private _shutdown = false
  private _inFlight = 0
  private _drainResolvers: Array<() => void> = []
  private _processFn: ProcessFn<T>

  constructor(processFn: ProcessFn<T>) {
    this._processFn = processFn
  }

  enqueue(item: T): void {
    if (this._shutdown) return
    this._queue.push(item)
    if (!this._processing) {
      this._startProcessing()
    }
  }

  get size(): number {
    return this._queue.length + this._inFlight
  }

  get isProcessing(): boolean {
    return this._processing
  }

  drain(): Promise<void> {
    if (!this._processing && this._queue.length === 0) {
      return Promise.resolve()
    }
    return new Promise<void>((resolve) => {
      this._drainResolvers.push(resolve)
    })
  }

  shutdown(): Promise<void> {
    this._shutdown = true
    this._queue = []
    return this.drain()
  }

  private _startProcessing(): void {
    this._processing = true
    this._runLoop()
  }

  private _runLoop(): void {
    if (this._queue.length === 0) {
      this._processing = false
      this._inFlight = 0
      const resolvers = this._drainResolvers.splice(0)
      for (const resolve of resolvers) {
        resolve()
      }
      return
    }

    const item = this._queue.shift()!
    this._inFlight = 1

    this._processFn(item).then(
      () => {
        this._inFlight = 0
        this._runLoop()
      },
      () => {
        this._inFlight = 0
        this._runLoop()
      }
    )
  }
}

export function withRetry<T>(
  fn: () => Promise<T>,
  options?: { maxRetries?: number; delayMs?: number }
): Promise<T> {
  const maxRetries = options?.maxRetries ?? 3
  const delayMs = options?.delayMs ?? 0

  const outer = new Promise<T>((resolve, reject) => {
    let attempt = 0

    function run(): void {
      fn().then(resolve, (err: unknown) => {
        if (attempt >= maxRetries) {
          reject(err)
        } else {
          attempt++
          setTimeout(run, delayMs)
        }
      })
    }

    run()
  })

  // Attach a no-op rejection handler immediately to prevent Node.js from
  // emitting "unhandledRejection" during the window between the final retry
  // failing and the caller attaching their own handler (e.g. expect().rejects).
  // Multiple rejection handlers on the same Promise are each called independently,
  // so callers still receive the rejection normally via their own .then/.catch.
  outer.catch(() => {})

  return outer
}
