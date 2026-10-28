# Security Policy

Security issues in petuja.email should be reported privately so they can be
investigated and fixed before public disclosure.

## Supported versions

Only the latest maintained petuja.email release line is intended to receive
security fixes.

| Version | Status |
| --- | --- |
| 1.1.x | Latest released and maintained line |
| 1.0.x | Not maintained |
| Earlier versions | Not maintained as petuja.email releases |

The latest released version is 1.1.0.

## Reporting a vulnerability

Do **not** open a public issue, discussion, or pull request containing
vulnerability details.

Report vulnerabilities privately to:

**contact@petuja.net**

Use a clear subject such as:

`[Security] petuja.email vulnerability`

A useful report should include, where possible:

- the affected petuja.email version, tag, or commit;
- the affected component or file;
- clear steps to reproduce the issue;
- the expected and observed behavior;
- the security impact and realistic attack scenario;
- a minimal proof of concept, if one is needed to demonstrate the issue.

Do not include real customer credentials, mailbox contents, private keys, or
other production data. Redact sensitive values from logs and screenshots.

If you need an encrypted or otherwise dedicated channel before sharing details,
contact petuja Systems first and request one.

## Coordinated disclosure

petuja Systems will review reported vulnerabilities and coordinate disclosure
with the reporter when appropriate. Please allow time for investigation and a
fix before publishing vulnerability details.

Reporter credit can be included in public disclosure when requested.

Do not perform testing against accounts, infrastructure, or data that you do not
own or have explicit authorization to test.

## Upstream relationship

petuja.email is based on SnappyMail 2.38.2. A vulnerability may therefore affect
petuja.email-specific code, upstream SnappyMail code, or both.

Please report issues that affect petuja.email to petuja Systems even when the
root cause appears to be upstream. Relevant upstream coordination can then be
handled without losing track of the impact on the petuja.email release line.
