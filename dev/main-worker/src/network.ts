import { Context } from 'hono'
import { getConnInfo } from 'hono/cloudflare-workers'

interface ConnectionMetadata {
  method: string
  path: string
  source_ip_address: string
  source_port: number | null
  destination_ip_address: string | null
  destination_port: number | null
  destination_hostname: string | null
  user_agent: string | null
  continent: string | null
  country: string | null
  city: string | null
  as_organization: string | null
  asn: number | null
  timezone: string | null
  region: string | null
  region_code: string | null
  subdomain: string | null
}

export function getClientIpAddress(c: Context): string {
  const info = getConnInfo(c)
  return info.remote.address || c.req.header('X-Forwarded-For') || ''
}

function getDomainFromUrl(url: string): string | null {
  try {
    const parsedUrl = new URL(url)
    return parsedUrl.hostname
  } catch {
    return null
  }
}

export function getClientDetails(c: Context): ConnectionMetadata {
  return {
    method: c.req.method,
    path: c.req.path,
    source_ip_address: getClientIpAddress(c) || '',
    source_port: parseInt(c.req.header('x-client-port') || '0') || null,
    destination_ip_address: c.req.header('edge-server-ip') || null,
    destination_port: parseInt(c.req.header('edge-server-port') || '0') || null,
    destination_hostname: c.req.header('host') || null,
    user_agent: c.req.header('user-agent') || null,
    continent: (c.req.raw.cf?.continent as string) || null,
    asn: parseInt((c.req.raw.cf?.asn as string) || '0') || null,
    as_organization: (c.req.raw.cf?.asOrganization as string) || null,
    country: c.req.header('cf-ipcountry') || null,
    city: (c.req.raw.cf?.city as string) || null,
    timezone: (c.req.raw.cf?.timezone as string) || null,
    region: (c.req.raw.cf?.region as string) || null,
    region_code: (c.req.raw.cf?.regionCode as string) || null,
    subdomain: getDomainFromUrl(c.req.url),
  }
}
