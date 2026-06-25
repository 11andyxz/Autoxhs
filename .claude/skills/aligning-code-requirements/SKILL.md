---
name: aligning-code-requirements
description: Analyzes each new coding request against the current repository, rewrites vague or fragmented user instructions into a precise implementation brief, and asks focused questions before any code changes. Use at the start of every new feature, bug fix, refactor, UI change, database change, API integration, automation task, or other material requirement change. Do not invoke again after the user has explicitly confirmed the current brief unless the requirements change.
when_to_use: Trigger when the user describes a new coding task in natural language, incomplete notes, screenshots, examples, mixed Chinese and English, or follow-up messages that materially change scope. Skip when the current task has already been aligned and the user is explicitly confirming execution.
disallowed-tools:
  - Write
  - Edit
  - NotebookEdit
---

# Requirement Alignment Workflow

## Core rule

For every new coding request or material requirement change, complete this workflow before implementation.

During the alignment turn:

- Do not edit, create, rename, move, or delete project files.
- Do not run commands that mutate files, dependencies, databases, infrastructure, Git history, or external services.
- Do not start implementation, even when the request appears simple.
- Use read-only inspection to understand the repository and the user's intent.
- After the user confirms the aligned requirements, proceed with implementation without repeating this workflow unless the scope changes materially.

## Phase 1: Understand the repository

Inspect the codebase before interpreting the request.

### 1. Read project instructions and current state

Read, when present:

- `CLAUDE.md`, `.claude/CLAUDE.md`, and relevant `.claude/rules/`
- `README.md` and architecture or setup documentation
- Package manifests and lockfiles
- Build, lint, test, deployment, and environment example files
- Database schemas and migrations
- Current `git status` and relevant uncommitted diff, using read-only commands

Never expose secrets. Prefer `.env.example` or documented variable names. Do not print values from real environment files.

### 2. Build an architecture map

Identify the project's:

- Frameworks, languages, and package manager
- Application entry points
- Frontend pages, routes, components, and state management
- Backend routes, controllers, services, jobs, and webhooks
- Database models, schemas, migrations, and persistence flow
- External APIs, authentication, payments, email, storage, and other integrations
- Tests and existing patterns related to the request

### 3. Read the relevant flow end to end

Trace the complete path affected by the request, such as:

`UI -> client state -> API request -> validation -> service logic -> database -> webhook or external service -> response -> email/admin display`

Do not rely only on filenames or isolated snippets. Read enough of each relevant file to understand actual behavior, data shape, dependencies, and side effects.

### 4. Scan intelligently

“Understand the whole codebase” means:

- Scan the overall repository structure and architecture.
- Deeply read the business flow relevant to the request.
- Inspect neighboring code that establishes conventions or shared behavior.

Do not waste context reading generated or irrelevant content such as:

- `node_modules/`
- Build outputs and caches
- Vendored dependencies
- Minified bundles
- Generated files
- Large binary assets
- Unrelated historical migrations or fixtures

For a large repository, use staged inspection rather than attempting to read every line.

## Phase 2: Infer and analyze the request

Use the repository as evidence to infer what the user most likely wants.

Determine:

- The user's business objective
- Current behavior
- Desired behavior
- Affected users and workflows
- Functional scope
- Explicit non-goals
- Data and persistence changes
- UI and UX changes
- API, webhook, email, admin, export, and reporting impact
- Backward compatibility and migration concerns
- Validation, error handling, permissions, and security implications
- Test and acceptance criteria
- Likely files or modules involved

Search for existing implementation patterns before proposing new architecture. Prefer consistency and reuse over introducing a parallel system.

### Assumption rules

- Infer details that are strongly supported by the codebase or the user's examples.
- Clearly label every material assumption.
- Do not present guesses as confirmed facts.
- Do not ask the user questions that the repository can answer.
- Ask the user only about product decisions, business rules, ambiguous behavior, or tradeoffs that cannot be resolved from code.
- When multiple interpretations exist, explain the most likely one and recommend a default.

## Phase 3: Promptlize the user's message

Rewrite the user's original message into a precise, implementation-ready requirement prompt.

The rewritten prompt must:

- Preserve the user's actual intent.
- Remove conversational ambiguity and fragmented wording.
- Include relevant repository context discovered during inspection.
- Separate confirmed requirements from assumptions.
- Describe current behavior and desired behavior.
- Cover all affected layers, not only the visible UI.
- Include edge cases and acceptance criteria.
- State that implementation must preserve unrelated behavior.
- Avoid inventing requirements that lack evidence.

Use this structure:

```text
请基于当前项目完成以下修改。

在修改代码前，请先阅读并遵守项目中的 CLAUDE.md、README、现有架构、数据库结构、相关前后端业务链路和测试约定。

一、背景与目标
- 当前行为：...
- 目标行为：...
- 业务目的：...

二、功能需求
1. ...
2. ...

三、影响范围
- 前端：...
- 后端：...
- 数据库：...
- 第三方集成 / Webhook / 邮件 / 后台：...

四、业务规则与边界情况
- ...

五、兼容性与限制
- 保持无关功能不变。
- 复用现有架构和组件，不创建重复逻辑。
- 不泄露或硬编码密钥。
- 如需数据库迁移，说明迁移与回滚策略。

六、验收标准
- ...

七、当前假设
- ...

在我确认需求之前，不要修改代码。
```

Adapt the sections to the task. Do not include empty or irrelevant sections merely to follow the template.

## Phase 4: Ask focused alignment questions

After presenting the rewritten requirement, ask only the questions that can materially change implementation.

Question rules:

- Ask between 1 and 7 questions in most cases.
- Group related questions together.
- Put the highest-impact question first.
- For each question, briefly explain why it matters when the reason is not obvious.
- Give a recommended default based on the current codebase and common project conventions.
- Make answers easy, such as `A / B / C`, yes/no, or a concrete value.
- Do not ask broad questions such as “还有其他需求吗？”
- Do not ask the user to identify files, frameworks, database tables, or implementation details that can be discovered from the repository.
- Do not repeat a question already answered in the conversation or codebase.

If the requirement is already unambiguous, do not invent questions. Ask only for final confirmation and state the recommended implementation scope.

## Phase 5: Required response format

Respond in the user's language. For Chinese requests, use this format:

### 1. 我对当前项目的理解

Summarize the relevant architecture and existing behavior in concise bullets. Mention concrete files or modules when useful.

### 2. 我对你需求的理解

Explain the likely intent, scope, assumptions, and any conflicts or hidden impact discovered from the code.

### 3. Promptlized 需求

Provide the complete rewritten implementation prompt in one copyable code block.

### 4. 需要你确认的问题

Ask the focused questions and include a recommended choice for each.

### 5. 确认方式

End with:

> 请回答上面的问题，或者直接回复“确认，按推荐方案执行”。在你确认之前，我不会修改代码。

## After confirmation

When the user confirms the aligned brief:

1. Treat the latest confirmed brief and answers as the source of truth.
2. Briefly summarize the final implementation plan and affected files.
3. Implement the change end to end.
4. Run appropriate tests, linting, type checks, builds, or targeted verification.
5. Report what changed, validation performed, and any remaining limitations.

Do not restart requirement alignment after a simple confirmation. Restart it only when the user introduces a material scope change, a conflicting requirement, or a new task.
