import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { allowsPublicGuestPath, matchesPublicGuestHost } from './PublicGuestEdge.js'

describe('Public guest edge policy', () => {
	it('matches only the actual Host authority, with case and default-port normalization', () => {
		assert.equal(matchesPublicGuestHost('SHARE.EXAMPLE.COM:443', 'share.example.com'), true)
		assert.equal(matchesPublicGuestHost('share.example.com.', 'share.example.com'), true)
		assert.equal(matchesPublicGuestHost('owner.example.com', 'share.example.com'), false)
	})

	it('allows only the guest page/API, health and existing built assets', async () => {
		const root = await mkdtemp(path.join(tmpdir(), 'mitra-public-edge-'))
		try {
			await mkdir(path.join(root, 'fonts'), { recursive: true })
			await writeFile(path.join(root, 'index.js'), 'bundle')
			await writeFile(path.join(root, 'fonts', 'body.woff2'), 'font')
			assert.equal(allowsPublicGuestPath('GET', '/s', root), true)
			assert.equal(allowsPublicGuestPath('POST', '/s/api/exchange', root), true)
			assert.equal(allowsPublicGuestPath('OPTIONS', '/s/api/exchange', root), true)
			assert.equal(allowsPublicGuestPath('OPTIONS', '/api/meta', root), false)
			assert.equal(allowsPublicGuestPath('GET', '/s/api/no-such-route', root), true)
			assert.equal(allowsPublicGuestPath('GET', '/api/health', root), true)
			assert.equal(allowsPublicGuestPath('GET', '/index.js', root), true)
			assert.equal(allowsPublicGuestPath('GET', '/fonts/body.woff2', root), true)
			assert.equal(allowsPublicGuestPath('GET', '/s/private', root), false)
			assert.equal(allowsPublicGuestPath('GET', '/api/files/opaque-id', root), false)
			assert.equal(allowsPublicGuestPath('GET', '/unknown.css', root), false)
			assert.equal(allowsPublicGuestPath('POST', '/api/health', root), false)
			assert.equal(allowsPublicGuestPath('GET', '/%2e%2e/package.json', root), false)
		} finally {
			await rm(root, { recursive: true, force: true })
		}
	})
})
