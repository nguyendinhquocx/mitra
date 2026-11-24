import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { CalDAV } from '../CalDAV.js'
import { CalDAVSyncEngine } from './CalDAVSyncEngine.js'

const multistatus = (...responses: Array<[href: string, props: string]>) => `<?xml version="1.0" encoding="utf-8"?>
<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">${responses.map(([href, props]) => `
	<d:response><d:href>${href}</d:href><d:propstat><d:prop>${props}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`).join('')}
</d:multistatus>`

/** Just enough of a CalDAV server on the loopback for tsdav to discover one calendar. */
const listings: Record<string, string> = {
	'/dav/': multistatus(['/dav/', '<d:current-user-principal><d:href>/dav/principal/</d:href></d:current-user-principal>']),
	'/dav/principal/': multistatus(['/dav/principal/', `
		<c:calendar-home-set><d:href>/dav/calendars/</d:href></c:calendar-home-set>
		<c:calendar-user-address-set><d:href>mailto:me@example.com</d:href></c:calendar-user-address-set>`]),
	'/dav/calendars/': multistatus(
		['/dav/calendars/', '<d:resourcetype><d:collection/></d:resourcetype>'],
		['/dav/calendars/work/', `
			<d:displayname>Work</d:displayname>
			<d:resourcetype><d:collection/><c:calendar/></d:resourcetype>
			<c:supported-calendar-component-set><c:comp name="VEVENT"/></c:supported-calendar-component-set>`],
	),
}

describe('CalDAV on the server\'s own network', () => {
	const requests = new Array<{ method: string, url: string, authorization?: string }>()
	const server = http.createServer((request, response) => {
		requests.push({ method: request.method!, url: request.url!, authorization: request.headers.authorization })
		request.resume()
		if (request.url === '/.well-known/caldav') {
			response.writeHead(301, { location: '/dav/' }).end()
			return
		}
		response.writeHead(207, { 'content-type': 'application/xml; charset=utf-8' })
			.end(listings[request.url!] ?? multistatus([request.url!, '']))
	})
	let uri: string
	before(async () => {
		await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
		uri = `http://127.0.0.1:${(server.address() as { port: number }).port}/dav/`
	})
	after(() => server.close())

	const integration = () => new CalDAV({ uri, credentials: { username: 'me@example.com', password: 'secret' } })

	it('discovers the calendars of a server the operator allows it to reach', async () => {
		requests.length = 0
		const sources = await new CalDAVSyncEngine(true).fetchSources(integration())

		assert.deepEqual(sources.map(source => [source.name, source.uri]), [['Work', new URL('/dav/calendars/work/', uri).href]])
		assert.ok(requests.every(request => request.authorization === `Basic ${Buffer.from('me@example.com:secret').toString('base64')}`))
		// tsdav reads the discovery redirect itself (`redirect: 'manual'`), so it never asks the well-known address twice.
		assert.equal(requests.filter(request => request.url === '/.well-known/caldav').length, 1)
	})

	it('connects to nothing on it otherwise', async () => {
		requests.length = 0
		await assert.rejects(new CalDAVSyncEngine(false).fetchSources(integration()), /only reaches public addresses/)
		assert.equal(requests.length, 0)
	})
})
