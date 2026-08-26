import * as core from '@actions/core'
import {
  GitHubClient,
  backendFingerprint,
  compactPlan,
  completeBackendConfig,
  findPlanComment,
  findPullRequest,
  isApproved,
  isBinaryPlanApproved,
  planCommentHeaders,
  planHash,
  planOutHash,
  writePlanComment,
} from '@core'
import type { EventContext, FoundComment, TerraformModule } from '@core'
import type { Inputs } from './inputs.js'

/**
 * Getting an apply approved by a plan on a pull request.
 *
 * When `auto_approve` is not set, the authorisation for an apply is a plan that
 * was posted to a pull request and reviewed there. This module finds that
 * comment and decides whether it approves the plan about to be applied.
 *
 * The default is to refuse. Anything that goes wrong — no pull request, no
 * comment, no token, a plan that does not match — leaves the apply unapproved
 * rather than proceeding.
 */

/** Events from which a pull request can be found. */
const APPROVAL_EVENTS = [
  'push',
  'pull_request',
  'issue_comment',
  'pull_request_review_comment',
  'pull_request_target',
  'pull_request_review',
  'repository_dispatch',
]

export interface ApprovalContext {
  client: GitHubClient
  /** API url of the pull request's issue, used as the hash salt. */
  issueUrl: string
  headers: Record<string, string | undefined>
  existing?: FoundComment
}

/** True when this event could have a plan comment to approve from. */
export function canSeekApproval(eventName: string): boolean {
  return APPROVAL_EVENTS.includes(eventName)
}

export interface SetupOptions {
  inputs: Inputs
  module: TerraformModule
  backendType: string
  dataDir: string
  token: string
  event: EventContext
}

/**
 * Locates the pull request and the comment for this configuration.
 *
 * The comment is identified by workspace, label, backend and the arguments that
 * shape the plan, so a pull request touching several modules keeps them apart.
 */
export async function findApprovalContext(options: SetupOptions): Promise<ApprovalContext> {
  const client = new GitHubClient({
    token: options.token,
    apiUrl: options.event.apiUrl,
  })

  const prUrl = await findPullRequest(client, options.event)
  const pr = await client.getPullRequest(prUrl)
  const issueUrl = pr.issue_url

  const fingerprint = backendFingerprint({
    backendType: options.backendType,
    config: completeBackendConfig({
      module: options.module,
      backendConfig: options.inputs.backendConfig,
      backendConfigFile: options.inputs.backendConfigFile,
      workspaceRoot: options.inputs.workspaceRoot,
    }),
    modulePath: options.inputs.path,
    dataDir: options.dataDir,
  })

  const headers = planCommentHeaders(
    {
      workspace: options.inputs.workspace,
      label: options.inputs.label,
      backendType: options.backendType,
      backendFingerprint: fingerprint,
      planModifier: {
        target: options.inputs.target,
        replace: options.inputs.replace,
        destroy: options.inputs.destroy,
      },
    },
    issueUrl
  )

  const existing = await findPlanComment(client, issueUrl, headers)

  return { client, issueUrl, headers, existing }
}

/**
 * Decides whether the plan is approved by the comment on the pull request.
 *
 * A missing comment is not an approval. Neither is a comment whose plan differs.
 */
export function planIsApproved(
  context: ApprovalContext,
  plan: { text?: string; path?: string }
): boolean {
  if (!context.existing) {
    core.error(
      'No plan found on the pull request for this configuration. ' +
        'Run terraform-plan first, or set auto_approve to apply without review.'
    )
    return false
  }

  if (plan.path) {
    if (isBinaryPlanApproved(plan.path, context.existing.comment, context.issueUrl)) return true
    core.error('The saved plan does not match the plan that was approved on the pull request.')
    return false
  }

  if (plan.text === undefined) return false

  if (isApproved(compactPlan(plan.text), context.existing.comment, context.issueUrl)) return true

  core.error(
    'The plan has changed since it was approved on the pull request. ' +
      'Review the new plan and apply again.'
  )
  return false
}

export type CommentState = 'begin-apply' | 'applied' | 'no-changes' | 'error'

const STATUS: Record<CommentState, string> = {
  'begin-apply': ':orange_circle: Applying plan in',
  applied: ':white_check_mark: Applied in',
  'no-changes': ':white_check_mark: No changes to apply in',
  error: ':x: Apply failed in',
}

/**
 * Updates the comment to say what happened.
 *
 * Best effort throughout. The apply itself is what matters, and a comment that
 * could not be written must not turn a successful apply into a failed step.
 */
export async function updateComment(
  context: ApprovalContext,
  state: CommentState,
  options: {
    plan: string
    planHashSalt?: string
    planPath?: string
    runUrl?: string
  }
): Promise<void> {
  try {
    const headers = { ...context.headers } as Record<string, string>
    delete headers.closed

    // Record what was applied so a later run can recognise it.
    if (options.planPath) {
      headers.plan_out_hash = planOutHash(options.planPath, context.issueUrl)
    } else if (options.plan) {
      headers.plan_hash = planHash(options.plan, context.issueUrl)
    }

    const status = options.runUrl
      ? `${STATUS[state]} [this run](${options.runUrl})`
      : STATUS[state]

    await writePlanComment({
      client: context.client,
      issueUrl: context.issueUrl,
      headers,
      description: 'Terraform plan',
      summary: summaryFor(options.plan),
      body: options.plan,
      status,
      existing: context.existing,
    })
  } catch (error) {
    core.debug(
      `Could not update the pull request comment: ${
        error instanceof Error ? error.message : String(error)
      }`
    )
  }
}

/** The line shown when the plan is collapsed. */
function summaryFor(plan: string): string {
  const summary = /^Plan: .*$/m.exec(plan)
  if (summary) return summary[0]
  if (plan.startsWith('No changes')) return 'No changes'
  if (plan.startsWith('Error')) return 'Error'
  return 'Terraform plan'
}
