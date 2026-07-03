# Autoxhs — Project Instructions

## Intent alignment (lightweight)

Default to implementing directly. Alignment is a lightweight check for genuinely ambiguous requests — **not** a mandatory gate on every task.

Only when a request is genuinely ambiguous — it could lead to substantially different implementations, or it hinges on an unresolved product/business decision that the message, the conversation, the repository, and established conventions cannot answer — ask **one** focused question (via the `AskUserQuestion` tool) to confirm the intended outcome before implementing. You may invoke the `/aligning-code-requirements` skill for the fuller inspect-and-clarify flow in these cases.

When the intended outcome is already clear:

* Do not ask an intent-confirmation question.
* Do not ask for a second confirmation.
* Proceed directly: inspect with read-only operations as needed, then implement.

Guidelines that always apply:

* Ask the fewest questions possible; never re-ask something already answered in the conversation or discoverable in the repository.
* Do not ask about which file, component, framework, table, or route to use — discover that from the repository.
* Do not rewrite, Promptlize, or convert the user's request into a separate implementation brief.
* While a genuinely ambiguous request is still being clarified, do not modify code, dependencies, databases, infrastructure, Git history, or external services. Once intent is clear, proceed without further confirmation.
