import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { ATTACHMENT_MAX_BYTES, sanitizeFileName, sanitizeMediaType } from './attachments.ts'

/**
 * Persistent Member avatar store.
 *
 * Deliberately the same shape as `human-avatar.ts` — one immutable directory
 * per avatar holding the payload plus `meta.json`, under a root of its own with
 * no TTL sweep — because the two seats are read by the same Client code and a
 * second layout would mean a second reader. The root differs (`member/` rather
 * than `human/`) so a Member's bytes can be removed with its Member without
 * touching the Human's.
 *
 * A Member's avatar is referenced from the Member record itself (`avatarRef`),
 * exactly as the Human's is referenced from its profile: the store owns the
 * bytes, the record owns whether they are still in use. `readMemberAvatar`
 * returning `undefined` is therefore the authority for "this avatar no longer
 * exists" — the same rule the Human seat already follows, so a ref whose bytes
 * were swept renders the initial instead of a blank circle.
 */

export function memberAvatarsRoot(): string {
  return dshHomePath('agent-team', 'member', 'v1')
}

function avatarDir(root: string, avatarRef: string): string {
  return join(root, avatarRef)
}

export interface StoredMemberAvatar {
  readonly name: string
  readonly mediaType: string
  readonly byteSize: number
  readonly uploadedAt: string
  readonly bytes: Buffer
}

/**
 * Accept only image payloads. Same contract as the Human seat: the setting
 * promises a picture, and a non-image would be stored happily and then render
 * as nothing, which the fallback cannot distinguish from a decode failure.
 */
export function assertMemberAvatarMediaType(mediaType: string): string {
  const sanitized = sanitizeMediaType(mediaType)
  if (!sanitized.startsWith('image/')) throw new Error(`member avatar must be an image (got '${mediaType}')`)
  return sanitized
}

/** Write one avatar as an immutable entry; the caller stores the ref on the Member. */
export async function writeMemberAvatar(
  root: string,
  rawName: string,
  mediaType: string,
  bytes: Buffer,
): Promise<{ avatarRef: string; path: string; name: string; byteSize: number; mediaType: string }> {
  if (bytes.byteLength === 0) throw new Error('member avatar must not be empty')
  if (bytes.byteLength > ATTACHMENT_MAX_BYTES) throw new Error(`member avatar exceeds the ${ATTACHMENT_MAX_BYTES} byte limit`)
  const storedMediaType = assertMemberAvatarMediaType(mediaType)
  const name = sanitizeFileName(rawName)
  const avatarRef = randomUUID()
  const dir = avatarDir(root, avatarRef)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, name), bytes)
  await writeFile(join(dir, 'meta.json'), JSON.stringify({ name, mediaType: storedMediaType, uploadedAt: new Date().toISOString() }), 'utf8')
  return { avatarRef, path: join(dir, name), name, byteSize: bytes.byteLength, mediaType: storedMediaType }
}

/** Read one avatar back; `undefined` when removed or never written. */
export async function readMemberAvatar(root: string, avatarRef: string): Promise<StoredMemberAvatar | undefined> {
  const dir = avatarDir(root, avatarRef)
  let metaRaw: Buffer
  try {
    metaRaw = await readFile(join(dir, 'meta.json'))
  } catch {
    return undefined
  }
  const meta = JSON.parse(metaRaw.toString('utf8')) as { name: string; mediaType: string; uploadedAt: string }
  const entries = await readdir(dir)
  const payload = entries.filter(entry => entry !== 'meta.json')[0]
  if (payload === undefined) return undefined
  const bytes = await readFile(join(dir, payload))
  return { name: meta.name, mediaType: meta.mediaType, byteSize: bytes.byteLength, uploadedAt: meta.uploadedAt, bytes }
}

/** Remove one avatar entry; missing entries already satisfy the removal. */
export async function removeMemberAvatar(root: string, avatarRef: string): Promise<void> {
  await rm(avatarDir(root, avatarRef), { recursive: true, force: true })
}
