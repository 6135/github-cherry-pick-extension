# GitHub Cherry-Pick

Browser extension. It adds a **Cherry-pick** button on GitHub commit pages and checkboxes on pull request commit lists. It applies the commits to a new branch through the GitHub REST API, then opens GitHub's "Open a pull request" form. You click **Create pull request**.

Works on github.com and GitHub Enterprise Server, in Chrome/Edge and Firefox 140+. The target can be another repo or fork on the same host (`owner/repo:branch`).

## Log in

Each user logs in with their own GitHub account (OAuth device flow). The token stays in the browser and only the background script uses it.

- Scope `public_repo` (public repos only) or `repo` (public and private; this gives access to all your private repos).
- **Log out** deletes the local token only. Revoke it on GitHub at **Settings → Applications**.

### Use your own OAuth App

Required for GitHub Enterprise hosts. Optional for github.com.

1. Open `https://<host>/settings/applications/new`. The callback URL can be any URL.
2. Turn on **Enable Device Flow**.
3. Paste the client ID in the extension settings for that host. A new client ID logs you out of that host.

## Limits

- Conflicts are not resolved. The dialog shows the local git commands to use.
- Merge commits are not supported.
- Commits that change `.github/workflows/*` are rejected (the token has no `workflow` scope).
- Commits that are already in the target are skipped.
- The new commits are not signed, so GitHub does not show them as "Verified". Repos that require signed commits reject them.
- Cross-repo picks copy the changed files (transplant). Renames on the target side are not detected, so they can give a conflict that `git cherry-pick` would not give.
- When you cannot push to the target repo, the branch goes to your fork. If you have no fork, the pick fails.
- CI that runs on `push` to any branch can run on the temporary commit of the new branch.

## Commands

```
npm test              # unit tests (the engine runs against a fake GitHub backed by real git repos)
npm run build         # dist/firefox and dist/chromium
npm run lint          # Mozilla add-on linter on dist/firefox
npm run package       # zips in web-ext-artifacts/
npm run start:firefox # test Firefox profile with the add-on loaded
```

Release: push a tag that matches the manifest version, for example `git tag v0.1.0 && git push origin v0.1.0`.
