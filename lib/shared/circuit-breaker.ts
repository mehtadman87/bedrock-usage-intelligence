import {
  CIRCUIT_BREAKER_FAILURE_THRESHOLD,
  CIRCUIT_BREAKER_COOLDOWN_MS,
} from './constants';

type CircuitState = 'closed' | 'open' | 'half-open';

/**
 * Circuit breaker implementing the standard state machine:
 *
 *   Closed ──(N consecutive failures)──► Open
 *   Open   ──(cooldown elapsed)────────► HalfOpen
 *   HalfOpen ──(success)───────────────► Closed
 *   HalfOpen ──(failure)───────────────► Open
 *
 * When Open, `execute()` throws immediately without calling the wrapped
 * function, preventing cascading failures to downstream services.
 *
 * Requirements: 8.8, 13.5, 13.6
 */
export class CircuitBreaker {
  private state: CircuitState = 'closed';
  private consecutiveFailures = 0;
  private openedAt: number | null = null;

  constructor(
    private readonly failureThreshold: number = CIRCUIT_BREAKER_FAILURE_THRESHOLD,
    private readonly cooldownMs: number = CIRCUIT_BREAKER_COOLDOWN_MS,
  ) {}

  /** Returns the current circuit state. */
  getState(): CircuitState {
    // Lazily transition Open → HalfOpen when the cooldown has elapsed.
    if (this.state === 'open' && this.openedAt !== null) {
      if (Date.now() - this.openedAt >= this.cooldownMs) {
        this.state = 'half-open';
        this.openedAt = null;
      }
    }
    return this.state;
  }

  /**
   * Execute `fn` through the circuit breaker.
   *
   * - Closed: call fn; on success reset counter; on failure increment counter
   *   and open circuit when threshold is reached.
   * - Open: throw immediately without calling fn.
   * - HalfOpen: allow one probe call; on success close circuit; on failure
   *   re-open circuit.
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    const currentState = this.getState();

    if (currentState === 'open') {
      throw new Error('Circuit breaker is open');
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure();
      throw err;
    }
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  private onSuccess(): void {
    // Both Closed and HalfOpen transitions reset to Closed on success.
    this.state = 'closed';
    this.consecutiveFailures = 0;
    this.openedAt = null;
  }

  private onFailure(): void {
    if (this.state === 'half-open') {
      // A probe call failed — go back to Open immediately.
      this.tripOpen();
      return;
    }

    // Closed state: increment counter and open if threshold reached.
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.failureThreshold) {
      this.tripOpen();
    }
  }

  private tripOpen(): void {
    this.state = 'open';
    this.openedAt = Date.now();
  }
}
