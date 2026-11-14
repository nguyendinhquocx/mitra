import type { EntityManager } from '@mikro-orm/sqlite'
import type { Request } from 'express'
import type { DateTimeRange } from '@3mo/date-time'
import { User } from '#features/identity'
import { Source } from '#features/sources'
import { Entry, EntryFile, EntryFiles } from '#features/entries'
import { EntryRelation, EntryRelations } from '#features/relations'
import { File } from '#features/files/File.js'
import { orm } from '#infrastructure/database/orm.js'
import { cookie } from '#features/identity/server/auth.js'
import { ShareCapability } from '../ShareCapability.js'
import { ShareFileGrant } from '../ShareFileGrant.js'

/** What a guest request refuses as, each with the status it answers with. */
export class ShareAccessError extends Error {
	constructor(readonly status: number, message: string) {
		super(message)
	}
}

/** The guest principal a request resolves to: a capability bound to one owner, one target, a role, and the owner's current overlays. */
export interface GuestContext {
	readonly em: EntityManager
	readonly capability: ShareCapability
	readonly owner: User
	/** The sources this link reaches, target first: the ids every read is filtered by. */
	readonly scope: ReadonlyArray<string>
}

/**
 * Resolves the share cookie into a guest context, denying whatever the link no longer reaches: no cookie, an unknown
 * token, a revoked capability, or a target deleted under the link. A revoked or dead link answers like a stranger's:
 * the next request is denied the moment the revoke committed.
 */
export async function resolveGuest(req: Request): Promise<GuestContext> {
	const token = cookie(req, ShareCapability.cookie)
	if (!token) {
		throw new ShareAccessError(401, 'This share session has ended. Reopen the link')
	}
	const em = orm.em.fork()
	const capability = await em.findOne(ShareCapability, { hash: await ShareCapability.hashOf(token) })
	if (!capability) {
		throw new ShareAccessError(401, 'This share session is not valid. Reopen the link')
	}
	if (capability.revoked) {
		throw new ShareAccessError(410, 'This link is no longer available. Ask its owner for a new one')
	}
	const owner = await em.findOne(User, { id: capability.ownerId })
	const targetExists = owner && await em.findOne(Source, { id: capability.targetSourceId })
	if (!owner || !targetExists) {
		throw new ShareAccessError(410, 'The shared calendar is gone. Ask its owner for a new link')
	}
	if (capability.entryId) {
		const entry = await em.findOne(Entry, { id: capability.entryId, sourceId: capability.targetSourceId })
		if (!entry) {
			throw new ShareAccessError(410, 'The shared event is gone. Ask its owner for a new link')
		}
	}
	return { em, capability, owner, scope: capability.scope }
}

/** The entry `id` names, provided it sits inside what the link reaches; anything else is a denial, not a 404. */
export async function guestEntry(context: GuestContext, id: string) {
	if (context.capability.entryId && id !== context.capability.entryId) {
		const override = await context.em.findOne(Entry, { id, recurringEntryId: context.capability.entryId, sourceId: context.capability.targetSourceId })
		if (!override) {
			throw new ShareAccessError(403, 'This link only reaches a single event or its series overrides')
		}
		return override
	}
	const entry = await context.em.findOne(Entry, { id })
	if (!entry) {
		throw new ShareAccessError(404, 'No such entry')
	}
	if (!context.capability.reaches(entry.sourceId)) {
		throw new ShareAccessError(403, 'This entry is outside the shared calendar')
	}
	return entry
}

/** Whether a guest may change `entry`: an edit link, and the entry sitting inside what the link reaches — target or overlays. */
export function assertGuestWritable(context: GuestContext, entry: Pick<Entry, 'sourceId'>) {
	if (context.capability.role !== 'edit') {
		throw new ShareAccessError(403, 'This link can only view')
	}
	if (!context.capability.reaches(entry.sourceId)) {
		throw new ShareAccessError(403, 'Only calendars this link reaches take changes')
	}
}

/** Whether every relation a guest's patch names reaches an entry inside the link's scope: a guessed id of a private calendar is a denial. */
export async function assertRelationsInScope(context: GuestContext, relations: ReadonlyArray<{ targetUid?: string }> | undefined) {
	const targetUids = [...new Set(relations?.map(relation => relation.targetUid).filter((uid): uid is string => !!uid) ?? [])]
	if (!targetUids.length) {
		return
	}
	const reached = await context.em.find(Entry, { $and: [{ uid: { $in: targetUids } }, { sourceId: { $in: [...context.scope] } }, { recurrenceId: null }] })
	const inScope = new Set(reached.map(entry => entry.uid!))
	const outside = targetUids.filter(uid => !inScope.has(uid))
	if (outside.length) {
		throw new ShareAccessError(403, 'Relations may only reach entries inside the shared calendars of this link')
	}
}

/**
 * The entries of one window inside the link's scope, each recurring entry once with its overrides, and only the
 * relations whose both ends the scope holds: a relation from a private calendar is neither returned nor followed.
 */
export async function scopedEntries(context: GuestContext, range?: DateTimeRange, limit?: number) {
	if (context.capability.entryId) {
		const entries = await context.em.find(Entry, {
			$and: [
				{ id: context.capability.entryId },
				{ sourceId: context.capability.targetSourceId },
				{ recurrenceId: null },
			],
		})
		const recurring = entries.filter(entry => entry.recurrence)
		const overrides = recurring.length
			? await context.em.find(Entry, { recurringEntryId: { $in: recurring.map(entry => entry.id!) }, sourceId: context.capability.targetSourceId })
			: []
		const byEntry = Map.groupBy(overrides, override => override.recurringEntryId!)
		for (const entry of recurring) {
			entry.overrides = byEntry.get(entry.id!) ?? []
		}
		return attachScopedRelations(context, entries)
	}
	const scope = [...context.scope]
	const entries = await context.em.find(Entry, {
		$and: [
			{ sourceId: { $in: scope } },
			...(range ? [User.inRange(range)] : []),
			{ recurrenceId: null },
		],
	}, limit ? { limit } : {})
	const recurring = entries.filter(entry => entry.recurrence)
	const overrides = recurring.length
		? await context.em.find(Entry, { recurringEntryId: { $in: recurring.map(entry => entry.id!) }, sourceId: { $in: scope } })
		: []
	const byEntry = Map.groupBy(overrides, override => override.recurringEntryId!)
	for (const entry of recurring) {
		entry.overrides = byEntry.get(entry.id!) ?? []
	}
	return attachScopedRelations(context, entries)
}

/** The entries a search finds inside the scope, newest first, the availability background left out. */
export async function searchedEntries(context: GuestContext, query: string) {
	if (context.capability.entryId) {
		const overrides = await context.em.find(Entry, { recurringEntryId: context.capability.entryId, sourceId: context.capability.targetSourceId })
		const entryIds = [context.capability.entryId, ...overrides.map(entry => entry.id!)]
		const found = await context.em.find(Entry, {
			$and: [
				{ id: { $in: entryIds } },
				{ sourceId: context.capability.targetSourceId },
				User.matching(query),
			],
		}, { limit: 20, orderBy: { start: 'desc' } })
		return attachScopedRelations(context, found)
	}
	const found = await context.em.find(Entry, {
		$and: [{ sourceId: { $in: [...context.scope] } }, User.matching(query)],
	}, { limit: 20, orderBy: { start: 'desc' } })
	return attachScopedRelations(context, found)
}

/**
 * Rebuilds each entry's relations from the rows whose both ends the scope holds, and links only targets the scope
 * holds: what a guest read serves can never name an entry outside the link, however the owner's own graph runs.
 *
 * A row pointing at a scope uid may come from a private entry: it stays only when its owner entry is inside the
 * scope too, so a private calendar's relation to a shared event is neither returned nor followed.
 */
function entriesAndOverrides(entries: ReadonlyArray<Entry>) {
	return entries.flatMap(entry => [entry, ...(entry.overrides ?? [])])
}

async function exposeGuestFilePaths(context: GuestContext, entries: ReadonlyArray<Entry>) {
	const permittedEntryIds = context.capability.entryId
		? [context.capability.entryId, ...(await context.em.find(Entry, { recurringEntryId: context.capability.entryId, sourceId: context.capability.targetSourceId })).map(entry => entry.id!)]
		: undefined
	const localFileOf = (id: string) => context.em.findOne(EntryFile, {
		id,
		userId: { $ne: null },
		sha256: { $ne: null },
		entry: permittedEntryIds ? { id: { $in: permittedEntryIds } } : { sourceId: { $in: [...context.scope] } },
	})
	for (const entry of entriesAndOverrides(entries)) {
		const ownerFiles = new Map<string, { row: EntryFile, references: Array<EntryFile> }>()
		const keep = new Array<EntryFile>()
		for (const file of entry.files ?? []) {
			const localId = file.userId && file.sha256 ? file.id : File.idOf(file.sourceUrl ?? '') ?? (!file.sourceUrl ? file.id : undefined)
			if (!localId) {
				keep.push(file)
				continue
			}
			const row = file.userId && file.sha256 ? file : await localFileOf(localId)
			if (!row?.id) {
				continue // A local-looking file URL outside the current capability is never sent back to the guest.
			}
			const existing = ownerFiles.get(row.id)
			if (existing) {
				existing.references.push(file)
			} else {
				ownerFiles.set(row.id, { row, references: [file] })
			}
		}
		const descriptionIds = entry.description
			? [...new Set([...entry.description.matchAll(/(?:https?:\/\/[^/\s<>()]+)?(?:\/s)?\/api\/files\/([A-Za-z0-9_-]{22})(?:\/[^\s<>()]*)?/g)].map(match => match[1]!))]
			: []
		for (const id of descriptionIds) {
			if (!ownerFiles.has(id)) {
				const row = await localFileOf(id)
				if (row?.id) {
					ownerFiles.set(row.id, { row, references: [] })
				}
			}
		}
		const aliasIds = ownerFiles.size
			? await ShareFileGrant.idsFor(context.em, context.capability.id, [...ownerFiles.keys()])
			: new Map<string, string>()
		const paths = new Map<string, string>()
		for (const [ownerId, { row, references }] of ownerFiles) {
			const guestId = aliasIds.get(ownerId)
			if (!guestId) {
				throw new ShareAccessError(410, 'This link is no longer available')
			}
			const path = `/s/api/files/${guestId}/${encodeURIComponent(row.name || 'file')}`
			paths.set(ownerId, path)
			for (const file of references) {
				file.id = guestId
				file.userId = undefined
				file.sha256 = row.sha256
				file.size ??= row.size
				file.name ??= row.name
				file.mimeType ??= row.mimeType
				file.sourceUrl = path
				keep.push(file)
			}
		}
		entry.files = EntryFiles.of(keep)
		if (entry.description) {
			entry.description = entry.description.replace(/(?:https?:\/\/[^/\s<>()]+)?(?:\/s)?\/api\/files\/([A-Za-z0-9_-]{22})(?:\/[^\s<>()]*)?/g, (_url, id: string) => paths.get(id) ?? '')
		}
		// Provider payloads and URIs can repeat a raw `/api/files/<id>` URL; neither belongs on a guest wire projection.
		entry.data = undefined
		entry.uri = undefined
	}
}

function cloneGuestEntry(entry: Entry): Entry {
	const clone = entry.clone()
	// Overrides are bookkeeping, so Entity.clone() keeps the array's Entity members by reference; detach them before projection.
	clone.overrides = entry.overrides?.map(cloneGuestEntry)
	return clone
}

export async function attachScopedRelations(context: GuestContext, entries: ReadonlyArray<Entry>): Promise<Array<Entry>> {
	if (!entries.length) {
		return []
	}
	// Project detached entities: a guest alias must never mutate a managed primary key and leak into a later ORM flush.
	const projected = entries.map(cloneGuestEntry)
	await exposeGuestFilePaths(context, projected)
	const allEntries = entriesAndOverrides(projected)
	if (context.capability.entryId) {
		// A single-event link grants no calendar graph: even another entry or an override relation is outside this capability.
		for (const entry of allEntries) {
			entry.relations = EntryRelations.none
		}
		return projected
	}
	const scope = [...context.scope]
	const ids = allEntries.map(entry => entry.id!)
	const uids = [...new Set(allEntries.map(entry => entry.uid!).filter((uid): uid is string => !!uid))]
	const [owned, pointing] = await Promise.all([
		context.em.find(EntryRelation, { entryId: { $in: ids } }),
		context.em.find(EntryRelation, { targetUid: { $in: uids } }),
	])
	// Keep a relation only when its owning entry and target both belong to the current source scope.
	const entryIdsInScope = new Set(ids)
	const candidateRows = [...owned, ...pointing].filter(row => entryIdsInScope.has(row.entryId))
	const rowTargetUids = [...new Set(candidateRows.map(row => row.targetUid))]
	const targets = rowTargetUids.length
		? await context.em.find(Entry, { $and: [{ uid: { $in: rowTargetUids }, recurrenceId: null }, { sourceId: { $in: scope } }] })
		: []
	const visibleByUid = new Map(allEntries.map(entry => [entry.uid!, entry]))
	const targetByUid = new Map(targets.map(entry => [entry.uid!, visibleByUid.get(entry.uid!) ?? cloneGuestEntry(entry)]))
	const visibleEntryIds = new Set(allEntries.map(entry => entry.id!))
	const externalTargets = [...targetByUid.values()].filter(target => !visibleEntryIds.has(target.id!))
	await exposeGuestFilePaths(context, externalTargets)
	for (const target of externalTargets) {
		target.relations = EntryRelations.none
	}
	const rows = candidateRows.filter(row => targetByUid.has(row.targetUid))
	const rowsByEntry = Map.groupBy(rows, row => row.entryId)
	for (const entry of allEntries) {
		const entryRows = rowsByEntry.get(entry.id!) ?? []
		entry.relations = EntryRelations.of(entryRows.map(row => row.relation))
	}
	EntryRelations.link(allEntries, uid => targetByUid.get(uid ?? ''))
	return projected
}
