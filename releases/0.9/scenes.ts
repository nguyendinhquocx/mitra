import { aroundEditorWith, chipOf, click, openChip, scrollToMorning, show } from '../../scripts/capture.ts'
import { still } from '../../scripts/scenes.ts'

// The captures only 0.9's notes show, shot on the build in development.

/** The week in Japanese, set in its own typeface, a repeating event open in its editor beside its chip. */
still('japanese-week', { language: 'ja' }, async ({ browser, open, text }) => {
	await open()
	await show(browser, 'week')
	await scrollToMorning(browser)
	await browser.evaluate('await document.fonts.ready')
	const heading = text('Weekly Team Sync')
	await openChip(browser, heading)
	return aroundEditorWith(browser, chipOf(heading), 28)
})

/** A task's description as Live Preview shows it: formatted throughout, the line being edited in its Markdown. */
still('markdown-description', async ({ browser, open, origin, text }) => {
	const heading = text('Prepare Q3 Presentation')
	const [entry] = await (await fetch(`${origin}api/entries/search?query=${encodeURIComponent(heading)}`)).json() as Array<{ id: string }>
	const description = [
		'## Outline',
		'Start from the [quarterly deck template](https://example.com/templates/quarterly-deck), **ten slides** at most.',
		'- [x] Results and growth',
		'- [ ] Hiring plan',
		'- [ ] Roadmap for Q4',
		'',
		'> [!tip] Rehearse on Wednesday',
		'',
		'| Section | Minutes |',
		'| --- | --- |',
		'| Results | 10 |',
		'| Plans | 15 |',
	].join('\n')
	await fetch(`${origin}api/entries/${entry!.id}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ description }) })
	await open()
	await show(browser, 'week')
	await scrollToMorning(browser)
	await openChip(browser, heading)
	await click(browser, `[...document.querySelectorAll('mitra-markdown-editor .cm-line')].find(line => line.textContent.includes('Outline'))`)
	return aroundEditorWith(browser, chipOf(heading), 28)
})
