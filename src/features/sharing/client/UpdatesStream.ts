/**
 * The guest's slice of the update stream: the same word the owner's pages live on, scoped to the link. A change
 * the link reaches pings `updated`; the owner's overlay changes ride the same ping (the refetch is scoped); a
 * revoke closes the stream and announces itself, so no later state is served.
 */
export class UpdatesStream {
	/** Called on every entry change the link's scope may hold; the guest refetches, which is scoped server-side. */
	updated?: () => void

	/** Called once the link is revoked, after which the surface offers no working state. */
	revoked?: () => void

	private source?: EventSource

	/** Opens the stream; a 410 or 401 from the scoped endpoint is a revoke as much as a mid-flight close is. */
	open() {
		const source = new EventSource('/s/api/stream')
		source.onmessage = event => {
			if (event.data === 'sources') {
				this.updated?.()
			} else {
				this.updated?.()
			}
		}
		source.addEventListener('revoked', () => {
			this.revoked?.()
			this.close()
		})
		source.onerror = () => {
			// The browser retries on its own; nothing to announce but silence, which the offline state already reads.
		}
		this.source = source
	}

	close() {
		this.source?.close()
		this.source = undefined
	}
}
