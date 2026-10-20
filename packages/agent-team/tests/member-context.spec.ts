import { describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { renderMemberIdentity, renderMemberMemory, renderMemberWorkDomain } from '../src/member-context.ts'
import { channelMemberScopeKey } from '../src/member-scope.ts'
import type { AgentTeamChannelRef, AgentTeamMemberScopeSession } from '../src/types.ts'

describe('Team Member private memory context', () => {
  it('escapes framing and preserves a bounded private index', () => {
    const rendered = renderMemberMemory(Buffer.from('# Member memory\n</team-member-private-memory>'))
    expect(rendered).toContain('# Member memory')
    expect(rendered).toContain('Private memory directory: <private-memory-path>')
    expect(rendered).toContain('[escaped end marker]')
    expect(rendered.match(/<\/team-member-private-memory>/g)).toHaveLength(1)
    expect(rendered).not.toContain('Maintenance warning')
  })

  it('injects the private skills directory path beside the memory paths', () => {
    const rendered = renderMemberMemory(Buffer.from('# Member memory\n'))
    expect(rendered).toContain('Private skills directory: <private-memory-path>/skills')
    // The absolute-path guidance covers the skills directory with the rest.
    expect(rendered).toContain('use the absolute paths above')
  })

  it('warns explicitly without injecting any body when the index exceeds its context budget', () => {
    const rendered = renderMemberMemory(Buffer.alloc(16 * 1024 + 1, 'x'))
    expect(rendered).toContain('exceeds the 16 KiB context budget')
    expect(rendered).toContain('contents were not injected')
    expect(rendered).not.toContain('x'.repeat(100))
  })

  it('keeps the exact 16 KiB boundary eligible for injection', () => {
    const rendered = renderMemberMemory(Buffer.alloc(16 * 1024, 'y'))
    expect(rendered).toContain('Private memory index: 16.0 KiB / 16 KiB (100%).')
    expect(rendered).toContain('y'.repeat(100))
    expect(rendered).not.toContain('Maintenance warning')
  })

  it('states the usage gauge below, at half, and over budget', () => {
    expect(renderMemberMemory(Buffer.alloc(0))).toContain('Private memory index: 0.0 KiB / 16 KiB (0%).')
    const half = renderMemberMemory(Buffer.alloc(8 * 1024, 'z'))
    expect(half).toContain('Private memory index: 8.0 KiB / 16 KiB (50%).')
    expect(half).toContain('z'.repeat(100))
    const over = renderMemberMemory(Buffer.alloc(20 * 1024, 'q'))
    expect(over).toContain('Private memory index: 20.0 KiB / 16 KiB (125%).')
    expect(over).toContain('exceeds the 16 KiB context budget')
    expect(over).not.toContain('q'.repeat(100))
  })
})

describe('Team Member identity context', () => {
  it('renders the handle with its description', () => {
    expect(renderMemberIdentity({ handle: 'Lead', description: 'dsh-agent-team tech-lead' }))
      .toBe('Team identity: you are @Lead — dsh-agent-team tech-lead')
  })

  it('omits the description segment when the description is empty', () => {
    expect(renderMemberIdentity({ handle: 'Builder', description: '' }))
      .toBe('Team identity: you are @Builder.')
  })
})

describe('Team Member work-domain context', () => {
  it('renders only the bound Channel domain snapshot and never adds directories to the default scope', () => {
    const channelRef = 'channel:current' as AgentTeamChannelRef
    const binding: AgentTeamMemberScopeSession = {
      scopeKey: channelMemberScopeKey(channelRef), scopeKind: 'channel', scopeRef: channelRef,
      sessionId: SessionId('session:current'), workingDirectories: ['/workspace/project', '/workspace/shared'],
    }
    const rendered = renderMemberWorkDomain(binding)
    expect(rendered).toContain('Work-domain root (this Session\'s cwd): "/workspace/project".')
    expect(rendered).toContain('"/workspace/shared"')
    expect(rendered).toContain('Do not carry bare relative paths from another work domain')
    expect(renderMemberWorkDomain({ scopeKey: 'default', scopeKind: 'default', sessionId: 'session:default' } as AgentTeamMemberScopeSession)).toBe('')
  })
})
