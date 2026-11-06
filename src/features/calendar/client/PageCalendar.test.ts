import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

describe('first-run calendar and search controls', () => {
	const startup = readFileSync('src/app/Mitra.ts', 'utf8')
	const page = readFileSync('src/features/calendar/client/PageCalendar.ts', 'utf8')

	it('does not open the welcome modal during app startup', () => {
		assert.doesNotMatch(startup, /DialogWelcome/)
	})

	it('shows an inline empty state and opens the existing integration chooser on request', () => {
		assert.match(page, /!Calendars\.integrations\.length \? html`[\s\S]*?t\('No calendar source yet'\)/)
		assert.match(page, /new DialogIntegration\(\{\}\)\.confirm\(\)/)
		assert.match(page, /t\('Add calendar'\)/)
	})

	it('keeps search accessible and operable without the visible command hint', () => {
		assert.match(page, /<mitra-icon-button class="search" icon="search" label=\$\{t\('Search'\)\} @click=\$\{\(\) => this\.palette\.show\(\)\}/)
		assert.match(page, /if \(new KeyPress\(e\)\.is\('\/'\)\)[\s\S]*?this\.palette\.show\(\)/)
		assert.doesNotMatch(page, /Search or run a command/)
	})
})
