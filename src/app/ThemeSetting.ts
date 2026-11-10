import { ChoiceSetting, deviceStorage, setting, type SettingStorage } from '#features/settings/client/Setting.js'
import { syncThemeColor } from './pwa.js'

export type Theme = 'minimalist' | 'system' | 'light' | 'dark'

/**
 * Application color scheme theme preference (stored locally per device).
 */
@setting()
export class ThemeSetting extends ChoiceSetting<Theme> {
	private static readonly stored = deviceStorage<Theme>('Mitra.Appearance.Theme')

	/** Applies the stored theme attribute to document root before initial paint. Minimalist is the default for devices without a stored choice. */
	static applyStored() {
		const theme = ThemeSetting.stored.read()
		if (!theme) {
			document.documentElement.dataset.theme = ThemeSetting.defaultTheme
		} else if (theme === 'system') {
			delete document.documentElement.dataset.theme
		} else {
			document.documentElement.dataset.theme = theme
		}
	}

	private static readonly defaultTheme: Theme = 'minimalist'

	readonly heading = t('Theme')
	readonly icon = 'sun-moon'
	readonly keywords = t('ThemeSetting.Keywords')
	readonly page = 'general'
	readonly fallback: Theme = 'minimalist'

	protected readonly storage: SettingStorage<Theme> = {
		read: () => ThemeSetting.stored.read(),
		write: value => {
			ThemeSetting.stored.write(value)
			ThemeSetting.applyStored()
			syncThemeColor()
		},
	}

	override get options() {
		return [
			{ value: 'minimalist' as const, label: t('Minimalist') },
			{ value: 'system' as const, label: t('Match the system') },
			{ value: 'light' as const, label: t('Light') },
			{ value: 'dark' as const, label: t('Dark') },
		]
	}
}

ThemeSetting.applyStored()
