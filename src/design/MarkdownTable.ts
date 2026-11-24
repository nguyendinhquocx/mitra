import { component, css } from '@a11d/lit'

export type MarkdownTableAlignment = 'start' | 'center' | 'end'

/**
 * A table as a grid, the rendered description's and the editor's alike: each row a subgrid of its columns, each cell
 * placed in its column, so a row missing a cell still lines up. Between two columns runs a gutter of no width, where
 * the editor's pipes stand while the cursor is in the table. Neither renders into it, so it is a plain element.
 */
@component('mitra-markdown-table')
export class MarkdownTable extends HTMLElement {
	/** A row's cells and pipes as written, by offset, each with the grid column it takes. An escaped pipe is text. */
	static split(row: string) {
		const pipes = [...row.matchAll(/(?<!\\)\|/g)].map(match => match.index)
		const items = new Array<{ from: number, to: number, pipe: boolean }>()
		let at = 0
		pipes.forEach((pipe, index) => {
			// Leading space joins the first pipe, as trailing space does the last.
			if (index > 0 || row.slice(at, pipe).trim()) {
				items.push({ from: at, to: pipe, pipe: false })
				at = pipe
			}
			items.push({ from: at, to: pipe + 1, pipe: true })
			at = pipe + 1
		})
		if (row.slice(at).trim() || !items.length) {
			items.push({ from: at, to: row.length, pipe: false })
		} else {
			items.at(-1)!.to = row.length
		}
		const first = items[0]?.pipe ? 1 : 2
		return items.map((item, index) => ({ ...item, column: first + index }))
	}

	/** Each column's alignment, as the delimiter row writes it: `:---`, `:---:` or `---:`. */
	static alignments(delimiter: string) {
		return MarkdownTable.split(delimiter).filter(item => !item.pipe).map(item => {
			const text = delimiter.slice(item.from, item.to).trim()
			return text.endsWith(':') ? (text.startsWith(':') ? 'center' : 'end') : text.startsWith(':') ? 'start' : undefined
		}) satisfies Array<MarkdownTableAlignment | undefined>
	}

	/** The grid column of a row's cell by its index among the cells. */
	static column(index: number) {
		return index * 2 + 2
	}

	static cellStyle(column: number, alignment?: MarkdownTableAlignment) {
		return `grid-column: ${column}${alignment ? `; text-align: ${alignment}` : ''}`
	}

	static tableStyle(columns: number) {
		return `--columns: ${columns}`
	}

	static get styles() {
		return css`
			mitra-markdown-table {
				--rule: color-mix(in srgb, var(--color-text) 10%, transparent);
				display: grid;
				grid-template-columns: repeat(var(--columns, 1), 0 auto) 0;
				margin: 0.8em 0;
				font-size: 0.95em;

				> .row {
					display: grid;
					--mitra-line-display: grid;
					grid-column: 1 / -1;
					grid-template-columns: subgrid;
					border-block-end: 1px solid var(--rule);
				}

				> .row:first-child {
					font-weight: 600;
					background: color-mix(in srgb, var(--color-text) 6%, transparent);
				}

				> .row:last-child {
					border-block-end: none;
				}

				.cell {
					padding: 0.4em 0.7em;
					text-align: start;
				}

				/* Centred on its gutter, which has no width, so a pipe moves nothing as it shows. */
				/* It keeps the space written around it on its line, which would otherwise wrap in a gutter that narrow. */
				.pipe {
					justify-self: center;
					padding-block: 0.4em;
					white-space: pre;
					visibility: hidden;
					--mitra-markup-color: var(--rule);
					--mitra-markup-opacity: 1;
				}

				/* The editor's lines: pipes and the delimiter row show while the cursor is in the table. */
				&:has(> .cm-line) {
					margin-block: 0;
				}

				> .row.written .pipe {
					visibility: visible;
				}

				> .row.delimiter:not(.written) {
					block-size: 0;
					overflow: hidden;
					border-block-end: none;
				}
			}
		`
	}
}

declare global {
	interface HTMLElementTagNameMap {
		'mitra-markdown-table': MarkdownTable
	}
}
