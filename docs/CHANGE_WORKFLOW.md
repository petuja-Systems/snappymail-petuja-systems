# petuja.email change workflow

petuja.email handles authentication credentials, sessions, account settings,
mail content, attachments, contacts, and other sensitive customer data. Changes
therefore use a stricter review workflow than ordinary presentation websites.

This workflow applies to every meaningful application change, including
apparently visual-only changes around sensitive surfaces such as the login page.

## Core rule

Every change is handled as four distinct stages:

1. **Read-only analysis**
2. **Scoped implementation**
3. **Security audit + fix**
4. **General audit + fix**

The four prompts are generated together as one pipeline bundle before any stage
runs. They are then executed sequentially. Do not wait for stage 1 to finish
before writing stages 2-4.

Each downstream prompt must be self-contained enough to run later, but must also
explicitly consume the previous stage's handoff. The handoff can be supplied by
the pipeline as the prior agent's report, the current Git state, or both. Later
stages must verify the repository and diff rather than blindly trust prose from
an earlier stage.

Prefer a fresh Codex/agent session for each stage. The security and general
reviewers should inspect the actual Git diff/commit range independently rather
than inherit the implementation agent's assumptions.

A stage may be skipped only for truly repository-only maintenance that cannot
affect shipped application behavior, security, build output, or user-facing
assets. If in doubt, use all four stages.

## Pipeline bundle contract

When prompts are prepared for a change, generate all four at once in execution
order.

The prompts should use stable handoff placeholders or instructions such as:

```text
STAGE 1 OUTPUT
- analysis report
- scope lock
- invariants
- validation plan
- baseline HEAD

STAGE 2 INPUT
- consume Stage 1 output
- verify current HEAD still matches or reconcile any drift
- implement only the approved scope

STAGE 2 OUTPUT
- implementation commit SHA
- base SHA
- exact changed-file list
- validation results
- scope deviations, if any

STAGE 3 INPUT
- consume Stage 1 invariants and Stage 2 result
- independently inspect base...implementation diff
- fix confirmed security findings only where justified

STAGE 3 OUTPUT
- reviewed commit range
- security findings/fixes
- resulting HEAD SHA
- residual limitations

STAGE 4 INPUT
- consume the previous handoffs
- independently review the complete base...current-HEAD change
- fix general regressions/quality issues

STAGE 4 OUTPUT
- final reviewed range
- final HEAD
- validations
- residual caveats
```

Do not bake unknown future commit SHAs into prompts generated before execution.
Instead, instruct each later stage to read the concrete SHA from the previous
handoff and verify it against Git before proceeding.

If the pipeline passes only text output between stages, the downstream prompt
must require the agent to confirm the reported SHAs and changed files from the
repository. If the pipeline shares the same checkout, Git remains the source of
truth and the previous report is context, not authority.

## Stage 1 — read-only analysis

The first stage must not modify the working tree, create commits, or push.

Its purpose is to establish how the affected area works before any code is
changed.

At minimum, the analysis should:

- inspect the relevant source, templates, styles, JavaScript, PHP, build tasks,
  configuration hooks, plugins, and upstream conventions;
- identify data flows and trust boundaries;
- distinguish generated output from source-of-truth files;
- identify existing validation, escaping, authentication, session, cookie, CSP,
  and plugin-hook behavior relevant to the area;
- compare with the official SnappyMail v2.38.2 baseline when useful;
- list the smallest set of files expected to change;
- list files/components that should remain untouched;
- define behavioral and security invariants that must remain true;
- define concrete build, runtime, visual, accessibility, and security checks for
  the later stages;
- call out uncertainties instead of guessing.

The output of this stage becomes the implementation contract.

### Scope lock

Before implementation, record two groups:

```text
MAY CHANGE
- files/components required for the requested change

SHOULD NOT CHANGE WITHOUT EXPLICIT JUSTIFICATION
- authentication/session/cookie code
- unrelated templates or application logic
- upstream build/dependency files
- unrelated themes/components
- generated files
- other sensitive code outside the requested scope
```

The exact entries depend on the task. If implementation needs to cross this
boundary, it must explain why before doing so.

## Stage 2 — scoped implementation

Implement only the approved change.

Requirements:

- begin from an up-to-date private `main`;
- preserve existing SnappyMail behavior unless the task explicitly changes it;
- keep the diff as small and source-oriented as practical;
- do not make opportunistic refactors or dependency upgrades;
- do not edit generated CSS/JavaScript when the build can regenerate it;
- do not introduce external runtime dependencies merely for convenience;
- do not add analytics, telemetry, third-party scripts, remote fonts, or remote
  assets without explicit approval;
- never use production credentials or user data for testing;
- preserve accessibility semantics and browser behavior unless deliberately
  improving them;
- preserve plugin extension points unless the task explicitly changes them.

For presentation-only work at a security-sensitive boundary, application logic
should normally remain untouched. For example, a login redesign should not
change authentication request construction, password handling, sign-me
semantics, session/cookie behavior, or server-side authentication code without a
separate functional requirement.

After implementation, run the relevant build and syntax checks, perform a local
smoke test, review `git diff`, and commit the implementation as a coherent
change.

The implementation report must identify:

- base commit;
- implementation commit;
- files changed;
- validation performed;
- any scope expansion and its justification;
- remaining known limitations.

## Stage 3 — explicit security audit + fix

Run this stage in a fresh context where practical.

Audit the exact implementation commit/diff. Do not accept statements such as
"security unchanged" without checking the code paths that support that claim.

The audit should consider the categories relevant to the change, including:

- authentication request construction and credential handling;
- password persistence, DOM exposure, logging, error messages, autocomplete, and
  accidental serialization;
- session and cookie behavior;
- authorization boundaries;
- CSRF-sensitive behavior;
- DOM XSS, HTML injection, unsafe bindings, escaping, sanitization, and URL
  handling;
- mail-content and attachment rendering boundaries;
- remote-content loading and privacy leakage;
- redirects and navigation targets;
- CSP compatibility and inline script/style implications;
- third-party/external resource requests;
- plugin hooks and extension points;
- local storage/session storage changes;
- sensitive data in logs, exceptions, browser console, or telemetry;
- secrets and production data accidentally added to Git;
- supply-chain or dependency changes;
- security controls removed, weakened, bypassed, or shadowed by new code.

For security-sensitive UI work, explicitly verify unchanged invariants. Example
for a login presentation change:

```text
- authentication request path unchanged
- password is not newly persisted, logged, exposed, or copied elsewhere
- autocomplete semantics preserved unless intentionally changed
- sign-me behavior preserved
- language selection behavior preserved
- login plugin hooks preserved
- error handling does not leak additional sensitive information
- session/cookie logic unchanged
- no new external requests
- no new third-party scripts/fonts/styles
- server-side authentication code unchanged unless explicitly required
```

Fix confirmed findings directly when the fix is clearly within scope. After each
fix, re-run relevant validation and review the final diff.

The security report must separate:

- confirmed findings;
- fixes made;
- checked-but-not-found risk categories;
- limitations that could not be tested;
- final commit SHA.

## Stage 4 — general audit + fix

Run a final independent audit of the complete change after the security stage.

Review at minimum:

- requirement fidelity;
- unintended behavior changes;
- unnecessary or out-of-scope modifications;
- maintainability and compatibility with future SnappyMail updates;
- source-vs-generated-file correctness;
- build and syntax results;
- runtime errors and browser console errors;
- responsive behavior;
- keyboard navigation and focus states;
- accessible labels/semantics and reasonable contrast;
- localization/i18n behavior;
- light/dark/theme interactions where applicable;
- loading, error, disabled, hover, focus, and empty states affected by the change;
- duplicate/dead CSS or JS;
- external requests introduced or retained unintentionally;
- release packaging of changed source/assets.

Fix clear defects directly, then re-run the applicable build and smoke tests.

The final report should state:

- the exact reviewed commit range;
- files changed by implementation and audit fixes;
- all commands/checks run and their results;
- whether the working tree is clean;
- final `main`/origin status if pushing was authorized;
- residual caveats.

## Evidence over assertion

Reviews should prove important properties using the repository and diff whenever
possible.

Prefer evidence such as:

- `git diff <base>...<head>`;
- exact changed-file lists;
- searches showing protected code paths were not modified;
- source inspection of form bindings and request construction;
- build/syntax output;
- local network-request inspection;
- browser console output;
- screenshots at representative viewport sizes;
- release-archive inspection.

Do not treat "the build passed" as proof that a change is secure, and do not
treat "the page looks correct" as proof that behavior is unchanged.

## Commit and handoff discipline

Keep the four stages attributable in Git when fixes are needed. A typical change
may look like:

```text
<base>
  |
  +-- Implement <change>
  |
  +-- Harden <change> after security audit      # only if findings required fixes
  |
  +-- Fix <change> audit findings               # only if needed
```

Do not create empty audit commits when no fixes are required. Reports should
still record that the stage was completed and which commit range was reviewed.

Routine development pushes only to the private `origin`. Publishing to the
public fork is a separate reviewed release operation.

## High-risk areas

Apply especially strict scope control and invariants when touching:

- login and authentication;
- sessions, cookies, remember/sign-me behavior;
- password or credential handling;
- account and identity settings;
- IMAP/SMTP/Sieve configuration;
- mail rendering, HTML sanitization, remote images, and links;
- compose/send flows;
- attachments and downloads;
- contacts/address books;
- encryption, PGP, S/MIME, and key material;
- plugins and plugin hooks;
- upload/import/export functionality;
- admin settings;
- CSP/security headers and redirects.

A visual-only request in one of these areas remains a security-sensitive change
because markup, bindings, form semantics, or resource loading can alter the
security boundary even when no feature change is intended.
