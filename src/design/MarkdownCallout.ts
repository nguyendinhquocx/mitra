import { component, css } from '@a11d/lit'

/**
 * A callout (`> [!tip] Title`), the box the rendered description draws around its paragraphs and the editor around the
 * lines that write it. Neither renders into it, so it is a plain element.
 */
@component('mitra-markdown-callout')
export class MarkdownCallout extends HTMLElement {
	static readonly icons = new Map<string, string>([
		['note', 'info'],
		['info', 'info'],
		['tip', 'lightbulb'],
		['success', 'circle-check'],
		['important', 'message-square-warning'],
		['warning', 'triangle-alert'],
		['caution', 'octagon-alert'],
		['danger', 'octagon-alert'],
		['error', 'octagon-alert'],
	])

	private static readonly head = /^\[!(\w+)\][ \t]*(.*)/

	/** What a quote's first line, without its `>`, declares: no callout unless it starts with `[!type]`. */
	static of(line: string) {
		const match = MarkdownCallout.head.exec(line.trim())
		if (!match) {
			return undefined
		}
		const type = match[1]!.toLowerCase()
		return {
			type,
			icon: MarkdownCallout.icons.get(type) ?? 'info',
			/** The title as written, which is the type's name when none is. */
			title: match[2]!.trim() || type.charAt(0).toUpperCase() + type.slice(1),
			written: !!match[2]!.trim(),
			/** Characters the `[!type]` marker and the space after it take. */
			marker: match[0].length - match[2]!.length,
		}
	}

	static get styles() {
		return css`
			mitra-markdown-callout {
				/* The calendar palette, and the mixes an entry's chip takes from its color. */
				--callout-color: var(--color-palette-blue);
				display: block;
				margin: 0.8em 0;
				padding: 0.5em 0.85em;
				border-inline-start: 3px solid var(--callout-color);
				border-radius: calc(var(--border-radius) * 1.5);
				background: color-mix(in srgb, var(--callout-color) 15%, transparent);
				/* The text tinted toward the callout, as muted text is to the title: readable on either theme. */
				color: color-mix(in srgb, var(--callout-color) 40%, currentColor);

				&[data-type=tip], &[data-type=success] { --callout-color: var(--color-palette-green); }
				&[data-type=important] { --callout-color: var(--color-palette-purple); }
				&[data-type=warning] { --callout-color: var(--color-palette-yellow); }
				&[data-type=caution], &[data-type=danger], &[data-type=error] { --callout-color: var(--color-palette-red); }

				> * { margin-block: 0.35em; }
				> :first-child { margin-block-start: 0; }
				> :last-child { margin-block-end: 0; }

				/* The icon hangs before the title, so the title and the text under it start at one edge. */
				--callout-icon: 1.4em;
				padding-inline-start: calc(0.85em + var(--callout-icon));

				.callout-title {
					color: color-mix(in srgb, var(--callout-color) 60%, var(--color-text));
					font-weight: 600;

					mitra-icon {
						vertical-align: -0.125em;
						inline-size: 1em;
						margin-inline: calc(-1 * var(--callout-icon)) calc(var(--callout-icon) - 1em);
					}
				}

				/* Around the editor's lines, which CodeMirror measures and nothing between them, its block spacing is theirs. */
				&:has(> .cm-line) {
					margin-block: 0;
					padding-block: 0;

					> .cm-line { margin-block: 0; }
					> .cm-line:first-child { --mitra-line-padding-start: 0.5em; }
					> .cm-line:last-child { --mitra-line-padding-end: 0.5em; }
				}
			}
		`
	}
}

declare global {
	interface HTMLElementTagNameMap {
		'mitra-markdown-callout': MarkdownCallout
	}
}
