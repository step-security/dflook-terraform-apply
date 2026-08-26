# ESM stubs for the test runner

`@actions/core`, `@actions/exec` and `@actions/tool-cache` are ESM-only. Our
source is ESM and bundles them correctly, but the tests are transpiled to
CommonJS (see the jest transform in package.json), and a CommonJS module cannot
resolve an ESM-only package — not even to mock it.

These stubs stand in for those packages during tests, wired up through
`moduleNameMapper`. A test that cares about the interaction still calls
`jest.mock(...)` with its own factory; the stub only has to make the specifier
resolvable.

Production code never sees these.
