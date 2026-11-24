import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { fetch } from 'undici'
import { OutboundAgent, RefusedAddress } from './outbound.js'

async function serve(handler: http.RequestListener) {
	const server = http.createServer(handler)
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
	const { port } = server.address() as { port: number }
	return { url: new URL(`http://127.0.0.1:${port}/`), [Symbol.asyncDispose]: () => new Promise<void>(resolve => server.close(() => resolve())) }
}

/** What `fetch` failed with: undici wraps it as the cause of a `TypeError`. */
const causeOf = async (request: Promise<unknown>) => {
	const error = await request.then(() => undefined, (error: unknown) => error)
	return error instanceof Error ? error.cause : undefined
}

describe('OutboundAgent', () => {
	const guarded = new OutboundAgent()

	it('refuses the server\'s own network, by address and by a name resolving there', async () => {
		for (const address of ['http://127.0.0.1/', 'http://169.254.169.254/latest/meta-data/', 'http://[::1]/', 'http://localhost/']) {
			assert.ok(await causeOf(fetch(address, { dispatcher: guarded })) instanceof RefusedAddress, address)
		}
	})

	it('refuses other ports on the public web', async () => {
		assert.ok(await causeOf(fetch('https://example.com:8443/', { dispatcher: guarded })) instanceof RefusedAddress)
	})

	it('reaches the server\'s own network only when asked to', async () => {
		let received = 0
		await using server = await serve((_request, response) => {
			received++
			response.end('hello')
		})
		assert.ok(await causeOf(fetch(server.url, { dispatcher: guarded })) instanceof RefusedAddress)
		assert.equal(received, 0)
		const response = await fetch(server.url, { dispatcher: new OutboundAgent({ privateNetwork: true }) })
		assert.equal(await response.text(), 'hello')
	})

	it('stops a body past its size', async () => {
		await using server = await serve((_request, response) => response.end('x'.repeat(10_000)))
		const response = await fetch(server.url, { dispatcher: new OutboundAgent({ privateNetwork: true, maxResponseSize: 1024 }) })
		await assert.rejects(response.text())
	})
})
