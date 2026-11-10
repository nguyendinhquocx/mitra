import { createDAVClient } from 'tsdav'
import { description, label } from '@a11d/metadata'
import { z } from 'zod'
import { validation, ValidationError } from '#infrastructure/validation'
import { updates } from '#infrastructure/realtime/Updates.js'
import { http, operation, Operation, type OperationContext } from '#infrastructure/operations/Operation.js'
import { Integration } from '#integrations'
import { GoogleCalendar } from '#integrations/google/GoogleCalendar.js'

class Parameters {
	@validation(z.string().min(1).max(200))
	@description('The new calendar\'s name, as Google will show it and the share dialog will list it.')
	readonly name!: string
}

/**
 * Creates a dedicated Google calendar for sharing, through the owner's connected account, and answers the new
 * calendar's source id to bind a link to. Google is asked over CalDAV (MKCALENDAR on the account's home); where the
 * account refuses it, the error says so and the owner creates the calendar in Google and selects it instead —
 * the link flow never falls back to a personal calendar.
 */
@operation(Parameters)
@label('Create a dedicated Google calendar for sharing')
@description('Creates a new calendar on the connected Google account and answers its source id, ready to be chosen as a share target.')
@http({ method: 'POST', path: '/shares/google-calendars', status: 201 })
@updates('sources')
export class CreateGoogleShareCalendar extends Operation<Parameters, { sourceId: string | undefined }> {
	async run({ em, user }: OperationContext) {
		const integration = await em.findOne(GoogleCalendar, { userId: user.id })
		if (!integration) {
			throw new ValidationError('Google Calendar is not connected. Connect it first, then create the calendar')
		}
		const client = await createDAVClient({ ...integration.clientParameters })
		const home = GoogleCalendar.uriFor(integration.credentials.username)
		try {
			await client.makeCalendar({
				url: home,
				props: {
					'd:resourcetype': { 'd:collection': {}, 'c:calendar': {} },
					'd:displayname': this.parameters.name,
				},
			})
		} catch (error) {
			throw new ValidationError(`Google refused to create the calendar (${error instanceof Error ? error.message : error}). Create it in Google Calendar, then select it as the share target`)
		}
		await Integration.exclusively(integration.id, async () => {
			await integration.getSources(em)
			await em.flush()
		})
		const created = integration.sources.find(source => source.name === this.parameters.name)
			?? integration.sources.at(-1)
		if (!created) {
			throw new ValidationError('The calendar was created, but Google has not listed it yet. Try selecting the target again in a moment')
		}
		this.logger.info(`Created Google calendar "${created.name}" (${created.id}) as a share target`)
		return { sourceId: created.id }
	}
}
