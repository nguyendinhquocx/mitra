import { Localizer } from '@3mo/localization'

let current = new Intl.Locale('en-US')
Object.defineProperty(Localizer.locales, 'current', {
	configurable: true,
	get: () => current,
	set: (value: string | Intl.Locale) => current = new Intl.Locale(value),
})

export function setTestLocaleLocation(search: string) {
	Object.defineProperty(globalThis, 'location', {
		configurable: true,
		value: new URL(`https://mitra.test/${search}`),
	})
}

setTestLocaleLocation('')
