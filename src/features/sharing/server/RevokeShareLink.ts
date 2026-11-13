import { description, label } from '@a11d/metadata'
import { NotFoundError } from '@mikro-orm/sqlite'
import { z } from 'zod'
import { validation } from '#infrastructure/validation'
import { http, operation, Operation, type OperationContext } from '#infrastructure/operations/Operation.js'
import { ShareCapability } from '../ShareCapability.js'
import { announceRevocation } from './shareRevocations.js'
import { takeLinkShot } from './rateLimit.js'

class Parameters {
	@validation(z.string())
	@description('The share link\'s id.')
	readonly id!: string
}

@operation(Parameters)
@label('Revoke a share link')
@description('Revokes a share link: the very next guest request is denied, and any open guest stream closes. Done links stay listed, as a record of what was shared, without their secret.')
@http({ method: 'DELETE', path: '/shares/:id' })
export class RevokeShareLink extends Operation<Parameters, void> {
	async run({ em, user }: OperationContext) {
		takeLinkShot(user.id)
		const capability = await em.findOne(ShareCapability, { id: this.parameters.id, ownerId: user.id })
		if (!capability) {
			throw new NotFoundError('No such share link')
		}
		if (!capability.revoked) {
			capability.revokedAt = new Date()
			await em.flush()
			// Announced after the commit: open streams close only once the denial is durable.
			announceRevocation(capability.id)
			this.logger.info(`Revoked share link ${capability.id} for source ${capability.targetSourceId}`)
		}
	}
}
