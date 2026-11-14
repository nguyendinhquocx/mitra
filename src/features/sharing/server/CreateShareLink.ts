import { description, label } from '@a11d/metadata'
import { z } from 'zod'
import { validation, ValidationError } from '#infrastructure/validation'
import { http, operation, Operation, type OperationContext } from '#infrastructure/operations/Operation.js'
import { Entry } from '#features/entries'
import { ShareCapability, ShareRole } from '../ShareCapability.js'
import { takeLinkShot } from './rateLimit.js'

class Parameters {
	@validation(z.string())
	@description('The calendar the link reaches, whose id freezes into the capability.')
	readonly targetSourceId!: string

	@validation(z.enum(ShareRole))
	@description('What the link lets its holder do: view, or view and edit the target.')
	readonly role!: ShareRole

	@validation(z.array(z.string()).max(50))
	@description('Other calendars the guest may read along, always read-only; the target stays the only writable one.')
	readonly overlays: Array<string> = []

	@validation(z.string().optional())
	@description('The one entry this link reaches, if restricted to a single event.')
	readonly entryId?: string

	@validation(z.boolean().optional())
	@description('Show none of the owner\'s entries: an edit link that starts from an empty calendar, the guest seeing only what they add. Requires the edit role.')
	readonly blank?: boolean
}

@operation(Parameters)
@label('Create a share link')
@description('Creates a bearer link for one calendar: a secret shown once, stored by its hash, bound to that calendar and the given role until revoked. The calendars named as overlays become readable to the guest, read-only; when the target is an existing Google calendar, the whole calendar falls inside the link\'s reach.')
@http({ method: 'POST', path: '/shares', status: 201 })
export class CreateShareLink extends Operation<Parameters, { capability: ShareCapability, token: string }> {
	async run({ em, user }: OperationContext) {
		takeLinkShot(user.id)
		if (this.parameters.blank && this.parameters.role !== ShareRole.Edit) {
			throw new ValidationError('A blank link hides everything, so it needs the edit role')
		}
		// A blank calendar has no event to focus: the flag supersedes a single-event share.
		const blank = this.parameters.blank ?? false
		const target = await user.getSource(em, this.parameters.targetSourceId)
		let entryId = blank ? undefined : this.parameters.entryId
		if (entryId) {
			const selected = await em.findOne(Entry, { id: entryId, sourceId: target.id })
			if (!selected) {
				throw new ValidationError('The specified entry does not belong to the selected calendar')
			}
			// Recurring overrides are occurrences of one shared series, not separate capabilities; normalize them to its root.
			entryId = selected.recurringEntryId ?? selected.id!
			if (entryId !== selected.id && !await em.findOne(Entry, { id: entryId, sourceId: target.id })) {
				throw new ValidationError('The recurring series for this event is gone')
			}
		}
		const overlays: Array<string> = []
		// Overlays ride for every link shape now: a single-event or blank link may still name calendars to show whole.
		for (const sourceId of this.parameters.overlays) {
			if (sourceId === target.id) {
				continue
			}
			await user.getSource(em, sourceId)
			overlays.push(sourceId)
		}
		const { capability, token } = await ShareCapability.issue(user, target, this.parameters.role, overlays, entryId)
		capability.blank = blank || undefined
		em.persist(capability)
		await em.flush()
		this.logger.info(`Created a ${capability.role} share link for source ${capability.targetSourceId}`)
		return { capability, token }
	}
}
