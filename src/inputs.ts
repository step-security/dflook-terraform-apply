import { existsSync, statSync } from 'fs'
import { isAbsolute, relative, resolve } from 'path'

export class InputError extends Error {}

export interface Inputs {
  /** Root module to apply. */
  path: string
  /** Workspace to apply in. */
  workspace: string
  /** Distinguishes several runs against the same configuration. */
  label?: string
  variables?: string
  varFile?: string
  backendConfig?: string
  backendConfigFile?: string
  replace?: string
  target?: string
  destroy: boolean
  refresh: boolean
  /** A plan file to apply instead of generating one. */
  planPath?: string
  /** Applies without needing an approved plan on a pull request. */
  autoApprove: boolean
  parallelism: string
  workspaceRoot: string
}

function read(name: string, fallback = ''): string {
  return (process.env[`INPUT_${name.toUpperCase()}`] ?? fallback).trim()
}

/** Reads an input, keeping internal formatting but treating blank as absent. */
function readBlock(name: string): string | undefined {
  const value = process.env[`INPUT_${name.toUpperCase()}`]
  if (value === undefined || !value.trim()) return undefined
  return value
}

/**
 * Reads a boolean input.
 *
 * Only the exact string `true` enables one, matching how upstream compares
 * these. Anything else is false, so a typo fails safe rather than, in the case
 * of `auto_approve`, applying without review.
 */
function readBoolean(name: string, fallback: boolean): boolean {
  const value = process.env[`INPUT_${name.toUpperCase()}`]
  if (value === undefined || value.trim() === '') return fallback
  return value.trim() === 'true'
}

/**
 * Confines a path to the workspace.
 *
 * These come from workflow input and have no business pointing outside the
 * checkout.
 */
function withinWorkspace(requested: string, workspaceRoot: string, label: string): string {
  const target = resolve(workspaceRoot, requested)
  const offset = relative(workspaceRoot, target)

  if (offset.startsWith('..') || isAbsolute(offset)) {
    throw new InputError(
      `${label} must stay inside the workspace, but '${requested}' resolves outside it`
    )
  }

  return target
}

export function loadInputs(): Inputs {
  const workspaceRoot = resolve(process.env.GITHUB_WORKSPACE || process.cwd())

  const requestedPath = read('path', '.') || '.'
  const path = withinWorkspace(requestedPath, workspaceRoot, 'path')

  if (!existsSync(path)) {
    throw new InputError(`Path does not exist: "${requestedPath}"`)
  }
  if (!statSync(path).isDirectory()) {
    throw new InputError(`path '${requestedPath}' is not a directory`)
  }

  const requestedPlan = read('plan_path')
  let planPath: string | undefined
  if (requestedPlan) {
    planPath = withinWorkspace(requestedPlan, workspaceRoot, 'plan_path')
    if (!existsSync(planPath) || !statSync(planPath).isFile()) {
      throw new InputError(`Plan file '${requestedPlan}' does not exist`)
    }
  }

  const target = readBlock('target')
  const exclude = readBlock('exclude')
  if (target?.trim() && exclude?.trim()) {
    throw new InputError('target and exclude cannot be used together')
  }

  return {
    path,
    workspace: read('workspace', 'default') || 'default',
    label: read('label') || undefined,
    variables: readBlock('variables'),
    varFile: readBlock('var_file'),
    backendConfig: readBlock('backend_config'),
    backendConfigFile: readBlock('backend_config_file'),
    replace: readBlock('replace'),
    target,
    destroy: readBoolean('destroy', false),
    refresh: readBoolean('refresh', true),
    planPath,
    autoApprove: readBoolean('auto_approve', false),
    parallelism: read('parallelism', '0') || '0',
    workspaceRoot,
  }
}
