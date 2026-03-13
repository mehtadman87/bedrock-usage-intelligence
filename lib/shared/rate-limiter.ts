/**
 * Token bucket rate limiter for controlling API call rates.
 *
 * The bucket starts full (`maxTokens` tokens). Tokens refill continuously at
 * `refillRate` tokens per second based on elapsed wall-clock time. Each
 * `acquire()` / `tryAcquire()` call first tops up the bucket, then attempts
 * to consume one token.
 *
 * Requirements: 18.3
 */
export class TokenBucketRateLimiter {
  private tokens: number;
  private lastRefillTime: number;

  /**
   * @param maxTokens   Maximum number of tokens the bucket can hold.
   *                    The bucket starts full.
   * @param refillRate  Tokens added per second (continuous refill).
   */
  constructor(
    private readonly maxTokens: number,
    private readonly refillRate: number,
  ) {
    this.tokens = maxTokens;
    this.lastRefillTime = Date.now();
  }

  /**
   * Refill the bucket based on elapsed time since the last refill.
   * Tokens are capped at `maxTokens`.
   */
  private refill(): void {
    const now = Date.now();
    const elapsedSeconds = (now - this.lastRefillTime) / 1_000;
    this.tokens = Math.min(
      this.maxTokens,
      this.tokens + elapsedSeconds * this.refillRate,
    );
    this.lastRefillTime = now;
  }

  /**
   * Non-blocking attempt to consume one token.
   *
   * @returns `true` if a token was available and consumed; `false` otherwise.
   */
  tryAcquire(): boolean {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }

  /**
   * Blocking acquire — waits until a token is available, then consumes it.
   *
   * The wait time is calculated from the current token deficit and the refill
   * rate, then a `setTimeout` is used to retry after that delay.
   */
  acquire(): Promise<void> {
    return new Promise((resolve) => {
      const attempt = (): void => {
        this.refill();
        if (this.tokens >= 1) {
          this.tokens -= 1;
          resolve();
          return;
        }

        // Calculate how long until one token is available.
        const tokensNeeded = 1 - this.tokens;
        const waitMs = Math.ceil((tokensNeeded / this.refillRate) * 1_000);
        setTimeout(attempt, waitMs);
      };

      attempt();
    });
  }
}
