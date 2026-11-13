import { Router, type Request, type RequestHandler, type Response } from 'express'
import { DateTimeRange } from '@3mo/date-time'
import { createLogger } from '#infrastructure/logging/Logger.js'
import { orm } from '#infrastructure/database/orm.js'
import { environment } from '#infrastructure/server/Environment.js'
import { updates } from '#infrastructure/realtime/Updates.js'
import { User } from '#features/identity'
import { Source } from '#features/sources'
import { ShareCapability, ShareRole } from '../ShareCapability.js'
import { ShareOperation, shareOperationRetentionMs } from './ShareOperation.js'
import { RateLimiter } from './rateLimit.js'
import { subscribeToRevocations } from './shareRevocations.js'
import { ShareAccessError, attachScopedRelations, assertGuestWritable, assertRelationsInScope, guestEntry, resolveGuest, scopedEntries, searchedEntries, type GuestContext } from './guestScope.js'
import { FileTooLargeError, fileStore } from '#features/files/server/FileStore.js'
import { FileLimits } from '#features/files/server/FileLimits.js'
import { MimeType } from '#features/files/MimeType.js'
import { File } from '#features/files/File.js'
import { CreateEntry } from '#features/entries/server/CreateEntry.js'
import { UpdateEntry } from '#features/entries/server/UpdateEntry.js'
import { DeleteEntry } from '#features/entries/server/DeleteEntry.js'
import { UpdateEntryOccurrence } from '#features/entries/server/UpdateEntryOccurrence.js'
import { DeleteEntryOccurrence } from '#features/entries/server/DeleteEntryOccurrence.js'
import { CompleteTask } from '#features/entries/server/CompleteTask.js'

const logger = createLogger('Sharing')

/** The one line each limiter takes: recorded defaults live on the RateLimiter, overridable by `MITRA_SHARE_*`. */
const exchangeLimiter = new RateLimiter(environment.share.exchange, 60_000)
const writeLimiter = new RateLimiter(environment.share.write, 60_000)
const streamLimiter = new RateLimiter(environment.share.stream, 60_000)

/** Answers a mutation the way reads are scoped: the owner's relation graph must not leak through the JSON body. */
async function scopedAnswer(context: GuestContext, res: Response, status: number, entry: unknown) {
	await attachScopedRelations(context, [entry as never])
	return res.status(status).json(entry)
}

/** Publishes a guest mutation to the update stream, so the owner's open tabs learn of it at once. */
function announce(operation: object, context: GuestContext, subject?: { readonly sourceId?: string }) {
	updates.dispatchFor(operation, context.owner, subject ?? undefined)
}

/** Share answers are private and perishable: no cache, no crawler, no referrer leakage. */
const shareHeaders: RequestHandler = (_req, res, next) => {
	res.setHeader('Cache-Control', 'no-store')
	res.setHeader('X-Robots-Tag', 'noindex')
	res.setHeader('Referrer-Policy', 'no-referrer')
	next()
}

/**
 * A cookie alone does not carry consent: unsafe methods must come from this origin, so a cross-site page cannot ride
 * the guest cookie to a write. `SameSite=Strict` already keeps the cookie home; this is the server-side belt.
 */
const sameOriginWrites: RequestHandler = (req, res, next) => {
	if (req.method !== 'POST' && req.method !== 'PUT' && req.method !== 'DELETE') {
		return next()
	}
	const origin = req.headers.origin
	const host = req.headers['x-forwarded-host'] ?? req.headers.host
	if (origin !== undefined) {
		try {
			if (new URL(origin).host !== host) {
				return res.status(403).json({ error: 'Cross-origin requests are refused' })
			}
		} catch {
			return res.status(403).json({ error: 'A malformed Origin header is refused' })
		}
	} else if (req.headers['sec-fetch-site'] === 'cross-site') {
		return res.status(403).json({ error: 'Cross-site requests are refused' })
	}
	return next()
}

/** Wraps a handler so every `ShareAccessError` answers with its status, and the rest falls to the error handler. */
const guest = (handler: (req: Request, res: Response, context: GuestContext) => Promise<unknown>): RequestHandler =>
	async (req, res, next) => {
		try {
			const context = await resolveGuest(req)
			const result = await handler(req, res, context)
			if (!res.writableEnded && result !== undefined && !res.headersSent) {
				res.status(200).json(result)
			}
			return
		} catch (error) {
			if (error instanceof ShareAccessError) {
				res.status(error.status).json({ error: error.message })
				return
			}
			next(error)
		}
	}

/** Whether the client's operation id is a well-shaped token (`x-operation-id`): letters, digits, dot, dash, 8..128. */
const operationIdOf = (req: Request) => {
	const id = req.get('x-operation-id')
	return id && /^[A-Za-z0-9._-]{8,128}$/.test(id) ? id : undefined
}

/**
 * Runs a guest mutation once per `x-operation-id`: a retry plays the first answer back instead of writing again, so
 * one retried create cannot become a second Google event. Without a header, the mutation simply runs.
 */
async function oncePerOperation<T>(context: GuestContext, req: Request, run: () => Promise<T>): Promise<{ result?: T, replayed?: unknown }> {
	const clientOperationId = operationIdOf(req)
	if (!clientOperationId) {
		return { result: await run() }
	}
	const id = ShareOperation.idFor(context.capability.id, clientOperationId)
	const previous = await context.em.findOne(ShareOperation, { id })
	if (previous) {
		return { replayed: previous.result }
	}
	const result = await run()
	context.em.persist(new ShareOperation({ id, capabilityId: context.capability.id, result, createdAt: new Date() }))
	await context.em.flush()
	return { result }
}

/** The relations a body names, whatever shape it arrived in, as bare `{ targetUid }` rows for the scope check. */
function relationTargetsOf(body: unknown): Array<{ targetUid?: string }> | undefined {
	const relations = (body as { relations?: unknown })?.relations
	if (relations === undefined || relations === null) {
		return undefined
	}
	if (Array.isArray(relations)) {
		return relations.filter(item => typeof item === 'object' && item !== null) as Array<{ targetUid?: string }>
	}
	const all = (relations as { all?: Array<{ targetUid?: string }> }).all
	return Array.isArray(all) ? all : undefined
}

const secondsOf = (value: unknown) => {
	const date = new Date(String(value))
	return Number.isNaN(date.getTime()) ? undefined : date
}

/** The guest surface: exchange, bootstrap, scoped reads and writes, the scoped stream, and the file uploads its entries claim. */
export function sharingRouter() {
	const router = Router()
	router.use(shareHeaders)

	// The fragment exchange: the token arrives in the POST body once, and leaves as a scoped session cookie. The raw
	// token never touches a query string, a log line, or storage; a failed guess is rate limited per address.
	router.post('/exchange', sameOriginWrites, async (req, res) => {
		const limit = exchangeLimiter.take(req.ip ?? 'unknown')
		if (!limit.allowed) {
			res.setHeader('Retry-After', String(limit.retryAfterSeconds))
			return res.status(429).json({ error: 'Too many attempts. Try again later' })
		}
		const token = typeof req.body?.token === 'string' ? req.body.token : ''
		if (!token.startsWith(ShareCapability.prefix) || token.length > ShareCapability.prefix.length + 512) {
			return res.status(401).json({ error: 'This link is not valid' })
		}
		const em = orm.em.fork()
		const capability = await em.findOne(ShareCapability, { hash: await ShareCapability.hashOf(token) })
		if (!capability || capability.revoked) {
			return res.status(capability?.revoked ? 410 : 401).json({ error: capability?.revoked
				? 'This link is no longer available. Ask its owner for a new one'
				: 'This link is not valid' })
		}
		const owner = await em.findOne(User, { id: capability.ownerId })
		const target = owner && await em.findOne(Source, { id: capability.targetSourceId })
		if (!owner || !target) {
			return res.status(410).json({ error: 'The shared calendar is gone. Ask its owner for a new link' })
		}
		res.cookie(ShareCapability.cookie, token, {
			httpOnly: true,
			secure: true, // `__Host-` demands it; localhost counts as secure, and a plain-HTTP LAN host cannot hold this cookie.
			sameSite: 'strict',
			path: '/',
			maxAge: ShareCapability.sessionLifetime,
		})
		logger.info(`Share session opened for capability ${capability.id}`)
		return res.status(200).json({
			capabilityId: capability.id,
			role: capability.role,
			target: { id: target.id, name: target.name, color: target.color?.value },
			overlays: [] as Array<{ id: string, name: string, color?: string }>,
		})
	})

	// Everything below speaks through the exchanged cookie.
	router.get('/bootstrap', guest(async (_req, res, context) => {
		const target = await context.em.findOne(Source, { id: context.capability.targetSourceId })
		if (!target) {
			throw new ShareAccessError(410, 'The shared calendar is gone. Ask its owner for a new link')
		}
		const overlays = new Array<{ id: string, name: string, color?: string }>()
		for (const id of context.capability.overlays ?? []) {
			const overlay = await context.em.findOne(Source, { id })
			if (overlay) {
				overlays.push({ id: overlay.id, name: overlay.name, color: overlay.color?.value })
			}
		}
		return res.status(200).json({
			capabilityId: context.capability.id,
			role: context.capability.role,
			target: { id: target.id, name: target.name, color: target.color?.value },
			overlays,
		})
	}))

	router.get('/entries', guest(async (req, res, context) => {
		const start = secondsOf(req.query.start)
		const end = secondsOf(req.query.end)
		if (!start || !end) {
			return res.status(400).json({ error: 'A start and an end instant are required' })
		}
		const entries = await scopedEntries(context, new DateTimeRange(start, end))
		return res.status(200).json(entries)
	}))

	router.get('/entries/search', guest(async (req, res, context) => {
		const query = typeof req.query.query === 'string' ? req.query.query.trim() : ''
		if (!query) {
			return res.status(200).json([])
		}
		return res.status(200).json(await searchedEntries(context, query))
	}))

	router.get('/entries/:id', guest(async (req, res, context) => {
		const entry = await guestEntry(context, String(req.params.id))
		await attachScopedRelations(context, [entry])
		return res.status(200).json(entry)
	}))

	// Writes: rate limited per capability, origin checked, and replay-safe by `x-operation-id`.
	const writeGuard = (res: Response, context: GuestContext) => {
		const limit = writeLimiter.take(context.capability.id)
		if (!limit.allowed) {
			res.setHeader('Retry-After', String(limit.retryAfterSeconds))
			throw new ShareAccessError(429, 'Too many changes in a minute. Try again shortly')
		}
	}

	router.post('/entries', sameOriginWrites, guest(async (req, res, context) => {
		writeGuard(res, context)
		if (context.capability.role !== ShareRole.Edit) {
			throw new ShareAccessError(403, 'This link can only view')
		}
		await assertRelationsInScope(context, relationTargetsOf(req.body))
		const values = { ...(req.body as object), sourceId: context.capability.targetSourceId }
		const operation = CreateEntry.fromValues(values as never)
		const { result, replayed } = await oncePerOperation(context, req, async () => {
			const created = await operation.run({ em: context.em, user: context.owner })
			return created
		})
		if (replayed !== undefined) {
			return scopedAnswer(context, res, 201, replayed)
		}
		logger.debug(`Guest created an entry in shared target ${context.capability.targetSourceId}`)
		announce(operation, context, result as { sourceId?: string })
		return scopedAnswer(context, res, 201, result)
	}))

	router.put('/entries/:id', sameOriginWrites, guest(async (req, res, context) => {
		writeGuard(res, context)
		const existing = await guestEntry(context, String(req.params.id))
		assertGuestWritable(context, existing)
		const body = req.body as { sourceId?: string }
		if (body.sourceId !== undefined && body.sourceId !== context.capability.targetSourceId) {
			throw new ShareAccessError(403, 'An entry of the shared calendar stays inside it')
		}
		await assertRelationsInScope(context, relationTargetsOf(req.body))
		const operation = UpdateEntry.fromValues({ ...(req.body as object), id: existing.id } as never)
		const { result, replayed } = await oncePerOperation(context, req, () => operation.run({ em: context.em, user: context.owner }))
		if (replayed !== undefined) {
			return scopedAnswer(context, res, 200, replayed)
		}
		announce(operation, context, result as { sourceId?: string })
		return scopedAnswer(context, res, 200, result)
	}))

	router.delete('/entries/:id', sameOriginWrites, guest(async (req, res, context) => {
		writeGuard(res, context)
		const existing = await guestEntry(context, String(req.params.id))
		assertGuestWritable(context, existing)
		const operation = DeleteEntry.fromValues({ id: existing.id } as never)
		await oncePerOperation(context, req, () => operation.run({ em: context.em, user: context.owner }))
		announce(operation, context, existing)
		return res.status(204).end()
	}))

	router.put('/entries/:id/occurrences/:occurrence', sameOriginWrites, guest(async (req, res, context) => {
		writeGuard(res, context)
		const existing = await guestEntry(context, String(req.params.id))
		assertGuestWritable(context, existing)
		// The occurrence patch carries the wire's sourceId too: without this clamp an edit link could move the entry,
		// this occurrence or the series, onto a read-only overlay or a calendar the link never reached.
		const body = req.body as { sourceId?: string }
		if (body.sourceId !== undefined && body.sourceId !== context.capability.targetSourceId) {
			throw new ShareAccessError(403, 'An entry of the shared calendar stays inside it')
		}
		await assertRelationsInScope(context, relationTargetsOf(req.body))
		const operation = UpdateEntryOccurrence.fromValues({ ...(req.body as object), id: existing.id, occurrence: String(req.params.occurrence), scope: (req.body as { scope?: string }).scope ?? 'this' } as never)
		const { result, replayed } = await oncePerOperation(context, req, () => operation.run({ em: context.em, user: context.owner }))
		if (replayed !== undefined) {
			return scopedAnswer(context, res, 200, replayed)
		}
		announce(operation, context, result as { sourceId?: string })
		return scopedAnswer(context, res, 200, result)
	}))

	router.delete('/entries/:id/occurrences/:occurrence', sameOriginWrites, guest(async (req, res, context) => {
		writeGuard(res, context)
		const existing = await guestEntry(context, String(req.params.id))
		assertGuestWritable(context, existing)
		const operation = DeleteEntryOccurrence.fromValues({ id: existing.id, occurrence: String(req.params.occurrence), scope: String(req.query.scope ?? 'this') } as never)
		await oncePerOperation(context, req, () => operation.run({ em: context.em, user: context.owner }))
		return res.status(204).end()
	}))

	router.post('/entries/:id/complete', sameOriginWrites, guest(async (req, res, context) => {
		writeGuard(res, context)
		const existing = await guestEntry(context, String(req.params.id))
		assertGuestWritable(context, existing)
		const operation = CompleteTask.fromValues({ id: existing.id, occurrence: (req.query.occurrence ?? (req.body as { occurrence?: string } | undefined)?.occurrence) ? String(req.query.occurrence ?? (req.body as { occurrence?: string } | undefined)?.occurrence) : undefined } as never)
		const { result, replayed } = await oncePerOperation(context, req, () => operation.run({ em: context.em, user: context.owner }))
		if (replayed !== undefined) {
			return res.status(200).json(replayed)
		}
		return res.status(200).json(result)
	}))

	// The file bytes a guest entry claims: uploaded under the owner's account, referenced by the entry's save.
	router.post('/files', sameOriginWrites, guest(async (req, res, context) => {
		writeGuard(res, context)
		if (context.capability.role !== ShareRole.Edit) {
			throw new ShareAccessError(403, 'This link can only view')
		}
		const limits = FileLimits.of(environment)
		if (!limits.uploads) {
			return res.status(403).json({ error: 'Uploads are disabled on this instance' })
		}
		if (!limits.allowsMore(await fileStore.usageOf(context.owner.id))) {
			return res.status(507).json({ error: 'File storage is full' })
		}
		const name = File.nameFrom(req.get('content-disposition'))
		const mimeType = MimeType.parse(req.get('content-type')) ?? MimeType.octetStream
		const bytes = await fileStore.put(context.owner.id, req, limits.maxSize).catch((error: unknown) => {
			if (error instanceof FileTooLargeError) {
				return error
			}
			throw error
		})
		if (bytes instanceof FileTooLargeError) {
			return res.status(413).json({ error: `This file is larger than the ${Math.round(limits.maxSize / 1024 / 1024)} MB limit` })
		}
		if (!bytes.size) {
			await fileStore.delete(context.owner.id, bytes.sha256)
			return res.status(400).json({ error: 'The file is empty' })
		}
		return res.status(201).json({ sha256: bytes.sha256, size: bytes.size, name, mimeType: String(mimeType) })
	}))

	// The scoped stream: entry changes the link reaches, and nothing else; a revoke closes it mid-flight.
	router.get('/stream', async (req, res, next) => {
		let context: GuestContext
		// Armed before the guest is resolved: a revoke committing while resolution is still underway must not slip
		// past this stream, leaving it open with a capability that no longer exists.
		const revocationsWhileResolving = new Set<string>()
		const unsubscribeWhileResolving = subscribeToRevocations(id => revocationsWhileResolving.add(id))
		try {
			context = await resolveGuest(req)
		} catch (error) {
			unsubscribeWhileResolving()
			if (error instanceof ShareAccessError) {
				return res.status(error.status).json({ error: error.message })
			}
			return next(error)
		}
		unsubscribeWhileResolving()
		const limit = streamLimiter.take(req.ip ?? 'unknown')
		if (!limit.allowed) {
			res.setHeader('Retry-After', String(limit.retryAfterSeconds))
			return res.status(429).json({ error: 'Too many connections. Try again later' })
		}
		res.writeHead(200, {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache',
			Connection: 'keep-alive',
		})
		// Flushed at once: an SSE stream may stay silent until its first change, and a client waiting on the headers must not hang.
		res.flushHeaders()
		const capability = context.capability
		if (revocationsWhileResolving.has(capability.id)) {
			res.write('event: revoked\ndata: revoked\n\n')
			return res.end()
		}
		const scope = new Set(capability.scope)
		const unsubscribe = updates.subscribe((userId, updateScope, sourceId) => {
			if (userId !== capability.ownerId) {
				return
			}
			// A change whose calendar is known rides its sourceId: outside the link's scope it is not even a ping.
			// An unknown-calendar change (a deletion, say) pings every link of that user; the guest refetch sees only its own scope.
			if (sourceId && !scope.has(sourceId)) {
				return
			}
			res.write(`data: ${updateScope === 'sources' ? 'sources' : 'updated'}\n\n`)
		})
		const unsubscribeRevocation = subscribeToRevocations(revokedId => {
			if (revokedId === capability.id) {
				res.write('event: revoked\ndata: revoked\n\n')
				res.end()
			}
		})
		req.on('close', () => {
			unsubscribe()
			unsubscribeRevocation()
		})
	})

	return router
}

/** Reaped by the caller that starts the server: old replay rows leave the table so it stays a bounded ledger. */
export async function sweepShareOperations() {
	await orm.em.nativeDelete(ShareOperation, { createdAt: { $lt: new Date(Date.now() - shareOperationRetentionMs) } })
}
