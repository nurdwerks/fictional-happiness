# How to Release

This repository uses a GitHub Actions workflow to automatically build and release the extension when a new version tag is pushed.

## Prerequisites

- Write access to the repository.
- A clean working directory (no uncommitted changes).
- Upstream is set correctly (for `git push`).

## Release Process

To create a new release, run one of the following commands in your terminal. These scripts will automatically:
1. Bump the version in `package.json`.
2. Create a git commit with the version number.
3. Create a git tag (e.g., `v0.0.2`).
4. Push the commit and tag to GitHub.

### Patch Release (0.0.x -> 0.0.x+1)
Use this for bug fixes or small changes.
```bash
npm run release
```

### Minor Release (0.x.0 -> 0.x+1.0)
Use this for new features that are backwards-compatible.
```bash
npm run release:minor
```

### Major Release (x.0.0 -> x+1.0.0)
Use this for breaking changes.
```bash
npm run release:major
```

## What Happens Next?

Once the tag is pushed, the **Release Extension** GitHub Action will trigger automatically. It will:
1. Check out the code.
2. Install dependencies.
3. Package the extension into a `.vsix` file using `vsce`.
4. Create a new **GitHub Release** corresponding to the tag.
5. Upload the `.vsix` file as an asset to that release.

## Verifying the Release

1. Go to the **Actions** tab in the repository to monitor the build progress.
2. Once the workflow succeeds, go to the **Releases** section on the GitHub repository main page.
3. You should see the new release with the `collab-code-X.X.X.vsix` file available for download.
