import { enum as enumType, entity, manyToOne, model, primaryKey, property, withheld } from '#infrastructure/model'
import { converter } from '@a11d/converter'
import { User } from '#features/identity'
import { Source } from '#features/sources'

/** What a bearer link lets its holder do inside one shared calendar. */
export enum ShareRole {
	View = 'view',
	Edit = 'edit',
}

/**
 * One shared target's capability: the secret a link carries, stored by its SHA-256 hash so the token itself is
 * seen once, when the link is made. It binds exactly one source (the target), a role, and the owner-selected
 * read-only overlays; it holds until the owner revokes it. The target never rebinds: a deleted source leaves the
 * link answering that nothing is there.
 */
@model('ShareCapability')
@entity()
export class ShareCapability {
	/** What every share token starts with, so a secret scanner can tell one from other secrets. */
	static readonly prefix = 'calx_'
	/** The browser cookie the fragment exchange issues, per the Secure Cookies hardening (`__Host-` needs Secure, Path=/ and no Domain). */
	static readonly cookie = '__Host-calendarx_share'
	/** How long an exchanged session lasts; reopening the link starts a new one. The capability itself holds until revoked. */
	static readonly sessionLifetime = 12 * 60 * 60 * 1000

	/** A new capability for `owner`'s `target`: the record to keep, and the token to show once (a ≥256-bit CSPRNG secret). */
	static async issue(owner: User, target: Source, role: ShareRole, overlays: ReadonlyArray<string> = [], entryId?: string) {
		const token = `${ShareCapability.prefix}${ShareCapability.hexOf(crypto.getRandomValues(new Uint8Array(32)))}`
		const capability = new ShareCapability({
			id: crypto.randomUUID(),
			hash: await ShareCapability.hashOf(token),
			ownerId: owner.id,
			targetSourceId: target.id,
			role,
			overlays: [...overlays],
			entryId: entryId ?? undefined,
			createdAt: new Date(),
		})
		return { capability, token }
	}

	static async hashOf(token: string) {
		return ShareCapability.hexOf(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))))
	}

	private static hexOf(bytes: Uint8Array) {
		return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
	}

	@primaryKey({ type: 'string' }) id!: string

	@manyToOne(() => User, { mapToPk: true, deleteRule: 'cascade' }) ownerId!: string

	@property({ type: 'string', unique: true })
	@converter(withheld()) hash!: string

	/** The one source this link reaches. Frozen on creation; never silently rebound. */
	@manyToOne(() => Source, { mapToPk: true, deleteRule: 'cascade' }) targetSourceId!: string

	@enumType({ items: () => ShareRole }) role!: ShareRole

	/** Other calendars of the owner the guest sees, read-only. Owner-managed; guests never write this list. */
	@property({ type: 'json', nullable: true }) overlays?: Array<string>

	/** When set, the link reaches only this single entry inside targetSourceId. Other entries in the calendar are omitted. */
	@property({ type: 'string', fieldName: 'entry_id', nullable: true }) entryId?: string

	@property({ type: 'Date', nullable: true }) revokedAt?: Date

	@property({ type: 'Date' }) createdAt!: Date

	constructor(init?: Partial<ShareCapability>) {
		Object.assign(this, init)
	}

	get revoked() {
		return this.revokedAt !== undefined
	}

	/** Whether `sourceId` is inside what this link reaches: the target itself, or an enabled overlay. */
	reaches(sourceId: string) {
		if (sourceId === this.targetSourceId) {
			return true
		}
		return this.overlays?.includes(sourceId) ?? false
	}

	/** The sources a guest may read: the target and the owner's current overlays. */
	get scope() {
		return [this.targetSourceId, ...this.overlays ?? []]
	}

	/** Whether `sourceId` takes a guest's writes: only the target, and only an edit link. */
	get writableSourceId() {
		return this.role === ShareRole.Edit ? this.targetSourceId : undefined
	}
}
