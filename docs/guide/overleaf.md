# Overleaf sync

Lattice syncs with Overleaf both ways. Your co-authors keep working on Overleaf and don't need Lattice; their edits, comments, chat and tracked changes show up in Lattice as they happen.

## Connect

Open **Settings › Overleaf** and choose **Connect to Overleaf**. You sign in on Overleaf's own page; Lattice never sees your password.

![Settings › Overleaf with Connect to Overleaf, Sync mode and the delete rule](images/en-overleaf-settings.webp)

## Open an Overleaf project

1. Choose **Open from Overleaf** in the project menu or the **File** menu, or click the cloud button in the title bar.
2. Search your projects, or paste a project's link. Projects shared with you as invitations are listed too; accept the invitation on Overleaf first.
3. Choose **Download to** for where the local copy goes, then open the project.

Lattice downloads it into an ordinary folder and keeps that folder linked. If you already have a local copy, **Link this folder** connects it instead of downloading again.

## Put a local project on Overleaf

With the project open, open the same Overleaf panel and choose **Upload this project to Overleaf**, give it a name, then **Upload and connect**.

## How sync behaves

Set in **Settings › Overleaf**:

- **Sync mode**: **Live sync** sends and receives edits as you type. **Manual** syncs only when you choose **Sync now**.
- **When you delete a file here**: **Ask before deleting** (the default), **Delete on Overleaf too**, or **Keep it on Overleaf**.

When the same file changed on both sides while you were offline, Lattice merges what it can. If it can't, Overleaf's version goes into the project and yours is saved beside it as a "(local conflict …)" file, so nothing is lost.

Comments and suggestions from Overleaf appear in the margin of the source and in the Overleaf panel (Comments, Suggestions and Chat). **View › Margin Review** chooses how much the margin shows.

## Sync through git

If your Overleaf plan includes the git integration, a linked project can sync through Overleaf's git bridge instead. Lattice then syncs the project's own git repository, so your commits and their history reach Overleaf.

1. In Overleaf, create a git token under **Account Settings › Git integration**.
2. With the project open, go to **Settings › Overleaf › Git sync**, set **Sync files with** to **Git bridge**, paste the token into **Git token** and choose **Save**. The token is kept in the macOS keychain.

In this mode you commit your own work, and **Sync with Overleaf** fetches Overleaf's commits, merges them and pushes yours. Lattice never commits your edits for you: files with uncommitted changes are listed after a sync, and they don't go to Overleaf. Live editing, chat and comments are off, and syncing is always manual. In **History › Versions**, commits that are on Overleaf but not yet merged are marked **On Overleaf, not merged yet**.

When you and a co-author changed the same lines, the merge stops and the conflict resolver opens on the file, so you can choose your text, Overleaf's, or both for each marked spot. A notice then stays up until you choose one of its two buttons:

- **Finish merge** commits the merge and sends it to Overleaf. It refuses while a file still has conflict markers. A figure or PDF that changed on both sides keeps your version.
- **Cancel merge** puts the project back as it was before the sync, and drops the spots you resolved. Overleaf keeps its changes, and the next sync merges them again.

If you close the resolver before you're done, choose **Sync with Overleaf** again to reopen it.
