import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'

/**
 * Guards the published interface against the code drifting from it.
 *
 * `action.yaml` is the contract consumers write their workflows against. An
 * output declared there but never set reads as an empty string at runtime, with
 * nothing to indicate it was never implemented. That happened three times while
 * this action was being written — `lock-info`, `plan-changed` and `run_id` were
 * all documented before they worked — and none of the behavioural tests caught
 * it, because they exercise the code rather than compare it to the contract.
 */

const ACTION = readFileSync(join(__dirname, '..', 'action.yaml'), 'utf8')

function declaredSection(name: 'inputs' | 'outputs'): string {
  const match = new RegExp(`^${name}:\\n([\\s\\S]*?)(?=^\\w+:)`, 'm').exec(ACTION)
  if (!match) throw new Error(`No ${name} section in action.yaml`)
  return match[1]
}

function declaredNames(name: 'inputs' | 'outputs'): string[] {
  return [...declaredSection(name).matchAll(/^ {2}([a-zA-Z0-9_-]+):/gm)].map((m) => m[1])
}

/** Every `.ts` file under src/, concatenated. */
function sourceText(): string {
  const dir = join(__dirname, '..', 'src')
  return readdirSync(dir)
    .filter((name) => name.endsWith('.ts'))
    .map((name) => readFileSync(join(dir, name), 'utf8'))
    .join('\n')
}

describe('every declared output is set somewhere', () => {
  const source = sourceText()
  const outputs = declaredNames('outputs')

  it('declares the documented outputs', () => {
    expect(outputs).toEqual(
      expect.arrayContaining([
        'json_plan_path',
        'text_plan_path',
        'failure_reason',
        'failure-reason',
        'lock_info',
        'lock-info',
        'run_id',
        'json_output_path',
      ])
    )
  })

  it.each(declaredNames('outputs'))('sets %s', (name) => {
    expect(source).toContain(`'${name}'`)
  })
})

describe('every declared input is read somewhere', () => {
  const source = sourceText()

  it.each(declaredNames('inputs'))('reads %s', (name) => {
    // Inputs are read as INPUT_<NAME> or by their camelCase field name.
    const camel = name.replace(/_(.)/g, (_, c: string) => c.toUpperCase())
    const found =
      source.includes(`'${name}'`) ||
      source.includes(`INPUT_${name.toUpperCase()}`) ||
      new RegExp(`\\b${camel}\\b`).test(source)
    expect(found).toBe(true)
  })
})

/**
 * The two spellings exist because the documented contract carries both, and
 * consumers depend on either. Setting only one is a silent half-failure.
 */
describe('paired output spellings', () => {
  it.each([
    ['failure_reason', 'failure-reason'],
    ['lock_info', 'lock-info'],
  ])('declares both %s and %s', (underscored, hyphenated) => {
    const outputs = declaredNames('outputs')
    expect(outputs).toContain(underscored)
    expect(outputs).toContain(hyphenated)
  })

  it.each([
    ['failure_reason', 'failure-reason'],
    ['lock_info', 'lock-info'],
  ])('sets both %s and %s', (underscored, hyphenated) => {
    const source = sourceText()
    expect(source).toContain(`'${underscored}'`)
    expect(source).toContain(`'${hyphenated}'`)
  })
})

describe('the action entrypoint', () => {
  it('runs on node24, not in a container', () => {
    expect(ACTION).toContain('using: node24')
    expect(ACTION).toContain('main: dist/index.js')
    expect(ACTION).not.toContain('using: docker')
  })

  /** Upstream's image must not be referenced; that is the thing being replaced. */
  it('does not reference the upstream image', () => {
    expect(ACTION).not.toContain('danielflook')
    expect(ACTION).not.toContain('entrypoint:')
  })
})
