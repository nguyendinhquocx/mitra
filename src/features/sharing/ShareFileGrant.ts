import { entity, manyToOne, primaryKey, unique } from '#infrastructure/model'
import { EntryFile } from '#features/entries'
import { File } from '#features/files/File.js'
import type { EntityManager } from '@mikro-orm/sqlite'
import { ShareCapability } from './ShareCapability.js'

/** A random per-link alias for one attached file: guests never learn the public bearer ID the owner uses elsewhere. */
@entity()
@unique({ properties: ['capabilityId', 'entryFileId'] })
export class ShareFileGrant {
	private static readonly pending = new Map<string, Promise<void>>()

	@primaryKey({ type: 'string' }) id!: string

	@manyToOne(() => ShareCapability, { mapToPk: true, deleteRule: 'cascade' }) capabilityId!: string

	@manyToOne(() => EntryFile, { mapToPk: true, deleteRule: 'cascade' }) entryFileId!: string

	constructor(init?: Partial<ShareFileGrant>) {
		Object.assign(this, init)
	}

	/** Reuses one unguessable alias per capability/file pair and batches creation to one flush per entry. */
	static async idsFor(em: EntityManager, capabilityId: string, entryFileIds: ReadonlyArray<string>) {
		const previous = ShareFileGrant.pending.get(capabilityId) ?? Promise.resolve()
		let release!: () => void
		const slot = new Promise<void>(resolve => { release = resolve })
		const queued = previous.then(() => slot)
		ShareFileGrant.pending.set(capabilityId, queued)
		await previous
		try {
			const active = await em.findOne(ShareCapability, { id: capabilityId }, { refresh: true })
			if (!active || active.revoked) {
				return new Map<string, string>()
			}
			const ids = [...new Set(entryFileIds)]
			const grants = ids.length ? await em.find(ShareFileGrant, { capabilityId, entryFileId: { $in: ids } }) : []
			const aliases = new Map(grants.map(grant => [grant.entryFileId, grant.id]))
			for (const entryFileId of ids) {
				if (!aliases.has(entryFileId)) {
					const id = File.mintId()
					const grant = new ShareFileGrant({ id, capabilityId, entryFileId })
					em.persist(grant)
					aliases.set(entryFileId, id)
				}
			}
			if (ids.some(id => !grants.some(grant => grant.entryFileId === id))) {
				await em.flush()
			}
			const stillActive = await em.findOne(ShareCapability, { id: capabilityId }, { refresh: true })
			if (!stillActive || stillActive.revoked) {
				await em.nativeDelete(ShareFileGrant, { capabilityId })
				return new Map<string, string>()
			}
			return aliases
		} finally {
			release()
			if (ShareFileGrant.pending.get(capabilityId) === queued) {
				ShareFileGrant.pending.delete(capabilityId)
			}
		}
	}
}
