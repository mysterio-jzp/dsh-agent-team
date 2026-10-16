import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type {
  AgentTeamAttachmentId, AgentTeamPutAttachmentRequest, AgentTeamPutAttachmentResult, AgentTeamRequestId,
} from '@contexera/dsh-agent-team/types'
import { bytesToBase64 } from './attachment-preview.ts'

/** Fresh idempotency identity for one Client-initiated durable request. */
export const mintRequestId = (): AgentTeamRequestId => crypto.randomUUID() as AgentTeamRequestId

/**
 * Upload composer files in order. A supplied cache keeps successful uploads
 * stable across retries; one failure stops with the error text and leaves the
 * remaining files for the caller to retry with its chips intact.
 */
export const uploadComposerFiles = async (
  putAttachment: (request: AgentTeamPutAttachmentRequest) => Promise<RemoteResult<AgentTeamPutAttachmentResult>>,
  workspaceId: AgentTeamPutAttachmentRequest['workspaceId'],
  files: readonly File[],
  uploadedByFile?: WeakMap<File, AgentTeamAttachmentId>,
): Promise<{ ok: true; attachmentIds: readonly AgentTeamAttachmentId[] } | { ok: false; error: string }> => {
  const attachmentIds: AgentTeamAttachmentId[] = []
  for (const file of files) {
    const cachedId = uploadedByFile?.get(file)
    if (cachedId !== undefined) {
      attachmentIds.push(cachedId)
      continue
    }
    const uploaded = await putAttachment({
      requestId: mintRequestId(), workspaceId,
      name: file.name,
      mediaType: file.type === '' ? undefined : file.type,
      bytesBase64: bytesToBase64(new Uint8Array(await file.arrayBuffer())),
    })
    if (!uploaded.ok) return { ok: false, error: uploaded.error.message }
    uploadedByFile?.set(file, uploaded.value.attachmentId)
    attachmentIds.push(uploaded.value.attachmentId)
  }
  return { ok: true, attachmentIds }
}
