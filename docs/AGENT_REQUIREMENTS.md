# Requirements for AI agents on a building automation system

A page an owner or engineer can put in a controls standard. It names no product. Anything that connects an AI agent to a building automation system should meet every line.

## Identity

1. Each agent signs in as its own user, not as a person and not as a shared account.
2. That user has only the permissions its job needs, set in the system's own roles.
3. An agent can be switched off, and can be given an end date, without touching any other user.
4. An agent's reach can be limited to the part of the system it is working on.

## Changes

5. Every change an agent makes or asks for carries a reason in plain words.
6. For each kind of work (commanding points, schedules, alarms, files, programming, discovery, tags), the owner chooses one of: refused, waits for a person, or allowed.
7. A command to a point is held inside stated limits: the point's own range, and any narrower range the owner sets for agents.
8. Emergency-priority commands are refused unless the owner turns them on.
9. An agent cannot approve its own change, and cannot change the rules it works under.
10. The number of changes an agent may make in a minute is limited.

## Approval

11. A change that waits for a person shows who asked, what would change, why, and what could not be undone afterwards.
12. An approved change is made with the approver's permissions and recorded under the approver's name.
13. A change that is waiting survives a restart of the system, and expires if nobody decides.
14. Whoever must approve is told without having to go and look, through the system's normal alarm routing.

## Record and undo

15. Every agent action is recorded in the system's own audit history: who, what, why, and the outcome, including refusals.
16. Each change can be listed afterwards and put back in one step by a person, or says plainly why it cannot be.
17. A change is not put back over newer work without a person saying so.
18. After a command, the system looks again and records whether the result was as expected.

## Proof

19. The owner can ask what the system would do with a given change by a given agent, and which rule decides, without the change being made.
20. With nothing configured, an agent can change nothing.
