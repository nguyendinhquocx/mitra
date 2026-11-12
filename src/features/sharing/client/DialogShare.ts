import { component, css, html, state, live } from '@a11d/lit'
import { DialogComponent } from '@a11d/lit-application'
import { Calendars } from '#features/sources/client/Calendars.js'
import { type Entry } from '#features/entries'
import { type Source } from '#features/sources'
import { CreateShareLink, ListShareLinks, RevokeShareLink, CreateGoogleShareCalendar } from '#operations'
import { type ShareCapability, ShareRole } from '../ShareCapability.js'

export interface ShareDialogParameters {
	/** An event to focus: the link opens the whole shared calendar on this event, with no wider right of its own. */
	readonly entry?: Entry
}

/**
 * The one owner share surface: it selects the calendar a link reaches, the view/edit role, and which other
 * calendars ride along read-only; it copies the link once and revokes it any time. An event link is this same
 * link carrying the event in its fragment — never a broader right of its own.
 */
@component('calendarx-dialog-share')
export class DialogShare extends DialogComponent<ShareDialogParameters, void> {
	@state() private links: Array<ShareCapability> = []
	@state() private targetSourceId?: string
	@state() linkRole: ShareRole = ShareRole.View
	@state() private overlays = new Set<string>()
	@state() private createdToken?: string
	@state() private copied = false
	@state() private creating = false
	@state() private creatingCalendar = false

	protected override async connected() {
		await Calendars.fetch().catch(() => void 0)
		if (this.parameters.entry) {
			this.targetSourceId = this.parameters.entry.sourceId
		}
		this.targetSourceId ??= Calendars.visible.find(source => source.writable && source.integration.type === 'google')?.id
			?? Calendars.visible.find(source => source.writable)?.id
		await this.refreshLinks()
	}

	private async refreshLinks() {
		this.links = await ListShareLinks.call().catch(() => [])
	}

	protected override createRenderRoot() { return this }

	private get target(): Source | undefined {
		return Calendars.getSource(this.targetSourceId ?? '')
	}

	/** A Google calendar reached over the owner's own account: the whole calendar falls inside the link's reach. */
	private get needsScopeWarning() {
		return this.target?.integration.type === 'google'
	}

	private get googleConnected() {
		return Calendars.integrations.some(integration => integration.type === 'google')
	}

	private get allSources() {
		return Calendars.enabled.filter(source => source.id !== this.targetSourceId)
	}

	private get maskedUrl() {
		return this.createdToken === undefined
			? ''
			: `${location.origin}/s#calx_••••${this.createdToken.slice(-6)}${this.parameters.entry ? `&entry=${this.parameters.entry.id}` : ''}`
	}

	private linkUrlOf(token: string) {
		const entry = this.parameters.entry ? `&entry=${this.parameters.entry.id}` : ''
		return `${location.origin}/s#${token}${entry}`
	}

	private async create() {
		if (!this.targetSourceId) {
			return
		}
		this.creating = true
		try {
			const { token } = await CreateShareLink.call({ targetSourceId: this.targetSourceId, role: this.linkRole, overlays: [...this.overlays] })
			this.createdToken = token
			await this.refreshLinks()
		} finally {
			this.creating = false
		}
	}

	private async createGoogleCalendar() {
		this.creatingCalendar = true
		try {
			const { sourceId } = await CreateGoogleShareCalendar.call({ name: t('Shared calendar') })
			await Calendars.fetch().catch(() => void 0)
			this.targetSourceId = sourceId ?? this.targetSourceId
			this.requestUpdate()
		} finally {
			this.creatingCalendar = false
		}
	}

	private async copy() {
		if (!this.createdToken) {
			return
		}
		await navigator.clipboard.writeText(this.linkUrlOf(this.createdToken))
		this.copied = true
		setTimeout(() => this.copied = false, 2000)
	}

	private async revoke(id: string) {
		await RevokeShareLink.call({ id })
		await this.refreshLinks()
	}

	static override get styles() {
		return css`
			calendarx-dialog-share {
				--mitra-dialog-width: 34rem;
			}

			.share {
				display: grid;
				gap: 0.75rem;
				padding-block-end: 0.25rem;
			}

			.share .row {
				display: grid;
				grid-template-columns: subgrid;
				grid-column: 1 / -1;
				align-items: center;
				gap: 0.5rem;
			}

			.share .note {
				grid-column: 1 / -1;
				padding: 0.5rem 0.75rem;
				border-radius: var(--border-radius);
				background: color-mix(in srgb, var(--color-text) 5%, transparent);
				color: var(--color-text-muted);
				font-size: 0.8rem;
			}

			.share .overlays {
				grid-column: 1 / -1;
				display: grid;
				gap: 0.25rem;
			}

			.share .actions {
				grid-column: 1 / -1;
				display: flex;
				align-items: center;
				gap: 0.5rem;
			}

			.share .url {
				grid-column: 1 / -1;
				display: flex;
				align-items: center;
				gap: 0.5rem;
			}

			.share .url > span {
				flex: 1;
				min-width: 0;
				font-family: monospace;
				font-size: 0.8rem;
				overflow-wrap: anywhere;
				user-select: text;
				-webkit-user-select: text;
			}

			.share .links {
				grid-column: 1 / -1;
				display: grid;
				gap: 0.375rem;
			}

			.share .link {
				display: flex;
				align-items: center;
				gap: 0.5rem;
				font-size: 0.85rem;
			}

			.share .link > .name {
				flex: 1;
				min-width: 0;
				overflow: hidden;
				text-overflow: ellipsis;
				white-space: nowrap;
			}

			.share .link > .revoked {
				color: var(--color-text-muted);
				font-size: 0.75rem;
			}

			.share > .head,
			.share .head {
				display: flex;
				align-items: center;
				gap: 0.5rem;

				h2 {
					margin: 0;
					font-size: 1rem;
					font-weight: 700;
				}
			}
		`
	}

	protected override get template() {
		const entry = this.parameters.entry
		return html`
			<mitra-dialog>
				<div class="head">
					<mitra-icon icon="share"></mitra-icon>
					<h2>${entry ? t('Share event') : t('Share calendar')}</h2>
				</div>
				<div class="share">
					${!entry ? html.nothing : html`
						<span class="note">${t('The link opens the whole shared calendar on this event. Anyone holding it may work inside that calendar, and nothing beyond it.')}</span>
					`}
					${this.createdToken === undefined ? html`
						<div class="row">
							<mitra-icon icon="calendar-days"></mitra-icon>
							<mitra-select label=${t('Calendar')} .value=${this.targetSourceId}
								@change=${(e: CustomEvent<string | undefined>) => { this.targetSourceId = e.detail; this.requestUpdate() }}
							>
								${Calendars.enabled.map(source => html`<mitra-option .value=${source.id}>${source.name}</mitra-option>`)}
							</mitra-select>
						</div>
						${!this.needsScopeWarning ? html.nothing : html`
							<span class="note">${t('A Google calendar is shared whole: every event inside it lies within the link, yours included. Check it is the calendar to share.')}</span>
						`}
						<div class="row">
							<mitra-icon icon="key-round"></mitra-icon>
							<mitra-select label=${t('Permission')} title=${t('Permission')} .value=${this.linkRole}
								@change=${(e: CustomEvent<ShareRole>) => this.linkRole = e.detail}
							>
								<mitra-option .value=${'view' as const}>${t('View only')}</mitra-option>
								<mitra-option .value=${'edit' as const}>${t('View and edit')}</mitra-option>
							</mitra-select>
						</div>
						${!this.allSources.length ? html.nothing : html`
							<div class="overlays">
								${this.allSources.map(source => html`
									<mitra-checkbox title=${t('Also visible to the guest (read-only)')}
										.checked=${live(this.overlays.has(source.id))}
										@change=${(e: CustomEvent<boolean>) => {
											if (e.detail) {
												this.overlays.add(source.id)
											} else {
												this.overlays.delete(source.id)
											}
											this.requestUpdate()
										}}
									>${source.name}</mitra-checkbox>
								`)}
							</div>
						`}
						<div class="actions">
							<mitra-button variant="primary" ?busy=${this.creating} @click=${() => void this.create()}>${t('Create link')}</mitra-button>
							${!this.googleConnected ? html.nothing : html`
								<mitra-button ?busy=${this.creatingCalendar} @click=${() => void this.createGoogleCalendar()}>${t('New Google calendar')}</mitra-button>
							`}
						</div>
					` : html`
						<div class="url">
							<span>${this.maskedUrl}</span>
							<mitra-button variant="primary" icon=${this.copied ? 'check' : 'copy'} @click=${() => void this.copy()}>${this.copied ? t('Copied') : t('Copy')}</mitra-button>
						</div>
						<span class="note">${t('The full link is copied to the clipboard. Anyone holding it works with this scope until the link is revoked.')}</span>
					`}
					${!this.links.length ? html.nothing : html`
						<div class="links">
							${this.links.map((link: ShareCapability) => html`
								<div class="link">
									<mitra-icon icon="link"></mitra-icon>
									<span class="name">
										${Calendars.getSource(link.targetSourceId)?.name ?? t('A removed calendar')}
										· ${link.role === 'edit' ? t('View and edit') : t('View only')}
									</span>
									${!link.revoked ? html.nothing : html`<span class="revoked">${t('Revoked')}</span>`}
									${link.revoked ? html.nothing : html`
										<mitra-icon-button icon="ban" label=${t('Revoke')} title=${t('Revoke')} @click=${() => void this.revoke(link.id)}></mitra-icon-button>
									`}
								</div>
							`)}
						</div>
					`}
				</div>
			</mitra-dialog>
		`
	}
}
