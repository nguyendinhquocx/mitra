import { Component, component, css, event, html, property, query, type PropertyValues } from '@a11d/lit'
import type { MarkdownEditorView } from './markdownEditorView.js'

/** Markdown written as its source, its formatting shown as it is typed. CodeMirror loads with the first one shown. */
@component('mitra-markdown-editor')
export class MarkdownEditor extends Component {
	/** On every edit, `value` already current, so `bind()` takes it. */
	@event() readonly edit!: EventDispatcher<string>
	/** Once an edit is done: on leaving the editor, or at once for one made from outside it, as ticking a box. */
	@event() readonly change!: EventDispatcher<string>

	@property({ bindingDefault: true, event: 'edit' }) value = ''
	@property() placeholder = ''
	@property() label?: string

	@query('.editor') private readonly container!: HTMLElement

	private view?: MarkdownEditorView
	private dirty = false

	protected override createRenderRoot() { return this }

	protected override async connected() {
		const [{ MarkdownEditorView }] = await Promise.all([import('./markdownEditorView.js'), this.updateComplete])
		if (!this.isConnected || this.view) {
			return
		}
		this.view = new MarkdownEditorView({
			parent: this.container,
			value: this.value,
			placeholder: this.placeholder,
			label: this.label,
			onEdit: (value, focused) => {
				this.value = value
				this.edit.dispatch(value)
				if (focused) {
					this.dirty = true
				} else {
					this.change.dispatch(value)
				}
			},
			onBlur: () => {
				if (this.dirty) {
					this.dirty = false
					this.change.dispatch(this.value)
				}
			},
		})
		this.requestUpdate()
	}

	protected override disconnected() {
		this.view?.destroy()
		this.view = undefined
	}

	protected override updated(props: PropertyValues<this>) {
		super.updated(props)
		if (this.view && props.has('value')) {
			this.view.value = this.value
		}
	}

	override focus() {
		this.view?.focus()
	}

	static override get styles() {
		return css`
			mitra-markdown-editor {
				display: block;
				min-inline-size: 0;

				> .loading {
					white-space: pre-wrap;
					overflow-wrap: break-word;
				}

				/* CodeMirror measures its lines, not what wraps them, so a wrapper's block spacing moves onto its lines. */
				.cm-content > :is(h1, h2, h3, h4, h5, h6) {
					margin-block: 0;
					> .cm-line { --mitra-line-padding-start: 1.4em; --mitra-line-padding-end: 0.5em; }
				}
				.cm-content > :first-child > .cm-line:first-child { --mitra-line-padding-start: 0; }
				.cm-content blockquote { margin-block: 0; padding-block: 0; }

				a { cursor: pointer; }

				/* A list's lines carry its items' spacing, and a line shown as written hangs its marker where the rendered one stood. */
				.cm-content :is(ul, ol) { margin-block: 0; }
				.cm-content li {
					margin-block: 0;
					> .cm-line:first-child { --mitra-line-padding-start: 0.2em; }
					&:has(> .cm-line.written:first-child)::marker { content: none; }
				}
				.list-mark {
					display: inline-block;
					min-inline-size: 1.4em;
					margin-inline-start: -1.4em;
				}
				.cm-content li.task {
					display: list-item;
					/* The box takes the space after it, so a done task's line-through starts at its text. */
					> .cm-line:first-child mitra-checkbox { margin-inline-end: 0.5em; }
					&:has(> .cm-line:first-child mitra-checkbox[checked]) > .cm-line:first-child {
						color: var(--color-text-muted);
						text-decoration: line-through;
					}
				}
				/* A rule stands inline in the one line its --- takes, beside the buffers CodeMirror keeps around a widget, so
				   nothing moves as the cursor reaches it. */
				.cm-line > hr { display: inline-block; inline-size: 100%; margin: 0; vertical-align: middle; }
				.cm-line > img { vertical-align: bottom; }

				.cm-content mitra-checkbox {
					vertical-align: baseline;
					&::part(checkbox) { inline-size: 1.1em; block-size: 1.1em; translate: 0 0.15em; }
					&::part(checkbox)::before { inline-size: 0.8em; block-size: 0.8em; }
				}
			}
		`
	}

	// Until CodeMirror arrives the text stands as it is, so the field doesn't jump when it does. CodeMirror gets an
	// element of its own, as lit clears whatever follows its own content in the host.
	protected override get template() {
		return html`
			${this.view ? html.nothing : html`<div class="loading">${this.value}</div>`}
			<div class="editor"></div>
		`
	}
}

declare global {
	interface HTMLElementTagNameMap {
		'mitra-markdown-editor': MarkdownEditor
	}
}
