import { bind, component, css, html, state, type PropertyValues } from '@a11d/lit'
import { PageComponent, route } from '@a11d/lit-application'
import { Task, TaskStatus } from '@lit/task'
import { Api } from '@a11d/api'
import { DateTime, DateTimeRange } from '@3mo/date-time'
import { ScheduleDefaults } from '#features/entries/ScheduleDefaults.js'
import { EntryStore } from '#features/entries/client/EntryStore.js'
import { EntryEditorIntent } from '#features/entries/client/EntryEditorIntent.js'
import { ListEntries } from '#operations'
import { Calendars } from '#features/sources/client/Calendars.js'
import { MitraCalendar } from '#integrations/mitra/MitraCalendar.js'
import { Integration } from '#integrations'
import { Color, Source } from '#features/sources'
import { EntryType } from '#features/entries'
import { UpdatesStream } from './UpdatesStream.js'

/**
 * The guest surface a share link opens at `/s`. It bootstraps itself alone: the fragment's token is exchanged
 * for a scoped session cookie, the fragment is wiped from the address at once, and only the link's scope is
 * fetched and rendered. Nothing of the owner's account runs here — no sign-in, no integrations, no settings.
 */
@component('calendarx-page-guest')
@route('/s')
export class PageGuest extends PageComponent {
	@state() phase: 'opening' | 'ready' | 'revoked' | 'failed' = 'opening'
	@state() failure?: string
	@state() guestRole: 'view' | 'edit' = 'view'
	@state() view: 'week' | 'month' = 'week'
	@state() navigatingDate = new DateTime()
	@state() targetName = ''
	@state() overlayNames: Array<string> = []

	private focusEntryId?: string
	private stream?: UpdatesStream

	readonly store = new EntryStore(this)

	readonly fetcher = new Task(this, {
		args: () => [this.phase, this.view, this.navigatingDate.month] as const,
		// No autoRun: the first render happens before the exchange has pointed the API at /s, and a stray request to
		// the owner's API from a link holder is exactly what this surface exists to prevent.
		autoRun: false,
		task: async () => {
			// The window answers the period in view, so paging away keeps bringing its entries, not today's.
			const today = this.navigatingDate
			const start = this.view === 'week'
				? today.subtract({ days: 21 })
				: today.monthStart.subtract({ months: 2 })
			const end = this.view === 'week'
				? today.add({ days: 21 })
				: today.monthEnd.add({ months: 2 })
			const window = new DateTimeRange(start, end)
			const entries = await ListEntries.call({ start, end })
			return { entries, window }
		},
		onComplete: ({ entries, window }) => {
			EntryStore.applyServerEntries(entries, window)
			if (this.focusEntryId) {
				EntryEditorIntent.requestOpen(this.focusEntryId)
			}
		},
	})

	protected override async connected() {
		const hash = location.hash.startsWith('#') ? location.hash.slice(1) : ''
		if (hash) {
			// The fragment carries the token once; it leaves the address before anything renders or logs it.
			history.replaceState(null, '', location.pathname)
			const [token, entryParameter] = hash.split('&')
			const opened = await fetch('/s/api/exchange', {
				method: 'POST',
				credentials: 'include',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ token }),
			})
			if (!opened.ok) {
				this.phase = opened.status === 410 ? 'revoked' : 'failed'
				this.failure = ((await opened.json().catch(() => undefined)) as { error?: string } | undefined)?.error
				return
			}
			if (entryParameter?.startsWith('entry=')) {
				this.focusEntryId = entryParameter.slice('entry='.length)
			}
		}
		const bootstrap = await fetch('/s/api/bootstrap', { credentials: 'include' })
		if (!bootstrap.ok) {
			this.phase = bootstrap.status === 410 ? 'revoked' : 'failed'
			this.failure = bootstrap.status === 401
				? t('This share session has ended. Reopen the link')
				: ((await bootstrap.json().catch(() => undefined)) as { error?: string } | undefined)?.error
			return
		}
		const scope = await bootstrap.json() as {
			role: 'view' | 'edit'
			target: { id: string, name: string, color?: string }
			overlays: Array<{ id: string, name: string, color?: string }>
		}
		this.guestRole = scope.role
		this.targetName = scope.target.name
		this.overlayNames = scope.overlays.map(overlay => overlay.name)

		// A stand-in integration holds only the sources this link reaches; nothing of the owner's account loads here.
		const integration = new MitraCalendar({ uri: MitraCalendar.uri })
		integration.sources = [scope.target, ...scope.overlays].map((source, index) => new Source({
			id: source.id,
			integrationId: integration.id,
			uri: MitraCalendar.sourceUri(source.id),
			name: source.name,
			color: source.color ? Color.parse(source.color) : undefined,
			entryTypes: [EntryType.Event, EntryType.Task],
			// A view-only link's sources read as read-only, so the editor arrives without its mutation actions.
			readOnly: this.guestRole !== 'edit',
			enabled: true,
			hidden: false,
			order: index,
		}))
		Calendars.adopt([integration as Integration])

		// Every operation the guest surface calls now reaches the guest routes, never the owner's API.
		Api.url = '/s/api'

		this.stream = new UpdatesStream()
		this.stream.updated = () => void this.fetcher.run()
		this.stream.revoked = () => {
			this.phase = 'revoked'
			this.requestUpdate()
		}
		this.stream.open()

		this.phase = 'ready'
		this.fetcher.run()
	}

	protected override disconnected() {
		this.stream?.close()
	}

	protected override updated(props: PropertyValues) {
		super.updated(props)
		if (props.has('phase') && this.phase === 'ready') {
			document.title = `${this.targetName} · CalendarX`
		}
	}

	/** One period on or back: the days move, and the time in view stays. */
	private step(direction: 1 | -1) {
		const step = this.view === 'week' ? { days: 7 } : { months: 1 }
		this.navigatingDate = direction > 0 ? this.navigatingDate.add(step) : this.navigatingDate.subtract(step)
		void this.fetcher.run()
	}

	private readonly canEdit = () => this.phase === 'ready' && this.guestRole === 'edit'

	// The app's stylesheet lives in the document; a shadow root would wall the guest surface off from it.
	protected override createRenderRoot() { return this }

	static override get styles() {
		return css`
			calendarx-page-guest {
				position: absolute;
				inset: 0;
				display: flex;
				flex-direction: column;
				background-color: var(--color-background);
				color: var(--color-text);
				font-family: var(--font-family);
				overflow: clip;

				> header {
					display: flex;
					align-items: center;
					gap: 0.75rem;
					padding: 0.75rem 1.25rem;

					.brand {
						display: flex;
						align-items: center;
						gap: 0.5rem;
						font-weight: 700;

						img {
							width: 1.375rem;
							height: 1.375rem;
						}
					}

					.scope {
						display: flex;
						align-items: center;
						gap: 0.375rem;
						min-width: 0;
						color: var(--color-text-muted);
						font-size: 0.8rem;

						.scope-name {
							min-width: 0;
							overflow: hidden;
							text-overflow: ellipsis;
							white-space: nowrap;
						}

						.role {
							flex-shrink: 0;
							padding: 0.125rem 0.5rem;
							border-radius: var(--border-radius);
							background: color-mix(in srgb, var(--color-text) 6%, transparent);
						}
					}

					.trailing {
						flex: 1;
						display: flex;
						align-items: center;
						justify-content: flex-end;
						gap: 0.75rem;
						min-inline-size: 0;

						h1 {
							min-inline-size: 0;
							overflow: hidden;
							text-overflow: ellipsis;
							white-space: nowrap;
							margin: 0;
							font-size: 1.125rem;
							font-weight: 700;
							letter-spacing: -0.01em;
						}
					}

					.period {
						display: flex;
						align-items: center;
					}
				}

				main {
					flex: 1;
					min-height: 0;
					position: relative;
				}
			}

			/* The guest surface owns the whole viewport, so its wrapping answers the window, not a container. */
			@media (max-width: 40rem) {
				calendarx-page-guest {
					> header {
						flex-wrap: wrap;
						gap: 0.5rem;
						padding: 0.75rem 1rem;

						.scope {
							flex: 1;
							min-inline-size: 0;
						}

						.trailing {
							flex-basis: 100%;
							flex-wrap: wrap;

							h1 {
								flex-basis: 100%;
								font-size: 1rem;
							}
						}
					}
				}
			}

			.guest-center {
				position: absolute;
				inset: 0;
				display: grid;
				place-content: center;
				justify-items: center;
				gap: 0.75rem;
				padding: 2rem;
				text-align: center;

				h2 {
					margin: 0;
					font-size: 1.1rem;
				}

				p {
					margin: 0;
					color: var(--color-text-muted);
					max-inline-size: 28rem;
				}
			}
		`
	}

	protected override get template() {
		switch (this.phase) {
			case 'opening':
				return html`
					<div class="guest-center">
						<mitra-circular-progress></mitra-circular-progress>
						<p>${t('Opening the shared calendar…')}</p>
					</div>`
			case 'revoked':
				return html`
					<div class="guest-center">
						<mitra-icon icon="unlink" size="32"></mitra-icon>
						<h2>${t('This link is no longer active')}</h2>
						<p>${t('The owner has revoked it, or the shared calendar is gone. Ask for a new link to continue.')}</p>
					</div>
				`
			case 'failed':
				return html`
					<div class="guest-center">
						<mitra-icon icon="cloud-off" size="32"></mitra-icon>
						<h2>${t('The link could not be opened')}</h2>
						<p>${this.failure ?? t('Check the link and your connection, then try again.')}</p>
						<mitra-button @click=${() => location.reload()}>${t('Try again')}</mitra-button>
					</div>
				`
			case 'ready':
				break
		}
		const { navigatingDate: date } = this
		const heading = this.view === 'week'
			? `${date.weekStart.format({ weekday: 'short', day: 'numeric', month: 'short' })} – ${date.weekEnd.format({ day: 'numeric', month: 'short', year: 'numeric' })}`
			: date.format({ month: 'long', year: 'numeric' })
		return html`
			<header>
				<span class="brand">
					<img src="/android-chrome-192x192.png" alt="">
					<span>CalendarX</span>
				</span>
				<span class="scope">
					<span class="scope-name">${this.targetName}</span>
					${!this.overlayNames.length ? html.nothing : html`<span class="scope-name">+ ${this.overlayNames.join(', ')}</span>`}
					<span class="role">${this.guestRole === 'edit' ? t('View and edit') : t('View only')}</span>
				</span>
				<div class="trailing">
					<h1>${heading}</h1>
					<mitra-select class="view" label=${t('View')} .value=${this.view} @change=${(e: CustomEvent<'week' | 'month'>) => { this.view = e.detail; void this.fetcher.run() }}>
						<mitra-option .value=${'week' as const}>${t('Week')}</mitra-option>
						<mitra-option .value=${'month' as const}>${t('Month')}</mitra-option>
					</mitra-select>
					${this.canEdit() ? html`
						<mitra-button variant="primary" icon="plus" @click=${() => void this.addEntry()}>${t('Create')}</mitra-button>
					` : html.nothing}
					<div class="period" role="group">
						<mitra-icon-button icon="chevron-left" label=${t('Previous')} @click=${() => this.step(-1)}></mitra-icon-button>
						<mitra-button @click=${() => { this.navigatingDate = new DateTime(); void this.fetcher.run() }}>${t('Today')}</mitra-button>
						<mitra-icon-button icon="chevron-right" label=${t('Next')} @click=${() => this.step(1)}></mitra-icon-button>
					</div>
				</div>
			</header>
			<main>
				${this.fetcher.status === TaskStatus.ERROR ? html`
					<div class="guest-center">
						<mitra-icon icon="cloud-off" size="32"></mitra-icon>
						<h2>${t('You are offline')}</h2>
						<p>${t('The shared calendar cannot be reached right now. Your last view stays as it was.')}</p>
						<mitra-button @click=${() => void this.fetcher.run()}>${t('Try again')}</mitra-button>
					</div>
				` : !this.store.shown.length && this.fetcher.status === TaskStatus.COMPLETE ? html`
					<div class="guest-center">
						<mitra-icon icon="calendar-days" size="32"></mitra-icon>
						<h2>${t('Nothing here yet')}</h2>
						<p>${this.guestRole === 'edit' ? t('This shared calendar is empty. Create the first entry.') : t('The shared calendar is empty for now.')}</p>
					</div>
				` : html`
					${this.view === 'week' ? html`
						<mitra-days
							.occurrences=${this.store.shown}
							.navigatingDate=${bind(this, 'navigatingDate', { event: 'navigate' })}
						></mitra-days>
					` : html`
						<mitra-weeks
							.occurrences=${this.store.shown}
							.navigatingDate=${bind(this, 'navigatingDate', { event: 'navigate' })}
							@switchToWeek=${() => { this.view = 'week'; void this.fetcher.run() }}
						></mitra-weeks>
					`}
				`}
			</main>
		`
	}

	private addEntry() {
		const target = Calendars.getPrimary()
		if (!target) {
			return
		}
		const start = this.navigatingDate.dayStart.add({ hours: Math.max(8, new DateTime().hour + 1) })
		const draft = target.draft({ type: target.defaultEntryType, start, end: start.add({ minutes: ScheduleDefaults.current.duration }), allDay: false })
		EntryStore.upsertDraft(draft)
		EntryEditorIntent.openDraft(draft)
	}
}
