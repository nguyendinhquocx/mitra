import { existsSync, statSync } from 'node:fs'
import path from 'node:path'

/** Compares the actual HTTP Host authority with the configured guest hostname; forwarded headers are deliberately not inputs. */
export function matchesPublicGuestHost(hostHeader: string | undefined, publicHost: string) {
	const host = (hostHeader ?? '').trim().toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '')
	return host === publicHost
}

/** Only the guest shell/API, health check and files that really exist in the built frontend may cross the public edge. */
export function allowsPublicGuestPath(method: string, requestPath: string, frontendRoot: string) {
	const reads = method === 'GET' || method === 'HEAD'
	if (reads && requestPath === '/s') {
		return true
	}
	if (requestPath === '/s/api' || requestPath.startsWith('/s/api/')) {
		return true
	}
	if (reads && requestPath === '/api/health') {
		return true
	}
	if (!reads) {
		return false
	}
	try {
		const decodedPath = decodeURIComponent(requestPath)
		const assetPath = path.resolve(frontendRoot, `.${decodedPath}`)
		const relative = path.relative(frontendRoot, assetPath)
		return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`)
			&& !path.isAbsolute(relative) && existsSync(assetPath) && statSync(assetPath).isFile()
	} catch {
		return false
	}
}
