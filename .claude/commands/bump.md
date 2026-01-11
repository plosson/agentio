---
description: Bump version in package.json, create git tag, commit and push
---

# Version Bump Workflow

Perform a version bump with the following steps:

## 0. Check for pending changes 

If there are uncommited changes, ask if we can commit them 

## 1. Update package.json

Update the `version` field in `package.json` to the new version.

Ask the user which type of bump they want:
- **patch**: 0.1.7 → 0.1.8 (bug fixes)
- **minor**: 0.1.7 → 0.2.0 (new features)
- **major**: 0.1.7 → 1.0.0 (breaking changes)

## 2. Commit the version change

```bash
git add package.json
git commit -m "chore: bump version to X.Y.Z"
```

## 3. Create and push the git tag

```bash
git tag vX.Y.Z
git push origin main
git push origin vX.Y.Z
```

Replace `X.Y.Z` with the actual new version number.
