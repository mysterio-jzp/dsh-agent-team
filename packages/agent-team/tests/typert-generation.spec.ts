import { describe, expect, it } from 'vitest'
import { TYPERT } from '../lib/typert.host.js'
import remote from '../lib/typert.remote-client.js'

interface GeneratedInvocation {
  readonly method: string
}

interface GeneratedHost {
  readonly invocations: readonly GeneratedInvocation[]
}

interface GeneratedRemote {
  readonly descriptors: readonly GeneratedInvocation[]
}

// The Client boundary, written out by hand.
//
// This list is deliberately NOT derived from anything in this run. The version
// this file replaced compared the host artifact against the remote artifact —
// both emitted by one generator call — so the two sides could not disagree and
// the assertion could never fail. What that misses is the question that
// matters: is the boundary still the one we intend to publish? Only a
// hand-written expected set can answer it, so adding a Remote method with no
// caller, or renaming one out from under the Client, fails here.
//
// Keeping this list costs one line per method and buys the answer; treat an
// edit to it as a statement about the public boundary, not as test maintenance.
const EXPECTED_REMOTE_METHODS = [
  'addChannelMember',
  'addMember',
  'archiveChannel',
  'archiveMember',
  'changeAttention',
  'changeHumanTodo',
  'changeTask',
  'changes',
  'channelWorkingDirectorySettings',
  'clearMemberContext',
  'contextJudge',
  'createChannel',
  'environment',
  'getAttachment',
  'getHumanAvatar',
  'getMemberAvatar',
  'humanProfile',
  'humanTodos',
  'inbox',
  'joinWorkspace',
  'leaveWorkspace',
  'members',
  'promoteThread',
  'putAttachment',
  'putHumanAvatar',
  'putMemberAvatar',
  'readMessage',
  'readThread',
  'recoverMember',
  'removeHumanAvatar',
  'removeMemberAvatar',
  'removeThreadMember',
  'reply',
  'replySettings',
  'resolveMessageRefs',
  'resolveTaskRefs',
  'resolveThreadRefs',
  'sendMessage',
  'setHumanProfile',
  'setPresident',
  'threadHistory',
  'threadObservations',
  'updateChannel',
  'updateChannelMemberWorkingDirectories',
  'updateChannelWorkingDirectories',
  'updateMember',
  'view',
]

describe('Agent Team generated Typert boundary', () => {
  it('publishes exactly the intended Agent Team Client boundary', () => {
    const host = TYPERT as GeneratedHost
    const client = remote as unknown as GeneratedRemote
    expect(host.invocations.map(invocation => invocation.method).sort()).toEqual(EXPECTED_REMOTE_METHODS)
    expect(client.descriptors.map(invocation => invocation.method).sort()).toEqual(EXPECTED_REMOTE_METHODS)
  })
})
