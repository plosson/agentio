# Multi-Repository Skills Support

## Overview

Make the skill install command support multiple GitHub repositories as skill sources, presenting all skills as a unified flat list to users.

## Registry Structure

Built-in registry in `src/commands/skill.ts`:

```typescript
interface SkillSource {
  repo: string;       // e.g., 'plosson/agentio'
  basePath: string;   // e.g., 'claude' or '' (root)
}

const SKILL_SOURCES: SkillSource[] = [
  { repo: 'plosson/agentio', basePath: 'claude' },
  { repo: 'openprose/prose', basePath: '' },
];
```

Each source defines:
- `repo`: GitHub repository in `owner/repo` format
- `basePath`: Path prefix to skills/commands folders (empty string for root)

Folder resolution:
- agentio: `claude/skills/`, `claude/commands/`
- prose: `skills/`, `commands/`

## Install Behavior

When installing a skill `foo`:
1. Find which source contains `{basePath}/skills/foo/`
2. Copy to `.claude/skills/foo/`
3. Check if `{basePath}/commands/foo/` exists in same source
4. If yes, copy to `.claude/commands/foo/`

## Function Changes

### `fetchGitHubContents(repo, repoPath)`
Add `repo` parameter instead of using constant.

### `listAvailableSkills()`
Aggregate skills from all sources into flat list.

### `findSkillSource(skillName)`
New helper to locate which source contains a skill.
Returns `{ source: SkillSource; hasCommands: boolean } | null`.

### `downloadSkillFolder()`
Update to accept source and handle both skills/commands paths.

### `installSkill()`
Use `findSkillSource()` to locate skill, download both folders when commands exist.

## Error Handling

- Skill not found in any source → error with available skills list
- GitHub API fails for one source → log warning, continue with others
- Commands folder doesn't exist → silently skip (optional)

## Files Changed

- `src/commands/skill.ts` - all changes in this file
