# How to Release

This repository uses a GitHub Actions workflow to automatically build and release the extension when a new version tag is pushed.

## Prerequisites

- Write access to the repository.
- A clean working directory.

## Release Process

1. **Update Version**:
   Update the `version` field in `package.json` to the new version number (following [Semantic Versioning](https://semver.org/)).
   ```json
   {
     "version": "0.0.2",
     ...
   }
   ```

2. **Commit the Change**:
   Commit the version bump.
   ```bash
   git add package.json
   git commit -m "Bump version to 0.0.2"
   git push
   ```

3. **Tag the Release**:
   Create a git tag for the new version. The tag **must** start with `v` (e.g., `v0.0.2`).
   ```bash
   git tag v0.0.2
   git push origin v0.0.2
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
