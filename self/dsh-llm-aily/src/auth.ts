/**
 * aily login-credential helpers: read the aily-blockly `.aily` token file,
 * inspect the JWT expiry, and refresh it through `/api/v1/auth/refresh`. The
 * plugin owns token policy; this module is the token-plane implementation.
 *
 * @module @deepseek-ai/dsh-llm-aily/auth
 */

import { readFile, stat, writeFile } from 'node:fs/promises'
import { LlmError } from '@deepseek-ai/dsh-llm'

/** A `.aily` file's relevant credentials. */
export interface AilyAuthState {
  access: string
  refresh: string | undefined
}

/** Decode a JWT payload (base64url) without verifying the signature. */
export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split('.')
    const part = parts[1]
    if (part === undefined) return null
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/')
    const pad = b64.length % 4 === 0 ? b64 : b64 + '='.repeat(4 - (b64.length % 4))
    const obj = JSON.parse(atob(pad)) as unknown
    return obj !== null && typeof obj === 'object' ? obj as Record<string, unknown> : null
  } catch {
    return null
  }
}

/** Whether a token is missing, unusable, or within `skewMs` of expiry. */
export function tokenNeedsRefresh(access: string, _refresh: string | undefined, skewMs = 60_000): boolean {
  if (access.length === 0) return true
  const payload = decodeJwtPayload(access)
  const exp = payload !== null && typeof payload.exp === 'number' ? payload.exp * 1000 : Number.NaN
  if (Number.isFinite(exp)) return exp < Date.now() + skewMs
  // No exp claim: treat as valid; only refresh on a 401.
  return false
}

/** Read the `.aily` token file. Returns null when absent or unreadable. */
export async function readTokenFile(path: string): Promise<AilyAuthState | null> {
  try {
    const info = await stat(path)
    if (!info.isFile()) return null
    const text = await readFile(path, 'utf8')
    const data = JSON.parse(text) as { access_token?: unknown; refresh_token?: unknown }
    // aily-blockly may store a safeStorage base64 blob; decode it once when it
    // is not already a JWT. Plaintext JWTs pass straight through.
    let access = typeof data.access_token === 'string' ? data.access_token.trim() : ''
    if (access.length > 0 && !access.startsWith('eyJ')) {
      try {
        const decoded = atob(access)
        if (decoded.startsWith('eyJ')) access = decoded.trim()
      } catch {
        // Not base64; keep as-is.
      }
    }
    const refresh = typeof data.refresh_token === 'string' && data.refresh_token.length > 0
      ? data.refresh_token.trim()
      : undefined
    if (access.length === 0 && refresh === undefined) return null
    return { access, refresh }
  } catch {
    return null
  }
}

/** Exchange a refresh token for a new access token. `data` shape follows the response envelope. */
async function fetchRefresh(baseUrl: string, refresh: string): Promise<{ access?: string; refresh?: string } | null> {
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/v1/auth/refresh`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ refresh_token: refresh }),
  })
  if (res.status !== 200) return null
  try {
    const parsed = await res.json() as { data?: { access_token?: unknown; refresh_token?: unknown } }
    const data = parsed.data ?? (parsed as { access_token?: unknown; refresh_token?: unknown })
    const access = typeof (data as { access_token?: unknown }).access_token === 'string'
      ? (data as { access_token: string }).access_token
      : undefined
    const nextRefresh = typeof (data as { refresh_token?: unknown }).refresh_token === 'string'
      ? (data as { refresh_token: string }).refresh_token
      : undefined
    if (access === undefined && nextRefresh === undefined) return null
    return {
      ...access === undefined ? {} : { access },
      ...nextRefresh === undefined ? {} : { refresh: nextRefresh },
    }
  } catch {
    return null
  }
}

/** Persist a refreshed credential set back to the `.aily` file (best effort). */
export async function writeTokenFile(path: string, access: string, refresh: string | undefined): Promise<void> {
  const existing = await readTokenFile(path)
  const next: Record<string, unknown> = {
    access_token: access,
    refresh_token: refresh ?? existing?.refresh,
    updated_at: new Date().toISOString(),
  }
  try {
    await writeFile(path, JSON.stringify(next, null, 2), 'utf8')
  } catch {
    // Best effort: a failed write-back must not fail the request.
  }
}

/**
 * Resolve a usable access token for one request: read the file, refresh when
 * the current token is missing/expiring, and write the refreshed set back.
 */
export async function resolveAccessToken(baseUrl: string, tokenFile: string): Promise<string> {
  const state = await readTokenFile(tokenFile)
  if (state === null) {
    throw new LlmError(
      `aily: no login token found at ${tokenFile}; log in once in aily-blockly (or set tokenFile in the llm-aily settings section)`,
      'MISSING_CREDENTIAL',
    )
  }
  if (state.access.length > 0 && !tokenNeedsRefresh(state.access, state.refresh)) {
    return state.access
  }
  if (state.refresh === undefined) {
    throw new LlmError(`aily: login token at ${tokenFile} is expired and no refresh token is available`, 'AUTH')
  }
  const refreshed = await fetchRefresh(baseUrl, state.refresh)
  if (refreshed?.access === undefined) {
    throw new LlmError('aily: token refresh failed; re-login in aily-blockly', 'AUTH')
  }
  await writeTokenFile(tokenFile, refreshed.access, refreshed.refresh ?? state.refresh)
  return refreshed.access
}
