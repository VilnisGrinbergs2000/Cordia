# Security policy

Cordia handles accounts, private messages, and end-to-end encrypted key material. If you think you have found a vulnerability, please report it privately and give us a chance to fix it before it is public.

## Reporting a vulnerability

**Do not open a public issue, discussion, or pull request for a security problem.**

Use GitHub's private vulnerability reporting:

1. Go to <https://github.com/VilnisGrinbergs2000/Cordia/security/advisories/new>.
2. Describe the issue, the affected version or commit, and the impact.
3. Include reproduction steps and, where useful, a proof of concept, request, or screenshot.
4. Tell us whether you intend to publish, and when.

If you cannot use GitHub advisories, open a minimal public issue that only asks a maintainer to contact you, without disclosing the vulnerability. Do not include details in that issue.

## What to include

A useful report answers:

- **What** is the vulnerability, in one or two sentences?
- **Where** does it live (route, file, component, deployment assumption)?
- **Who** can exploit it: an unauthenticated visitor, any signed-in user, a server member, a bot, an administrator?
- **What** can they do: read data, impersonate, escalate permissions, deny service, execute code?
- **How** can we reproduce it, step by step?
- **Version** or commit, plus Node, PostgreSQL, browser, and operating system where relevant.
- Any mitigation you have already applied.

Please use a test instance, not the hosted demo, for destructive testing. Do not access other people's data, and do not run automated scanners against the demo without asking first.

## Scope

In scope:

- Authentication and session handling (registration, login, password reset, recovery, cookies, bearer tokens, token revocation).
- Authorization: server groups, channel overrides, DMs, threads, admin routes, bot scopes.
- End-to-end encryption: key publication, bundle handling, envelope validation, key history, recovery, client-side ratchet.
- Uploads: MIME handling, path traversal, signed upload tokens, quota enforcement.
- Injection: SQL, HTML/JS in messages or profiles, command injection, template injection.
- CSRF, CORS, origin checks, and socket authentication.
- Bot platform: token handling, gateway authentication, interaction claims, install scoping.
- Denial of service that is cheap to trigger and hard to recover from.
- Secrets or personal data accidentally committed or exposed by the server.
- Dependency vulnerabilities that are reachable in a default deployment.

Usually out of scope:

- Missing headers or configuration on a deployment that ignored the documented setup (for example, no TLS, `TRUST_PROXY` misconfigured, PostgreSQL exposed publicly).
- Self-XSS, clickjacking of pages that already send `frame-ancestors 'none'`, or social engineering.
- Spam or abuse that is not a technical vulnerability. Report those through the app's **Report** action.
- Vulnerabilities in a fork or a modified deployment that do not reproduce on the code in this repository.
- Findings that require an administrator to be malicious or to have already compromised the host. A database administrator can read channel content by design; see the E2EE boundary in the [architecture documentation](docs/architecture.md#end-to-end-encrypted-dms).
- Automated scanner output without a demonstrated impact.

## Supported versions

Cordia is under active development. Security fixes land on `main` and in the latest tagged release. Older commits are not maintained; if you are running an old deployment, upgrade before reporting unless the issue also reproduces on the latest code.

## What happens next

- We aim to acknowledge a report within **3 business days** and give an initial assessment within **7 business days**. This is a volunteer project, so these are targets, not guarantees.
- We will keep you updated on the fix and the disclosure timeline.
- We will credit you in the advisory unless you prefer to remain anonymous.
- Please give us **90 days** before public disclosure, or less if a fix and advisory are ready sooner. If a vulnerability is being actively exploited, tell us and we will prioritize accordingly.

## Safe harbor

We will not pursue legal action or report you to a platform for security research that:

- Targets a test instance you control, or the hosted demo in a way that does not access or alter other people's data.
- Avoids privacy violations, data destruction, and service disruption.
- Is reported privately and given reasonable time to fix.
- Does not extort, demand payment, or threaten disclosure.

If you are unsure whether a test is allowed, ask first through the private advisory.

## Hardening your own deployment

The security model depends on how Cordia is deployed. At minimum:

- Serve over HTTPS and keep `NODE_ENV=production`.
- Keep `HOST=127.0.0.1` and put a reverse proxy in front.
- Set `TRUST_PROXY` to the real number of proxy hops.
- Keep PostgreSQL on loopback or a private network.
- Set a strong `JWT_SECRET`, back it up, and restrict `server/.env` to the service user.
- Back up the database, `server/data/`, and `server/uploads/`.
- Keep Node.js and dependencies patched.

See [Deployment](docs/deployment.md#security-checklist) for the full checklist.

## Related documentation

- [Architecture: security model](docs/architecture.md#security-model)
- [Architecture: E2EE](docs/architecture.md#end-to-end-encrypted-dms)
- [Deployment](docs/deployment.md)
