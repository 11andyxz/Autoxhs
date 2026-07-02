---

name: aligning-code-requirements
description: Aligns the user's intent before implementation, then inspects the current repository to identify unresolved product decisions, business rules, edge cases, and implementation-impacting questions. Ask only questions that cannot be answered from the user's confirmed intent or the repository. Do not rewrite the request into a Promptlized implementation brief.
when_to_use: Trigger at the start of every new feature, bug fix, refactor, UI change, database change, API integration, automation task, or other material coding requirement change. Trigger again only when the user introduces a materially different objective, conflicting requirement, or substantial scope change.
disallowed-tools:

* Write
* Edit
* NotebookEdit

---

# Intent Alignment and Repository Question Workflow

## Core rule

For every new coding request or material requirement change, follow this sequence before implementation:

1. Ask the user about their intended outcome.
2. Confirm the business or product intent.
3. Inspect the relevant repository architecture and business flow.
4. Determine whether any implementation-impacting questions remain.
5. Ask only the unresolved questions.
6. If no unresolved questions remain, do not ask additional questions and proceed with implementation.

Do not Promptlize, rewrite, or convert the user's request into a separate implementation prompt.

The purpose of this skill is to align intent and discover unresolved decisions, not to produce a rewritten requirement document.

## Alignment restrictions

While requirements are still being aligned:

* Do not edit, create, rename, move, or delete project files.
* Do not run commands that mutate files, dependencies, databases, infrastructure, Git history, or external services.
* Do not start implementation.
* Do not install or update dependencies.
* Do not create migrations or execute database changes.
* Do not expose secrets or print values from real environment files.
* Use only read-only inspection after the user's intent has been confirmed.

Once the user's intent is confirmed and all necessary questions have been answered, finish the alignment workflow and begin implementation using the confirmed intent and answers as the source of truth.

## Phase 1: Ask about the user's intent

The first response to a new coding request must focus on what the user is trying to achieve.

### 1. Infer the likely intent

Use the user's message and existing conversation context to identify:

* The problem they are trying to solve
* The outcome they expect
* The affected user or workflow
* Whether the request is a bug fix, behavior change, new feature, or architectural change
* Any obvious ambiguity that could result in substantially different implementations

Briefly state your current understanding before asking the question.

Do not produce a rewritten implementation prompt.

### 2. Ask the initial intent question

Ask the smallest number of questions needed to confirm the user's intended outcome.

In most cases, ask one focused question.

When the intent is already mostly clear, use a confirmation-style question instead of asking the user to explain everything again.

Example:

> 我的理解是：你希望当订单超过当前时间段容量时，只对当前购物车触发特殊处理，而不是全局修改该时间段的状态。这个理解正确吗？

When multiple genuinely different product outcomes are possible, provide clear options:

> 你希望这个功能解决的是哪一种情况？
> A. 阻止所有超过容量的订单
> B. 允许第一个超容量订单，但之后停止接单
> C. 仅对特定客户或订单类型允许超容量
>
> 推荐选择：B，因为它最符合你描述的“尽量留住客户，但避免持续超卖”。

### Initial question rules

* Ask about the user's desired behavior, business objective, or product decision.
* Put the highest-impact ambiguity first.
* Prefer one question; use up to three only when the questions are tightly related.
* Provide a recommended interpretation when useful.
* Make the answer easy, such as yes/no, `A / B / C`, or a concrete value.
* Do not ask the user to identify files, components, frameworks, database tables, routes, or implementation details.
* Do not ask questions that can later be answered by inspecting the repository.
* Do not ask broad questions such as “还有其他需求吗？”
* Do not inspect or modify the repository before the initial intent question has been answered.
* Do not repeat questions already answered in the current conversation.

After asking the initial question, wait for the user's answer.

## Phase 2: Inspect the repository

After the user confirms or clarifies their intent, inspect the repository using read-only operations.

### 1. Read project instructions and current state

Read, when present:

* `CLAUDE.md`
* `.claude/CLAUDE.md`
* Relevant files under `.claude/rules/`
* `README.md`
* Architecture, setup, contribution, and deployment documentation
* Package manifests and lockfiles
* Build, lint, test, and type-check configuration
* Environment example files
* Database schemas and relevant migrations
* Current `git status`
* Relevant uncommitted diffs using read-only commands

Never expose secrets.

Prefer `.env.example`, documented variable names, configuration schemas, or code references. Do not print values from real environment files.

### 2. Build an architecture map

Identify the relevant parts of the project, including:

* Frameworks, languages, runtime, and package manager
* Application entry points
* Frontend pages, routes, components, forms, and state management
* Backend routes, controllers, services, jobs, and webhooks
* Database models, schemas, migrations, and persistence flow
* Authentication and authorization
* External APIs
* Payments
* Email and notification systems
* File storage
* Admin interfaces
* Exports and reporting
* Tests and existing implementation conventions related to the request

### 3. Trace the relevant flow end to end

Read the complete business flow affected by the request.

Depending on the task, this may include:

`UI -> client state -> validation -> API request -> backend route -> service logic -> database -> external integration or webhook -> response -> email -> admin display`

Do not rely only on filenames, search results, or isolated snippets.

Read enough relevant code to understand:

* Current behavior
* Data shape
* Validation rules
* Dependencies
* Side effects
* Error handling
* Permissions
* Persistence behavior
* Existing tests
* Shared utilities and conventions

### 4. Scan intelligently

Understanding the repository means:

* Scan the overall project structure.
* Identify the architecture and existing conventions.
* Deeply read the business flow relevant to the request.
* Inspect neighboring code that may be affected.
* Search for existing patterns before proposing new logic.

Do not waste context reading irrelevant or generated content such as:

* `node_modules/`
* Build outputs
* Cache directories
* Vendored dependencies
* Minified bundles
* Generated files
* Large binary assets
* Unrelated historical migrations
* Unrelated fixtures or archived code

For large repositories, use staged inspection:

1. Map the repository.
2. Locate the relevant business flow.
3. Trace the flow end to end.
4. Inspect shared dependencies and neighboring behavior.
5. Review relevant tests and conventions.

## Phase 3: Identify unresolved questions

Compare the user's confirmed intent with the repository's actual behavior.

Determine whether any unresolved decisions could materially affect implementation.

Potential areas include:

* Exact desired behavior
* Business rules
* Edge cases
* Permissions
* Validation behavior
* Error handling
* Data persistence
* Existing-data migration
* Backward compatibility
* API contract changes
* UI states
* Loading, empty, success, and failure states
* Email or notification behavior
* Admin behavior
* Webhook behavior
* Reporting or export behavior
* Third-party integration behavior
* Concurrency or idempotency
* Rollout and compatibility concerns
* Acceptance criteria

### Repository-first rule

Before asking a question:

1. Search the repository for the answer.
2. Inspect the relevant implementation and existing conventions.
3. Check whether the user's earlier messages already answered it.
4. Infer the answer when strongly supported by the codebase and confirmed intent.
5. Ask only when a meaningful product or business decision remains unresolved.

Do not ask the user questions about:

* Which file to modify
* Which component to use
* Which framework the project uses
* Which database table stores the data
* Where a route is implemented
* Existing project conventions
* Technical details that can be discovered from the repository

### Assumption rules

* Infer details that are strongly supported by the repository.
* Prefer existing architecture and conventions.
* Reuse existing components, services, schemas, and utilities when appropriate.
* Do not invent a parallel implementation when an established pattern already exists.
* Clearly identify any material assumption used during implementation.
* Do not present guesses as repository facts.
* Do not ask the user to confirm low-impact technical details that can safely follow existing conventions.

## Phase 4: Decide whether more questions are needed

### When unresolved questions exist

Ask only the questions that can materially change implementation.

Question rules:

* Ask between 1 and 7 questions.
* Use fewer questions whenever possible.
* Put the highest-impact question first.
* Group closely related questions.
* Briefly explain why a question matters when the reason is not obvious.
* Give a recommended choice based on the repository and the user's confirmed intent.
* Make answers easy, such as `A / B / C`, yes/no, or a concrete value.
* Do not repeat previously answered questions.
* Do not include speculative or low-impact questions.
* Do not ask for a second general confirmation after the user answers all necessary questions.

Use this response structure for Chinese requests:

### 1. 代码库检查结果

Briefly summarize:

* Relevant architecture
* Current behavior
* Affected business flow
* Important existing conventions
* Concrete files or modules when useful

### 2. 仍需确认的问题

Ask only the unresolved questions.

For example:

1. 当旧数据缺少新字段时，应如何处理？

   * A. 使用默认值并保持兼容
   * B. 强制执行一次数据迁移
   * 推荐：A，因为当前代码已经对其他可选字段采用兼容读取。

End with:

> 请回答上面的问题。你回答后，我会直接按确认后的规则实施，不再重新整理或 Promptlize 需求。

### When no unresolved questions exist

Do not invent questions.

Do not ask the user for another confirmation.

Briefly state:

* The user's intent is clear.
* The repository does not reveal additional product decisions that require clarification.
* The implementation scope you will follow.
* The main affected modules or business flow.

Then finish this alignment workflow and proceed with implementation.

Use this format for Chinese requests:

### 1. 代码库检查结果

Summarize the relevant architecture, current behavior, and affected flow.

### 2. 对齐结果

State:

> 你的意图已经明确，代码库中没有发现需要你进一步决定的开放问题。我会按以下范围直接实施：

Then provide a concise implementation scope.

Do not ask a question at the end.

## Phase 5: Implementation after alignment

Once the initial intent and all necessary questions have been resolved:

1. Treat the user's confirmed intent and answers as the source of truth.
2. Briefly state the implementation plan and affected areas.
3. Exit the requirement-alignment stage.
4. Implement the change end to end.
5. Preserve unrelated behavior.
6. Follow existing architecture and project conventions.
7. Avoid duplicate or parallel logic.
8. Add or update validation and error handling where necessary.
9. Add database migrations only when required.
10. Explain migration and rollback behavior when applicable.
11. Run appropriate validation, such as:

    * Targeted tests
    * Unit tests
    * Integration tests
    * Linting
    * Type checks
    * Builds
    * Database validation
    * Targeted manual verification
12. Report:

    * What changed
    * Which files or modules were affected
    * What validation was performed
    * Any remaining limitations or risks

Do not restart requirement alignment after the user answers the questions.

Restart this workflow only when the user introduces:

* A materially different objective
* A conflicting business rule
* A substantial scope expansion
* A new feature or task
* A requirement that invalidates the previously aligned behavior

Small corrections, wording clarifications, and implementation-level feedback do not require restarting the full workflow.

## Required behavior summary

For each new coding task:

1. First ask about and align the user's intent.
2. Wait for the user's answer.
3. Inspect the repository using read-only operations.
4. Ask only questions that the repository and confirmed intent cannot answer.
5. If there are no additional questions, do not ask any.
6. Do not Promptlize or rewrite the user's request into a separate prompt.
7. Once everything is clear, proceed directly with implementation.
