import { Prec, StateField, type EditorState, type Range, type RangeSet } from '@codemirror/state'
import { BlockWrapper, Decoration, EditorView, ViewPlugin, WidgetType, keymap, type Command, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import { syntaxTree } from '@codemirror/language'
import { cursorLineEnd, cursorLineStart, selectLineEnd, selectLineStart } from '@codemirror/commands'
import { Checkbox } from './Checkbox.js'
import { Icon } from './Icon.js'
import { MarkdownLinks } from './MarkdownLinks.js'
import { MarkdownCallout } from './MarkdownCallout.js'
import { MarkdownCode } from './MarkdownCode.js'
import { MarkdownTable } from './MarkdownTable.js'

class TaskBox extends WidgetType {
	constructor(readonly checked: boolean) {
		super()
	}

	override eq(other: TaskBox) {
		return other.checked === this.checked
	}

	toDOM(view: EditorView) {
		const box = new Checkbox()
		box.checked = this.checked
		box.addEventListener('change', () => {
			const from = view.posAtDOM(box)
			view.dispatch({ changes: { from, to: from + 3, insert: box.checked ? '[x]' : '[ ]' }, userEvent: 'input.check' })
		})
		return box
	}

	// The box takes its own clicks; the editor would otherwise move the cursor there and reveal the marker.
	override ignoreEvent() {
		return true
	}
}

class Rule extends WidgetType {
	override eq() {
		return true
	}

	toDOM() {
		return document.createElement('hr')
	}
}

class Picture extends WidgetType {
	constructor(readonly src: string, readonly alt: string) {
		super()
	}

	override eq(other: Picture) {
		return other.src === this.src && other.alt === this.alt
	}

	toDOM(view: EditorView) {
		const image = document.createElement('img')
		image.src = this.src
		image.alt = this.alt
		image.addEventListener('load', () => view.requestMeasure())
		// A click puts the cursor on the image, which shows its source.
		image.addEventListener('mousedown', event => {
			if (event.button === 0) {
				event.preventDefault()
				view.dispatch({ selection: { anchor: view.posAtDOM(image) } })
				view.focus()
			}
		})
		return image
	}
}

class CalloutIcon extends WidgetType {
	constructor(readonly icon: string, readonly label: string) {
		super()
	}

	override eq(other: CalloutIcon) {
		return other.icon === this.icon && other.label === this.label
	}

	toDOM() {
		const head = document.createElement('span')
		const icon = new Icon()
		icon.icon = this.icon
		head.append(icon, this.label)
		return head
	}
}

type SyntaxNode = ReturnType<typeof syntaxTree>['topNode']

const hidden = Decoration.replace({})

/** Inline formatting as the elements the rendered description uses, so one stylesheet dresses both. */
const inline = new Map([
	['StrongEmphasis', Decoration.mark({ tagName: 'strong' })],
	['Emphasis', Decoration.mark({ tagName: 'em' })],
	['Strikethrough', Decoration.mark({ tagName: 'del' })],
	['InlineCode', Decoration.mark({ tagName: 'code' })],
])

/** A line that shows its Markdown as written where the block it is in would otherwise hide it. */
const written = Decoration.line({ class: 'written' })

/** A list item's marker as written, where its rendered marker stands. */
const listMark = Decoration.mark({ class: 'list-mark' })

const link = (href: string) => Decoration.mark({ tagName: 'a', attributes: { href, title: href } })

/** The lines a selection touches while the editor has focus, which show their Markdown as written. */
function activeLines(view: EditorView) {
	const lines = new Set<number>()
	if (view.hasFocus) {
		for (const range of view.state.selection.ranges) {
			const last = view.state.doc.lineAt(range.to).number
			for (let line = view.state.doc.lineAt(range.from).number; line <= last; line++) {
				lines.add(line)
			}
		}
	}
	return lines
}

/** What a quote declares on its first line, read without its `>`. */
function calloutOf(state: EditorState, quote: { from: number }) {
	return MarkdownCallout.of(state.doc.lineAt(quote.from).text.replace(/^\s*>/, ''))
}

/** Markup hides, as the line it's on reads it, from the space after it as well. */
function trailingSpace(state: EditorState, to: number) {
	return state.sliceDoc(to, to + 1) === ' ' ? to + 1 : to
}

function decorate(view: EditorView) {
	const { state } = view
	const active = activeLines(view)
	const isActive = (from: number, to = from) => {
		const last = state.doc.lineAt(to).number
		for (let line = state.doc.lineAt(from).number; line <= last; line++) {
			if (active.has(line)) {
				return true
			}
		}
		return false
	}
	const decorations = new Array<Range<Decoration>>()
	const lines = (from: number, to: number, decoration: Decoration) => {
		for (let line = state.doc.lineAt(from).number; line <= state.doc.lineAt(to).number; line++) {
			decorations.push(decoration.range(state.doc.line(line).from))
		}
	}

	for (const { from, to } of view.visibleRanges) {
		syntaxTree(state).iterate({
			from, to,
			enter: node => {
				const parent = node.node.parent?.name
				const tag = inline.get(node.name)
				if (tag) {
					decorations.push(tag.range(node.from, node.to))
				}
				switch (node.name) {
					case 'HeaderMark':
						if (!isActive(node.from)) {
							decorations.push(hidden.range(node.from, parent === 'SetextHeading1' || parent === 'SetextHeading2' ? node.to : trailingSpace(state, node.to)))
						}
						break
					case 'CodeMark': {
						// A code block shows both its fences while the cursor is anywhere in it. Rendered, its language heads
						// it as written, and its closing fence folds away.
						const block = parent === 'FencedCode' ? node.node.parent! : node
						if (!isActive(block.from, block.to)) {
							decorations.push(hidden.range(node.from, node.to))
							if (parent === 'FencedCode' && node.from > block.from) {
								decorations.push(Decoration.line({ class: 'fence' }).range(state.doc.lineAt(node.from).from))
							}
						}
						break
					}
					case 'EmphasisMark':
					case 'StrikethroughMark':
						if (!isActive(node.from)) {
							decorations.push(hidden.range(node.from, node.to))
						}
						break
					case 'QuoteMark':
						if (!isActive(node.from)) {
							decorations.push(hidden.range(node.from, trailingSpace(state, node.to)))
						}
						break
					case 'ListMark': {
						const line = state.doc.lineAt(node.from)
						// The list it is in shows how deep it stands, so its indentation hides on every line.
						const start = /^\s*$/.test(state.sliceDoc(line.from, node.from)) ? line.from : node.from
						if (!isActive(node.from)) {
							decorations.push(hidden.range(start, trailingSpace(state, node.to)))
							break
						}
						decorations.push(written.range(line.from))
						if (start < node.from) {
							decorations.push(hidden.range(start, node.from))
						}
						if (!node.node.parent?.getChild('Task')) {
							decorations.push(listMark.range(node.from, trailingSpace(state, node.to)))
						}
						break
					}
					case 'TaskMarker':
						if (!isActive(node.from)) {
							const checked = state.sliceDoc(node.from + 1, node.to - 1).toLowerCase() === 'x'
							decorations.push(Decoration.replace({ widget: new TaskBox(checked) }).range(node.from, trailingSpace(state, node.to)))
						}
						break
					case 'Link': {
						const marks = node.node.getChildren('LinkMark')
						const href = node.node.getChild('URL')
						if (marks.length < 2 || marks[0]!.to >= marks[1]!.from) {
							break
						}
						if (href) {
							const url = state.sliceDoc(href.from, href.to)
							decorations.push(link(url).range(marks[0]!.to, marks[1]!.from))
						}
						if (!isActive(node.from, node.to)) {
							decorations.push(hidden.range(marks[0]!.from, marks[0]!.to), hidden.range(marks[1]!.from, node.to))
						}
						break
					}
					case 'Image': {
						const href = node.node.getChild('URL')
						const marks = node.node.getChildren('LinkMark')
						const src = href ? state.sliceDoc(href.from, href.to) : ''
						if (src && MarkdownLinks.allows(src) && !isActive(node.from, node.to)) {
							const alt = marks.length >= 2 ? state.sliceDoc(marks[0]!.to, marks[1]!.from) : ''
							decorations.push(Decoration.replace({ widget: new Picture(src, alt) }).range(node.from, node.to))
							return false
						}
						break
					}
					case 'URL':
						if (parent !== 'Link' && parent !== 'Image') {
							const url = state.sliceDoc(node.from, node.to)
							decorations.push(link(url).range(node.from, node.to))
						}
						break
					case 'Autolink':
						if (!isActive(node.from)) {
							for (const mark of node.node.getChildren('LinkMark')) {
								decorations.push(hidden.range(mark.from, mark.to))
							}
						}
						break
					case 'HorizontalRule':
						if (!isActive(node.from)) {
							decorations.push(Decoration.replace({ widget: new Rule() }).range(node.from, node.to))
						}
						break
					case 'Blockquote': {
						const callout = parent === 'Blockquote' ? undefined : calloutOf(state, node)
						if (!callout) {
							break
						}
						const head = state.doc.lineAt(node.from)
						decorations.push(Decoration.line({ class: 'callout-title' }).range(head.from))
						if (!isActive(head.from)) {
							const start = head.from + head.text.indexOf('[!')
							decorations.push(Decoration.replace({ widget: new CalloutIcon(callout.icon, callout.written ? '' : callout.title) }).range(start, start + callout.marker))
						}
						break
					}
					case 'Table':
						// The whole table shows its pipes and delimiter row while the cursor is anywhere in it.
						if (isActive(node.from, node.to)) {
							lines(node.from, node.to, written)
						}
						break
				}
				return undefined
			},
		})
	}
	return Decoration.set(decorations, true)
}

/** Opens a link where its line reads as rendered, or anywhere with Ctrl or ⌘ held. */
function openLink(event: MouseEvent, view: EditorView) {
	const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null
	const href = anchor?.getAttribute('href')
	if (!anchor || !href || event.button !== 0 || !MarkdownLinks.allows(href)) {
		return false
	}
	const line = view.state.doc.lineAt(view.posAtDOM(anchor)).number
	if (activeLines(view).has(line) && !event.ctrlKey && !event.metaKey) {
		return false
	}
	event.preventDefault()
	window.open(href, '_blank', 'noopener')
	return true
}

/** A table's rows, cells and pipes as its component places them, with how many columns it has. */
function tableOf(state: EditorState, table: SyntaxNode, decorations: Array<Range<Decoration>>) {
	const delimiter = table.getChild('TableDelimiter')
	const alignments = delimiter ? MarkdownTable.alignments(state.doc.lineAt(delimiter.from).text) : []
	let columns = 0
	for (let row = table.firstChild; row; row = row.nextSibling) {
		const isDelimiter = row.from === delimiter?.from
		if (row.name !== 'TableHeader' && row.name !== 'TableRow' && !isDelimiter) {
			continue
		}
		const line = state.doc.lineAt(row.from)
		decorations.push(Decoration.line({ class: isDelimiter ? 'row delimiter' : 'row' }).range(line.from))
		for (const { from, to, pipe, column } of MarkdownTable.split(line.text)) {
			const index = (column - 2) / 2
			columns = Math.max(columns, pipe ? 0 : index + 1)
			// An empty cell (`||`) has no text to mark; the cells after it keep their columns.
			if (from === to) {
				continue
			}
			decorations.push(Decoration.mark({
				class: pipe ? 'pipe' : 'cell',
				attributes: { style: MarkdownTable.cellStyle(column, pipe ? undefined : alignments[index]) },
			}).range(line.from + from, line.from + to))
		}
	}
	return columns
}

/** The text of a fenced code block between its fences, which its copy button copies. */
function codeOf(state: EditorState, block: SyntaxNode) {
	const marks = block.getChildren('CodeMark')
	const first = state.doc.lineAt(block.from).number + 1
	const last = state.doc.lineAt(block.to).number - Number(marks.length > 1)
	return first > last ? '' : state.sliceDoc(state.doc.line(first).from, state.doc.line(last).to)
}

class CopyCode extends WidgetType {
	constructor(readonly code: string) {
		super()
	}

	override eq(other: CopyCode) {
		return other.code === this.code
	}

	toDOM() {
		return MarkdownCode.copyButton(() => this.code)
	}
}

/** The elements the rendered description wraps blocks in, around the lines that write them. */
function blocksOf(state: EditorState) {
	const wrappers = new Array<Range<BlockWrapper>>()
	const decorations = new Array<Range<Decoration>>()
	const around = (from: number, to: number) => [state.doc.lineAt(from).from, state.doc.lineAt(to).to] as const
	syntaxTree(state).iterate({
		enter: node => {
			const heading = /^(?:ATX|Setext)Heading(\d)$/.exec(node.name)
			if (heading) {
				// One level down, as the rendered description takes the entry's title for its first.
				const [from, to] = around(node.from, node.to)
				wrappers.push(BlockWrapper.create({ tagName: `h${Math.min(Number(heading[1]) + 1, 6)}`, rank: 10 }).range(from, to))
				return false
			}
			if (node.name === 'Table') {
				const [from, to] = around(node.from, node.to)
				const columns = tableOf(state, node.node, decorations)
				wrappers.push(BlockWrapper.create({ tagName: 'mitra-markdown-table', attributes: { style: MarkdownTable.tableStyle(columns) }, rank: 5 }).range(from, to))
				return false
			}
			if (node.name === 'FencedCode' || node.name === 'CodeBlock') {
				const [from, to] = around(node.from, node.to)
				const info = node.node.getChild('CodeInfo')
				const language = info ? state.sliceDoc(info.from, info.to).match(/^\S*/)![0] : ''
				wrappers.push(BlockWrapper.create({ tagName: 'mitra-markdown-code', attributes: language ? { 'data-language': language } : {}, rank: 20 }).range(from, to))
				if (node.name === 'FencedCode') {
					const head = state.doc.lineAt(node.from)
					decorations.push(
						Decoration.line({ class: 'head' }).range(head.from),
						Decoration.widget({ widget: new CopyCode(codeOf(state, node.node)), side: 1 }).range(head.to),
					)
				}
				return false
			}
			if (node.name === 'BulletList' || node.name === 'OrderedList' || node.name === 'ListItem') {
				// A list nests in the item it is in, and both in a quote around them.
				let depth = 0
				for (let parent = node.node.parent; parent; parent = parent.parent) {
					depth += Number(parent.name === 'ListItem')
				}
				const [from, to] = around(node.from, node.to)
				if (node.name === 'ListItem') {
					const mark = node.node.getChild('ListMark')
					const number = node.node.parent?.name === 'OrderedList' && mark ? parseInt(state.sliceDoc(mark.from, mark.to)) : NaN
					const attributes: Record<string, string> = node.node.getChild('Task') ? { class: 'task' } : {}
					if (!Number.isNaN(number)) {
						attributes.value = String(number)
					}
					wrappers.push(BlockWrapper.create({ tagName: 'li', attributes, rank: 48 - depth * 2 }).range(from, to))
				} else {
					wrappers.push(BlockWrapper.create({ tagName: node.name === 'BulletList' ? 'ul' : 'ol', rank: 49 - depth * 2 }).range(from, to))
				}
				return undefined
			}
			if (node.name === 'Blockquote' && node.node.parent?.name !== 'Blockquote') {
				const callout = calloutOf(state, node)
				const [from, to] = around(node.from, node.to)
				wrappers.push((callout
					? BlockWrapper.create({ tagName: 'mitra-markdown-callout', attributes: { 'data-type': callout.type }, rank: 50 })
					: BlockWrapper.create({ tagName: 'blockquote', rank: 50 })
				).range(from, to))
			}
			return undefined
		},
	})
	return { wrappers: BlockWrapper.set(wrappers, true), decorations: Decoration.set(decorations, true) }
}

/**
 * Blocks, table rows and code heads follow the text alone. Their marks wrap whatever else marks the text, so a table
 * cell stays one element.
 */
const blocks = StateField.define<{ wrappers: RangeSet<BlockWrapper>, decorations: DecorationSet }>({
	create: blocksOf,
	update: (value, transaction) => transaction.docChanged || syntaxTree(transaction.startState) !== syntaxTree(transaction.state) ? blocksOf(transaction.state) : value,
	provide: field => [EditorView.blockWrappers.from(field, value => value.wrappers), EditorView.outerDecorations.from(field, value => value.decorations)],
})

/**
 * A table row's Home and End go to its first and last pipe. CodeMirror finds a line's ends where they show, which in a
 * row laid out as a grid is inside its outer cells.
 */
const rowEnds = (command: Command): Command => view => {
	const { state } = view
	for (let node: SyntaxNode | null = syntaxTree(state).resolveInner(state.doc.lineAt(state.selection.main.head).from, 1); node; node = node.parent) {
		if (node.name === 'Table') {
			return command(view)
		}
	}
	return false
}

/**
 * Live Preview: Markdown reads as rendered, and the lines the cursor is on show it as written. Blocks are the elements
 * the rendered description uses, wrapped around the lines that write them.
 */
export const livePreview = [
	ViewPlugin.fromClass(class {
		decorations: DecorationSet

		constructor(view: EditorView) {
			this.decorations = decorate(view)
		}

		update(update: ViewUpdate) {
			if (update.docChanged || update.selectionSet || update.viewportChanged || update.focusChanged || syntaxTree(update.startState) !== syntaxTree(update.state)) {
				this.decorations = decorate(update.view)
			}
		}
	}, { decorations: plugin => plugin.decorations }),
	blocks,
	EditorView.domEventHandlers({ mousedown: openLink }),
	Prec.high(keymap.of([
		{ key: 'Home', run: rowEnds(cursorLineStart), shift: rowEnds(selectLineStart) },
		{ key: 'End', run: rowEnds(cursorLineEnd), shift: rowEnds(selectLineEnd) },
		{ mac: 'Cmd-ArrowLeft', run: rowEnds(cursorLineStart), shift: rowEnds(selectLineStart) },
		{ mac: 'Cmd-ArrowRight', run: rowEnds(cursorLineEnd), shift: rowEnds(selectLineEnd) },
	])),
]
