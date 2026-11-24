import dns from 'node:dns'
import net from 'node:net'
import { Agent, buildConnector } from 'undici'

/** Loopback, private, link-local (cloud metadata), shared, reserved and multicast ranges: none is the public web. */
const privateRanges = new net.BlockList()
for (const [address, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 3]] as const) {
	privateRanges.addSubnet(address, prefix, 'ipv4')
}
for (const [address, prefix] of [['::', 127], ['64:ff9b::', 96], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]] as const) {
	privateRanges.addSubnet(address, prefix, 'ipv6')
}

const isPrivate = (address: string) => privateRanges.check(address, net.isIPv6(address) ? 'ipv6' : 'ipv4')

/** An address the server would not connect to: its own network, or a port other than the scheme's. */
export class RefusedAddress extends Error {
	constructor(host: string) {
		super(`This server does not connect to ${host}, as it only reaches public addresses on the standard web ports`)
	}
}

/** Resolves as the connection is made, so a name that answers with a public address first and a private one later (DNS rebinding) is still refused. */
const publicLookup: net.LookupFunction = (hostname, options, callback) => {
	dns.lookup(hostname, { ...options, all: true }, (error, addresses) => {
		if (error || !addresses.length || addresses.some(({ address }) => isPrivate(address))) {
			return callback(error ?? new RefusedAddress(hostname), '', 0)
		}
		return options.all ? (callback as any)(null, addresses) : callback(null, addresses[0]!.address, addresses[0]!.family)
	})
}

/**
 * Where `fetch` sends a request to an address a user entered (`fetch(url, { dispatcher })`). Unless it may reach the
 * `privateNetwork`, it connects only to public addresses on the scheme's default port, checked as each connection is
 * made, so a redirect is checked as well; an address may come from someone else's text or a user the operator does not
 * vouch for.
 */
export class OutboundAgent extends Agent {
	constructor({ privateNetwork = false, maxResponseSize }: { readonly privateNetwork?: boolean, readonly maxResponseSize?: number } = {}) {
		const connect = buildConnector(privateNetwork ? {} : { lookup: publicLookup })
		super({
			maxResponseSize,
			// A literal address never reaches the lookup.
			connect: privateNetwork ? connect : (options, callback) => {
				const literal = options.hostname.replace(/^\[|\]$/g, '')
				return options.port || (net.isIP(literal) && isPrivate(literal))
					? callback(new RefusedAddress(options.host ?? options.hostname), null)
					: connect(options, callback)
			},
		})
	}
}
