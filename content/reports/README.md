# Weekly Intelligence Briefings

Drop weekly report content here. Each report is a data object in the `WEEKLY_REPORTS` array inside `index.html`.

## How to Add a New Weekly Report

1. Open a Claude session and say: "Read the weekly report skill and generate this week's report"
2. Claude reads `_claude/skills/WEEKLY_REPORT_SKILL.md` and generates the report data object
3. The object gets added to the FRONT of the `WEEKLY_REPORTS` array (newest first)
4. Set `isCurrent: true` on the new one, `false` on the previous current
5. The Weekly Report page auto-renders it with archive tabs

## Report File Format

Reports are stored as JavaScript objects (not separate files). The skill file at `_claude/skills/WEEKLY_REPORT_SKILL.md` has the full schema.

## Current Reports

- Vol. 43: Mar 17-21, 2026 (Current)
- Vol. 42: Mar 10-14, 2026 (Archive)

## Weekly Cadence

Generate a new report every Monday covering the previous week. Include:
- Market Pulse (heartbeat, breadth, mood)
- Crypto Corner (chart, smart money, gossip, price table)
- Strategic Focus (3 timely topics with beginner breakdowns)
- Capital Migration (sector rotation analysis)
- Pocket Glossary (4-6 terms)
