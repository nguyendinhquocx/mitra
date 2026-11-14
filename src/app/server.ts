import express, { type RequestHandler } from 'express'
import path from 'path'
import cors from 'cors'
import '#integrations/server/registerEngines.js'
import { ModelValueConstructor } from '@a11d/api-model-value-constructor'
import { createLogger, logLevelName } from '#infrastructure/logging/Logger.js'
import { orm } from '#infrastructure/database/orm.js'
import { environment } from '#infrastructure/server/Environment.js'
import { authMiddleware, authRouter, oidc } from '#features/identity/server/auth.js'
import { accessTokenMiddleware } from '#features/identity/server/accessTokenMiddleware.js'
import { synchronizer } from '#integrations/server/Synchronizer.js'
import { eventsRouter } from '#infrastructure/realtime/events.js'
import { staleTabs } from '#features/entries/server/staleTabs.js'
import { googleConnectRouter } from '#integrations/google/server/googleConnect.js'
import { notionRouter } from '#integrations/notion/server/notion.js'
import { operationsRouter } from '#infrastructure/operations/server/operationsRouter.js'
import { sharingRouter, sweepShareOperations } from '#features/sharing/server/sharingRouter.js'
import { mcpRouter } from '#features/agents/server/mcp.js'
import './operations.js'
import { healthRouter } from '#infrastructure/http/health.js'
import { compression, precompressed } from '#infrastructure/http/compression.js'
import { errorHandler } from '#infrastructure/http/errorHandler.js'
import { cacheControlOf } from '#infrastructure/http/caching.js'
import { updateChecker } from '#features/about/server/updates.js'
import { ReminderScheduler } from '#features/reminders/server/ReminderScheduler.js'
import { UnusedFileDisposer } from '#features/files/server/UnusedFileDisposer.js'
import { fileContentRouter, filesRouter } from '#features/files/server/files.js'
import { EntryFile } from '#features/entries'
import { observeInstanceOrigin } from '#infrastructure/http/instanceUrl.js'
import { allowsPublicGuestPath, matchesPublicGuestHost } from '#infrastructure/server/PublicGuestEdge.js'

const logger = createLogger('API')

synchronizer.start()
new ReminderScheduler(orm).start()
void sweepShareOperations().catch(error => logger.warn(`Sweeping old share replay rows failed: ${error instanceof Error ? error.message : error}`))
setInterval(() => void sweepShareOperations().catch(() => void 0), 60 * 60 * 1000).unref()
/** The tables holding files, which serving looks a file up in and the disposer keeps the bytes for. */
const fileTables = [EntryFile]
new UnusedFileDisposer(orm, fileTables).start()
updateChecker.start()

const app = express()
// The reverse proxy (Caddy) terminates TLS on the same host: only its loopback answers may rewrite the client address,
// so rate limits and origin checks see the real visitor instead of the proxy.
app.set('trust proxy', environment.trustedProxy)

const frontendDistPath = path.resolve(import.meta.dirname, '../../dist')

// A public guest edge (`MITRA_PUBLIC_HOST`) reaches only the link shell, its actual built assets and health check.
// Compare the request's Host authority: X-Forwarded-Host is untrusted input and must never choose the security zone.
const publicHostGate: RequestHandler = (req, res, next) => {
	if (!environment.publicHost) {
		return next()
	}
	const onPublicGuestHost = matchesPublicGuestHost(req.headers.host, environment.publicHost)
	const guestAllowed = allowsPublicGuestPath(req.method, req.path, frontendDistPath)
	if (onPublicGuestHost && !guestAllowed) {
		return res.status(404).json({ error: 'Not found' })
	}
	return next()
}
app.use(publicHostGate)
app.use(cors())
app.use((req, res, next) => {
	if (environment.publicHost && matchesPublicGuestHost(req.headers.host, environment.publicHost)) {
		return next()
	}
	return observeInstanceOrigin(req, res, next)
})
// Before everything it covers: the API routers below and the static frontend at the bottom.
app.use(compression())

// Request logger middleware.
app.use((req, res, next) => {
	const startedAt = performance.now()
	const appRoute = (req.path.startsWith('/api') || req.path.startsWith('/auth')) && req.path !== '/api/health'
	res.on('finish', () => {
		const line = `${req.method} ${req.originalUrl} → ${res.statusCode} (${Math.round(performance.now() - startedAt)}ms)`
		const tagged = req.user ? `${line} · user ${req.user.id}` : line
		if (appRoute) {
			logger.debug(tagged)
		} else {
			logger.verbose(tagged)
		}
	})
	next()
})

// Files come first, as their bodies are raw files: `express.json()` below would swallow an uploaded .json. Serving needs no sign-in:
// the id in the path is the capability, so the URL also works from the calendar servers and apps Mitra writes it into.
app.use('/api/files', fileContentRouter(fileTables))
app.use('/api/files', authMiddleware, filesRouter)

// Rehydrate typed JSON into domain model instances.
const modelConstructor = new ModelValueConstructor()
app.use(express.json({ reviver: (_key, value) => modelConstructor.shallConstruct(value) ? modelConstructor.construct(value) : value }))

// A calendar is private, so guest share routes mount before the owner auth: a guest signs in by link cookie alone.
app.use('/s/api', sharingRouter())

// The guest shell and share answers stay out of caches, crawlers and referrers.
const guestPage: RequestHandler = (req, res, next) => {
	if (req.path === '/s' || req.path.startsWith('/s/')) {
		res.setHeader('X-Robots-Tag', 'noindex')
		res.setHeader('Referrer-Policy', 'no-referrer')
		res.setHeader('Cache-Control', 'no-store')
	}
	next()
}
app.use(guestPage)

// Static assets the guest shell loads, shared with the owner frontend below.
// The guest page opens by link alone, so it is served before the owner sign-in has anything to say about it: under
// OIDC the SPA fallback sits behind `authMiddleware`, which would redirect `/s` to login and strand every guest.
app.get('/s', (_req, res) => res.sendFile('index.html', { root: frontendDistPath, headers: { 'Cache-Control': 'no-store' } }))
app.use('/s', (_req, res) => res.status(404).json({ error: 'Not found' }))

if (oidc) {
	app.use('/auth', authRouter)
	logger.info(`Multi-user mode: OIDC against ${oidc.issuer} (redirect URI ${oidc.redirectUri})`)
} else if (environment.demo) {
	logger.info('Demo mode: every visitor gets a sandbox with the sample calendar')
} else {
	logger.info('Single-user mode: no authentication (set MITRA_OIDC_ISSUER to enable multi-user sign-in)')
}

// Unauthenticated health check endpoint for orchestrators.
app.use('/api/health', healthRouter)
// Agents sign in by their access token, and only to their endpoint.
app.use('/api/mcp', accessTokenMiddleware)
app.use(authMiddleware)

app.use('/api/events', eventsRouter)
app.use('/api/entries', staleTabs)
app.use('/api/integrations/google', googleConnectRouter)
app.use('/api/notion', notionRouter)
// A calendar file arrives as itself, which `ImportIcs` and `PreviewIcsImport` read as the body.
app.use('/api/sources', express.text({ type: 'text/calendar', limit: '25mb' }))
app.use('/api/mcp', mcpRouter)
app.use('/api', operationsRouter(() => orm.em.fork()))

// Serve frontend SPA dist bundle.
app.use(precompressed(frontendDistPath))
app.use(express.static(frontendDistPath, { cacheControl: false, setHeaders: (res, file) => res.setHeader('Cache-Control', cacheControlOf(file)) }))
// The SPA fallback: any non-API path serves the shell, so deep links (/week?date=…) survive a reload.
app.get(/(.*)/, (_, res) => res.sendFile('index.html', { root: frontendDistPath, headers: { 'Cache-Control': cacheControlOf('index.html') } }))

app.use(errorHandler)

app.listen(environment.port, () => {
	logger.info(`Mitra ${mitra.version}: backend API running on http://localhost:${environment.port}`)
	logger.info(`Log level: ${logLevelName} (set MITRA_LOG_LEVEL=debug for per-request detail, trace for SQL)`)
})
