import { Component, component, html, svg, css, property, event, query } from '@a11d/lit'
import type { Slider, Menu } from '#design'
import { hierarchy } from '#features/relations/client/Hierarchy.js'
import { type Entry, type EntryRollup } from '../Entry.js'
import { EntryStatus } from '../EntryStatus.js'
import { EntryStore } from './EntryStore.js'

/**
 * The status control of an entry: a task's checkbox, ticked by a click, with its statuses and progress in a menu; an
 * event's glyph, whose click opens the menu of its statuses, since there is nothing to tick. Either one's outline fills
 * with the progress of the steps beneath it.
 */
@component('mitra-entry-status')
export class EntryStatusComponent extends Component {
	@property({ type: Object }) entry!: Entry

	/** Fired after the entry's status or progress is mutated in place, so the host can persist and re-render. */
	@event() readonly change!: EventDispatcher

	readonly store = new EntryStore(this, { entry: () => this.entry })

	protected override createRenderRoot() { return this }

	/** Whether the control says more of `entry` than what kind it is, so a chip or a link gives it room: a task's checkbox always, an event's glyph once it is a maybe, cancelled, or has steps to count. */
	static saysMoreOf(entry: Entry) {
		return entry.type.isTask || (!!entry.status && entry.status !== EntryStatus.Confirmed) || entry.hierarchy.statedProgress !== undefined
	}

	/** The glyphs as dials: the outline that fills with the progress, drawn from where a box's does, and the marks within it. */
	private static readonly dials = {
		task: { frame: 'M3 19V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2', marks: 'M8 12h8' },
		event: { frame: 'M3 20V6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2', marks: 'M8 2v4M16 2v4M3 10h18' },
		// A maybe's calendar ends where its clock sits, as its glyph's does.
		maybe: { frame: 'M8.5 22H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v1.5', marks: 'M8 2v4M16 2v4M3 10h5M17.5 17.5 16 16.3V14M22 16a6 6 0 1 1-12 0 6 6 0 0 1 12 0' },
	}

	private get task() {
		return this.entry?.type.isTask ?? false
	}

	/** Whether a click ticks it off: a task where its calendar has Done. */
	private get tickable() {
		return this.entry.statuses.includes(EntryStatus.Done)
	}

	private get dial() {
		return this.task ? EntryStatusComponent.dials.task : this.status === EntryStatus.Tentative ? EntryStatusComponent.dials.maybe : EntryStatusComponent.dials.event
	}

	/** The status shown: an event with none is on, a task with none to do, and a task in progress reads as Doing where its calendar has it. */
	private get status() {
		const status = this.entry.effectiveStatus
		if (!this.task || status.closed) {
			return status
		}
		// Progress reads as Doing only where a task can be Doing; a calendar of two states shows it To Do.
		if (this.entry.hierarchy.partlyDone && this.entry.statuses.includes(EntryStatus.Doing)) {
			return EntryStatus.Doing
		}
		return status
	}

	private get progress() {
		return this.status === EntryStatus.Done ? 1 : this.entry.hierarchy.progress
	}

	private get progressLabel() {
		const rollup = this.entry.hierarchy.rollup
		if (rollup?.total) {
			return EntryStatusComponent.summarize(rollup)
		}
		const progress = this.progress
		return progress === undefined ? undefined : t('${percent} complete', { percent: Math.round(progress * 100).formatAsPercent() })
	}

	/** Formats progress summary label adapted by step type (subtasks, checklist items, or steps). */
	private static summarize(rollup: EntryRollup) {
		if (!rollup.checklist.total) {
			return t('${done:number} of ${total:pluralityNumber} subtasks done', rollup)
		}
		if (!rollup.subtasks.total) {
			return t('${done:number} of ${total:pluralityNumber} checklist items done', rollup)
		}
		return t('${done:number} of ${total:pluralityNumber} steps done', rollup)
	}

	@query('mitra-menu') private readonly menu?: Menu

	/** Sets the status; an event's Confirmed is its none, as an event without STATUS takes place, so nothing is written for it. */
	private commit(status: EntryStatus) {
		const value = !this.task && status === EntryStatus.Confirmed ? undefined : status
		if (this.entry.status === value) {
			this.menu?.hide()
			return
		}
		this.entry.status = value
		this.menu?.hide()
		this.requestUpdate()
		this.change.dispatch()
	}

	/** Opens leftover subtask closure prompt from the menu. */
	private readonly closeOutSubtasks = (e: Event) => {
		e.stopPropagation()
		this.menu?.hide()
		void hierarchy.offerToCloseSubtasks(this.entry).catch(() => void 0)
	}

	private readonly clearPercent = (e: Event) => {
		e.stopPropagation()
		this.entry.progress = undefined
		this.requestUpdate()
		this.change.dispatch()
	}

	private readonly handleSliderInput = (e: Event) => {
		e.stopPropagation()
		this.entry.progress = (e.target as Slider).value / 100
		this.requestUpdate()
		this.change.dispatch()
	}

	private readonly onToggle = (e: MouseEvent) => {
		e.stopPropagation()
		e.preventDefault()
		if (e.altKey || !this.tickable) {
			this.menu?.toggle(e.currentTarget as HTMLElement)
			return
		}
		this.commit(this.entry.done ? EntryStatus.ToDo : EntryStatus.Done)
	}

	private readonly onContextMenu = (e: MouseEvent) => {
		e.preventDefault()
		e.stopPropagation()
		this.menu?.toggle(e.currentTarget as HTMLElement)
	}

	private readonly pick = (status: EntryStatus) => (e: Event) => {
		e.stopPropagation()
		this.commit(status)
	}

	static override get styles() {
		return css`
			@keyframes dial-orbit {
				from {
					stroke-dashoffset: 0;
				}
				to {
					stroke-dashoffset: -100;
				}
			}

			mitra-entry-status {
				display: inline-flex;
				flex-shrink: 0;
				position: relative;

				> button.status-button {
					all: unset;
					display: inline-flex;
					align-items: center;
					justify-content: center;
					inline-size: 100%;
					block-size: 100%;
					cursor: pointer;
					color: inherit;
					box-sizing: border-box;

					svg, mitra-icon {
						inline-size: 100%;
						block-size: 100%;
						display: flex;
						align-items: center;
						justify-content: center;
						font-size: inherit;
					}

					svg {
						.progress-track {
							opacity: 0.6;
						}

						.progress-stroke {
							stroke-dashoffset: 0;
						}
					}
				}

				&[data-status='doing'] > button.status-button svg .progress-stroke {
					animation: dial-orbit 11s linear infinite;

					@media (prefers-reduced-motion: reduce) {
						animation: none;
					}
				}

				> mitra-menu {
					min-inline-size: 11.5rem;

					.progress-section {
						margin-block-start: 0.375rem;
						padding-block-start: 0.375rem;
						border-block-start: 1px solid color-mix(in srgb, var(--color-text) 10%, transparent);
						display: flex;
						flex-direction: column;
						gap: 0.375rem;
						padding-inline: 0.375rem;

						.progress-header {
							display: flex;
							align-items: center;
							justify-content: space-between;
							font-size: 0.75rem;
							color: var(--color-text-muted);
							min-block-size: 1.25rem;

							.value-group {
								display: flex;
								align-items: center;
								gap: 0.25rem;
								min-block-size: 1.25rem;

								.clear {
									color: var(--color-text-muted);
									margin-block: -0.25rem;
								}
							}

							.value {
								font-variant-numeric: tabular-nums;
								font-weight: 600;
								color: var(--color-text);

								&.none {
									font-weight: 400;
									color: var(--color-text-muted);
								}
							}
						}

						mitra-slider {
							margin-block-end: -0.25rem;
						}

						&.subtasks {
							mitra-progress {
								margin-block: 0.125rem;
							}

							.progress-summary {
								display: flex;
								align-items: center;
								gap: 0.375rem;
								padding-block-start: 0.125rem;
								font-size: 0.75rem;
								color: var(--color-text-muted);

								mitra-icon {
									font-size: 0.8125rem;
								}

								&.leftover {
									all: unset;
									display: flex;
									align-items: center;
									gap: 0.375rem;
									padding: 0.1875rem 0.25rem;
									margin-inline: -0.25rem;
									border-radius: var(--border-radius);
									cursor: pointer;
									font-size: 0.75rem;
									color: var(--color-text-muted);
									box-sizing: border-box;

									&:hover, &:focus-visible {
										color: var(--color-text);
										background: color-mix(in srgb, var(--color-text) 10%, transparent);
									}

									> .go {
										margin-inline-start: auto;
									}
								}
							}
						}
					}
				}

			}
		`
	}

	private get progressSectionTemplate() {
		const rollup = this.entry.hierarchy.rollup
		if (rollup?.total) {
			// RFC 5545 §3.8.1.8: a completed task reads 100%.
			const value = Math.round((this.progress ?? rollup.progress) * 100)
			const leftover = this.entry.closed && rollup.subtasks.done < rollup.subtasks.total
			const summary = EntryStatusComponent.summarize(rollup)
			return html`
				<div class="progress-section subtasks">
					<div class="progress-header">
						<span>${t('Progress')}</span>
						<span class="value">${value.formatAsPercent()}</span>
					</div>
					<mitra-progress .value=${value / 100}></mitra-progress>
					${!leftover ? html`
						<div class="progress-summary">
							<mitra-icon icon="chart-pie"></mitra-icon>
							<span>${summary}</span>
						</div>
					` : html`
						<button class="progress-summary leftover" title=${t('Close out the subtasks that are still open')}
							@click=${this.closeOutSubtasks}>
							<mitra-icon icon="chart-pie"></mitra-icon>
							<span>${summary}</span>
							<mitra-icon class="go" icon="chevron-right"></mitra-icon>
						</button>
					`}
				</div>
			`
		}

		if (!this.entry.holds('percentComplete')) {
			return html.nothing
		}

		const progress = this.progress
		const value = progress === undefined ? 0 : Math.round(progress * 100)
		return html`
			<div class="progress-section custom">
				<div class="progress-header">
					<span>${t('Progress')}</span>
					${progress === undefined ? html`
						<span class="value none">${t('None')}</span>
					` : html`
						<div class="value-group">
							<span class="value">${value.formatAsPercent()}</span>
							<mitra-icon-button size="small" class="clear" icon="x" label=${t('Clear custom progress')} @click=${this.clearPercent}></mitra-icon-button>
						</div>
					`}
				</div>
				<mitra-slider label=${t('Progress')} step="5" .value=${value}
					@input=${this.handleSliderInput}
					@click=${(e: Event) => e.stopPropagation()}
				></mitra-slider>
			</div>
		`
	}

	protected override get template() {
		// A calendar that holds no status still shows how far the steps of its entries are.
		if (!this.entry?.statuses.length && this.entry?.hierarchy.statedProgress === undefined) {
			return html.nothing
		}

		this.setAttribute('data-status', this.status.code)

		const readout = this.progressLabel
		const name = readout ? `${this.status.format()} (${readout})` : this.status.format()
		const progress = this.progress
		const showsProgressDial = this.status === EntryStatus.Doing || this.entry.hierarchy.statedProgress !== undefined
		const percent = progress !== undefined ? Math.round(progress * 100) : 50
		const hint = this.tickable ? t('${status}. Click to toggle, Alt-click for options', { status: name }) : t('${status}. Click for options', { status: name })
		const title = this.entry.editable ? hint : name

		return html`
			<button class="status-button" aria-label=${name} ?disabled=${!this.entry.editable}
				title=${title}
				@click=${this.onToggle}
				@contextmenu=${this.onContextMenu}>
				${showsProgressDial ? html`
					<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
						<path class="progress-track" d=${this.dial.frame}></path>
						${!percent ? html.nothing : svg`
							<path class="progress-stroke" d=${this.dial.frame} pathLength="100" stroke-dasharray="${percent} ${100 - percent}"></path>
						`}
						<path d=${this.dial.marks}></path>
					</svg>
				` : html`
					<mitra-icon icon=${this.status.iconFor(this.entry.type)}></mitra-icon>
				`}
			</button>
			<mitra-menu>
				${this.entry.statuses.map(status => html`
					<mitra-menu-item type="radio" icon=${status.iconFor(this.entry.type)} ?selected=${status === this.status} @click=${this.pick(status)}>${status.format()}</mitra-menu-item>
				`)}
				${this.progressSectionTemplate}
			</mitra-menu>
		`
	}
}

declare global {
	interface HTMLElementTagNameMap {
		'mitra-entry-status': EntryStatusComponent
	}
}
