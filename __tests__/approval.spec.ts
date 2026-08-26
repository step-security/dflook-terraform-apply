import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { planHash, planOutHash, renderComment, parseComment } from '@core'
import { canSeekApproval, planIsApproved } from '../src/approval.js'

const ISSUE = 'https://api.github.com/repos/o/r/issues/1'
const PLAN = 'Terraform will perform the following actions:\n\nPlan: 1 to add, 0 to change, 0 to destroy.'

function context(headers: Record<string, string> = {}, body = PLAN) {
  const rendered = renderComment({
    headers: { workspace: 'default', ...headers },
    description: 'Plan',
    summary: 'Plan: 1 to add',
    bodyHighlighting: 'hcl',
    body,
    status: '',
  })

  return {
    client: {} as never,
    issueUrl: ISSUE,
    headers: {},
    existing: { comment: parseComment(rendered)!, url: `${ISSUE}/comments/1` },
  }
}

function planFile(contents: string): string {
  const path = join(mkdtempSync(join(tmpdir(), 'plan-')), 'plan.out')
  writeFileSync(path, contents)
  return path
}

/**
 * The default has to be refusal. Every path that cannot positively confirm the
 * plan was reviewed must leave the apply unapproved.
 */
describe('refusing by default', () => {
  it('refuses when there is no comment', () => {
    const withoutComment = { client: {} as never, issueUrl: ISSUE, headers: {} }
    expect(planIsApproved(withoutComment, { text: PLAN })).toBe(false)
  })

  it('refuses when there is neither plan text nor a plan file', () => {
    expect(planIsApproved(context(), {})).toBe(false)
  })
})

describe('approving from plan text', () => {
  it('approves a plan matching the recorded hash', () => {
    const ctx = context({ plan_hash: planHash(PLAN, ISSUE) })
    expect(planIsApproved(ctx, { text: PLAN })).toBe(true)
  })

  it('refuses a plan that changed since it was approved', () => {
    const ctx = context({ plan_hash: planHash(PLAN, ISSUE) })
    expect(planIsApproved(ctx, { text: 'Plan: 3 to destroy.' })).toBe(false)
  })

  /** A hash recorded against another pull request must not authorise this one. */
  it('refuses a hash from a different pull request', () => {
    const ctx = context({
      plan_hash: planHash(PLAN, 'https://api.github.com/repos/o/r/issues/99'),
    })
    expect(planIsApproved(ctx, { text: PLAN })).toBe(false)
  })

  it('falls back to comparing text when no hash was recorded', () => {
    expect(planIsApproved(context({}, PLAN), { text: PLAN })).toBe(true)
  })

  /**
   * The plan is compacted before hashing, so lines Terraform emits only
   * sometimes must not stop an approved plan from applying.
   */
  it('ignores state lock noise around the plan', () => {
    const ctx = context({ plan_hash: planHash(PLAN, ISSUE) })
    const noisy = `Acquiring state lock. This may take a few moments...\n${PLAN}`
    expect(planIsApproved(ctx, { text: noisy })).toBe(true)
  })
})

describe('approving from a saved plan file', () => {
  it('approves a file matching the recorded hash', () => {
    const path = planFile('reviewed plan')
    const ctx = context({ plan_out_hash: planOutHash(path, ISSUE) })
    expect(planIsApproved(ctx, { path })).toBe(true)
  })

  it('refuses a substituted file', () => {
    const ctx = context({ plan_out_hash: planOutHash(planFile('reviewed'), ISSUE) })
    expect(planIsApproved(ctx, { path: planFile('substituted') })).toBe(false)
  })

  /** There is no text to fall back on, so an unhashed comment approves nothing. */
  it('refuses when the comment recorded no plan file hash', () => {
    expect(planIsApproved(context({}), { path: planFile('anything') })).toBe(false)
  })

  it('prefers the plan file over text when both are given', () => {
    const path = planFile('reviewed plan')
    const ctx = context({ plan_hash: planHash(PLAN, ISSUE) })
    // The text would approve, the file will not. The file has to win.
    expect(planIsApproved(ctx, { text: PLAN, path })).toBe(false)
  })
})

/**
 * An apply awaiting approval can only run where a pull request can be found. Any
 * other event has to be told to use auto_approve rather than silently applying.
 */
describe('which events can find a pull request', () => {
  it.each([
    'push',
    'pull_request',
    'issue_comment',
    'pull_request_review_comment',
    'pull_request_target',
    'pull_request_review',
    'repository_dispatch',
  ])('accepts %s', (eventName) => {
    expect(canSeekApproval(eventName)).toBe(true)
  })

  it.each(['schedule', 'workflow_dispatch', 'release', 'create'])('rejects %s', (eventName) => {
    expect(canSeekApproval(eventName)).toBe(false)
  })
})
