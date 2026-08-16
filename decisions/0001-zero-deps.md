# 0001 -- Zero runtime dependencies: inline the OKLCH formatter (SN-19)

Status: accepted (S4, v1.1.1)

## Context

Through v1.1.0 the package carried a single runtime dependency,
`@zakkster/lite-color`, used for exactly one call: `toCssOklch` in the
constructor, and only when `config.color` is an `{ l, c, h }` object rather than
an already-formatted CSS string. That call resolves to one template literal:

    oklch(${l.toFixed(4)} ${c.toFixed(4)} ${h.toFixed(2)} / ${a})

Suite law is zero runtime dependencies. This was the cheapest law breach in the
ecosystem to close.

## Decision

Inline a six-line private formatter, `SnowEngine._cssOklch(c)`, that produces a
string byte-identical to `toCssOklch` for a valid `{ l, c, h, a? }` object, and
fails closed to the documented default `'oklch(0.98 0.02 250)'` on any
null/non-object input or non-finite channel. Keep `@zakkster/lite-color` as a
devDependency so the torture T8 tier can prove byte-identity across a fixed
64-color corpus -- the amputation must not silently change a documented output.

## Alternatives rejected

- **"Keep the dep, it is only 1 KB."** Rejected. The cost is not bytes on disk,
  it is coupling: a runtime dependency makes every downstream consumer of
  lite-snow transitively depend on lite-color's release cadence, semver, and
  supply-chain surface -- all to obtain one string template. A snow engine has
  no business pinning a color library's version for its consumers.

- **`colorFormat: fn` injection.** Rejected. Letting the caller pass a formatter
  function would remove the hard dependency, but it adds public configuration
  surface -- a new option to document, validate, fail-close on, and support
  forever -- to solve a problem a six-line pure function already solves outright.
  New surface is a permanent liability; the inline function is not.
