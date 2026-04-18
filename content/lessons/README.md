# Academy Lessons

Drop lesson content here. Each lesson is a data object in the `ACADEMY_LESSONS` array inside `index.html`.

## How to Add a New Lesson

1. Open a Claude session and say: "Read the lesson skill and create Lesson X about [topic]"
2. Claude reads `_claude/skills/LESSON_SKILL.md` and generates the lesson data object
3. The object gets added to the `ACADEMY_LESSONS` array in `index.html`
4. The Academy page auto-renders it

## Lesson File Format

Lessons are stored as JavaScript objects (not separate files). The skill file at `_claude/skills/LESSON_SKILL.md` has the full schema.

## Current Lessons

1. What is a Stock? (Beginner)
2. What is Cryptocurrency? (Beginner)
3. Reading Stock Charts (Beginner)

## Planned

4. Understanding P/E Ratios (Intermediate)
5. Dollar-Cost Averaging (Beginner)
6. Options Trading 101 (Advanced)
7. Blockchain Infrastructure (Intermediate)
8. Portfolio Management (Intermediate)
9. Algorithmic Strategies (Advanced)
10. Risk Management (Intermediate)
11. Market Orders vs Limit Orders (Beginner)
12. What is a Dividend? (Beginner)
