---
name: member-deliverable-handoff
description: Hand a deliverable to a human or peer so it actually arrives — a file, screenshot, acceptance sheet, or log that someone else must receive and open. Read this before telling anyone that a file is ready, available at a path, or waiting for them, and before sending an acceptance sample or review asset.
---

# Member Deliverable Handoff

A file that exists on disk has not been delivered. Handing it over is a separate act with a separate result, and only the receiver can confirm it happened.

**This skill covers one case**: you know you owe someone a file, and you are about to choose how to give it. It does **not** cover forgetting that you owe one — no wording prevents that, and treating this skill as a general memory will not help.

## Before You Write The Sentence

If the sentence you are about to send contains a file path, ask: **am I handing over the file, or describing where it lives?**

- Describing where it lives is only useful to someone who is already inside that directory with you.
- The human is not inside it. Neither is a peer in another workspace.

A path in prose reaches them as a string they cannot click. That is the whole failure: the file was written, the path was typed, the work was real, and the deliverable still did not arrive.

## What To Do Instead

Attach it. Pass the file's **absolute path** to the tool that sends your message, so the Host validates it and copies it into the attachment cache — the receiver then gets a download item, not a paragraph.

Write the path in full. A machine commonly holds several directories with the same short name (for example more than one `review-assets/` across different workspaces), so a relative path does not identify a file — it identifies whichever one the reader happens to be standing in. When you name a file in prose as well as attaching it, the name is a convenience; the attachment is the delivery.

## How You Know It Arrived

**You do not.** You cannot see the receiver's screen. "I passed the parameter" and "I wrote the file" are not readings — they are your own actions, and the failure mode being prevented here is precisely a sender who believes their own actions.

The only reading is on the receiver's side: they saw an attachment they could open. So after handing something over, ask them to confirm they got it, and treat their silence as "not confirmed" rather than "delivered".

## Two Failures That Look Alike

When a handoff appears to have failed, separate these before investigating anything:

| What you observe | What it means |
|---|---|
| The send **failed with an error** | You did pass a path, and it was rejected — not absolute, missing, not a regular file, empty, or over the size limit |
| The send **succeeded, but the receiver only got text** | You did not pass the file at all; nothing rejected it, so nothing was checked |

The second one is the common one, and it reads like a mystery ("the tool didn't attach it") when in fact no attachment was ever requested. It is not a broken channel.

## Where Deliverables Belong

Put what a human must receive and open in the shared delivery tree, not in a working directory next to the code. Keep source in progress, build residue, and scratch scripts out of it — an acceptance tree that also holds half-finished work teaches the reader to stop opening it.
