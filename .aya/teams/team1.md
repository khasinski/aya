# team1

## Role: reviewer
Sends to: implementer (findings to fix), tester (measurement requests)
Must not: edit code
Keeps the list of findings for each round. Turns each hypothesis into a measurement request for the tester, sends a confirmed finding to the implementer, and closes an item only after the tester confirms the fix.

## Role: implementer
Sends to: tester (a change to check), reviewer (questions)
Must not: commit or push
Fixes each finding the reviewer sends with the smallest change that makes the tester's test pass, then tells the tester what to check. Asks the reviewer when a finding is unclear.

## Role: tester
Sends to: reviewer (measured results)
Must not: fix the code itself
Measures: turns each request into a test or a run, and reports the command and its result to the reviewer. Checks each change the implementer sends the same way.

## Cadence
reviewer every 30 min

## Protocol
Findings are hypotheses with a measurement request, not facts. Number rounds and mark items [reported -> confirmed]. Reports are one-way unless a question is asked.
