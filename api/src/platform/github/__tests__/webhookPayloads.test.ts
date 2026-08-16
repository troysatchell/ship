import { describe, it, expect } from 'vitest'
import { extractIssueReferences, derivePrState, PullRequestEventSchema } from '../webhookPayloads.js'

describe('extractIssueReferences', () => {
  it('extracts a single Ship#<n> reference from a title', () => {
    expect(extractIssueReferences('Fixes Ship#42', null)).toEqual([42])
  })

  it('is case-insensitive', () => {
    expect(extractIssueReferences('fixes SHIP#7 and ship#8')).toEqual([7, 8])
  })

  it('de-dupes repeated references across multiple fields, first-seen order', () => {
    expect(extractIssueReferences('Ship#5', 'also Ship#5 and Ship#9')).toEqual([5, 9])
  })

  it('does not match a reference embedded inside a longer token', () => {
    expect(extractIssueReferences('xShip#5 and Ship#5y')).toEqual([])
  })

  it('returns [] for text with no reference, never null/throws', () => {
    expect(extractIssueReferences('no reference here')).toEqual([])
    expect(extractIssueReferences(null, undefined, '')).toEqual([])
  })

  it('ignores a zero or malformed number', () => {
    expect(extractIssueReferences('Ship#0')).toEqual([])
  })
})

describe('derivePrState', () => {
  it('is open when GitHub state is open', () => {
    expect(derivePrState({ state: 'open', merged: false })).toBe('open')
  })

  it('is merged when closed AND merged=true', () => {
    expect(derivePrState({ state: 'closed', merged: true })).toBe('merged')
  })

  it('is closed when closed AND merged=false', () => {
    expect(derivePrState({ state: 'closed', merged: false })).toBe('closed')
  })
})

describe('PullRequestEventSchema', () => {
  it('parses a realistic GitHub pull_request "opened" payload (hand-built per GitHub docs)', () => {
    const payload = {
      action: 'opened',
      number: 17,
      pull_request: {
        number: 17,
        html_url: 'https://github.com/acme/widgets/pull/17',
        title: 'Fix login bug (Ship#42)',
        body: 'Closes Ship#42.',
        state: 'open',
        merged: false,
        head: { ref: 'fix/login-bug' },
      },
      repository: { name: 'widgets', owner: { login: 'acme' } },
      installation: { id: 123456 },
    }
    const result = PullRequestEventSchema.safeParse(payload)
    expect(result.success).toBe(true)
  })

  it('does not reject a payload carrying extra, unmodeled GitHub fields', () => {
    const payload = {
      action: 'opened',
      number: 1,
      pull_request: {
        number: 1,
        html_url: 'https://github.com/acme/widgets/pull/1',
        title: 'x',
        body: null,
        state: 'open',
        merged: false,
        head: { ref: 'x', sha: 'abc123' },
        draft: false,
        additions: 10,
      },
      repository: { name: 'widgets', owner: { login: 'acme', id: 999 }, private: false },
      sender: { login: 'someone' },
    }
    const result = PullRequestEventSchema.safeParse(payload)
    expect(result.success).toBe(true)
  })
})
