/** Token bucket rate limiter (in-process; resets on restart) */

export class RateLimiter {
  private tokens: number;
  private lastRefill: number;

  constructor(
    private readonly maxTokens: number,
    private readonly refillMs: number,
  ) {
    this.tokens = maxTokens;
    this.lastRefill = Date.now();
  }

  async acquire(cost = 1, signal?: AbortSignal): Promise<void> {
    if (cost <= 0 || cost > this.maxTokens) throw new Error('Invalid limiter cost');
    while (true) {
      signal?.throwIfAborted();
      this.refill();
      if (this.tokens >= cost) {
        this.tokens -= cost;
        return;
      }
      const wait = Math.max(10, this.refillMs / this.maxTokens);
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => { clearTimeout(timer); reject(signal?.reason ?? new Error('Aborted')); };
        const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, wait);
        signal?.addEventListener('abort', onAbort, { once: true });
        if (signal?.aborted) onAbort();
      });
    }
  }

  private refill() {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    if (elapsed >= this.refillMs) {
      const periods = Math.floor(elapsed / this.refillMs);
      this.tokens = Math.min(this.maxTokens, this.tokens + periods * this.maxTokens);
      this.lastRefill += periods * this.refillMs;
    }
  }
}

/** AniList: keep requests at roughly 90/min instead of sending a startup burst. */
export const anilistLimiter = new RateLimiter(1, 700);

/** Jikan: 3/sec → bucket 3 tokens / 1s */
export const jikanLimiter = new RateLimiter(3, 1_000);
