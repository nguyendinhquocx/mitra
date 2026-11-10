import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import type { EntityManager } from '@mikro-orm/sqlite'
import type { Server } from 'node:http'
import express from 'express'
import { DateTime } from '@3mo/date-time'
import { ModelValueConstructor } from '@a11d/api-model-value-constructor'
import { User } from '#features/identity'
import { Source } from '#features/sources'
import { Entry, EntryType } from '#features/entries'
import { EntryRelations, RelationType } from '#features/relations'
import { MitraCalendar } from '#integrations/mitra/MitraCalendar.js'
import { errorHandler } from '#infrastructure/http/errorHandler.js'
import { ShareCapability, ShareRole } from '../ShareCapability.js'
import { ShareOperation } from './ShareOperation.js'
import { RevokeShareLink } from './RevokeShareLink.js'
import { CreateShareLink } from './CreateShareLink.js'
import { UpdateShareLinkOverlays } from './UpdateShareLinkOverlays.js'
import { sweepShareOperations } from './sharingRouter.js'

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

	const request = async (path: string, init: RequestInit = {}, cookie?: string) =>
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
			headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
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

	it('keeps a private calendar out of search, direct ids, writes, relations and the overlay read-only line', async () => {
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

		const overlayDelete = await request(`/entries/${overlayEntry.id}`, { method: 'DELETE' }, cookie)
		assert.equal(overlayDelete.status, 403)

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

	it('lets a view link read but not write, and an edit link write only inside the target', async () => {
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

	it('closes an open stream on revoke and denies the next request after it', async () => {
		const { capability, token } = await capabilityOf(ShareRole.View)
		const cookie = cookieOf(token)
		const stream = await request('/stream', {}, cookie)
		assert.equal(stream.status, 200)
		const reader = stream.body!.getReader()
		const revoked = new Promise<boolean>(async resolve => {
			let collected = ''
			for (;;) {
				const { done, value } = await reader.read()
				if (done) {
					break
				}
				collected += new TextDecoder().decode(value)
				if (collected.includes('revoked')) {
					resolve(true)
					reader.cancel().catch(() => void 0)
					return
				}
			}
			resolve(collected.includes('revoked'))
		})
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
})
