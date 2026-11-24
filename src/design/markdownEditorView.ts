import { Annotation, EditorSelection, EditorState, Transaction, type StateCommand } from '@codemirror/state'
import { EditorView, keymap, placeholder } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { HighlightStyle, LanguageSupport, syntaxHighlighting } from '@codemirror/language'
import { deleteMarkupBackward, insertNewlineContinueMarkup, markdownLanguage } from '@codemirror/lang-markdown'
import { tags } from '@lezer/highlight'
import { livePreview } from './markdownLivePreview.js'

/** Marks a document set from outside, which its owner already holds. */
const external = Annotation.define<boolean>()

/** Wraps the selection in a marker, or unwraps it when the marker is already around it. */
const wrap = (marker: string): StateCommand => ({ state, dispatch }) => {
	const size = marker.length
	dispatch(state.update(state.changeByRange(range => {
		const before = state.sliceDoc(range.from - size, range.from)
		const after = state.sliceDoc(range.to, range.to + size)
		if (before === marker && after === marker) {
			return {
				changes: [{ from: range.from - size, to: range.from }, { from: range.to, to: range.to + size }],
				range: EditorSelection.range(range.from - size, range.to - size),
			}
		}
		return {
			changes: [{ from: range.from, insert: marker }, { from: range.to, insert: marker }],
			range: EditorSelection.range(range.from + size, range.to + size),
		}
	}), { userEvent: 'input' }))
	return true
}

// Inline formatting is real tags (markdownLivePreview.ts), styled with the rendered description; this only dims markup,
// which a block may tint through the properties.
const highlighting = HighlightStyle.define([
	{ tag: [tags.processingInstruction, tags.contentSeparator, tags.labelName], color: 'var(--mitra-markup-color, var(--color-text-muted))', opacity: 'var(--mitra-markup-opacity, 0.7)' },
])

// Only undoes CodeMirror's own defaults, which are unlayered and outrank any stylesheet of ours; Mitra's look lives in
// MarkdownEditor's styles. A line's display and block padding are read from properties, which only our styles set.
const reset = EditorView.theme({
	'&': { color: 'inherit', background: 'transparent' },
	'&.cm-focused': { outline: 'none' },
	'.cm-scroller': { fontFamily: 'inherit', lineHeight: 'inherit', overflow: 'visible' },
	'.cm-content': { padding: '0', caretColor: 'currentColor' },
	'.cm-line': { display: 'var(--mitra-line-display, block)', paddingInline: '0', paddingBlock: 'var(--mitra-line-padding-start, 0) var(--mitra-line-padding-end, 0)' },
})

export interface MarkdownEditorOptions {
	readonly parent: HTMLElement
	readonly value: string
	readonly placeholder: string
	readonly label?: string
	readonly onEdit: (value: string, focused: boolean) => void
	readonly onBlur: () => void
}

/** The CodeMirror behind `mitra-markdown-editor`, apart so it loads only once an editor is shown. */
export class MarkdownEditorView {
	private readonly view: EditorView

	constructor(options: MarkdownEditorOptions) {
		this.view = new EditorView({
			parent: options.parent,
			// CodeMirror finds its root through slots, which for slotted light DOM is a shadow root that holds neither focus nor selection.
			root: options.parent.getRootNode() as Document | ShadowRoot,
			state: EditorState.create({
				doc: options.value,
				extensions: [
					history(),
					keymap.of([
						{ key: 'Enter', run: insertNewlineContinueMarkup },
						{ key: 'Backspace', run: deleteMarkupBackward },
						{ key: 'Mod-b', run: wrap('**') },
						{ key: 'Mod-i', run: wrap('*') },
						...defaultKeymap,
						...historyKeymap,
					]),
					new LanguageSupport(markdownLanguage),
					syntaxHighlighting(highlighting),
					livePreview,
					reset,
					EditorView.lineWrapping,
					placeholder(options.placeholder),
					EditorView.contentAttributes.of({ 'spellcheck': 'true', 'autocapitalize': 'sentences', 'aria-label': options.label ?? options.placeholder }),
					EditorView.updateListener.of(update => {
						if (update.docChanged && !update.transactions.some(transaction => transaction.annotation(external))) {
							options.onEdit(update.state.doc.toString(), update.view.hasFocus)
						}
					}),
					EditorView.domEventHandlers({ blur: () => options.onBlur() }),
				],
			}),
		})
	}

	get value() {
		return this.view.state.doc.toString()
	}

	set value(value: string) {
		if (value !== this.value) {
			this.view.dispatch({
				changes: { from: 0, to: this.view.state.doc.length, insert: value },
				annotations: [external.of(true), Transaction.addToHistory.of(false)],
			})
		}
	}

	focus() {
		this.view.focus()
	}

	destroy() {
		this.view.destroy()
	}
}
