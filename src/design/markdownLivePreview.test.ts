import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

// The preview's widgets are elements, which Node lacks; opening a state never draws one.
globalThis.HTMLElement ??= class {} as typeof HTMLElement
globalThis.customElements ??= { define() { }, get() { } } as unknown as CustomElementRegistry
const { EditorState } = await import('@codemirror/state')
const { LanguageSupport } = await import('@codemirror/language')
const { markdownLanguage } = await import('@codemirror/lang-markdown')
const { livePreview } = await import('./markdownLivePreview.js')

const open = (doc: string) => EditorState.create({ doc, extensions: [new LanguageSupport(markdownLanguage), livePreview] })

describe('Live Preview', () => {
	it('opens a table with an empty cell', () => {
		assert.doesNotThrow(() => open('| A | B | C |\n|---|---|---|\n| 1 || 3 |\n'))
	})

	it('takes a pipe typed beside another', () => {
		const state = open('| A | B |\n|---|---|\n| 1 | 2 |\n|')
		assert.doesNotThrow(() => state.update({ changes: { from: state.doc.length, insert: '|' } }).state)
	})
})
