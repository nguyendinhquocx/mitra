import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Environment } from './Environment.js'

describe('Environment', () => {
	const signedIn = { MITRA_OIDC_ISSUER: 'https://auth.example.com', MITRA_OIDC_CLIENT_ID: 'mitra', MITRA_URL: 'https://mitra.example.com' }

	it('lets the addresses people enter reach the server\'s own network, signed in or not', () => {
		assert.equal(new Environment({}).privateNetwork, true)
		assert.equal(new Environment(signedIn).privateNetwork, true)
	})

	it('keeps them to the public web where the operator blocks it, and always in the demo', () => {
		assert.equal(new Environment({ ...signedIn, MITRA_BLOCK_PRIVATE_NETWORK: 'true' }).privateNetwork, false)
		assert.equal(new Environment({ MITRA_DEMO: 'true' }).privateNetwork, false)
		assert.equal(new Environment({ MITRA_DEMO: 'true', MITRA_BLOCK_PRIVATE_NETWORK: 'false' }).privateNetwork, false)
	})
})
