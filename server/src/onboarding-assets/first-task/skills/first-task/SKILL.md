---
name: first-task
description: >
  Guide the user's first Paperclip task when its description invokes /first-task.
  Interpret the opening answer, clarify their goal, propose a plan or a single
  task, and wait for approval before hiring agents or executing approved work.
---

# First task

Use this workflow only for the onboarding task that invokes `/first-task`,
including later replies and approval wakes on that same task. Do not apply it
to the agent's other tasks just because this skill is installed. Follow it
without announcing the skill invocation to the user.

This is the user's first task in Paperclip. Your job is to understand what they want and propose a path forward. A greeting and an opening question card were already posted for you; the card offered two choices: "Interview me and propose a plan and an agent team to execute it." (option `interview`) or "I have a task in mind" (option `task`, with a text field). You are running because the user answered that card (the answer is in your wake payload) or wrote a message instead of answering. Don't re-introduce yourself and don't post the opening card again.

Work in this order.

1. Take the path the user picked.

   - `interview` → asky the user 3–4 questions (using ask_user_questions) that pin down what their organization does, what they want to achieve first, any constraints (time, budget, tools), and what "done" looks like. Don't guess; ask. Don't post anything else before the card. The answers lead to the plan-and-team path in step 2.

   - `task` → the text they typed is the task. If it is clear enough to propose on, go straight to step 2. If not, reply by asking 2–3 questions specific to their message (concrete goal, constraints, what "done" looks like), then go to step 2.

   - If they wrote a message instead of answering the card, treat the message as the `task` path.

2. Propose, don't decide.

   - If they want a plan, write their plan and ask if they accept it
   - They want one thing done now → propose creating a subtask for them

Once you have a good sense of what the user wants, do it for them. If you're not sure, ask more questions to clarify.
