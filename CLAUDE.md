# Autoxhs — Project Instructions

## Mandatory intent-alignment workflow

For every new coding request or material requirement change, invoke the `/aligning-code-requirements` skill before editing or implementing anything.

The workflow must follow this order:

1. First, ask the user a focused question to confirm their intended outcome, business objective, or desired behavior.
2. Do not inspect or modify the repository until the user has answered the initial intent question.
3. After the user's intent is confirmed, inspect the repository using read-only operations.
4. Trace the relevant architecture and business flow end to end.
5. Determine whether any unresolved product decisions, business rules, edge cases, compatibility concerns, or implementation-impacting questions remain.
6. Ask only questions that cannot be answered from:

   * The user's confirmed intent
   * The existing conversation
   * The repository
   * Established project conventions
7. If no unresolved questions remain, do not ask for another confirmation. Proceed directly with implementation.

The skill must not rewrite, Promptlize, or convert the user's request into a separate implementation brief.

Do not modify code, dependencies, databases, infrastructure, Git history, or external services while requirements are still being aligned.

Once the user's intent and all necessary open questions have been resolved, proceed with implementation without invoking the skill again for the same task.

Invoke the skill again only when the user introduces:

* A materially different objective
* A conflicting requirement
* A substantial scope change
* A new coding task
* A requirement that invalidates the previously aligned behavior

Small clarifications, corrections, or implementation feedback do not require restarting the full alignment workflow.
