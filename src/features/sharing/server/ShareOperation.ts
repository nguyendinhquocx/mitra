import { entity, manyToOne, primaryKey, property } from '#infrastructure/model'
import { ShareCapability } from '../ShareCapability.js'

/**
 * A finished guest mutation, kept by the id the guest's client gave it (`x-operation-id`), so one retry plays back the
 * first answer instead of writing again — a retried create must not become a second Google event. Per capability, kept
 * for a bounded stretch (the sweeper prunes old ones), never across capabilities.
 */
@entity()
export class ShareOperation {
	/** SHA-256 of `capabilityId:operationId`, so an operation id is only replayable against its own capability. */
	static idFor(capabilityId: string, operationId: string) {
		return `${capabilityId}:${operationId}`
	}

	@primaryKey({ type: 'string' }) id!: string

	@manyToOne(() => ShareCapability, { mapToPk: true, deleteRule: 'cascade' }) capabilityId!: string

	/** The first run's answer, replayed verbatim on retries. */
	@property({ type: 'json', nullable: true }) result?: unknown

	@property({ type: 'Date' }) createdAt!: Date

	constructor(init?: Partial<ShareOperation>) {
		Object.assign(this, init)
	}
}

/** How long a finished operation stays replayable; past it, a client retry runs again rather than replaying. */
export const shareOperationRetentionMs = 24 * 60 * 60 * 1000
