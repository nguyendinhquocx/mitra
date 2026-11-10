/**
 * A fixed-window rate limiter for the sharing endpoints, in process: one bucket per key (an IP, a capability, a user),
 * counted against the limits the operator set (`MITRA_SHARE_*`, see Environment). An excess request is refused with
 * 429 and a `Retry-After`, so a link holder cannot hammer an exchange or a guest cannot hammer writes.
 *
 * Recorded defaults (2026-11-10, spec SPEC-2026-11-10): 10 exchanges a minute per address, 30 link changes a minute
 * per user, 60 guest writes a minute per capability, and 20 stream connections a minute per address.
 */
export class RateLimiter {
	private readonly buckets = new Map<string, { count: number, resetAt: number }>()
	private lastSweptAt = Date.now()

	constructor(readonly limit: number, readonly windowMs: number) { }

	/** Takes one shot for `key`. When refused, answers how long the client should wait, in whole seconds. */
	take(key: string): { allowed: true } | { allowed: false, retryAfterSeconds: number } {
		const now = Date.now()
		if (now - this.lastSweptAt > this.windowMs) {
			this.sweep(now)
		}
		let bucket = this.buckets.get(key)
		if (!bucket || bucket.resetAt <= now) {
			bucket = { count: 0, resetAt: now + this.windowMs }
			this.buckets.set(key, bucket)
		}
		bucket.count++
		if (bucket.count > this.limit) {
			return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)) }
		}
		return { allowed: true }
	}

	private sweep(now: number) {
		for (const [key, bucket] of this.buckets) {
			if (bucket.resetAt <= now) {
				this.buckets.delete(key)
			}
		}
		this.lastSweptAt = now
	}
}
