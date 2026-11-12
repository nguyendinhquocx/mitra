/// <reference types="node" />
import consola from 'consola'
import {
	appText, captureCss, click, keys, press, settle, stage, viewport, waitFor,
	type Devtools,
} from './capture.ts'
import fs from 'node:fs'
import path from 'node:path'

// The spec's own visual evidence (SPEC-2026-11-10 CalendarX Minimalist and sharing): the Minimalist
// week at the desktop, collapsed, user and mobile widths, the share dialog, and the guest surfaces
// — view, edit, empty and revoked — at the widths the gates name. Synthetic data only: the seeded
// sample calendar stands in for the owner's.
//
// Usage: node scripts/spec-captures.ts [--no-build]

const noBuild = process.argv.includes('--no-build')
const outDir = path.join('releases', 'spec-captures')
const shareLabel = JSON.stringify(appText('Share', 'vi'))
process.on('unhandledRejection', error => { console.error('[spec-captures] failed near step:', stepNameRef.value); throw error })
const stepNameRef: { value: string } = { value: 'start' }

/** One viewport override, then the layout's own settle time. */
async function size(page: Devtools, width: number, height: number, mobile = false) {
	await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile })
	await new Promise(resolve => setTimeout(resolve, 600))
}

/** A PNG of the current viewport, as a visitor sees it. */
async function shot(page: Devtools) {
	const { data } = await page.send<{ data: string }>('Page.captureScreenshot', { format: 'png' })
	return Buffer.from(data, 'base64')
}

async function frame(page: Devtools) {
	await page.evaluate('await new Promise(resolve => setTimeout(resolve, 500))')
}

/** A full-height PNG of the page, resized to its content first. */
async function fullShot(page: Devtools) {
	const height = await page.evaluate<number>('return document.documentElement.scrollHeight') ?? viewport.height
	const width = await page.evaluate<number>('return document.documentElement.scrollWidth') ?? viewport.width
	await size(page, width, Math.min(height, 4200))
	await frame(page)
	return shot(page)
}

/** The app as a visitor opens it: no stored theme, so the Minimalist preset answers as the default. */
async function openMinimalist(page: Devtools, origin: string) {
	await page.send('Page.navigate', { url: origin })
	await waitFor(() => page.evaluate<boolean>('return !!document.querySelector("mitra-page-calendar")'), 'the app to boot')
	await page.evaluate(`
		localStorage.setItem('Mitra.WeekZoom', '2')
		localStorage.removeItem('Mitra.SidebarCollapsed')
	`)
	await page.send('Page.reload')
	await waitFor(() => page.evaluate<boolean>('return document.documentElement.dataset.theme === "minimalist"'), 'the Minimalist theme to apply')
	await waitFor(() => page.evaluate<boolean>('return document.querySelectorAll("mitra-entry-segment").length > 0'), 'entries to render')
	await settle(page)
	await page.evaluate(`
		const style = document.createElement('style')
		style.id = 'capture'
		style.textContent = ${JSON.stringify(captureCss)}
		document.head.append(style)
		await document.fonts.ready
	`)
}

interface ShareAnswer { capability: { id: string }, token: string }

async function createShare(origin: string, role: 'view' | 'edit') {
	const integrations = await (await fetch(`${origin}api/integrations`)).json() as Array<{ sources: Array<{ id: string, name: string }> }>
	const target = integrations[0]!.sources[0]!
	const answer = await fetch(`${origin}api/shares`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ targetSourceId: target.id, role, overlays: [] }),
	})
	if (!answer.ok) {
		throw new Error(`Creating a share link failed: ${answer.status} ${await answer.text()}`)
	}
	const { capability, token } = await answer.json() as ShareAnswer
	return { capabilityId: capability.id, token }
}

async function revoke(origin: string, capabilityId: string) {
	const answer = await fetch(`${origin}api/shares/${capabilityId}`, { method: 'DELETE' })
	if (!answer.ok && answer.status !== 204) {
		throw new Error(`Revoking failed: ${answer.status}`)
	}
}

/** Clicks the calendar header's share action, an icon-only button an owner reaches by keyboard too. */
async function clickShareAction(page: Devtools) {
	await click(page, `[...document.querySelectorAll('mitra-page-calendar header mitra-icon-button')].find(button => button.getAttribute('label') === ${shareLabel})`)
}

const step = (name: string) => { stepNameRef.value = name }
await stage(async (browser, origin) => {
	fs.mkdirSync(outDir, { recursive: true })

	// ── The Minimalist owner surface ──
	await openMinimalist(browser, origin)
	await size(browser, 1440, 900)
	await frame(browser)
	step; fs.writeFileSync(path.join(outDir, 'desktop.png'), await fullShot(browser))

	await browser.evaluate(`
		localStorage.setItem('Mitra.SidebarCollapsed', 'true')
		const calendar = document.querySelector('mitra-page-calendar')
		calendar.sidebarOpen = false
		await calendar.updateComplete
	`)
	await frame(browser)
	step; fs.writeFileSync(path.join(outDir, 'desktop-collapsed.png'), await shot(browser))
	await browser.evaluate('localStorage.removeItem("Mitra.SidebarCollapsed")')

	await size(browser, 1750, 900)
	await frame(browser)
	step; fs.writeFileSync(path.join(outDir, 'user-1750.png'), await shot(browser))

	await size(browser, 375, 812, true)
	await frame(browser)
	step; fs.writeFileSync(path.join(outDir, 'mobile.png'), await shot(browser))

	// ── The share dialog, at desktop and at 320 ──
	await size(browser, 1440, 900)
	await frame(browser)
	await clickShareAction(browser)
	await frame(browser)
	step; fs.writeFileSync(path.join(outDir, 'share-dialog.png'), await shot(browser))
	await press(browser, ...keys.escape())
	await size(browser, 320, 700, true)
	await frame(browser)
	await clickShareAction(browser)
	await frame(browser)
	step; fs.writeFileSync(path.join(outDir, 'share-dialog-320.png'), await shot(browser))
	await press(browser, ...keys.escape())

	// ── The guest surfaces ──
	const view = await createShare(origin, 'view')
	const edit = await createShare(origin, 'edit')

	await browser.send('Page.navigate', { url: `${origin}s#${view.token}` })
	await waitFor(() => page(), 'the guest surface to open')
	await frame(browser)
	await size(browser, 1440, 900)
	await frame(browser)
	step; fs.writeFileSync(path.join(outDir, 'guest-view.png'), await shot(browser))

	await size(browser, 375, 812, true)
	await frame(browser)
	step; fs.writeFileSync(path.join(outDir, 'guest-view-mobile.png'), await shot(browser))

	// Already on `/s` for the view step: the same URL with a new fragment would not reload, so hop through the origin.
	await browser.send('Page.navigate', { url: origin })
	await waitFor(() => browser.evaluate<boolean>('return !!document.querySelector("mitra-page-calendar")'), 'the owner app')
	await browser.send('Page.navigate', { url: `${origin}s#${edit.token}` })
	await waitFor(() => browser.evaluate<boolean>('return document.querySelector("calendarx-page-guest")?.guestRole === "edit"'), 'the edit guest to open')
	await frame(browser)
	await size(browser, 375, 812, true)
	await frame(browser)
	step; fs.writeFileSync(path.join(outDir, 'guest-edit-mobile.png'), await shot(browser))

	// Revoked: the edit link dies, the surface answers and offers nothing.
	await revoke(origin, edit.capabilityId)
	// The page is already on `/s` for the edit step: same URL with a different fragment would not reload, so hop through the origin to force a fresh boot.
	await browser.send('Page.navigate', { url: origin })
	await waitFor(() => browser.evaluate<boolean>('return !!document.querySelector("mitra-page-calendar")'), 'the owner app')
	await browser.send('Page.navigate', { url: `${origin}s#${edit.token}` })
	await waitFor(() => browser.evaluate<boolean>('return document.querySelector("calendarx-page-guest")?.phase === "revoked"'), 'the revoked surface')
	await frame(browser)
	step; fs.writeFileSync(path.join(outDir, 'guest-revoked.png'), await shot(browser))

	consola.success(`Spec captures written to ${path.join(outDir)}`)

	function page() {
		return browser.evaluate<boolean>('return document.querySelector("calendarx-page-guest")?.phase === "ready"')
	}
}, { build: !noBuild })
