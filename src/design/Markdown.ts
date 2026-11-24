import { Component, component, css, html, property } from '@a11d/lit'
import { Renderer, type Tokens } from 'marked'
import './Checkbox.js'
import { MarkdownLinks } from './MarkdownLinks.js'
import { MarkdownCallout } from './MarkdownCallout.js'
import { MarkdownCode } from './MarkdownCode.js'
import { MarkdownTable, type MarkdownTableAlignment } from './MarkdownTable.js'

export class MarkdownRenderer extends Renderer {
	override heading(token: Tokens.Heading) {
		return super.heading({ ...token, depth: Math.min(token.depth + 1, 6) })
	}

	override listitem(token: Tokens.ListItem) {
		const content = super.listitem(token)
		const input = token.task ? content.match(/<mitra-checkbox\b[^>]*><\/mitra-checkbox>/)?.[0] : undefined
		return !input ? content : content
			.replace(input, '')
			.replace('<li>', `<li class="task">${input}<div class="label">`)
			.replace(/<\/li>\s*$/, '</div></li>\n')
	}

	override checkbox({ checked }: Tokens.Checkbox) {
		return `<mitra-checkbox${checked ? ' checked' : ''} disabled></mitra-checkbox>`
	}

	/**
	 * Links render as `mitra-link`, which shows where they lead; marked's own anchor carries the escaped
	 * address. A bare address drops its words so the link names its destination. A scheme that would run code
	 * renders its words alone.
	 */
	override link(token: Tokens.Link) {
		if (!MarkdownLinks.allows(token.href)) {
			return this.parser.parseInline(token.tokens)
		}
		return super.link(MarkdownLinks.isBare(token) ? { ...token, text: '', tokens: [] } : token)
			.replace(/^<a /, '<mitra-link ')
			.replace(/<\/a>$/, '</mitra-link>')
	}

	override blockquote(token: Tokens.Blockquote) {
		const [head = '', ...body] = token.text.split('\n')
		const callout = MarkdownCallout.of(head)
		if (!callout) {
			return super.blockquote(token)
		}
		const title = callout.written ? this.parser.parseInline(MarkdownLinks.marked.Lexer.lexInline(callout.title)) : callout.title
		return `
			<mitra-markdown-callout data-type="${callout.type}">
				<div class="callout-title"><mitra-icon icon="${callout.icon}"></mitra-icon>${title}</div>
				${this.parser.parse(MarkdownLinks.marked.lexer(body.join('\n')))}
			</mitra-markdown-callout>
		`
	}

	override table(token: Tokens.Table) {
		const alignments: Record<string, MarkdownTableAlignment> = { left: 'start', center: 'center', right: 'end' }
		const row = (cells: Array<Tokens.TableCell>, role: string) => `<div class="row" role="row">${cells.map((cell, index) => `
			<div class="cell" role="${role}" style="${MarkdownTable.cellStyle(MarkdownTable.column(index), cell.align ? alignments[cell.align] : undefined)}">${this.parser.parseInline(cell.tokens)}</div>
		`).join('')}</div>`
		return `
			<mitra-markdown-table role="table" style="${MarkdownTable.tableStyle(token.header.length)}">
				${row(token.header, 'columnheader')}
				${token.rows.map(cells => row(cells, 'cell')).join('')}
			</mitra-markdown-table>
		`
	}

	override code(token: Tokens.Code) {
		const language = MarkdownRenderer.escape(token.lang?.match(/^\S*/)?.[0] ?? '')
		const head = token.codeBlockStyle === 'indented' ? '' : `
			<div class="head">${language}<mitra-icon-button class="copy" size="small" icon="copy" label="${MarkdownRenderer.escape(MarkdownCode.copyLabel())}"></mitra-icon-button></div>
		`
		return `<mitra-markdown-code${language ? ` data-language="${language}"` : ''}>${head}${super.code(token).trim()}</mitra-markdown-code>`
	}

	private static escape(text: string) {
		return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
	}

	render(markdown: string) {
		// Raw HTML is renamed into inert tags, under a prefix none of the description's own elements takes; an autolink
		// (`<scheme:…>`, `<name@host>`) is Markdown, not a tag.
		markdown = markdown
			.replaceAll(/<(?!\/|[a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s<>]*>|[^\s<>@]+@[^\s<>]+>)(.)([^>]+)>/g, '<mitra-raw-$1$2>')
			.replaceAll(/<\/(.*)>/g, '</mitra-raw-$1>')
		return MarkdownLinks.marked.parse(markdown, { renderer: this, async: false })
	}
}

@component('mitra-markdown')
export class Markdown extends Component {
	@property() value = ''

	protected readonly renderer = new MarkdownRenderer()

	protected override createRenderRoot() { return this }

	static override get styles() {
		// The prose of both the rendered and the edited description: the editor wraps its text in the same elements.
		return css`
			:is(mitra-markdown, mitra-markdown-editor) {
				display: block;
				color: var(--color-text);
				line-height: 1.6;
				overflow-wrap: break-word;
				main > :first-child { margin-block-start: 0; }
				main > :last-child { margin-block-end: 0; }

				h1, h2, h3, h4, h5, h6 {
					margin: 1.4em 0 0.5em;
					font-weight: 600;
					line-height: 1.3;
				}

				h1 { font-size: 1.5em; }
				h2 { font-size: 1.3em; }
				h3 { font-size: 1.15em; }
				h4, h5, h6 { font-size: 1em; }

				p {
					margin: 0.6em 0;
				}

				a {
					color: var(--color-accent);
					text-decoration: none;

					&:hover {
						text-decoration: underline;
					}
				}

				strong { font-weight: 600; }
				em { font-style: italic; }

				ul, ol {
					margin: 0.6em 0;
					padding-inline-start: 1.4em;
				}

				li {
					margin: 0.2em 0;

					&::marker {
						color: var(--color-text-muted);
					}
				}

				li.task {
					list-style: none;
					display: grid;
					grid-template-columns: auto minmax(0, 1fr);
					gap: 0.5em;
					align-items: start;
					margin-inline-start: -1.4em;

					/* Sized to the prose rather than to the control height, and a read-only list is not a disabled one. */
					> mitra-checkbox {
						margin-block-start: calc((1lh - 1.1em) / 2);

						&::part(checkbox) {
							inline-size: 1.1em;
							block-size: 1.1em;
						}

						&::part(checkbox)::before {
							inline-size: 0.8em;
							block-size: 0.8em;
						}

						&[disabled]::part(checkbox) {
							opacity: 1;
							cursor: default;
						}
					}

					> .label {
						> :first-child { margin-block-start: 0; }
						> :last-child { margin-block-end: 0; }
					}

					&:has(> mitra-checkbox[checked]) > .label {
						color: var(--color-text-muted);
						text-decoration: line-through;
					}
				}

				blockquote {
					margin: 0.8em 0;
					padding: 0.1em 0 0.1em 0.9em;
					border-inline-start: 3px solid color-mix(in srgb, var(--color-accent) 55%, transparent);
					color: var(--color-text-muted);
				}

				code {
					font-family: ui-monospace, 'Cascadia Code', monospace;
					font-size: 0.9em;
					background: color-mix(in srgb, var(--color-text) 8%, transparent);
					padding: 0.1em 0.35em;
					border-radius: var(--border-radius);
				}

				hr {
					margin: 1.4em 0;
					border: 0;
					height: 1px;
					background: color-mix(in srgb, var(--color-text) 12%, transparent);
				}

				img {
					max-width: 100%;
					border-radius: calc(var(--border-radius) * 2);
				}
			}
		`
	}

	protected override get template() {
		return html`<main .innerHTML=${this.renderer.render(this.value)}></main>`
	}
}

declare global {
	interface HTMLElementTagNameMap {
		'mitra-markdown': Markdown
	}
}
