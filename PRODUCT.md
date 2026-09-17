# SCH-LOOP

## What it is

An autonomous software-development loop. You give it one sentence; it produces a specification, a plan, a
queue of tickets, and working code that passed a review it did not write.

The rule the whole system rests on: **code decides, models advise.** Every verdict a model returns is
evidence for a decision made in JavaScript. The Builder writes, the Judge grades, the Manager decides, and
they are three separate processes. The one that produced the work can never approve it.

## Who uses it

One developer, on their own machine, running several projects at once. They are not watching the loop
work — that is the point of it. They come back to it: between meetings, after lunch, the next morning.

The two questions they arrive with, in this order:

1. **Is anything wrong?** Something blocked, something waiting on me, something burning money.
2. **How far has it got?** Which project, which phase, what did it cost, how long is left.

They are a terminal person. They have `progress` and `log` in a shell already. The dashboard exists for the
thing a terminal is bad at: **many projects at once**, and **an overview they can read in three seconds
from across the room.**

## The surfaces

- **Home** — every project on the machine. Status first, progress second, detail third.
- **Project** — one project in full: what is building right now, every phase and ticket with timings and
  cost, the seats it runs with, its event log.
- **Global settings** — the seat defaults a project inherits until it chooses its own.

## What is true about the data

- A project is **running, idle, blocked, or waiting on a human.** Those are not severities; blocked and
  waiting-on-a-human are the two that need a person, and they are different needs.
- Progress is a fraction of tickets, and tickets are grouped into ordered phases.
- Everything is **measured, never estimated**: durations come from an event stream, cost from delivery
  reports. If a number is shown, a run produced it.
- Money is real and worth showing. So is time. A phase that took fifteen minutes of work spread over six
  hours is a normal and useful thing to say.

## Constraints

- **Local only.** One Node http server, loopback, no build step, no framework, no dependencies. The page
  is one file of vanilla HTML, CSS and JS served as a string.
- **No network at runtime** beyond a Google Fonts stylesheet.
- It reads durable state the loop already writes. It never invents a number.

## The incumbent visual world

A terminal operations console, and that is deliberate — it lives beside the CLI that produced it.

- near-black ground `#0a0a0a`, panels `#121212`, hairlines `#282828`
- **red `#ff2a2a` is structure**, not decoration: the rule under the header, the left edge of a locked
  seat, the ticket id
- **terminal green `#4af626` means live and good**
- amber for in-flight, blue for informational
- monospace throughout, Archivo Black for the wordmark and seat names
- scanline overlay, bracketed section labels `[ INSTALLED ]`, a blinking liveness dot

## What is wrong with it today

- Dark only. The user asked for a light mode.
- Not responsive: fixed-ish rows, tables that do not reflow, a layout that assumes a wide screen.
- The information structure is flat. Home does not lead with what is wrong. The project view is a long
  scroll where a blocked ticket looks the same as a finished one.

*Assumption, from the brief rather than an interview: the user reads this on a desktop most of the time
and a phone occasionally, and wants the phone case to work rather than be the primary.*
