# Risks and hazards

Read this before you use Cherry-Pick for GitHub. It tells you what the extension can do with your account, what can go wrong, and how to reduce the risk.

## Summary

| Risk | Severity | What you can do |
|---|---|---|
| The token can write to your repos | High | Use "Public repositories only" when you can. Log out when you do not use the extension. |
| Private code can become public | High | Read the warning in the dialog. Check the target before you click. |
| The token is stored in the browser | Medium | Do not use the extension on a shared or untrusted computer. |
| Log out does not cancel the token on GitHub | Medium | Revoke the token on GitHub when you stop using the extension. |
| Device code phishing | Medium | Enter a code on GitHub only when you started the login yourself. |
| Commits are not signed | Low | Repos that require signed commits reject the result. |
| Temporary branches start CI | Low | Use branch filters or concurrency groups in your workflows. |
| Wrong result after a conflict on the target side | Low | Review the PR diff before you merge. |

## 1. Access the extension gets

When you log in, GitHub gives the extension an OAuth token. The token acts as you.

- **"Public repositories only"** gives the `public_repo` scope. The token can write to every public repo that you can write to.
- **"Public and private repositories"** gives the `repo` scope. The token can read and write **all** private repos that you can access, in every organization you belong to. GitHub has no smaller OAuth scope for this.
- The token **does not expire**. It works until you revoke it.
- The extension never asks for the `workflow` scope. So it cannot change files in `.github/workflows/`.

The extension uses the token only to read commits and to create commits, trees, blobs and branches for a pick. It does not create pull requests, merge, delete repos or change settings. But the token itself allows more than the extension uses. If someone steals it, they get all of this access.

## 2. Private code can become public

A pick from one repo into another copies the changed files into the target repo. If the source is private and the target is public, the copied files become **public at once**. They are visible in the new branch even if you never create the pull request.

The extension checks this before it writes anything. If the source is private and the target or your fork is public, it stops and asks you to confirm. Do not click **Pick anyway** unless you are sure the changes can be public.

Other cases the extension does not check:

- A pick from a private repo into another private repo that other people can read (for example, a different organization).
- Commit messages and author names. These are copied too.

A branch that was public once can be cloned or cached by others. Deleting it later does not remove those copies.

## 3. Where the token is stored

The token is stored in the browser's extension storage (`chrome.storage.local`) as plain text. Browsers do not give extensions an encrypted store.

- Only the extension's background script and its own pages read the token. GitHub pages and other extensions cannot read it.
- Any person or program with access to your browser profile files can read it. This includes malware on your computer.

Do not log in on a shared computer. Use a separate browser profile if other people use your computer.

## 4. Logging out

**Log out** deletes the token from the browser only. The extension cannot cancel it on GitHub, because that needs the OAuth App's client secret, and an extension cannot keep a secret.

To cancel the token, open **GitHub → Settings → Applications → Authorized OAuth Apps**, find **Cherry-Pick for GitHub**, and click **Revoke**. Do this:

- when you stop using the extension;
- when you think the token was stolen;
- when you change computers.

## 5. Device code phishing

The login uses GitHub's device flow. You get a code and enter it at `github.com/login/device`.

An attacker can start a device flow with the same public client ID and send you their code, for example in a chat message: "Enter this code to get access". If you enter it, the attacker gets a token with your access, and GitHub shows the name "Cherry-Pick for GitHub" on the approval page.

- Enter a code only when **you** clicked **Log in** in the extension, a moment before.
- Check that the code on GitHub is the same as the code in the extension's login tab.
- Check the scope that GitHub shows before you approve.

## 6. Is the public client ID a risk?

No, not by itself. An OAuth client ID is a name for the app, not a password. Device flow is made for apps that cannot keep a secret, so the client ID is public by design. Anyone can read it from the extension files anyway.

The client ID alone gives no access. A token is created only when a user approves a login on GitHub. The real risk is the phishing in section 5: the attacker uses the public client ID so that the approval page shows a name you trust. The defense is to enter only codes you started yourself.

The OAuth App must never have a client secret in this repo or in the extension. If one was created, delete it on the app's settings page on GitHub.

## 7. Organizations

- Organizations that restrict third-party apps must approve the OAuth App. Until then, their private repos answer "not found".
- Organizations with SAML single sign-on need you to authorize the token for that organization.
- Your organization's security policy may forbid tools that store tokens in the browser. Check before you use the extension on work repos.

## 8. Results to check

- **Conflicts are not resolved.** The extension stops and shows the git commands to use on your computer.
- **Cross-repo picks do not detect renames on the target side.** A change to a file that the target renamed can give a conflict that `git cherry-pick` would not give. Always review the PR's "Files changed" tab.
- **Commits are not signed.** GitHub does not show them as "Verified". Repos that require signed commits reject them.
- **Temporary commits:** during a pick, the new branch briefly points at temporary commits. Workflows that run on `push` to any branch can start on them.

## 9. GitHub Enterprise Server

- Each host needs its own OAuth App. The client ID that you paste decides which app gets your approval. Get it from your GitHub administrator, not from a message.
- When you add a host, the browser asks for access to that host. Add only hosts that you trust.

## 10. Report a security problem

Do not open a public issue for a security problem. Use **Security → Report a vulnerability** on the GitHub repo.
