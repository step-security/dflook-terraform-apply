import { mkdirSync, mkdtempSync, writeFileSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { join } from 'path'
import { pathToFileURL } from 'url'
import * as core from '@actions/core'
import {
  PLAN_CHANGES,
  PLAN_ERROR,
  PLAN_NO_CHANGES,
  acquire,
  backendConfigArgs,
  candidateVersions,
  cannotSavePlan,
  compactPlan,
  deleteAutoTfVars,
  flattenOutputs,
  getBackendType,
  getLockInfo,
  getOpenTofuVersions,
  getRemoteRunId,
  getTerraformVersions,
  isRemoteExecution,
  initBackendWorkspace,
  loadModule,
  parseOutputs,
  planArgs,
  publishOutputs,
  resolveVersion,
  runApply,
  runPlan,
  runPreRunCommands,
  runTool,
  savedPlanHasNoChanges,
  writeAutoTfVars,
  writeCredentials,
} from '@core'
import type { TerraformModule } from '@core'
import { InputError, loadInputs } from './inputs.js'
import type { Inputs } from './inputs.js'
import { canSeekApproval, findApprovalContext, planIsApproved, updateComment } from './approval.js'
import type { ApprovalContext } from './approval.js'
import { validateSubscription } from './subscription.js'

/** Directory inside the workspace where plan artifacts are written. */
const ARTIFACT_DIR = '.terraform-apply'

function setFailureReason(reason: string): void {
  core.setOutput('failure-reason', reason)
  core.setOutput('failure_reason', reason)
}

/**
 * Publishes the lock details.
 *
 * Both spellings are documented outputs, so both are set. An empty object is
 * still worth publishing: it says the lock was held but the backend reported
 * nothing about by whom.
 */
/**
 * Publishes the remote run identifier, when there is one.
 *
 * Only the remote and cloud backends execute remotely, and the id is scraped
 * from output because Terraform reports it no other way. Absence is normal, so
 * it is not an error.
 */
function setRunId(backendType: string, ...sources: (string | undefined)[]): void {
  if (!isRemoteExecution(backendType)) return

  const runId = getRemoteRunId(...sources)
  if (runId) core.setOutput('run_id', runId)
}

function setLockInfo(info: Record<string, string>): void {
  const encoded = JSON.stringify(info)
  core.setOutput('lock-info', encoded)
  core.setOutput('lock_info', encoded)
}

function openTofuRequested(): boolean {
  return process.env.OPENTOFU_VERSION !== undefined || process.env.OPENTOFU === 'true'
}

interface Prepared {
  binary: string
  env: NodeJS.ProcessEnv
  dataDir: string
  tempDir: string
  backendType: string
  module: TerraformModule
}

/**
 * Installs the tool and prepares the environment.
 *
 * Ordering is upstream's: the tool is installed before `TERRAFORM_PRE_RUN`, and
 * `TF_WORKSPACE` is cleared so a value inherited from the job cannot silently
 * override the `workspace` input.
 */
async function prepare(inputs: Inputs): Promise<Prepared> {
  const tempDir = mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), 'terraform-apply-'))
  const dataDir = join(tempDir, 'terraform-data-dir')
  const pluginCache = join(homedir(), '.terraform.d', 'plugin-cache')
  mkdirSync(dataDir, { recursive: true })
  mkdirSync(pluginCache, { recursive: true })

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TF_DATA_DIR: dataDir,
    TF_PLUGIN_CACHE_DIR: pluginCache,
    TF_IN_AUTOMATION: 'true',
  }
  delete env.TF_WORKSPACE

  if (!env.TERRAFORM_ACTIONS_GITHUB_TOKEN && env.GITHUB_TOKEN) {
    env.TERRAFORM_ACTIONS_GITHUB_TOKEN = env.GITHUB_TOKEN
  }

  writeCredentials({
    cloudTokens: process.env.TERRAFORM_CLOUD_TOKENS,
    httpCredentials: process.env.TERRAFORM_HTTP_CREDENTIALS,
    sshKey: process.env.TERRAFORM_SSH_KEY,
  })

  const openTofu = openTofuRequested()
  const module = loadModule(inputs.path, openTofu)
  const terraform = await getTerraformVersions()
  const tofu = openTofu ? await getOpenTofuVersions(process.env.GITHUB_TOKEN) : undefined

  const resolution = resolveVersion(
    { modulePath: inputs.path, workspaceRoot: inputs.workspaceRoot, openTofu },
    { module, versions: candidateVersions(terraform, tofu), env: process.env }
  )

  if (!resolution) {
    throw new Error('No release matched the version constraints in effect')
  }

  core.info(
    `Using ${resolution.version.product} ${resolution.version} because ${resolution.reason}`
  )
  const binary = await acquire(resolution.version)

  const backendType = getBackendType(module)
  if (backendType) core.info(`Detected ${backendType} backend`)

  await runPreRunCommands(process.env.TERRAFORM_PRE_RUN)

  return { binary, env, dataDir, tempDir, backendType, module }
}

/** Writes a file into the workspace and returns its workspace-relative path. */
function writeArtifact(inputs: Inputs, name: string, contents: string): string {
  const dir = join(inputs.workspaceRoot, ARTIFACT_DIR)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, name), contents)
  return join(ARTIFACT_DIR, name)
}

/** Publishes the root module outputs, masking sensitive ones first. */
async function publishTerraformOutputs(
  prepared: Prepared,
  inputs: Inputs
): Promise<void> {
  const result = await runTool(prepared.binary, ['output', '-json'], {
    cwd: inputs.path,
    env: prepared.env,
    silent: true,
  })

  if (result.exitCode !== 0) {
    core.debug(`Could not read outputs: ${result.stderr}`)
    return
  }

  try {
    const outputs = parseOutputs(result.stdout)
    publishOutputs(outputs)
    const path = writeArtifact(
      inputs,
      'outputs.json',
      `${JSON.stringify(flattenOutputs(outputs), null, 2)}\n`
    )
    core.setOutput('json_output_path', path)
  } catch (error) {
    core.debug(`Could not parse outputs: ${error instanceof Error ? error.message : String(error)}`)
  }
}

interface PlanStage {
  /** Compacted plan text, when one was generated. */
  text?: string
  /** Saved plan file to apply, when the backend can produce one. */
  planOut?: string
  /** Terraform's plan exit code. */
  exitCode: number
}

/**
 * Generates the plan to apply, or adopts the one given.
 *
 * The remote backend cannot save a plan file. When that happens and the caller
 * asked for `auto_approve`, planning is skipped entirely and the apply
 * regenerates it, which is what upstream does — there is no point planning twice
 * when nothing will review it.
 */
async function makePlan(
  prepared: Prepared,
  inputs: Inputs,
  args: { parallelism: string[]; args: string[] }
): Promise<PlanStage> {
  if (inputs.planPath) {
    // Given a plan file, there is nothing to generate.
    return { planOut: inputs.planPath, exitCode: PLAN_CHANGES }
  }

  const planOut = join(prepared.tempDir, 'plan.out')

  let result = await runPlan({
    binary: prepared.binary,
    modulePath: inputs.path,
    planOut,
    parallelism: args.parallelism,
    args: args.args,
    env: prepared.env,
  })

  let savedPlan: string | undefined = planOut

  if (result.exitCode === PLAN_ERROR && cannotSavePlan(result.stderr)) {
    savedPlan = undefined

    if (inputs.autoApprove) {
      core.info('This backend cannot save a plan; the apply will generate it.')
      return { exitCode: PLAN_CHANGES }
    }

    core.info('This backend cannot save a plan; planning again without one.')
    result = await runPlan({
      binary: prepared.binary,
      modulePath: inputs.path,
      parallelism: args.parallelism,
      args: args.args,
      env: prepared.env,
    })
  }

  if (result.exitCode === PLAN_ERROR) {
    const lockInfo = getLockInfo(result.stderr)
    if (lockInfo) {
      setLockInfo(lockInfo)
      setFailureReason('state-locked')
    }
    throw new Error('Error running Terraform plan')
  }

  setRunId(prepared.backendType, result.output, result.stderr)

  const text = compactPlan(result.output)

  // Published so a workflow can attach the plan to the run.
  core.setOutput('text_plan_path', writeArtifact(inputs, 'plan.txt', text))

  if (savedPlan) {
    const shown = await runTool(prepared.binary, ['show', '-json', savedPlan], {
      cwd: inputs.path,
      env: prepared.env,
      silent: true,
    })
    if (shown.exitCode === 0) {
      core.setOutput('json_plan_path', writeArtifact(inputs, 'plan.json', shown.stdout))
    } else {
      core.debug(`Could not render the plan as json: ${shown.stderr}`)
    }
  }

  return { text, planOut: savedPlan, exitCode: result.exitCode }
}

/** Runs the apply and reports the outcome. */
async function applyPlan(
  prepared: Prepared,
  inputs: Inputs,
  plan: PlanStage,
  args: { parallelism: string[]; args: string[] },
  approval: ApprovalContext | undefined
): Promise<number> {
  const result = await runApply({
    binary: prepared.binary,
    modulePath: inputs.path,
    planOut: plan.planOut,
    parallelism: args.parallelism,
    args: args.args,
    env: prepared.env,
  })

  setRunId(prepared.backendType, result.output, result.stderr)

  // Terraform Cloud refuses to apply an empty plan. Nothing is wrong.
  if (prepared.backendType === 'cloud' && savedPlanHasNoChanges(result.stderr)) {
    core.info('No changes to apply')
    await publishTerraformOutputs(prepared, inputs)
    if (approval) {
      await updateComment(approval, 'no-changes', { plan: plan.text ?? 'No changes' })
    }
    return 0
  }

  if (result.exitCode !== 0) {
    if (result.lockInfo) setLockInfo(result.lockInfo)
    setFailureReason(result.failure ?? 'apply-failed')
    if (approval) {
      await updateComment(approval, 'error', { plan: plan.text ?? result.stderr })
    }
    return 1
  }

  await publishTerraformOutputs(prepared, inputs)

  if (approval) {
    await updateComment(approval, 'applied', {
      plan: plan.text ?? 'Applied',
      planPath: plan.planOut,
    })
  }

  return 0
}

export async function run(): Promise<number> {
  await validateSubscription()

  let inputs: Inputs
  try {
    inputs = loadInputs()
  } catch (error) {
    if (error instanceof InputError) {
      core.error(error.message)
      return 1
    }
    throw error
  }

  let prepared: Prepared | undefined

  try {
    prepared = await prepare(inputs)

    writeAutoTfVars(
      { variables: inputs.variables, varFile: inputs.varFile },
      inputs.path,
      inputs.workspaceRoot
    )

    const initResult = await initBackendWorkspace({
      binary: prepared.binary,
      modulePath: inputs.path,
      workspace: inputs.workspace,
      backendConfigArgs: backendConfigArgs(
        { backendConfig: inputs.backendConfig, backendConfigFile: inputs.backendConfigFile },
        { modulePath: inputs.path, workspaceRoot: inputs.workspaceRoot }
      ),
      dataDir: prepared.dataDir,
      env: prepared.env,
      backendType: prepared.backendType,
    })

    if (initResult.tfWorkspace) prepared.env.TF_WORKSPACE = initResult.tfWorkspace

    const args = planArgs({
      parallelism: inputs.parallelism,
      target: inputs.target,
      replace: inputs.replace,
      destroy: inputs.destroy,
      refresh: inputs.refresh,
    })

    const token = process.env.TERRAFORM_ACTIONS_GITHUB_TOKEN || process.env.GITHUB_TOKEN
    const eventName = process.env.GITHUB_EVENT_NAME ?? ''

    // Only look for a plan comment when one could actually authorise this run.
    let approval: ApprovalContext | undefined
    if (token && canSeekApproval(eventName)) {
      try {
        approval = await findApprovalContext({
          inputs,
          module: prepared.module,
          backendType: prepared.backendType,
          dataDir: prepared.dataDir,
          token,
          event: {
            eventName,
            eventPath: process.env.GITHUB_EVENT_PATH,
            repository: process.env.GITHUB_REPOSITORY,
            sha: process.env.GITHUB_SHA,
            ref: process.env.GITHUB_REF,
            refType: process.env.GITHUB_REF_TYPE,
            apiUrl: process.env.GITHUB_API_URL || 'https://api.github.com',
          },
        })
      } catch (error) {
        // Not fatal on its own: an auto-approved apply does not need it.
        core.debug(
          `Could not reach the pull request: ${
            error instanceof Error ? error.message : String(error)
          }`
        )
      }
    }

    const plan = await makePlan(prepared, inputs, args)

    if (prepared.backendType === 'cloud' && plan.exitCode === PLAN_NO_CHANGES) {
      core.info('No changes to apply')
      await publishTerraformOutputs(prepared, inputs)
      if (approval) await updateComment(approval, 'no-changes', { plan: plan.text ?? 'No changes' })
      return 0
    }

    if (inputs.autoApprove || plan.exitCode === PLAN_NO_CHANGES) {
      core.info('Automatically approving plan')
      if (approval) await updateComment(approval, 'begin-apply', { plan: plan.text ?? '' })
      return applyPlan(prepared, inputs, plan, args, approval)
    }

    // Nothing has authorised this yet, so it needs an approved plan.
    if (!canSeekApproval(eventName)) {
      core.error(
        `Could not fetch plan from the PR - ${eventName} event does not relate to a pull request. ` +
          "You can generate and apply a plan automatically by setting the auto_approve input to 'true'"
      )
      return 1
    }

    if (!token) {
      core.error(
        'GITHUB_TOKEN environment variable must be set to get plan approval from a PR. ' +
          "Either set the GITHUB_TOKEN environment variable or automatically approve by setting the auto_approve input to 'true'"
      )
      return 1
    }

    if (!approval) {
      core.error('Could not find the pull request to get plan approval from.')
      return 1
    }

    if (!planIsApproved(approval, { text: plan.text, path: inputs.planPath })) {
      // Documented reason: the plan differs from the one that was approved, so
      // nothing was applied. Distinct from the apply itself failing.
      setFailureReason('plan-changed')
      await updateComment(approval, 'error', { plan: plan.text ?? '' })
      return 1
    }

    await updateComment(approval, 'begin-apply', { plan: plan.text ?? '' })
    return applyPlan(prepared, inputs, plan, args, approval)
  } catch (error) {
    core.error(error instanceof Error ? error.message : String(error))
    return 1
  } finally {
    if (prepared) deleteAutoTfVars(inputs.path)
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href

if (invokedDirectly) {
  run()
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      core.setFailed(error instanceof Error ? error.message : String(error))
      process.exit(1)
    })
}
