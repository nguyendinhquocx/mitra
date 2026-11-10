import { description, label } from '@a11d/metadata'
import { NotFoundError } from '@mikro-orm/sqlite'
import { z } from 'zod'
import { validation } from '#infrastructure/validation'
import { updates } from '#infrastructure/realtime/Updates.js'
import { http, operation, Operation, type OperationContext } from '#infrastructure/operations/Operation.js'
import { ShareCapability } from '../ShareCapability.js'

class Parameters {
	@validation(z.string())
	@description('The share link\'s id.')
	readonly id!: string

	@validation(z.array(z.string()).max(50))
	@description('The calendars the guest may read along, read-only. The target never changes with this.')
	readonly overlays!: Array<string>
}

@operation(Parameters)
@label('Change a share link\'s overlays')
@description('Sets which other calendars of yours the link\'s holder may read, read-only; guests cannot change this. It takes effect from the guest\'s next request or stream-driven refetch, never retroactively.')
@http({ method: 'PUT', path: '/shares/:id/overlays' })
@updates('entries')
export class UpdateShareLinkOverlays extends Operation<Parameters, void> {
	async run({ em, user }: OperationContext) {
		const capability = await em.findOne(ShareCapability, { id: this.parameters.id, ownerId: user.id })
		if (!capability) {
			throw new NotFoundError('No such share link')
		}
		if (capability.revoked) {
			return
		}
		const overlays: Array<string> = []
		for (const sourceId of this.parameters.overlays) {
			if (sourceId === capability.targetSourceId) {
				continue
			}
			await user.getSource(em, sourceId)
			overlays.push(sourceId)
		}
		capability.overlays = overlays
		await em.flush()
		this.logger.debug(`Set overlays of share link ${capability.id} to ${overlays.length} calendar(s)`)
	}
}
