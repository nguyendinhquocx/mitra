import { component, css } from '@a11d/lit'
import { IconButton } from './IconButton.js'

/**
 * A code block: a head naming its language with a button that copies it, over the code. The rendered description
 * writes the head and a `pre`; the editor wraps its lines, the opening fence being the head. Neither renders into it,
 * so it is a plain element, and it copies for the rendered description, whose button can't hold a handler.
 */
@component('mitra-markdown-code')
export class MarkdownCode extends HTMLElement {
	static copyLabel() {
		return t('Copy the code')
	}

	/** Copies the text and confirms on the button for a moment. */
	static async copy(button: IconButton, text: string) {
		await navigator.clipboard.writeText(text)
		button.icon = 'check'
		setTimeout(() => button.icon = 'copy', 1500)
	}

	/** The copy button, for the editor, which knows the text it copies. */
	static copyButton(text: () => string) {
		const button = new IconButton()
		button.className = 'copy'
		button.size = 'small'
		button.icon = 'copy'
		button.label = MarkdownCode.copyLabel()
		button.addEventListener('click', () => MarkdownCode.copy(button, text()).catch(() => void 0))
		return button
	}

	constructor() {
		super()
		this.addEventListener('click', event => {
			const button = event.target instanceof Element ? event.target.closest('mitra-icon-button.copy') : null
			const code = this.querySelector(':scope > pre')
			if (button instanceof IconButton && code) {
				MarkdownCode.copy(button, code.textContent ?? '').catch(() => void 0)
			}
		})
	}

	static get styles() {
		return css`
			mitra-markdown-code {
				display: block;
				position: relative;
				margin: 0.8em 0;
				padding: 0.8em 1em;
				font-family: ui-monospace, 'Cascadia Code', monospace;
				font-size: 0.9em;
				white-space: pre-wrap;
				background: color-mix(in srgb, var(--color-text) 6%, transparent);
				border-radius: calc(var(--border-radius) * 2);

				> pre {
					margin: 0;
					font: inherit;
					white-space: inherit;

					code {
						font-size: inherit;
						padding: 0;
						background: none;
					}
				}

				/* The language as written, with room at the end for the button. */
				> .head {
					min-block-size: 1lh;
					padding-inline-end: 2rem;
					color: var(--color-text-muted);
				}

				.copy {
					position: absolute;
					inset-block-start: 0.4em;
					inset-inline-end: 0.4em;
					font-family: var(--font-family);
					opacity: 0;
					transition: opacity 0.15s;
				}

				&:is(:hover, :focus-within) .copy {
					opacity: 1;
				}

				/* The editor's lines carry the block spacing, and the closing fence, where it reads as rendered, folds away.
				   Clipped, as the buffers CodeMirror keeps around its hidden marks would stand a line tall. */
				&:has(> .cm-line) {
					margin-block: 0;
					padding-block: 0;

					> .cm-line:first-child { --mitra-line-padding-start: 0.8em; }
					> .cm-line:last-child { --mitra-line-padding-end: 0.8em; }
					> .cm-line.fence { block-size: 0; overflow: hidden; }
				}
			}
		`
	}
}

declare global {
	interface HTMLElementTagNameMap {
		'mitra-markdown-code': MarkdownCode
	}
}
