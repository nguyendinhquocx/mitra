import { type RequestHandler } from 'express'
import { environment } from '../server/Environment.js'

/**
 * The instance's public origin, needed wherever mitra hands its own URL to somebody else (an
 * `ATTACH` line, a provider's file field). `MITRA_URL` is authoritative when set; otherwise the
 * address the last request arrived at stands in, which is what a localhost or LAN instance has.
 */
let observed: string | undefined

export function instanceOrigin(): string | undefined {
	return environment.url?.origin ?? observed
}

/** Remembers the address requests arrive at, so background writes can still build absolute URLs. */
export const observeInstanceOrigin: RequestHandler = (req, _res, next) => {
	// Express trusts forwarded protocol only when the socket peer matches `MITRA_TRUST_PROXY`; raw Host preserves local ports.
	const host = req.get('host')
	const protocol = req.protocol
	if (host && protocol) {
		observed = `${protocol}://${host}`
	}
	next()
}

/** Test seam — production only ever learns the origin from a real request. */
export function setObservedOrigin(origin: string | undefined) {
	observed = origin
}
