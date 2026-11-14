import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import type { EntityManager } from '@mikro-orm/sqlite'
import type { Server } from 'node:http'
import { Readable } from 'node:stream'
import express from 'express'
import { DateTime } from '@3mo/date-time'
import { ModelValueConstructor } from '@a11d/api-model-value-constructor'
import { User } from '#features/identity'
import { Source } from '#features/sources'
import { Entry, EntryFile, EntryFileType, EntryFiles, EntryType } from '#features/entries'
import { EntryRelations, RelationType } from '#features/relations'
import { MimeType } from '#features/files/MimeType.js'
import { FileLimits } from '#features/files/server/FileLimits.js'
import { fileStore } from '#features/files/server/FileStore.js'
import { environment } from '#infrastructure/server/Environment.js'
import { fileContentRouter } from '#features/files/server/files.js'
import { Recurrence, RecurrenceFrequency } from '#features/recurrence'
import { ValidationError } from '#infrastructure/validation'
import { MitraCalendar } from '#integrations/mitra/MitraCalendar.js'
import { errorHandler } from '#infrastructure/http/errorHandler.js'
import { updates } from '#infrastructure/realtime/Updates.js'
import { ShareCapability, ShareRole } from '../ShareCapability.js'
import { ShareFileGrant } from '../ShareFileGrant.js'
import { ShareOperation } from './ShareOperation.js'
import { RevokeShareLink } from './RevokeShareLink.js'
import { CreateShareLink } from './CreateShareLink.js'
import { DeleteEntry } from '#features/entries/server/DeleteEntry.js'
import { UpdateShareLinkOverlays } from './UpdateShareLinkOverlays.js'
import { exchangeLimiterForTests, sweepShareOperations } from './sharingRouter.js'
import { attachScopedRelations, type GuestContext } from './guestScope.js'

/** The guest API as a hostile client would reach it: real HTTP, a cookie the test sets, no owner session anywhere. */
describe('Sharing (guest capability)', () => {
	let server: Server
	let url: string
	let em: EntityManager
	let user: User
	let target: Source
	let overlay: Source
	let privatus: Source
	let sharedEntry: Entry
	let overlayEntry: Entry
	let privateEntry: Entry

	before(async () => {
		const { orm } = await import('#infrastructure/database/orm.js')
		em = orm.em.fork()
		user = new User({ username: 'share-owner' })
		const integration = new MitraCalendar({ userId: user.id, uri: MitraCalendar.uri })
		target = new Source({ integrationId: integration.id, uri: MitraCalendar.sourceUri('shared'), name: 'Shared', entryTypes: [EntryType.Event, EntryType.Task], enabled: true, hidden: false })
		overlay = new Source({ integrationId: integration.id, uri: MitraCalendar.sourceUri('work'), name: 'Work', entryTypes: [EntryType.Event], enabled: true, hidden: false })
		privatus = new Source({ integrationId: integration.id, uri: MitraCalendar.sourceUri('private'), name: 'Private', entryTypes: [EntryType.Event], enabled: true, hidden: false })
		sharedEntry = new Entry({ id: crypto.randomUUID(), sourceId: target.id, type: EntryType.Event, heading: 'Shared review', start: new DateTime(Date.parse('2027-01-10T10:00:00Z')), end: new DateTime(Date.parse('2027-01-10T11:00:00Z')), uid: crypto.randomUUID() })
		overlayEntry = new Entry({ id: crypto.randomUUID(), sourceId: overlay.id, type: EntryType.Event, heading: 'Work block', start: new DateTime(Date.parse('2027-01-11T10:00:00Z')), end: new DateTime(Date.parse('2027-01-11T11:00:00Z')), uid: crypto.randomUUID() })
		privateEntry = new Entry({ id: crypto.randomUUID(), sourceId: privatus.id, type: EntryType.Event, heading: 'Private matter', start: new DateTime(Date.parse('2027-01-12T10:00:00Z')), end: new DateTime(Date.parse('2027-01-12T11:00:00Z')), uid: crypto.randomUUID() })
		// The owner links a private entry to a shared one: the leak a guest read must never carry back.
		privateEntry.relations = EntryRelations.of([{ type: RelationType.Parent, targetUid: sharedEntry.uid! }])
		em.persist([user, integration, target, overlay, privatus, sharedEntry, overlayEntry, privateEntry])
		await em.flush()

		const models = new ModelValueConstructor()
		const app = express()
		app.use(express.json({ reviver: (_key, value) => models.shallConstruct(value) ? models.construct(value) : value }))
		app.use('/api/files', fileContentRouter([EntryFile]))
		app.use('/s/api', (await import('./sharingRouter.js')).sharingRouter())
		app.use(errorHandler)
		server = await new Promise<Server>(resolve => {
			const listening = app.listen(0, () => resolve(listening))
		})
		url = `http://localhost:${(server.address() as AddressInfo).port}`
	})

	const capabilityOf = async (role: ShareRole, overlays: ReadonlyArray<string> = []) => {
		const { capability, token } = await ShareCapability.issue(user, target, role, overlays)
		em.persist(capability)
		await em.flush()
		return { capability, token }
	}

	const request = (path: string, init: RequestInit = {}, cookie?: string) =>
		fetch(`${url}/s/api${path}`, {
			...init,
			headers: { ...(init.headers ?? {}), ...(cookie ? { cookie } : {}) },
		} as RequestInit)

	const instant = (value: string) => encodeURIComponent(new Date(value).toISOString())
	const cookieOf = (token: string) => `__Host-calendarx_share=${token}`
	const event = (heading: string, day: string) => ({
		type: 'event',
		heading,
		start: new Date(day).toISOString(),
		end: new Date(`${day.slice(0, 11)}${Number(day.slice(11, 13)) + 1}:00:00Z`),
	})

	after(async () => {
		await new Promise<undefined>(resolve => server.close(() => resolve(undefined)))
		await (await import('#infrastructure/database/orm.js')).orm.close()
	})

	it('denies a request with no cookie and an unknown cookie, then answers a revoked link as gone', async () => {
		assert.equal((await request('/bootstrap')).status, 401)
		assert.equal((await request('/bootstrap', {}, cookieOf('calx_wrong'))).status, 401)
		const { token, capability } = await capabilityOf(ShareRole.View)
		assert.equal((await request('/bootstrap', {}, cookieOf(token))).status, 200)
		await new RevokeShareLink({ id: capability.id }).run({ em: em.fork(), user })
		const response = await request('/bootstrap', {}, cookieOf(token))
		assert.equal(response.status, 410)
		assert.match(await response.text(), /no longer available/)
	})

	it('exchanges a fragment token for a scoped answer, and refuses a dead token', async () => {
		const { token } = await capabilityOf(ShareRole.View)
		const answer = await fetch(`${url}/s/api/exchange`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) })
		assert.equal(answer.status, 200)
		const body = await answer.json() as { role: string, target: { id: string, name: string }, overlays: Array<unknown> }
		assert.equal(body.role, 'view')
		assert.deepEqual([body.target.id, body.target.name], [target.id, 'Shared'])
		const dead = await fetch(`${url}/s/api/exchange`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: `calx_${'x'.repeat(43)}` }) })
		assert.equal(dead.status, 401)
	})

	it('refuses a guessed origin on a write, and floods with 429 and Retry-After', async () => {
		const { token } = await capabilityOf(ShareRole.Edit)
		const cookie = cookieOf(token)
		const foreign = await request('/entries', {
			method: 'POST',
			headers: { 'content-type': 'application/json', origin: 'https://evil.example', 'x-forwarded-host': 'evil.example' },
			body: JSON.stringify(event('Injected', '2027-02-01T10:00:00Z')),
		}, cookie)
		assert.equal(foreign.status, 403)
		let last: Response | undefined
		for (let attempt = 0; attempt < 12; attempt++) {
			last = await fetch(`${url}/s/api/exchange`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: `calx_${'y'.repeat(43)}` }) })
		}
		assert.equal(last!.status, 429)
		assert.ok(last!.headers.get('retry-after'))
	})

	it('lists only the target and the enabled overlays, a private calendar never named in any answer', async () => {
		const { token } = await capabilityOf(ShareRole.View, [overlay.id])
		const listed = await request(`/entries?start=${instant('2027-01-01T00:00:00Z')}&end=${instant('2027-01-31T00:00:00Z')}`, {}, cookieOf(token))
		assert.equal(listed.status, 200)
		const text = await listed.text()
		assert.ok(text.includes('Shared review'))
		assert.ok(text.includes('Work block'))
		assert.ok(!text.includes('Private matter'))
		assert.ok(!text.includes(privatus.id))
	})

	it('keeps a private calendar out of search, direct ids, writes and relations', async () => {
		const { token } = await capabilityOf(ShareRole.Edit, [overlay.id])
		const cookie = cookieOf(token)

		assert.deepEqual(await (await request('/entries/search?query=Private', {}, cookie)).json(), [])
		assert.equal((await request(`/entries/${privateEntry.id}`, {}, cookie)).status, 403)

		const moved = await request(`/entries/${sharedEntry.id}`, {
			method: 'PUT',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ heading: 'Shared review', sourceId: privatus.id }),
		}, cookie)
		assert.equal(moved.status, 403)

		const bridged = await request('/entries', {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'x-operation-id': 'relation-leak-probe' },
			body: JSON.stringify({ ...event('Bridged', '2027-01-13T10:00:00Z'), relations: [{ type: 'PARENT', targetUid: privateEntry.uid }] }),
		}, cookie)
		assert.equal(bridged.status, 403)
		assert.equal(await em.count(Entry, { heading: 'Bridged' }), 0)

		const read = await request(`/entries/${sharedEntry.id}`, {}, cookie)
		const body = await read.text()
		assert.ok(!body.includes('Private matter'))
		assert.ok(!body.includes(privateEntry.uid!))
	})

	it('projects a task completion response through the guest file and relation scope', async () => {
		const task = new Entry({
			id: crypto.randomUUID(), sourceId: target.id, type: EntryType.Task, heading: 'Scoped task', uid: crypto.randomUUID(),
			uri: 'private-provider-uri',
			relations: EntryRelations.of([{ type: RelationType.Parent, targetUid: privateEntry.uid! }]),
		})
		const bytes = await fileStore.put(user.id, Readable.from([Buffer.from('task attachment')]), 1024)
		const fileEm = em.fork()
		const fileTask = new EntryFile({ entry: task, type: EntryFileType.Attachment, userId: user.id, sha256: bytes.sha256, size: bytes.size, name: 'task.txt', mimeType: MimeType.parse('text/plain') })
		task.data = { raw: `ATTACH:/api/files/${fileTask.id}/task.txt` }
		fileEm.persist([task, fileTask])
		await fileEm.flush()
		const cookie = cookieOf((await capabilityOf(ShareRole.Edit)).token)
		const stream = await request('/stream', {}, cookie)
		assert.equal(stream.status, 200)
		const reader = stream.body!.getReader()
		const updateRead = reader.read()
		const completionHeaders = { 'x-operation-id': 'complete-scope-test-001' }
		const response = await request(`/entries/${task.id}/complete`, { method: 'POST', headers: completionHeaders }, cookie)
		assert.equal(response.status, 200)
		const completionSignal = await Promise.race([
			updateRead.then(result => new TextDecoder().decode(result.value)),
			new Promise<string>(resolve => setTimeout(() => resolve('timeout'), 1000)),
		])
		assert.match(completionSignal, /data: updated/)
		const body = await response.text()
		assert.ok(!body.includes(fileTask.id))
		assert.ok(!body.includes(privateEntry.uid!))
		assert.ok(!body.includes('private-provider-uri'))
		const entry = JSON.parse(body) as { files?: Array<{ id: string, sourceUrl?: string }> }
		assert.ok(entry.files?.[0]?.sourceUrl?.startsWith('/s/api/files/'))
		const replayRead = reader.read()
		const replay = await request(`/entries/${task.id}/complete`, { method: 'POST', headers: completionHeaders }, cookie)
		assert.equal(replay.status, 200)
		assert.ok(!(await replay.text()).includes(fileTask.id))
		const replaySignal = await Promise.race([
			replayRead.then(() => 'sent'),
			new Promise<string>(resolve => setTimeout(() => resolve('quiet'), 50)),
		])
		assert.equal(replaySignal, 'quiet')
		await reader.cancel()
		await fileStore.delete(user.id, bytes.sha256)
		fileEm.remove([task, fileTask])
		await fileEm.flush()
	})

	it('persists a guest edit sent as the browser EntryPatch model', async () => {
		const cookie = cookieOf((await capabilityOf(ShareRole.Edit)).token)
		const response = await request(`/entries/${sharedEntry.id}`, {
			method: 'PUT',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ '@type': 'EntryPatch', type: 'event', heading: 'Guest edit persisted', start: '2027-01-10T10:00:00.000Z', end: '2027-01-10T11:00:00.000Z' }),
		}, cookie)
		assert.equal(response.status, 200, await response.text())
		assert.equal((await em.fork().findOne(Entry, { id: sharedEntry.id }))?.heading, 'Guest edit persisted')
	})

	it('uploads guest files without a configured quota, bounded by the per-file cap', async () => {
		if (!FileLimits.of(environment).uploads || environment.files.quota !== undefined) {
			return
		}
		const { token } = await capabilityOf(ShareRole.Edit)
		const response = await request('/files', {
			method: 'POST',
			headers: { 'content-type': 'text/plain', 'content-disposition': 'attachment; filename="guest.txt"' },
			body: 'unclaimed guest bytes',
		}, cookieOf(token))
		assert.equal(response.status, 201, await response.clone().text())
		const stored = await response.json() as { sha256: string, size: number, name: string }
		assert.equal(stored.size, 'unclaimed guest bytes'.length)
		assert.equal(stored.name, 'guest.txt')
		await fileStore.delete(user.id, stored.sha256)
	})

	it('persists a guest create sent as the browser EntryPatch model', async () => {
		const { token } = await capabilityOf(ShareRole.Edit)
		const response = await request('/entries', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ '@type': 'EntryPatch', type: 'event', heading: 'Browser-created guest event', start: '2027-02-02T10:00:00.000Z', end: '2027-02-02T11:00:00.000Z' }),
		}, cookieOf(token))
		assert.equal(response.status, 201)
		assert.ok(await em.fork().findOne(Entry, { sourceId: target.id, heading: 'Browser-created guest event' }))
	})

	it('lets an edit link change and create inside its overlays, never outside the link', async () => {
		const probe = new Entry({ id: crypto.randomUUID(), sourceId: overlay.id, type: EntryType.Event, heading: 'Overlay probe', start: new DateTime(Date.parse('2027-01-16T10:00:00Z')), end: new DateTime(Date.parse('2027-01-16T11:00:00Z')), uid: crypto.randomUUID() })
		em.persist(probe)
		await em.flush()
		const { token } = await capabilityOf(ShareRole.Edit, [overlay.id])
		const cookie = cookieOf(token)
		const edited = await request(`/entries/${probe.id}`, {
			method: 'PUT',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ '@type': 'EntryPatch', heading: 'Overlay edit persisted' }),
		}, cookie)
		assert.equal(edited.status, 200, await edited.text())
		assert.equal((await em.fork().findOne(Entry, { id: probe.id }))?.heading, 'Overlay edit persisted')

		const created = await request('/entries', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ '@type': 'EntryPatch', type: 'event', heading: 'Guest overlay event', sourceId: overlay.id, start: '2027-02-03T10:00:00.000Z', end: '2027-02-03T11:00:00.000Z' }),
		}, cookie)
		assert.equal(created.status, 201, await created.text())
		assert.equal((await em.fork().findOne(Entry, { heading: 'Guest overlay event' }))?.sourceId, overlay.id)

		// A calendar the link never reached stays unreachable: a hostile sourceId lands in the target, a move there is a denial.
		const outside = await request('/entries', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ '@type': 'EntryPatch', type: 'event', heading: 'Guest hostile event', sourceId: privatus.id, start: '2027-02-04T10:00:00.000Z', end: '2027-02-04T11:00:00.000Z' }),
		}, cookie)
		assert.equal(outside.status, 201)
		assert.equal((await em.fork().findOne(Entry, { heading: 'Guest hostile event' }))?.sourceId, target.id)
		const escaped = await request(`/entries/${probe.id}`, {
			method: 'PUT',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ sourceId: privatus.id }),
		}, cookie)
		assert.equal(escaped.status, 403)
		await em.fork().nativeDelete(Entry, { id: probe.id })
	})

	it('answers a guest write without leaking the owner relation graph into the JSON', async () => {
		// A private entry points at this shared entry: the mutation's raw answer once carried the private side along.
		const { token } = await capabilityOf(ShareRole.Edit)
		const cookie = cookieOf(token)
		const updated = await request(`/entries/${sharedEntry.id}`, {
			method: 'PUT',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ heading: 'Shared review' }),
		}, cookie)
		assert.equal(updated.status, 200)
		const body = await updated.text()
		assert.ok(!body.includes('Private matter'))
		assert.ok(!body.includes(privateEntry.uid!))
	})

	it('uses the browser query occurrence scope rather than a conflicting body field', async () => {
		const series = new Entry({
			id: crypto.randomUUID(), sourceId: target.id, type: EntryType.Event, heading: 'Query-scoped series',
			start: new DateTime(Date.parse('2027-01-10T10:00:00Z')), end: new DateTime(Date.parse('2027-01-10T11:00:00Z')),
			recurrence: new Recurrence({ freq: RecurrenceFrequency.Daily, count: 3 }), uid: crypto.randomUUID(),
		})
		em.persist(series)
		await em.flush()
		const cookie = cookieOf((await capabilityOf(ShareRole.Edit)).token)
		const response = await request(`/entries/${series.id}/occurrences/2027-01-10T10%3A00%3A00.000Z?scope=all`, {
			method: 'PUT',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ '@type': 'EntryPatch', heading: 'Series changed from query scope', scope: 'this' }),
		}, cookie)
		assert.equal(response.status, 200)
		assert.equal((await em.fork().findOne(Entry, { id: series.id }))?.heading, 'Series changed from query scope')
		assert.equal(await em.count(Entry, { heading: 'Series changed from query scope', recurrenceId: { $ne: null } }), 0)
		em.remove(series)
		await em.flush()
	})

	it('keeps an occurrence patch from moving the entry outside the target', async () => {
		const { token } = await capabilityOf(ShareRole.Edit)
		const cookie = cookieOf(token)
		const moved = await request(`/entries/${sharedEntry.id}/occurrences/2027-01-05T09:00:00Z`, {
			method: 'PUT',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ heading: 'Shared review', sourceId: privatus.id, scope: 'all' }),
		}, cookie)
		assert.equal(moved.status, 403)
	})

	it('lets a view link read but not write, and an edit link write inside what it reaches', async () => {
		const { token } = await capabilityOf(ShareRole.View)
		const refused = await request('/entries', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(event('Guest picknick', '2027-01-14T10:00:00Z')),
		}, cookieOf(token))
		assert.equal(refused.status, 403)

		const editCookie = cookieOf((await capabilityOf(ShareRole.Edit)).token)
		const created = await request('/entries', {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'x-operation-id': 'retry-once-0001' },
			body: JSON.stringify({ ...event('Guest dinner', '2027-01-15T18:00:00Z'), sourceId: privatus.id }),
		}, editCookie)
		assert.equal(created.status, 201)
		const answer = await created.json() as { id: string, sourceId: string }
		// A hostile sourceId is overridden: the entry lands in the target, never in the named calendar.
		assert.equal(answer.sourceId, target.id)
		assert.equal((await em.findOne(Entry, { heading: 'Guest dinner' }))?.sourceId, target.id)

		const retried = await request('/entries', {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'x-operation-id': 'retry-once-0001' },
			body: JSON.stringify(event('Guest dinner', '2027-01-15T18:00:00Z')),
		}, editCookie)
		assert.equal(retried.status, 201)
		const replayed = await retried.json() as { id: string }
		assert.equal(replayed.id, answer.id)
		assert.equal((await em.find(Entry, { heading: 'Guest dinner' })).length, 1)
	})

	it('replays a mutation id inside its own capability only, and prunes old replay rows', async () => {
		const { capability, token } = await capabilityOf(ShareRole.Edit)
		const cookie = cookieOf(token)
		const body = JSON.stringify(event('Replay probe', '2027-01-16T09:00:00Z'))
		const first = await request('/entries', { method: 'POST', headers: { 'content-type': 'application/json', 'x-operation-id': 'replay-probe-id1' }, body }, cookie)
		assert.equal(first.status, 201)
		const row = await em.findOne(ShareOperation, { id: ShareOperation.idFor(capability.id, 'replay-probe-id1') })
		assert.ok(row)
		await em.nativeUpdate(ShareOperation, { id: row.id }, { createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000) })
		await sweepShareOperations()
		assert.equal(await em.count(ShareOperation, { id: row.id }), 0)
	})

	it('applies owner overlay changes from the next read on, and leaves guests no route to change them', async () => {
		const { capability, token } = await capabilityOf(ShareRole.View, [])
		const cookie = cookieOf(token)
		const range = `/entries?start=${instant('2027-01-01T00:00:00Z')}&end=${instant('2027-01-31T00:00:00Z')}`
		assert.ok(!(await (await request(range, {}, cookie)).text()).includes('Work block'))
		await new UpdateShareLinkOverlays({ id: capability.id, overlays: [overlay.id] }).run({ em: em.fork(), user })
		assert.ok((await (await request(range, {}, cookie)).text()).includes('Work block'))
		const forged = await request(`/shares/${capability.id}/overlays`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ overlays: [] }) }, cookie)
		assert.equal(forged.status, 404)
	})

	it('dispatches the root entry ID when an entry mutation has no result body', () => {
		const dispatched: Array<{ userId: string, scope: string, sourceId?: string, entryId?: string }> = []
		const unsubscribe = updates.subscribe((userId, scope, sourceId, entryId) => dispatched.push({ userId, scope, sourceId, entryId }))
		updates.dispatchFor(new DeleteEntry({ id: sharedEntry.id! }), user)
		unsubscribe()
		assert.deepEqual(dispatched, [{ userId: user.id, scope: 'entries', sourceId: undefined, entryId: sharedEntry.id }])
	})

	it('closes an open stream on revoke and denies the next request after it', async () => {
		const { capability, token } = await capabilityOf(ShareRole.View)
		const cookie = cookieOf(token)
		const stream = await request('/stream', {}, cookie)
		assert.equal(stream.status, 200)
		const reader = stream.body!.getReader()
		let resolveRevoked!: (revoked: boolean) => void
		const revoked = new Promise<boolean>(resolve => resolveRevoked = resolve)
		void (async () => {
			let collected = ''
			for (;;) {
				const { done, value } = await reader.read()
				if (done) {
					break
				}
				collected += new TextDecoder().decode(value)
				if (collected.includes('revoked')) {
					reader.cancel().catch(() => void 0)
					resolveRevoked(true)
					return
				}
			}
			resolveRevoked(collected.includes('revoked'))
		})()
		await new RevokeShareLink({ id: capability.id }).run({ em: em.fork(), user })
		assert.ok(await Promise.race([revoked, new Promise<boolean>(resolve => setTimeout(() => resolve(false), 3000))]))
		assert.equal((await request('/entries', {}, cookie)).status, 410)
	})

	it('creates a link bound to its target through the owner operation, its secret stored only as a hash', async () => {
		const answer = await new CreateShareLink({ targetSourceId: target.id, role: ShareRole.Edit, overlays: [overlay.id, privatus.id, target.id] }).run({ em: em.fork(), user })
		assert.deepEqual(answer.capability.scope, [target.id, overlay.id, privatus.id])
		assert.match(answer.token, /^calx_/)
		const stored = await em.findOne(ShareCapability, { id: answer.capability.id })
		assert.ok(stored?.hash)
		assert.notEqual(stored.hash, answer.token)
	})

	it('projects recurring overrides without mutating managed rows across grant flushes', async () => {
		const series = new Entry({
			id: crypto.randomUUID(), sourceId: target.id, type: EntryType.Event, heading: 'Detached guest series',
			start: new DateTime(Date.parse('2027-03-01T10:00:00Z')), end: new DateTime(Date.parse('2027-03-01T11:00:00Z')),
			recurrence: new Recurrence({ freq: RecurrenceFrequency.Daily, count: 3 }), uid: crypto.randomUUID(),
		})
		const first = new Entry({
			id: crypto.randomUUID(), sourceId: target.id, type: EntryType.Event, heading: 'First private override',
			start: new DateTime(Date.parse('2027-03-02T12:00:00Z')), end: new DateTime(Date.parse('2027-03-02T13:00:00Z')),
			recurringEntryId: series.id, recurrenceId: new DateTime(Date.parse('2027-03-02T10:00:00Z')), uid: series.uid,
			uri: 'provider://private/first', data: { raw: 'first private payload' },
			relations: EntryRelations.of([{ type: RelationType.Parent, targetUid: privateEntry.uid! }]),
		})
		const second = new Entry({
			id: crypto.randomUUID(), sourceId: target.id, type: EntryType.Event, heading: 'Second private override',
			start: new DateTime(Date.parse('2027-03-03T12:00:00Z')), end: new DateTime(Date.parse('2027-03-03T13:00:00Z')),
			recurringEntryId: series.id, recurrenceId: new DateTime(Date.parse('2027-03-03T10:00:00Z')), uid: series.uid,
			uri: 'provider://private/second', data: { raw: 'second private payload' },
			relations: EntryRelations.of([{ type: RelationType.Parent, targetUid: privateEntry.uid! }]),
		})
		const firstHash = 'a'.repeat(64)
		const secondHash = 'b'.repeat(64)
		const firstFile = new EntryFile({ entry: first, type: EntryFileType.Attachment, userId: user.id, sha256: firstHash, name: 'first-private.txt', mimeType: MimeType.parse('text/plain') })
		const secondFile = new EntryFile({ entry: second, type: EntryFileType.Attachment, userId: user.id, sha256: secondHash, name: 'second-private.txt', mimeType: MimeType.parse('text/plain') })
		const localUrlReference = new EntryFile({ entry: second, type: EntryFileType.Attachment, sourceUrl: `/api/files/${firstFile.id}/first-private.txt`, name: 'first-via-url.txt', mimeType: MimeType.parse('text/plain') })
		series.description = `[Shared file](/api/files/${firstFile.id}/first-private.txt)`
		em.persist([series, first, second, firstFile, secondFile, localUrlReference])
		await em.flush()

		const link = await new CreateShareLink({ targetSourceId: target.id, role: ShareRole.Edit, overlays: [], entryId: first.id }).run({ em: em.fork(), user })
		const window = await request(`/entries?start=${instant('2027-03-01T00:00:00Z')}&end=${instant('2027-03-05T00:00:00Z')}`, {}, cookieOf(link.token))
		assert.equal(window.status, 200)
		const wireEntries = await window.json() as Array<{
			id: string
			description?: string
			files?: Array<{ id: string }>
			overrides?: Array<{
				id: string
				data?: unknown
				uri?: string
				relations?: unknown
				files?: Array<{ id: string, sourceUrl?: string, name?: string }>
			}>
		}>
		assert.equal(wireEntries.length, 1)
		const projected = wireEntries[0]!
		assert.equal(projected.id, series.id)
		assert.deepEqual(projected.overrides?.map(entry => entry.id).sort(), [first.id, second.id].sort())
		assert.match(projected.description ?? '', /\/s\/api\/files\//)
		assert.equal(projected.files?.length ?? 0, 0)
		const descriptionAlias = /\((\/s\/api\/files\/[^)]+)\)/.exec(projected.description ?? '')?.[1]
		assert.ok(descriptionAlias)
		assert.ok(projected.overrides?.find(entry => entry.id === second.id)?.files?.some(file => file.name === 'first-via-url.txt' && file.sourceUrl === descriptionAlias))
		assert.ok(!JSON.stringify(projected).includes(firstFile.id))
		assert.ok(!JSON.stringify(projected).includes(secondFile.id))
		assert.ok(!JSON.stringify(projected).includes(user.id))
		for (const override of projected.overrides ?? []) {
			assert.equal(override.data, undefined)
			assert.equal(override.uri, undefined)
			assert.deepEqual(override.relations, [])
			assert.ok(override.files?.every(file => file.sourceUrl?.startsWith('/s/api/files/')))
		}

		// The real guest route aliases multiple overrides; the second grant flush must leave all owner rows intact.
		const storedOverrides = await em.fork().find(Entry, { id: { $in: [first.id!, second.id!] } })
		const storedById = new Map(storedOverrides.map(entry => [entry.id!, entry]))
		for (const [entryId, file, hash, uri, raw] of [
			[first.id!, firstFile, firstHash, 'provider://private/first', 'first private payload'],
			[second.id!, secondFile, secondHash, 'provider://private/second', 'second private payload'],
		] as const) {
			const stored = storedById.get(entryId)
			assert.equal(stored?.uri, uri)
			assert.equal(stored?.data?.raw, raw)
			const storedFile = stored?.files?.all.find(candidate => candidate.id === file.id)
			assert.equal(storedFile?.id, file.id)
			assert.equal(storedFile?.userId, user.id)
			assert.equal(storedFile?.sha256, hash)
			assert.equal(stored?.relations?.all[0]?.targetUid, privateEntry.uid)
		}
		const storedSecond = storedById.get(second.id!)
		const storedUrlReference = storedSecond?.files?.all.find(file => file.id === localUrlReference.id)
		assert.equal(storedUrlReference?.sourceUrl, `/api/files/${firstFile.id}/first-private.txt`)
		assert.equal(storedUrlReference?.userId, undefined)
		assert.equal(storedUrlReference?.sha256, undefined)
		const storedSeries = await em.fork().findOneOrFail(Entry, { id: series.id })
		assert.equal(storedSeries.description, `[Shared file](/api/files/${firstFile.id}/first-private.txt)`)
		assert.equal(storedSeries.files?.length, 0)

		const guestEdit = await request(`/entries/${series.id}`, {
			method: 'PUT',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ '@type': 'EntryPatch', description: projected.description }),
		}, cookieOf(link.token))
		assert.equal(guestEdit.status, 200, await guestEdit.text())
		assert.equal((await em.fork().findOneOrFail(Entry, { id: series.id })).description, `[Shared file](/api/files/${firstFile.id}/first-private.txt)`)

		assert.ok(await em.fork().findOne(ShareFileGrant, { capabilityId: link.capability.id, entryFileId: secondFile.id }))
		await em.fork().nativeDelete(EntryFile, { id: secondFile.id })
		assert.equal(await em.fork().findOne(ShareFileGrant, { capabilityId: link.capability.id, entryFileId: secondFile.id }), null)
		await new RevokeShareLink({ id: link.capability.id }).run({ em: em.fork(), user })
		await new RevokeShareLink({ id: link.capability.id }).run({ em: em.fork(), user })
		assert.equal(await em.count(ShareFileGrant, { capabilityId: link.capability.id }), 0)
		const cleanupEm = em.fork()
		cleanupEm.remove([series, first, second])
		await cleanupEm.flush()
	})

	it('clears relations from a shared series and its nested overrides', async () => {
		const override = new Entry({
			id: crypto.randomUUID(), sourceId: target.id, type: EntryType.Event, heading: 'Private override',
			relations: EntryRelations.of([{ type: RelationType.Parent, targetUid: privateEntry.uid! }]),
		})
		const root = new Entry({
			id: crypto.randomUUID(), sourceId: target.id, type: EntryType.Event, heading: 'Shared series',
			relations: EntryRelations.of([{ type: RelationType.Parent, targetUid: privateEntry.uid! }]),
			overrides: [override],
		})
		const context = { capability: { entryId: root.id, targetSourceId: target.id }, scope: [target.id], em: { find: () => Promise.resolve([]) } } as unknown as GuestContext
		const [projected] = await attachScopedRelations(context, [root])
		assert.deepEqual(projected!.relations?.all, [])
		assert.deepEqual(projected!.overrides?.[0]?.relations?.all, [])
	})

	it('scopes a single-event share link to only that one event on read and write', async () => {
		exchangeLimiterForTests.reset() // an earlier flood test spends this address's whole exchange window
		const answer = await new CreateShareLink({ targetSourceId: target.id, role: ShareRole.Edit, overlays: [], entryId: sharedEntry.id }).run({ em: em.fork(), user })
		assert.equal(answer.capability.entryId, sharedEntry.id)

		// 1. Exchange
		const exchange = await fetch(`${url}/s/api/exchange`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ token: answer.token }),
		})
		assert.equal(exchange.status, 200)
		const exchangeData = await exchange.json() as { entryId?: string, target: { name: string } }
		assert.equal(exchangeData.entryId, sharedEntry.id)
		assert.equal(exchangeData.target.name, sharedEntry.heading)

		const cookie = cookieOf(answer.token)
		const sibling = new Entry({ id: crypto.randomUUID(), sourceId: target.id, type: EntryType.Event, heading: 'Sibling secret', start: new DateTime(Date.parse('2027-01-13T10:00:00Z')), end: new DateTime(Date.parse('2027-01-13T11:00:00Z')), uid: crypto.randomUUID(), relations: EntryRelations.of([{ type: RelationType.Parent, targetUid: privateEntry.uid! }]) })
		const relationEm = em.fork()
		const shared = await relationEm.findOneOrFail(Entry, { id: sharedEntry.id })
		shared.relations = EntryRelations.of([{ type: RelationType.Parent, targetUid: sibling.uid! }])
		relationEm.persist(sibling)
		await relationEm.flush()
		const fileEm = em.fork()
		const sharedForFiles = await fileEm.findOneOrFail(Entry, { id: sharedEntry.id })
		const siblingForFiles = await fileEm.findOneOrFail(Entry, { id: sibling.id })
		const sharedBytes = await fileStore.put(user.id, Readable.from([Buffer.from('shared event attachment')]), 1024)
		const siblingBytes = await fileStore.put(user.id, Readable.from([Buffer.from('sibling attachment')]), 1024)
		const sharedFile = new EntryFile({ entry: sharedForFiles, type: EntryFileType.Attachment, userId: user.id, sha256: sharedBytes.sha256, size: sharedBytes.size, name: 'shared.txt', mimeType: MimeType.parse('text/plain') })
		const siblingFile = new EntryFile({ entry: siblingForFiles, type: EntryFileType.Attachment, userId: user.id, sha256: siblingBytes.sha256, size: siblingBytes.size, name: 'sibling.txt', mimeType: MimeType.parse('text/plain') })
		fileEm.persist([sharedFile, siblingFile])
		sharedForFiles.description = `[Shared file](https://calendar.quoc.app/api/files/${sharedFile.id}/shared.txt)\n\n[Prior guest path](/s/api/files/${sharedFile.id}/shared.txt)`
		await fileEm.flush()

		// 2. Bootstrap
		const bootstrap = await (await request('/bootstrap', {}, cookie)).json() as { entryId?: string, overlays: Array<unknown> }
		assert.equal(bootstrap.entryId, sharedEntry.id)
		assert.deepEqual(bootstrap.overlays, [])

		// 3. GET /entries returns ONLY this entry
		const entries = await (await request(`/entries?start=${instant('2027-01-01T00:00:00Z')}&end=${instant('2027-01-31T00:00:00Z')}`, {}, cookie)).json() as Array<{ id: string, description?: string, data?: unknown, uri?: string, relations?: unknown, files?: Array<{ id: string, sourceUrl?: string, type?: string, name?: string, size?: number, mimeType?: unknown }> }>
		assert.equal(entries.length, 1)
		assert.equal(entries[0]!.id, sharedEntry.id)
		assert.deepEqual(entries[0]!.relations, [])
		const calendarLink = await capabilityOf(ShareRole.View)
		assert.ok(await em.fork().findOne(ShareCapability, { id: calendarLink.capability.id }))
		assert.ok(await em.fork().findOne(EntryFile, { id: sharedFile.id }))
		assert.ok(await em.fork().findOne(EntryFile, { id: siblingFile.id }))
		const calendarCookie = cookieOf(calendarLink.token)
		const calendarWindow = await (await request(`/entries?start=${instant('2027-01-01T00:00:00Z')}&end=${instant('2027-01-12T00:00:00Z')}`, {}, calendarCookie)).text()
		assert.ok(calendarWindow.includes('Sibling secret'))
		assert.ok(!calendarWindow.includes(privateEntry.uid!))
		await new RevokeShareLink({ id: calendarLink.capability.id }).run({ em: em.fork(), user })
		assert.doesNotMatch(JSON.stringify(entries), /Sibling secret|"targetUid":"[^"]+"/)
		assert.equal(entries[0]!.data, undefined)
		assert.equal(entries[0]!.uri, undefined)
		assert.equal(JSON.stringify(entries).includes(user.id), false)
		const guestFile = entries[0]!.files?.[0]
		assert.ok(guestFile)
		assert.notEqual(guestFile.id, sharedFile.id)
		assert.ok(!JSON.stringify(entries).includes(sharedFile.id))
		assert.equal(guestFile.sourceUrl, `/s/api/files/${guestFile.id}/shared.txt`)
		assert.match(entries[0]!.description ?? '', new RegExp(`/s/api/files/${guestFile.id}/shared.txt`))
		assert.equal((entries[0]!.description ?? '').includes('calendar.quoc.app/api/files'), false)
		assert.equal((entries[0]!.description ?? '').includes('/s/s/api/files'), false)
		assert.equal((await fetch(`${url}/api/files/${guestFile.id}/shared.txt`)).status, 404)
		const attachmentResponse = await request(`/files/${guestFile.id}/shared.txt`, {}, cookie)
		assert.equal(attachmentResponse.status, 200, await attachmentResponse.clone().text())
		assert.equal(attachmentResponse.headers.get('cache-control'), 'no-store, no-transform')
		assert.equal(await attachmentResponse.text(), 'shared event attachment')
		assert.equal((await request(`/files/${siblingFile.id}/sibling.txt`, {}, cookie)).status, 404)

		// A hand-written file URL on an entry without that attachment is removed rather than leaking another row's bearer id.
		const linkOnlyEntry = new Entry({
			id: crypto.randomUUID(), sourceId: target.id, type: EntryType.Event, heading: 'Link-only event',
			start: new DateTime(Date.parse('2027-01-14T10:00:00Z')), end: new DateTime(Date.parse('2027-01-14T11:00:00Z')),
			description: `[Private file](/api/files/${sharedFile.id}/shared.txt)`, uid: crypto.randomUUID(),
		})
		const outOfScopeReference = new EntryFile({ entry: linkOnlyEntry, type: EntryFileType.Attachment, sourceUrl: `https://calendar.quoc.app/api/files/${sharedFile.id}/shared.txt`, name: 'private.txt', mimeType: MimeType.parse('text/plain') })
		linkOnlyEntry.files = EntryFiles.of([outOfScopeReference])
		fileEm.persist(linkOnlyEntry)
		await fileEm.flush()
		const linkOnly = await new CreateShareLink({ targetSourceId: target.id, role: ShareRole.View, overlays: [], entryId: linkOnlyEntry.id }).run({ em: em.fork(), user })
		const linkOnlyResponse = await request(`/entries/${linkOnlyEntry.id}`, {}, cookieOf(linkOnly.token))
		const linkOnlyBody = await linkOnlyResponse.text()
		assert.equal(linkOnlyResponse.status, 200)
		assert.ok(!linkOnlyBody.includes(sharedFile.id))
		assert.ok(!linkOnlyBody.includes('private.txt'))
		await new RevokeShareLink({ id: linkOnly.capability.id }).run({ em: em.fork(), user })
		fileEm.remove([linkOnlyEntry, outOfScopeReference])
		await fileEm.flush()

		// 4. Searching for other entries returns nothing
		const searchWork = await (await request('/entries/search?query=Work', {}, cookie)).json() as Array<unknown>
		assert.equal(searchWork.length, 0)
		const searchShared = await (await request('/entries/search?query=Shared', {}, cookie)).json() as Array<{ id: string }>
		assert.equal(searchShared.length, 1)
		assert.equal(searchShared[0]!.id, sharedEntry.id)

		// 5. Direct GET for other entries in the same calendar or overlay is rejected with 403
		assert.equal((await request(`/entries/${overlayEntry.id}`, {}, cookie)).status, 403)

		// 6. Other events stay hidden, but the guest may create: what they add shows up and can go again
		const created = await request('/entries', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ '@type': 'EntryPatch', type: 'event', heading: 'Sneaked event', start: '2027-01-10T10:00:00.000Z', end: '2027-01-10T11:00:00.000Z' }),
		}, cookie)
		const createdBody = await created.json() as { id: string }
		assert.equal(created.status, 201, JSON.stringify(createdBody))
		const sneakWindow = await (await request(`/entries?start=${instant('2027-01-01T00:00:00Z')}&end=${instant('2027-01-31T00:00:00Z')}`, {}, cookie)).json() as Array<{ heading: string }>
		assert.deepEqual(sneakWindow.map(entry => entry.heading).sort(), ['Shared review', 'Sneaked event'])
		assert.equal((await request(`/entries/${createdBody.id}`, { method: 'DELETE' }, cookie)).status, 204)
		const afterDelete = await (await request(`/entries?start=${instant('2027-01-01T00:00:00Z')}&end=${instant('2027-01-31T00:00:00Z')}`, {}, cookie)).json() as Array<{ heading: string }>
		assert.deepEqual(afterDelete.map(entry => entry.heading), ['Shared review'])

		// 7. The reach boundary still holds: entries the link never named stay untouchable
		assert.equal((await request(`/entries/${sibling.id}`, { method: 'DELETE' }, cookie)).status, 403)
		assert.equal((await request(`/entries/${sibling.id}/complete`, { method: 'POST' }, cookie)).status, 403)

		// 8. A relations echo is dropped, never applied: the guest cannot see the whole graph, so it cannot change it
		const relationPatch = await request(`/entries/${sharedEntry.id}`, {
			method: 'PUT',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ '@type': 'EntryPatch', heading: 'Relation echo', relations: [] }),
		}, cookie)
		assert.equal(relationPatch.status, 200, await relationPatch.text())
		const afterEcho = await em.fork().findOneOrFail(Entry, { id: sharedEntry.id })
		assert.equal(afterEcho.heading, 'Relation echo')
		assert.equal(afterEcho.relations?.all.length, 1)
		assert.equal(afterEcho.relations?.all[0]?.targetUid, sibling.uid)

		// 9. Updating the single event succeeds and persists
		const updateRes = await request(`/entries/${sharedEntry.id}`, {
			method: 'PUT',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ '@type': 'EntryPatch', type: 'event', heading: 'Solo event edited', start: '2027-01-10T10:00:00.000Z', end: '2027-01-10T11:00:00.000Z', description: entries[0]!.description, files: [guestFile] }),
		}, cookie)
		assert.equal(updateRes.status, 200)
		const savedEvent = await em.fork().findOne(Entry, { id: sharedEntry.id })
		assert.equal(savedEvent?.heading, 'Solo event edited')
		assert.ok(savedEvent?.description?.includes(`/api/files/${sharedFile.id}/shared.txt`))
		assert.equal(savedEvent?.description?.includes('/s/api/files/'), false)
		assert.ok(await em.fork().findOne(EntryFile, { id: sharedFile.id }))

		// 10. A single-event stream does not reveal when an unrelated event in the same calendar changes.
		const stream = await request('/stream', {}, cookie)
		assert.equal(stream.status, 200)
		const reader = stream.body!.getReader()
		const nextEvent = reader.read()
		updates.dispatch(user.id, 'entries', target.id, sibling.id!)
		const unrelatedUpdate = await Promise.race([
			nextEvent.then(() => 'sent'),
			new Promise<string>(resolve => setTimeout(() => resolve('quiet'), 50)),
		])
		assert.equal(unrelatedUpdate, 'quiet')
		updates.dispatch(user.id, 'entries', target.id, sharedEntry.id!)
		const ownUpdate = await Promise.race([
			nextEvent.then(result => new TextDecoder().decode(result.value)),
			new Promise<string>(resolve => setTimeout(() => resolve('timeout'), 1000)),
		])
		assert.match(ownUpdate, /data: updated/)
		await reader.cancel()

		// 11. Revocation also closes the file route; its URL is not an independent year-long bearer cache.
		await new RevokeShareLink({ id: answer.capability.id }).run({ em: em.fork(), user })
		assert.equal((await request(`/files/${guestFile.id}/shared.txt`, {}, cookie)).status, 410)
		assert.equal((await fetch(`${url}/api/files/${guestFile.id}/shared.txt`)).status, 404)
		assert.equal(await em.count(ShareFileGrant, { capabilityId: answer.capability.id }), 0)
		assert.deepEqual(await ShareFileGrant.idsFor(em.fork(), answer.capability.id, [sharedFile.id]), new Map())
		fileEm.remove([sharedFile, siblingFile])
		await fileEm.flush()
		await Promise.all([fileStore.delete(user.id, sharedBytes.sha256), fileStore.delete(user.id, siblingBytes.sha256)])

		// 12. The guest may delete the very event the link focuses; the link then reports it gone.
		const focus = new Entry({ id: crypto.randomUUID(), sourceId: target.id, type: EntryType.Event, heading: 'Focus event', start: new DateTime(Date.parse('2027-01-15T10:00:00Z')), end: new DateTime(Date.parse('2027-01-15T11:00:00Z')), uid: crypto.randomUUID() })
		em.persist(focus)
		await em.flush()
		const focusLink = await new CreateShareLink({ targetSourceId: target.id, role: ShareRole.Edit, overlays: [], entryId: focus.id }).run({ em: em.fork(), user })
		const focusCookie = cookieOf(focusLink.token)
		assert.equal((await request(`/entries/${focus.id}`, { method: 'DELETE' }, focusCookie)).status, 204)
		const gone = await fetch(`${url}/s/api/exchange`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ token: focusLink.token }),
		})
		assert.equal(gone.status, 410)
		await em.fork().nativeDelete(Entry, { id: focus.id })
	})

	it('starts a blank edit link empty, showing only what its guest adds', async () => {
		await assert.rejects(
			new CreateShareLink({ targetSourceId: target.id, role: ShareRole.View, overlays: [], blank: true }).run({ em: em.fork(), user }),
			(error: unknown) => error instanceof ValidationError,
		)
		const answer = await new CreateShareLink({ targetSourceId: target.id, role: ShareRole.Edit, overlays: [], blank: true, entryId: sharedEntry.id }).run({ em: em.fork(), user })
		assert.equal(answer.capability.entryId, undefined)
		assert.equal(answer.capability.blank, true)
		const cookie = cookieOf(answer.token)
		const empty = await (await request(`/entries?start=${instant('2027-01-01T00:00:00Z')}&end=${instant('2027-01-31T00:00:00Z')}`, {}, cookie)).json() as Array<unknown>
		assert.equal(empty.length, 0)
		assert.equal((await request(`/entries/${sharedEntry.id}`, {}, cookie)).status, 403)
		const created = await request('/entries', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ '@type': 'EntryPatch', type: 'event', heading: 'Blank guest event', start: '2027-02-05T10:00:00.000Z', end: '2027-02-05T11:00:00.000Z' }),
		}, cookie)
		assert.equal(created.status, 201)
		const added = await (await request(`/entries?start=${instant('2027-02-01T00:00:00Z')}&end=${instant('2027-02-28T00:00:00Z')}`, {}, cookie)).json() as Array<{ heading: string }>
		assert.deepEqual(added.map(entry => entry.heading), ['Blank guest event'])
		assert.equal((await em.fork().findOneOrFail(Entry, { heading: 'Blank guest event' })).createdVia, answer.capability.id)
		await new RevokeShareLink({ id: answer.capability.id }).run({ em: em.fork(), user })
		await em.fork().nativeDelete(Entry, { heading: 'Blank guest event' })
	})

	it('lets an edit link edit occurrences of the single series it shares', async () => {
		const series = new Entry({
			id: crypto.randomUUID(), sourceId: target.id, type: EntryType.Event, heading: 'Solo shared series',
			start: new DateTime(Date.parse('2027-01-10T10:00:00Z')), end: new DateTime(Date.parse('2027-01-10T11:00:00Z')),
			recurrence: new Recurrence({ freq: RecurrenceFrequency.Daily, count: 3 }), uid: crypto.randomUUID(),
		})
		em.persist(series)
		await em.flush()
		const answer = await new CreateShareLink({ targetSourceId: target.id, role: ShareRole.Edit, overlays: [], entryId: series.id }).run({ em: em.fork(), user })
		const cookie = cookieOf(answer.token)
		const edited = await request(`/entries/${series.id}/occurrences/2027-01-12T10%3A00%3A00.000Z?scope=all`, {
			method: 'PUT',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ '@type': 'EntryPatch', heading: 'Series edited by guest' }),
		}, cookie)
		assert.equal(edited.status, 200, await edited.text())
		assert.equal((await em.fork().findOneOrFail(Entry, { id: series.id })).heading, 'Series edited by guest')
		const split = await request(`/entries/${series.id}/occurrences/2027-01-12T10%3A00%3A00.000Z?scope=this`, {
			method: 'PUT',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ '@type': 'EntryPatch', heading: 'Split occurrence' }),
		}, cookie)
		assert.equal(split.status, 200, await split.text())
		const detached = await em.fork().findOne(Entry, { createdVia: answer.capability.id })
		assert.equal(detached?.heading, 'Split occurrence')
		await new RevokeShareLink({ id: answer.capability.id }).run({ em: em.fork(), user })
		const cleanupEm = em.fork()
		cleanupEm.remove(await cleanupEm.find(Entry, { $or: [{ id: series.id }, { recurringEntryId: series.id }, { createdVia: answer.capability.id }] }))
		await cleanupEm.flush()
	})

	it('normalizes an override share to its recurring series and keeps its overrides inside that scope', async () => {
		const series = new Entry({
			id: crypto.randomUUID(), sourceId: target.id, type: EntryType.Event, heading: 'Shared recurring series',
			start: new DateTime(Date.parse('2027-01-10T10:00:00Z')), end: new DateTime(Date.parse('2027-01-10T11:00:00Z')),
			recurrence: new Recurrence({ freq: RecurrenceFrequency.Daily, count: 3 }), uid: crypto.randomUUID(),
		})
		const override = new Entry({
			id: crypto.randomUUID(), sourceId: target.id, type: EntryType.Event, heading: 'One moved occurrence',
			start: new DateTime(Date.parse('2027-01-11T12:00:00Z')), end: new DateTime(Date.parse('2027-01-11T13:00:00Z')),
			recurringEntryId: series.id, recurrenceId: new DateTime(Date.parse('2027-01-11T10:00:00Z')), uid: series.uid,
			relations: EntryRelations.of([{ type: RelationType.Parent, targetUid: privateEntry.uid! }]),
		})
		em.persist([series, override])
		await em.flush()
		const answer = await new CreateShareLink({ targetSourceId: target.id, role: ShareRole.View, overlays: [], entryId: override.id }).run({ em: em.fork(), user })
		assert.equal(answer.capability.entryId, series.id)
		const cookie = cookieOf(answer.token)
		const entries = await (await request(`/entries?start=${instant('2027-01-01T00:00:00Z')}&end=${instant('2027-01-31T00:00:00Z')}`, {}, cookie)).json() as Array<{ id: string, overrides?: Array<{ id: string }> }>
		assert.equal(entries.length, 1)
		assert.equal(entries[0]!.id, series.id)
		assert.equal(entries[0]!.overrides?.[0]?.id, override.id)
		assert.equal((await request(`/entries/${override.id}`, {}, cookie)).status, 200)
		const search = await (await request('/entries/search?query=One%20moved', {}, cookie)).json() as Array<{ id: string }>
		assert.deepEqual(search.map(entry => entry.id), [override.id])
		await new RevokeShareLink({ id: answer.capability.id }).run({ em: em.fork(), user })

		// A calendar-wide link can include the series, but its nested override must not leak the private relation either.
		const calendarReadLink = await capabilityOf(ShareRole.View)
		const calendarCookie = cookieOf(calendarReadLink.token)
		const calendarEntries = await (await request(`/entries?start=${instant('2027-01-01T00:00:00Z')}&end=${instant('2027-01-31T00:00:00Z')}`, {}, calendarCookie)).json() as Array<{ id: string, overrides?: Array<{ id: string, relations?: unknown }> }>
		const calendarSeries = calendarEntries.find(entry => entry.id === series.id)
		assert.ok(calendarSeries)
		assert.deepEqual(calendarSeries.overrides?.[0]?.relations, [])
		assert.equal(JSON.stringify(calendarEntries).includes(privateEntry.uid!), false)
		await new RevokeShareLink({ id: calendarReadLink.capability.id }).run({ em: em.fork(), user })

		const occurrenceLink = await capabilityOf(ShareRole.Edit)
		const occurrenceCookie = cookieOf(occurrenceLink.token)
		const occurrenceStream = await request('/stream', {}, occurrenceCookie)
		const occurrenceReader = occurrenceStream.body!.getReader()
		const occurrenceRead = occurrenceReader.read()
		const deleted = await request(`/entries/${series.id}/occurrences/2027-01-12T10%3A00%3A00.000Z?scope=this`, { method: 'DELETE' }, occurrenceCookie)
		assert.equal(deleted.status, 204)
		const occurrenceSignal = await Promise.race([
			occurrenceRead.then(result => new TextDecoder().decode(result.value)),
			new Promise<string>(resolve => setTimeout(() => resolve('timeout'), 1000)),
		])
		assert.match(occurrenceSignal, /data: updated/)
		await occurrenceReader.cancel()
		await new RevokeShareLink({ id: occurrenceLink.capability.id }).run({ em: em.fork(), user })

		em.remove([series, override])
		await em.flush()
	})

	it('notifies the scoped stream after an HTTP entry delete', async () => {
		const entry = new Entry({
			id: crypto.randomUUID(), sourceId: target.id, type: EntryType.Event, heading: 'Guest-deleted entry',
			start: new DateTime(Date.parse('2027-04-01T10:00:00Z')), end: new DateTime(Date.parse('2027-04-01T11:00:00Z')), uid: crypto.randomUUID(),
		})
		em.persist(entry)
		await em.flush()
		const link = await capabilityOf(ShareRole.Edit)
		const cookie = cookieOf(link.token)
		const stream = await request('/stream', {}, cookie)
		assert.equal(stream.status, 200)
		const reader = stream.body!.getReader()
		const updateRead = reader.read()
		const deleted = await request(`/entries/${entry.id}`, { method: 'DELETE' }, cookie)
		assert.equal(deleted.status, 204)
		const signal = await Promise.race([
			updateRead.then(result => new TextDecoder().decode(result.value)),
			new Promise<string>(resolve => setTimeout(() => resolve('timeout'), 1000)),
		])
		assert.match(signal, /data: updated/)
		await reader.cancel()
		assert.equal(await em.fork().findOne(Entry, { id: entry.id }), null)
		await new RevokeShareLink({ id: link.capability.id }).run({ em: em.fork(), user })
	})

	it('answers an unknown guest API path with a bare 404, never the owner sign-in redirect', async () => {
		const response = await request('/no-such-route', {}, cookieOf((await capabilityOf(ShareRole.View)).token))
		assert.equal(response.status, 404)
		assert.match(await response.text(), /Not found/)
	})
})
