[![StepSecurity Maintained Action](https://raw.githubusercontent.com/step-security/maintained-actions-assets/main/assets/maintained-action-banner.png)](https://docs.stepsecurity.io/actions/stepsecurity-maintained-actions)

# terraform-apply action

A StepSecurity maintained drop-in replacement for [dflook/terraform-apply](https://github.com/dflook/terraform-apply), with
the same inputs and outputs.

Applies a Terraform plan. By default the plan must already have been posted to a
pull request and reviewed there: before applying, the action regenerates the plan
and checks it against the approved one. If they differ, nothing is applied.

Set `auto_approve: true` to skip that and apply whatever the current
configuration produces.

## Usage

Applying a reviewed plan when a pull request merges:

```yaml
name: Apply

on:
  push:
    branches: [main]

jobs:
  apply:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7

      - name: Apply the approved plan
        uses: step-security/dflook-terraform-apply@v3
        with:
          path: infra
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

Applying without review, for an environment where that is acceptable:

```yaml
      - name: Apply
        uses: step-security/dflook-terraform-apply@v3
        with:
          path: infra
          auto_approve: true
```

## How approval works

Without `auto_approve`, the authorisation for an apply is a plan that was posted
to a pull request and reviewed there. The action finds that comment and checks
that the plan it holds is the plan about to be applied.

The check is a SHA-256 of the plan text, salted with the pull request URL and
recorded in the comment. The salt matters: without it, a plan approved in one
pull request would authorise the same plan in another, so something approved
somewhere harmless could be replayed somewhere that matters.

Before hashing, two things are removed from the plan text, both of which
Terraform varies between otherwise identical runs:

- the `# (N unchanged attributes hidden)` counts
- warnings printed **after** the `Plan:` summary line

Warnings *before* the summary are kept, since they are part of what was reviewed.
Nothing else is normalised. The failure that matters here is accepting a plan that
differs, not rejecting one that does not: a wrongly rejected plan costs a re-run,
a wrongly accepted one applies changes nobody saw.

Some further properties worth knowing:

- **Only comments written by your token's own user count.** Reading a plan out of
  anyone else's comment would let anyone who can comment on the pull request
  authorise an apply.
- **A comment is matched to one configuration** by workspace, label, backend and
  the arguments that shape the plan. A pull request touching several modules keeps
  them apart. Changing `target`, `replace` or `destroy` produces a different
  identity and will not match a comment made without them.
- **A saved plan is hashed whole.** With `plan_path`, the file is compared byte
  for byte, and a comment carrying no plan-file hash cannot approve one, since
  there is no text to fall back on.
- **Anything unresolved means no.** No pull request, no comment, no token, or a
  plan that does not match all leave the apply unapproved.

A plan with no changes needs no approval and is applied without looking for a
comment.

For repositories migrating from the upstream action, the hash is computed exactly
as upstream computes it, so a plan comment posted by upstream still authorises an
apply here.

### Which events can find a pull request

Approval requires a pull request to look in, which these events provide:
`push`, `pull_request`, `pull_request_target`, `pull_request_review`,
`pull_request_review_comment`, `issue_comment` and `repository_dispatch`.

For a `push`, the pull request is the one whose merge commit matches the pushed
commit — so pushing directly to the target branch finds nothing. On any other
event the action fails and tells you to use `auto_approve` instead of applying
something unreviewed.

`GITHUB_TOKEN` must be set for approval. Without it there is no way to read the
comment.

## Inputs

| Name | Default | Description |
| --- | --- | --- |
| `path` | `.` | Directory holding the root module to apply. |
| `workspace` | `default` | Workspace to select before applying. |
| `label` | | Name for the environment, shown in the comment. Must match the label the plan was posted with. |
| `variables` | | Variable definitions in Terraform syntax, as in a tfvars file. |
| `var_file` | | Paths to tfvars files, one per line, relative to the workspace. |
| `backend_config` | | Backend settings as `key=value`, one per line. |
| `backend_config_file` | | Paths to backend config files, one per line, relative to the workspace. |
| `replace` | | Resource addresses to replace rather than update, one per line. |
| `target` | | Resource addresses to limit the operation to, one per line. |
| `destroy` | `false` | Plan and apply the destruction of everything the module manages. |
| `refresh` | `true` | Set `false` to skip reconciling state with real resources first. |
| `plan_path` | | A saved plan file to apply instead of generating one. |
| `auto_approve` | `false` | Apply without looking for an approved plan. |
| `parallelism` | `0` | Maximum concurrent operations. `0` leaves the limit to Terraform. |

`destroy`, `refresh` and `auto_approve` are enabled only by the exact string
`true`. Anything else leaves them off, so a typo in `auto_approve` keeps approval
required rather than silently skipping it.

### Variables

`variables` and `var_file` are both written into the module as auto-loaded
`.tfvars` files, so they apply to every command rather than only the one this
action runs directly. They are named so `variables` loads last, which is what
makes it override `var_file`:

```yaml
      - uses: step-security/dflook-terraform-apply@v3
        with:
          var_file: |
            common.tfvars
            production.tfvars
          variables: |
            image_id = "${{ secrets.AMI_ID }}"
```

The generated files are removed when the step finishes, including on failure, so
they cannot leak into a later step or an uploaded artifact.

Note that these change the plan, so they must match what the reviewed plan was
built with, or the apply will find the plan has changed.

### Applying a saved plan

`plan_path` applies a plan file instead of generating one. It is faster, and the
file is still checked against the approved plan, so only the reviewed plan is
applied.

The trade-offs are real: a saved plan is a snapshot that does not reflect anything
changed since, plans must be applied in the order they were created, they are not
portable between platforms, and Terraform and provider versions must match. A plan
file also contains sensitive values, so it needs storing accordingly.

## Outputs

| Name | Value |
| --- | --- |
| `json_plan_path` | Workspace-relative path to the plan in Terraform's JSON format. |
| `text_plan_path` | Workspace-relative path to the plan as text. |
| `failure_reason` | `apply-failed`, `plan-changed` or `state-locked`. |
| `failure-reason` | Hyphenated spelling of the same value. |
| `lock_info` | JSON describing who holds the state lock. |
| `lock-info` | Hyphenated spelling of the same value. |
| `run_id` | Remote run identifier, for `remote` and `cloud` backends. |
| `json_output_path` | Workspace-relative path to the root module outputs as JSON. |

Both spellings of `failure_reason` and `lock_info` are published, so either name
works.

`failure_reason` distinguishes the failures worth acting on:

- `apply-failed` — the apply itself failed
- `plan-changed` — the plan no longer matches the approved one, so nothing was applied
- `state-locked` — the state lock was already held, which is usually worth retrying

Any other failure leaves it unset.

`lock_info` accompanies `state-locked` and holds whatever the backend reported —
typically `ID`, `Path`, `Operation`, `Who`, `Version` and `Created`. It may be an
empty object when the backend reported nothing, which still tells you the lock was
held.

`json_plan_path` is not set for backends that cannot save a plan, such as
`remote`. `text_plan_path` is not set when no plan was generated, which happens
with `auto_approve` against such a backend.

Every root module output also becomes a step output of the same name. Outputs
marked `sensitive` are registered as masks before they are published, so they are
redacted in the log.

```yaml
      - name: Apply
        id: apply
        uses: step-security/dflook-terraform-apply@v3

      - name: Use an output
        run: echo "Deployed to ${{ steps.apply.outputs.service_hostname }}"
```

## Terraform version

The version to run is worked out from your configuration, using the first of
these that applies:

1. a `required_version` constraint in the Terraform configuration
2. a `.tfswitchrc` file
3. an `.opentofu-version` file
4. a `.terraform-version` file
5. a `terraform` entry in `.tool-versions` (asdf), searching upwards to the workspace root
6. the `TERRAFORM_VERSION` environment variable
7. the version recorded in local state, when state has been written
8. otherwise, the latest release

Configuration beats environment deliberately. `required_version` describes what
the code needs, so a workflow-wide `TERRAFORM_VERSION` default does not silently
override a module that pins something narrower.

Set `OPENTOFU_VERSION`, or `OPENTOFU: true`, to use OpenTofu instead. Downloads
are compared against the published `SHA256SUMS` before being extracted.

## Redacting output

Plan and apply output reaches the job log and the pull request comment, so values
under attribute names that look like credentials are replaced with `*` first, and
outputs marked `sensitive` are registered as masks before being published.

This matches the redaction upstream applies, including its limits:

- It works on **attribute names**, not on Terraform's own `sensitive` marking, so
  a sensitive value under an innocuous name is not masked in plan output.
- The pattern requires a non-alphabetic character before the keyword, so
  `db_password` is masked but a bare `password` is not.

Set `TFMASK_VALUES_REGEX` to apply a stricter pattern of your own.

**`json_output_path` and `json_plan_path` are written in full, including sensitive
values.** That matches upstream, but it means you should not upload them as
artifacts from a public repository.

## Environment variables

| Name | Purpose |
| --- | --- |
| `GITHUB_TOKEN` | Required to read and write the pull request comment. Without it, only `auto_approve` works. |
| `TERRAFORM_VERSION` | Version or constraint to run. See above for where it sits in precedence. |
| `OPENTOFU_VERSION` / `OPENTOFU` | Use OpenTofu instead of Terraform. |
| `GITHUB_DOT_COM_TOKEN` | Token for github.com when running on GitHub Enterprise, used only to download OpenTofu releases. |
| `TERRAFORM_CLOUD_TOKENS` | `host=token` pairs, one per line, for the `remote` backend and the module registry. |
| `TERRAFORM_HTTP_CREDENTIALS` | `host=user:password` pairs, one per line, for fetching modules over HTTP or `git::https`. Evaluated in order; the first match wins. |
| `TERRAFORM_SSH_KEY` | PEM-format private key for fetching modules over SSH. |
| `TERRAFORM_PRE_RUN` | Shell commands to run after Terraform is installed and before it is used. |
| `TFMASK_VALUES_REGEX` | Overrides which attribute names have their values masked. |
| `TF_PLAN_COLLAPSE_LENGTH` | Line count above which plan output in the comment is collapsed. |

`TERRAFORM_PRE_RUN` runs with `-x`, `-e` and `-o pipefail`, so it stops at the
first failing command rather than continuing into Terraform with a half-prepared
environment. Workflow commands are suspended while it runs, so a line of its
output cannot masquerade as an instruction to the runner.

## Development

Version resolution, downloading, backend init, workspace selection, plan and
apply execution, output redaction and the plan approval machinery are shared with
the sibling Terraform actions through
[`dflook-terraform-actions-core`](https://github.com/step-security/dflook-terraform-actions-core),
included here as a submodule at `vendor/core`. The submodule is bundled into
`dist/` at build time, so consumers never need to fetch it.

```bash
git clone --recurse-submodules https://github.com/step-security/dflook-terraform-apply.git
npm ci
npm test
npm run build   # regenerates dist/, which is committed
```

An existing clone needs `git submodule update --init` once, or the build cannot
resolve `@core`.
