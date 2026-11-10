/**
 * The in-process bus a revocation announces itself on: the moment a revoke commits, every open guest stream for that
 * capability closes, so no event is served after the revoke took effect. The guest routes subscribe; the owner's
 * revoke operation emits.
 */
type RevocationListener = (capabilityId: string) => void

const listeners = new Set<RevocationListener>()

/** Calls `listener` with every revoked capability id until it unsubscribes, which the function this answers does too. */
export function subscribeToRevocations(listener: RevocationListener) {
	listeners.add(listener)
	return () => listeners.delete(listener)
}

/** Announces a committed revocation, closing the streams holding that capability open. */
export function announceRevocation(capabilityId: string) {
	listeners.forEach(listener => listener(capabilityId))
}
