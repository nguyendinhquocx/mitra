import { setTestLocaleLocation } from './TestLocale.js'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Localizer } from '@3mo/localization'
import { session } from '#infrastructure/http/PageSession.js'
import { LocaleSetting } from './LocaleSetting.js'

describe('LocaleSetting account defaults', () => {
	const originalUser = session.user
	const originalLocale = Localizer.locales.current

	afterEach(() => {
		session.user = originalUser
		setTestLocaleLocation('')
		Localizer.locales.current = originalLocale
	})

	it('defaults an account without a saved language to Vietnamese', () => {
		session.user = { settings: {} } as never
		Localizer.locales.current = 'en-US'

		LocaleSetting.followAccount()

		assert.equal(Localizer.locales.current.language, 'vi')
	})

	it('keeps a supported language supplied by a link when the account has no choice yet', () => {
		session.user = { settings: {} } as never
		setTestLocaleLocation('?lang=de')
		Localizer.locales.current = 'de'

		LocaleSetting.followAccount()

		assert.equal(Localizer.locales.current.language, 'de')
	})

	it('preserves the account language and region when one is saved', () => {
		session.user = { settings: { locale: 'de-DE' } } as never
		Localizer.locales.current = 'en-US'

		LocaleSetting.followAccount()

		assert.equal(Localizer.locales.current.language, 'de')
		assert.equal(Localizer.locales.current.region, 'DE')
	})
})
