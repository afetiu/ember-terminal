---
name: check-todos
description: Go through recent email, Slack, Jira and GitHub, add the things the user has to act on to the Ember todo list, and tick the items that have since been handled. Use when the user types /check-todos, says "check my todos", "what do I need to do", "go through my mail/slack/jira/github for todos", or when Ember's Check todos button runs this.
---

<!-- installed by Ember; edit freely, Ember will not overwrite a file that has lost this line -->

# Check todos

Two jobs, in this order: tick the open items that have since been handled, and add what
the user must **do** from what arrived since the last check. Nothing else. Never send or
reply to anything, never mark anything read, never archive, move, transition or delete.
Reading only, then `todo done` and `todo add`.

## 0. Which sources, and since when

The arguments name the sources for this machine, any of `gmail`, `outlook`, `slack`,
`jira`, `github` (Ember passes the ones ticked in its Settings > Todo; `todo check gmail`
passes one). Read only those. With no source named, read every one you have a tool for.
A named source you have no tool for is reported at the end, not searched for elsewhere.

`since=<ISO time>` is when this machine last checked. Read only what is newer than that.
With no `since`, this is the first run: read the last three days.

## 1. Mail

- `gmail`: the Gmail connector — search threads newer than `since` (or `newer_than:3d`)
  and read subject, sender and the first lines of each. Open a full thread only when the
  summary is ambiguous.
- `outlook`: a Microsoft 365 / Outlook tool — list the inbox messages since then the
  same way.

## 2. Slack

- `slack`: a Slack tool — mentions of the user and direct messages since then.

## 2b. Jira

- `jira`: the Atlassian connector (`mcp__claude_ai_Atlassian__*` tools). Issues assigned
  to the user that are open, issues where they were mentioned in a comment since `since`,
  and anything with a due date inside the next week. If only `authenticate` is offered,
  the connector is not signed in: report that, do not guess.

## 2c. GitHub

- `github`: the `gh` CLI, already signed in on this machine (`gh auth status`). Read:

  ```
  gh search prs --review-requested=@me --state=open --json repository,number,title,updatedAt,url
  gh search prs --author=@me --state=open --json repository,number,title,reviewDecision,statusCheckRollup,url
  gh search issues --assignee=@me --state=open --json repository,number,title,updatedAt,url
  gh api notifications -f all=false -f since=<since>
  ```

  A review requested of the user, one of their own PRs with changes requested or failing
  checks, an issue assigned to them, and a mention in a notification are the things that
  become items. Keep the repo and number in the item text.

## 3. Decide

A message becomes a todo when a person is asking the user for something, is waiting on a
reply, a decision or a deliverable from them, or names a date the user has to meet.
Newsletters, notifications, receipts, calendar noise and anything automated never do.
When in doubt, leave it out — a short list that is right beats a long one.

## 4. Do not repeat what is there, and tick what is done

Run `todo list --all` first. It prints open items and, marked `[x]`, the ones already
ticked. Both count as handled: skip anything matching either (same person and same
subject, even if worded differently). A thread that already has a ticked item gets a new
one only if a newer message in it asks for something new.

Then go through the **open** items that came from a source you are reading and look at
that source for evidence the user has already done them. This is what stops the list
becoming a graveyard:

- mail: a reply from the user in the thread after the message that asked
- Slack: a reply from the user in the thread or channel after the ask
- Jira: the issue is resolved, closed, or no longer assigned to the user
- GitHub: the PR is merged or closed, the review the user was asked for has been
  submitted, the checks are green again, the issue is closed

For each one that is clearly done, `todo done "<a few words from the item>"`. Clearly:
when you are not sure, leave it open. Never tick an item you cannot trace to a source
(one the user typed themselves), and never tick because it looks old.

## 5. Add

One item per thing, most urgent first, at most ten in one run. Phrase each as an action
the user can tick off, with who and where, and end it with a markdown link to the
source, so the list can open it: the Jira issue, the PR or issue, the mail thread
(`https://mail.google.com/mail/#all/<threadId>` for Gmail, the message's web link for
Outlook), the Slack permalink. For example:

```
todo add "Reply to Blerim about the invoice, 2 Sep [Mail](https://mail.google.com/mail/#all/18f2c3a9b1)"
todo add "Review Guri's PR radix-platform#521 [GitHub](https://github.com/org/radix-platform/pull/521)"
todo add "Answer Noah on DE-862, native S3 or the EBS pin [Jira](https://org.atlassian.net/browse/DE-862)"
```

The link is the last thing on the line and the only link on it. Without a URL to hand,
leave it off rather than invent one.

If `todo` is not on PATH (this is not an Ember shell), append the same items as lines of
the form `- [ ] …` to `~/Documents/Ember Notes/Todo.md` (create it with a `# Todo` first
line if it does not exist).

## 6. Report

End with a short report and nothing else: the items ticked as done, the items added, the
number skipped as already present, and any source you could not read with the one step
that would fix it (`/mcp` to authenticate, `claude mcp add ...`, or `gh auth login`).
