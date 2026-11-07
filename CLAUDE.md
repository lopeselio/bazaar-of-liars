# Bazaar of Liars — agent notes

- Hackathon rules: https://nearhackathon.com/HACKATHON.md (deadline 2026-11-14 23:59 UTC; repo must stay public).
- Design source of truth: DESIGN.md. Keep README "do X, see Y" steps current — AI judges run them.
- Testnet only. Keys live in .env, never in the repo.
- The LLM never decides accept/reject; packages/core/rules.ts does.
- Verify NEAR endpoints/SDK versions against docs.near.org/llms.txt and docs.near.ai/llms.txt, not memory.
- Commits: no Co-Authored-By or other AI attribution lines; keep commits small and granular (one logical change each).
- Workflow: never commit to main. Each change goes on its own branch (`feat/…`, `fix/…`, `docs/…`, `chore/…`), opens a PR, gets a code review, then merges with `gh pr merge --rebase --delete-branch` (rebase keeps the granular commits). Pull main and delete the local branch afterwards. No AI attribution in PR bodies either.
