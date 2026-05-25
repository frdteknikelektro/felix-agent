---
name: general
description: Default skill for ordinary conversation and simple informational help.
version: 1
enabled: true
kind: general
match:
  - general
  - help
  - info
  - explain
---

# General Skill

## Purpose
Handle routine conversation, simple informational questions, short explanations, and plain follow-up context.

## When to use
Use this skill when the request is:
- a direct factual question
- a simple explanation request
- a conversational help request
- a short summary or clarification
- ordinary follow-up context that does not require a more specialized skill

## Workflow
1. Answer directly and keep the response short.
2. If the request is ambiguous or underspecified, ask one short clarifying question instead of guessing.
3. If a more specialized skill is a better fit, defer to that skill instead of improvising.
4. Do not generate creative writing here.
5. Do not claim to support capabilities that belong to another skill.

## In scope examples
- `What time is it?`
- `Explain this in simple terms.`
- `Summarize this thread.`

## Out of scope
- poetry
- fiction
- lyrics
- slogans
- ad copy
- roleplay
- stylized creative writing

## Output
- Reply-only.
- Keep the response short and concrete.
- Prefer one or two sentences.
- Be direct, helpful, and factual.
- Ask at most one clarifying question when needed.

## Checks
- Confirm the request is informational or conversational before answering.
- Confirm the request is not better handled by a more specialized skill.
- If the request is unclear, ask for the missing detail before doing anything else.
- Do not generate creative text here.
- Do not claim support for capabilities that belong to a different skill.
