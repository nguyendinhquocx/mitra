import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Environment } from './Environment.js'

describe('Public guest edge configuration', () => {
	it('requires the public host and guest-link origin together', () => {
		assert.throws(() => new Environment({ MITRA_PUBLIC_HOST: 'share.example.com', MITRA_TRUST_PROXY: '127.0.0.1' }), /must be configured together/)
		assert.throws(() => new Environment({ MITRA_SHARE_ORIGIN: 'https://share.example.com' }), /must be configured together/)
	})

	it('requires an exact trusted proxy peer before enabling the guest host', () => {
		assert.throws(() => new Environment({
			MITRA_URL: 'https://calendar.example.com/',
			MITRA_PUBLIC_HOST: 'share.example.com',
			MITRA_SHARE_ORIGIN: 'https://share.example.com/',
		}), /MITRA_TRUST_PROXY/)
		assert.throws(() => new Environment({ MITRA_TRUST_PROXY: 'true' }), /one exact IP/)
	})

	it('accepts a matching HTTPS guest origin, owner origin and trusted proxy', () => {
		const environment = new Environment({
			MITRA_URL: 'https://calendar.example.com/',
			MITRA_TRUST_PROXY: '127.0.0.1',
			MITRA_PUBLIC_HOST: 'SHARE.EXAMPLE.COM.',
			MITRA_SHARE_ORIGIN: 'https://share.example.com/',
		})
		assert.equal(environment.publicHost, 'share.example.com')
		assert.equal(environment.shareOrigin?.origin, 'https://share.example.com')
		assert.equal(environment.trustedProxy, '127.0.0.1')
	})

	it('requires a fixed HTTPS owner origin distinct from the guest host', () => {
		assert.throws(() => new Environment({
			MITRA_URL: 'http://calendar.example.com/',
			MITRA_TRUST_PROXY: '127.0.0.1',
			MITRA_PUBLIC_HOST: 'share.example.com',
			MITRA_SHARE_ORIGIN: 'https://share.example.com/',
		}), /HTTPS MITRA_URL/)
		assert.throws(() => new Environment({
			MITRA_URL: 'https://share.example.com/',
			MITRA_TRUST_PROXY: '127.0.0.1',
			MITRA_PUBLIC_HOST: 'share.example.com',
			MITRA_SHARE_ORIGIN: 'https://share.example.com/',
		}), /must differ from the owner hostname/)
	})

	it('refuses an insecure or mismatched guest origin and a hostname with a port', () => {
		assert.throws(() => new Environment({
			MITRA_URL: 'https://calendar.example.com/',
			MITRA_TRUST_PROXY: '127.0.0.1',
			MITRA_PUBLIC_HOST: 'share.example.com',
			MITRA_SHARE_ORIGIN: 'http://share.example.com/',
		}), /HTTPS origin/)
		assert.throws(() => new Environment({
			MITRA_URL: 'https://calendar.example.com/',
			MITRA_TRUST_PROXY: '127.0.0.1',
			MITRA_PUBLIC_HOST: 'share.example.com',
			MITRA_SHARE_ORIGIN: 'https://owner.example.com/',
		}), /hostname matches/)
		assert.throws(() => new Environment({
			MITRA_URL: 'https://calendar.example.com/',
			MITRA_TRUST_PROXY: '127.0.0.1',
			MITRA_PUBLIC_HOST: 'share.example.com:443',
			MITRA_SHARE_ORIGIN: 'https://share.example.com/',
		}), /hostname without a port/)
	})

	it('refuses a share origin that is a path, has credentials, or carries query state', () => {
		for (const origin of [
			'https://share.example.com/guest',
			'https://user:pass@share.example.com/',
			'https://share.example.com/?token=secret',
		]) {
			assert.throws(() => new Environment({
				MITRA_URL: 'https://calendar.example.com/',
				MITRA_TRUST_PROXY: '127.0.0.1',
				MITRA_PUBLIC_HOST: 'share.example.com',
				MITRA_SHARE_ORIGIN: origin,
			}))
		}
	})
})
