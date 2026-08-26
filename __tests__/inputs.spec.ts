import { mkdirSync, mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { InputError, loadInputs } from '../src/inputs.js'

let workspace: string

const INPUTS = [
  'PATH',
  'WORKSPACE',
  'LABEL',
  'VARIABLES',
  'VAR_FILE',
  'BACKEND_CONFIG',
  'BACKEND_CONFIG_FILE',
  'REPLACE',
  'TARGET',
  'EXCLUDE',
  'DESTROY',
  'REFRESH',
  'PLAN_PATH',
  'AUTO_APPROVE',
  'PARALLELISM',
].map((name) => `INPUT_${name}`)

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'apply-ws-'))
  process.env.GITHUB_WORKSPACE = workspace
  for (const name of INPUTS) delete process.env[name]
})

afterEach(() => {
  delete process.env.GITHUB_WORKSPACE
  for (const name of INPUTS) delete process.env[name]
})

describe('defaults', () => {
  it('matches the documented defaults', () => {
    const inputs = loadInputs()

    expect(inputs.path).toBe(workspace)
    expect(inputs.workspace).toBe('default')
    expect(inputs.destroy).toBe(false)
    expect(inputs.refresh).toBe(true)
    expect(inputs.autoApprove).toBe(false)
    expect(inputs.parallelism).toBe('0')
    expect(inputs.label).toBeUndefined()
    expect(inputs.planPath).toBeUndefined()
  })
})

/**
 * auto_approve decides whether an apply proceeds without anyone reviewing the
 * plan, so anything other than exactly `true` has to leave it off.
 */
describe('reading auto_approve', () => {
  it.each([
    ['true', true],
    ['false', false],
    ['TRUE', false],
    ['True', false],
    ['yes', false],
    ['1', false],
    ['', false],
  ])('reads %s as %s', (value, expected) => {
    process.env.INPUT_AUTO_APPROVE = value
    expect(loadInputs().autoApprove).toBe(expected)
  })

  it('is off when unset', () => {
    expect(loadInputs().autoApprove).toBe(false)
  })
})

describe('reading destroy and refresh', () => {
  it('turns destroy on only for true', () => {
    process.env.INPUT_DESTROY = 'true'
    expect(loadInputs().destroy).toBe(true)
  })

  /** refresh defaults on, so only an explicit false turns it off. */
  it('turns refresh off only for an explicit false', () => {
    process.env.INPUT_REFRESH = 'false'
    expect(loadInputs().refresh).toBe(false)
  })

  it('leaves refresh on for anything else', () => {
    process.env.INPUT_REFRESH = 'no'
    expect(loadInputs().refresh).toBe(false)

    delete process.env.INPUT_REFRESH
    expect(loadInputs().refresh).toBe(true)
  })
})

describe('the plan file', () => {
  it('accepts one that exists', () => {
    writeFileSync(join(workspace, 'plan.out'), 'binary')
    process.env.INPUT_PLAN_PATH = 'plan.out'
    expect(loadInputs().planPath).toBe(join(workspace, 'plan.out'))
  })

  it('rejects one that does not exist', () => {
    process.env.INPUT_PLAN_PATH = 'absent.out'
    expect(() => loadInputs()).toThrow(/Plan file 'absent.out' does not exist/)
  })

  it('rejects a directory', () => {
    mkdirSync(join(workspace, 'notaplan'))
    process.env.INPUT_PLAN_PATH = 'notaplan'
    expect(() => loadInputs()).toThrow(/does not exist/)
  })

  /** A plan file is applied directly, so it must not be read from outside the checkout. */
  it('rejects one outside the workspace', () => {
    process.env.INPUT_PLAN_PATH = '../elsewhere/plan.out'
    expect(() => loadInputs()).toThrow(/stay inside the workspace/)
  })
})

describe('confining path to the workspace', () => {
  it.each([
    ['a parent traversal', '../elsewhere'],
    ['a nested traversal', 'infra/../../elsewhere'],
    ['an absolute path', '/etc'],
  ])('rejects %s', (_label, value) => {
    process.env.INPUT_PATH = value
    expect(() => loadInputs()).toThrow(InputError)
  })
})

describe('target and exclude', () => {
  /** Terraform rejects them together, but only after initializing. */
  it('refuses both at once', () => {
    process.env.INPUT_TARGET = 'a.b'
    process.env.INPUT_EXCLUDE = 'c.d'
    expect(() => loadInputs()).toThrow(/cannot be used together/)
  })

  it('accepts target alone', () => {
    process.env.INPUT_TARGET = 'a.b'
    expect(loadInputs().target).toBe('a.b')
  })

  it('does not treat a blank target as a conflict', () => {
    process.env.INPUT_TARGET = '  '
    process.env.INPUT_EXCLUDE = 'c.d'
    expect(() => loadInputs()).not.toThrow()
  })
})

describe('block inputs', () => {
  it('keeps newlines in variables', () => {
    process.env.INPUT_VARIABLES = 'a = 1\nb = 2\n'
    expect(loadInputs().variables).toBe('a = 1\nb = 2\n')
  })

  it('treats a blank label as absent', () => {
    process.env.INPUT_LABEL = '   '
    expect(loadInputs().label).toBeUndefined()
  })

  it('keeps a label that is set', () => {
    process.env.INPUT_LABEL = 'production'
    expect(loadInputs().label).toBe('production')
  })
})
