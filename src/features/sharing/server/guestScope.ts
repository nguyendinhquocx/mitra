import type { EntityManager } from '@mikro-orm/sqlite'
import type { Request } from 'express'
import { DateTimeRange } from '@3mo/date-time'
import { User } from '#features/identity'
import { Source } from '#features/sources'
import { Entry } from '#features/entries'
import { EntryRelation, EntryRelations } from '#features/relations'
import { orm } from '#infrastructure/database/orm.js'
import { cookie } from '#features/identity/server/auth.js'
import { ShareCapability } from '../ShareCapability.js'

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
	return { em, capability, owner, scope: capability.scope }
}

/** The entry `id` names, provided it sits inside what the link reaches; anything else is a denial, not a 404. */
export async function guestEntry(context: GuestContext, id: string) {
	const entry = await context.em.findOne(Entry, { id })
	if (!entry) {
		throw new ShareAccessError(404, 'No such entry')
	}
	if (!context.capability.reaches(entry.sourceId)) {
		throw new ShareAccessError(403, 'This entry is outside the shared calendar')
	}
	return entry
}

/** Whether a guest may change `entry`: an edit link, and the entry sitting in the target — overlays are read-only. */
export function assertGuestWritable(context: GuestContext, entry: Pick<Entry, 'sourceId'>) {
	if (context.capability.role !== 'edit') {
		throw new ShareAccessError(403, 'This link can only view')
	}
	if (entry.sourceId !== context.capability.targetSourceId) {
		throw new ShareAccessError(403, 'Only the shared calendar itself takes changes')
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
	await attachScopedRelations(context, entries)
	return entries
}

/** The entries a search finds inside the scope, newest first, the availability background left out. */
export async function searchedEntries(context: GuestContext, query: string) {
	const found = await context.em.find(Entry, {
		$and: [{ sourceId: { $in: [...context.scope] } }, User.matching(query)],
	}, { limit: 20, orderBy: { start: 'desc' } })
	await attachScopedRelations(context, found)
	return found
}

/**
 * Rebuilds each entry's relations from the rows whose both ends the scope holds, and links only targets the scope
 * holds: what a guest read serves can never name an entry outside the link, however the owner's own graph runs.
 *
 * A row pointing at a scope uid may come from a private entry: it stays only when its owner entry is inside the
 * scope too, so a private calendar's relation to a shared event is neither returned nor followed.
 */
export async function attachScopedRelations(context: GuestContext, entries: ReadonlyArray<Entry>) {
	if (!entries.length) {
		return
	}
	const scope = [...context.scope]
	const ids = entries.map(entry => entry.id!)
	const uids = [...new Set(entries.map(entry => entry.uid!).filter((uid): uid is string => !!uid))]
	const [owned, pointing] = await Promise.all([
		context.em.find(EntryRelation, { entryId: { $in: ids } }),
		context.em.find(EntryRelation, { targetUid: { $in: uids } }),
	])
	// A row pointing at a scope uid may come from a private entry: it stays only when its owner entry is inside the scope too.
	const entryIdsInScope = new Set(ids)
	const rows = [...owned, ...pointing].filter(row => entryIdsInScope.has(row.entryId))
	const rowTargetUids = [...new Set(rows.map(row => row.targetUid))]
	const targets = rowTargetUids.length
		? await context.em.find(Entry, { $and: [{ uid: { $in: rowTargetUids }, recurrenceId: null }, { sourceId: { $in: scope } }] })
		: []
	const targetByUid = new Map(targets.map(entry => [entry.uid!, entry]))
	const rowsByEntry = Map.groupBy(rows, row => row.entryId)
	for (const entry of entries) {
		const entryRows = rowsByEntry.get(entry.id!) ?? []
		entry.relations = EntryRelations.of(entryRows.map(row => row.relation))
	}
	EntryRelations.link([...entries], uid => targetByUid.get(uid ?? ''))
}
