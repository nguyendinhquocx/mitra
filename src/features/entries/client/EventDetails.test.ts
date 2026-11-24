import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * CodeMirror measures each line against the list item around it. An item caught growing from nothing measured shorter
 * than its line, and the editor's height map turned to NaN: every edit after that threw (`lineInner` reading `length`).
 */
describe('the entry editor', () => {
	it('grows its own rows into place, never the items of a description, rendered or edited', () => {
		const source = readFileSync(join('src', 'features', 'entries', 'client', 'EventDetails.ts'), 'utf8')
		const growing = [...source.matchAll(/^\s*(li[^{]*)\{\s*transition: block-size/gm)].map(match => match[1]!.trim())
		assert.ok(growing.length > 0, 'the rule that grows rows into place')
		for (const selector of growing) {
			for (const host of ['mitra-markdown', 'mitra-markdown-editor']) {
				assert.match(selector, new RegExp(`:not\\(.*\\b${host}\\b(?![\\w-]).*\\)`), `${selector} leaves out ${host}`)
			}
		}
	})
})
