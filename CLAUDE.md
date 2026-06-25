# Autoxhs — Project Instructions

## Mandatory requirement-alignment workflow

For every new coding request or material requirement change, invoke the `/aligning-code-requirements` skill before editing or implementing anything.

The skill must inspect the repository, infer the user's intent, rewrite the request into a precise implementation brief, and ask focused alignment questions. Do not modify code until the user confirms the brief.

Once the user confirms the current brief, do not invoke the skill again for that same task unless the requirements materially change.
