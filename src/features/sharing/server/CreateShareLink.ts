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
}

@operation(Parameters)
@label('Create a share link')
@description('Creates a bearer link for one calendar: a secret shown once, stored by its hash, bound to that calendar and the given role until revoked. The calendars named as overlays become readable to the guest, read-only; when the target is an existing Google calendar, the whole calendar falls inside the link\'s reach.')
@http({ method: 'POST', path: '/shares', status: 201 })
export class CreateShareLink extends Operation<Parameters, { capability: ShareCapability, token: string }> {
	async run({ em, user }: OperationContext) {
		takeLinkShot(user.id)
		const target = await user.getSource(em, this.parameters.targetSourceId)
		if (this.parameters.entryId) {
			const entry = await em.findOne(Entry, { id: this.parameters.entryId, sourceId: target.id })
			if (!entry) {
				throw new ValidationError('The specified entry does not belong to the selected calendar')
			}
		}
		const overlays: Array<string> = []
		if (!this.parameters.entryId) {
			for (const sourceId of this.parameters.overlays) {
				if (sourceId === target.id) {
					continue
				}
				await user.getSource(em, sourceId)
				overlays.push(sourceId)
			}
		}
		const { capability, token } = await ShareCapability.issue(user, target, this.parameters.role, overlays, this.parameters.entryId)
		em.persist(capability)
		await em.flush()
		this.logger.info(`Created a ${capability.role} share link for source ${capability.targetSourceId}`)
		return { capability, token }
	}
}
