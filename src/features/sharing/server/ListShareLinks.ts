import { description, label } from '@a11d/metadata'
import { http, operation, Operation, type OperationContext } from '#infrastructure/operations/Operation.js'
import { ShareCapability } from '../ShareCapability.js'

@operation()
@label('List share links')
@description('Lists the owner\'s share links with their target, role, overlays and state. The secret itself is never answered; a link\'s token is shown once, when the link is created.')
@http({ method: 'GET', path: '/shares' })
export class ListShareLinks extends Operation<object, Array<ShareCapability>> {
	async run({ em, user }: OperationContext) {
		return em.find(ShareCapability, { ownerId: user.id }, { orderBy: { createdAt: 'desc' } })
	}
}
