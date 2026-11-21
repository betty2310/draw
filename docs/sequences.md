# Sequence diagrams

These diagrams show the main flows of the app, as the code on `main` does them. The components and the message names are described in [architecture.md](architecture.md).

The participants:

| Name | Code |
| --- | --- |
| Editor | `apps/web/src/Editor.tsx` with Excalidraw |
| Sync | `ProjectSync` in `apps/web/src/sync.ts` |
| IDB | IndexedDB in the browser (idb-keyval) |
| Worker | The Hono app in `packages/server/src/index.ts` |
| DO | The `ProjectRepo` Durable Object of the project, `packages/server/src/project-repo.ts` |
| D1 | The D1 database with the `projects` table |

## Contents

- [Open the project list](#open-the-project-list)
- [Open a project](#open-a-project)
- [Autosave](#autosave)
- [Close the tab during a change](#close-the-tab-during-a-change)
- [Offline then reconnect](#offline-then-reconnect)
- [Save with an old hash (conflict)](#save-with-an-old-hash-conflict)
- [Second browser and Take over](#second-browser-and-take-over)
- [Paste an image](#paste-an-image)
- [Name a version (Ctrl+S)](#name-a-version-ctrls)
- [Preview a version](#preview-a-version)
- [Restore a version](#restore-a-version)
- [Create a branch](#create-a-branch)
- [Rename a branch](#rename-a-branch)
- [Delete a branch](#delete-a-branch)
- [Delete of old versions (alarm)](#delete-of-old-versions-alarm)

## Open the project list

The project list reads only D1. It does not wake a Durable Object.

```mermaid
sequenceDiagram
  autonumber
  actor U as Person
  participant App as React app
  participant W as Worker
  participant D1

  U->>App: open /
  alt no display name in localStorage
    App-->>U: WelcomePage asks for the name and an optional email
    U->>App: Continue
    App->>App: store draw.author and draw.email in localStorage
  end
  App->>W: GET /api/projects
  W->>D1: CREATE TABLE IF NOT EXISTS projects (one time for each Worker instance)
  W->>D1: SELECT * FROM projects WHERE deleted_at IS NULL ORDER BY updated_at DESC
  D1-->>W: rows
  W-->>App: Project[] with thumbnails
  App-->>U: project cards
  U->>App: New project
  App->>W: POST /api/projects with the name
  W->>D1: INSERT INTO projects
  W-->>App: 201 Project
  App->>App: navigate to /p/id
```

## Open a project

The editor shows the local copy first, then the server tells the role and sends the scene if it is different.

```mermaid
sequenceDiagram
  autonumber
  participant E as Editor
  participant S as Sync
  participant IDB
  participant W as Worker
  participant DO as ProjectRepo
  participant D1

  E->>W: GET /api/projects/id
  W->>D1: SELECT the project
  W-->>E: name for the status bar
  E->>S: new ProjectSync(projectId, branch, author)
  par
    S->>IDB: get scene:projectId:branch
    IDB-->>S: LocalCopy (json, baseHash, dirty) or nothing
  and
    E->>E: setupFonts() loads DFVN Excalifont, Geist, Geist Mono
  end
  E->>E: show Excalidraw with the local copy
  E->>S: connect() in onInitialize
  S->>W: WebSocket /api/projects/id/ws with branch, author, client, known=baseHash
  W->>DO: getByName(id).fetch(upgrade request)
  DO->>DO: branch exists? first socket of the branch is the editor
  DO->>DO: acceptWebSocket, serializeAttachment(client, author, branch, editor)
  DO-->>S: hello (role, editor name, head, imageIds)
  alt head.hash differs from known
    DO-->>S: scene frame (head + gzip scene)
    S->>S: gunzip, baseHash = head.hash
    alt editor with unsaved local changes
      S->>E: applyRemote(json, merge=true) with reconcileElements
      S->>S: changed(), save the merge
    else no local changes
      S->>E: applyRemote(json, merge=false)
      S->>IDB: write the local copy
    end
  else same hash and local copy is dirty
    S->>DO: save frame at once
  end
  E->>E: load missing images, status Saved or Read-only
```

## Autosave

Each change goes to IndexedDB at once and to the server 2 seconds after the last change. The 5 minute rule decides if the save writes into the open version or adds a version.

```mermaid
sequenceDiagram
  autonumber
  actor U as Person
  participant E as Editor
  participant S as Sync
  participant IDB
  participant DO as ProjectRepo
  participant V as Viewers of the branch
  participant O as Sockets of other branches
  participant W as Worker and D1

  U->>E: draw
  E->>E: onChange, sceneKey changed?
  E->>S: changed()
  S->>IDB: set scene:projectId:branch (json, baseHash, dirty=true)
  S->>S: restart the 2 s timer, status Saving
  Note over U,S: more changes restart the timer
  S->>S: timer fires
  S->>S: upload new images (see Paste an image)
  S->>DO: save frame (baseHash, gzip scene)
  DO->>DO: hash = SHA-256(scene)
  DO->>DO: socket is editor? branch exists? head.hash equals baseHash?
  alt newest version is open (less than 5 min, no name, no branch from it, same author)
    DO->>DO: UPDATE versions SET scene, hash, updated_at
  else
    DO->>DO: INSERT INTO versions (new version)
  end
  DO-->>S: saved (head)
  DO-->>V: scene frame (head + scene)
  opt a new version was added
    DO-->>O: history
    DO->>DO: set the cleanup alarm in 1 day if none is set
  end
  S->>S: baseHash = head.hash, dirty = false if no change during the save
  S->>IDB: write the local copy (dirty=false)
  S->>E: onSaved, status Saved
  opt branch is main
    E->>E: at most each 10 s, exportScene PNG 320 px
    E->>W: PATCH /api/projects/id with thumb
    W->>W: UPDATE projects SET thumb, updated_at
  end
```

The thumbnail goes to D1, not to the Durable Object. The new `updated_at` moves the project to the top of the list.

## Close the tab during a change

```mermaid
sequenceDiagram
  autonumber
  actor U as Person
  participant E as Editor
  participant S as Sync
  participant IDB
  participant DO as ProjectRepo

  U->>E: draw a shape
  E->>S: changed()
  S->>IDB: write the local copy (dirty=true)
  U->>E: close the tab before the 2 s timer
  E->>S: pagehide / visibilitychange
  S->>IDB: write the local copy again if dirty
  Note over S,DO: the server does not have the shape
  U->>E: open the project again
  S->>IDB: load the local copy (dirty=true)
  E->>E: show the shape
  S->>DO: connect with known = baseHash
  DO-->>S: hello, head.hash equals baseHash
  S->>DO: save frame with the shape
  DO-->>S: saved
```

## Offline then reconnect

```mermaid
sequenceDiagram
  autonumber
  actor U as Person
  participant S as Sync
  participant IDB
  participant DO as ProjectRepo

  alt the browser goes offline
    S->>S: offline event, drop the socket
  else the network stops without an event
    S->>DO: ping (each 15 s)
    Note over S: no pong in 5 s
    S->>S: drop the socket
  end
  S->>S: status Offline, saved in this browser
  U->>S: draw
  S->>IDB: write each change (dirty=true)
  Note over S: saves wait, the socket is not open
  loop reconnect after 0.5 s, 1 s, 2 s ... at most 10 s
    S->>DO: WebSocket with known = baseHash
  end
  Note over S: the online event connects at once
  DO-->>S: hello (role, head)
  alt head.hash equals baseHash (nobody saved meanwhile)
    S->>DO: save frame with the offline changes
    DO-->>S: saved
  else a different browser saved meanwhile
    DO-->>S: scene frame with the server scene
    S->>S: reconcileElements(local, server), keep both
    S->>DO: save frame with the merge and the new baseHash
    DO-->>S: saved
  end
```

The same flow runs after a deploy, which closes all WebSockets. A page that connects again has the same `client` id, so it keeps its edit lock.

## Save with an old hash (conflict)

```mermaid
sequenceDiagram
  autonumber
  participant S as Sync (editor)
  participant DO as ProjectRepo

  S->>DO: save frame (baseHash = H1)
  DO->>DO: head.hash is H2, not H1
  DO-->>S: conflict (head H2)
  DO-->>S: scene frame (head H2 + scene)
  S->>S: baseHash = H2
  S->>S: applyRemote(json, merge=true) with reconcileElements
  S->>S: changed(), the 2 s timer starts
  S->>DO: save frame (baseHash = H2, merged scene)
  DO-->>S: saved (head H3)
```

## Second browser and Take over

One person edits a branch. The edit lock is in the WebSocket attachment, so it stays through hibernation.

```mermaid
sequenceDiagram
  autonumber
  actor A as Betty (browser A)
  actor B as Minh (browser B)
  participant DO as ProjectRepo

  A->>DO: connect (client a)
  DO-->>A: hello role=editor, editor=Betty
  B->>DO: connect (client b)
  DO-->>B: hello role=viewer, editor=Betty
  B->>B: read-only canvas, Read-only. Betty edits. with Take over
  A->>DO: save frame
  DO-->>A: saved
  DO-->>B: scene frame, B shows the change about 2 s after A stops
  B->>DO: takeover
  DO->>DO: attachment of b: editor=true, attachment of a: editor=false
  DO-->>B: role editor (editor=Minh)
  DO-->>A: role viewer (editor=Minh)
  A->>A: read-only, unsaved changes stay in IndexedDB (dirty)
  B->>DO: save frame
  DO-->>A: scene frame
  A->>DO: takeover (later)
  DO-->>A: role editor
  DO-->>B: role viewer
  A->>A: merge its dirty local copy into the scene, save
  Note over A,DO: when the editor closes, viewers get role with editor=null
```

## Paste an image

```mermaid
sequenceDiagram
  autonumber
  participant E as Editor (editor)
  participant S as Sync
  participant IDB
  participant W as Worker
  participant DO as ProjectRepo
  participant V as Viewer

  E->>E: paste an image, Excalidraw gives a file id from the content
  E->>S: changed()
  S->>IDB: set file:projectId:fileId (dataURL)
  S->>IDB: write the local copy
  Note over S: 2 s later, before the save
  S->>W: PUT /api/projects/id/images/fileId (only if not in hello.imageIds)
  W->>W: larger than 1.5 MB? 413
  W->>DO: putImage RPC
  DO->>DO: INSERT OR IGNORE INTO images
  W-->>S: 204
  S->>DO: save frame with the scene that uses the image
  DO-->>V: scene frame
  V->>V: image not in memory
  V->>IDB: file:projectId:fileId?
  V->>W: GET /api/projects/id/images/fileId (up to 5 tries, 2 s apart)
  W->>DO: getImage RPC
  W-->>V: image, Cache-Control immutable
```

## Name a version (Ctrl+S)

```mermaid
sequenceDiagram
  autonumber
  actor U as Person
  participant E as Editor
  participant S as Sync
  participant W as Worker
  participant DO as ProjectRepo
  participant All as All sockets of the project

  U->>E: Ctrl+S
  E-->>U: dialog Name this version
  U->>E: type the name, Save name
  E->>S: flush()
  S->>DO: save frame at once (if dirty)
  DO-->>S: saved (head)
  S-->>E: resolved, headVersionId
  E->>W: PATCH /api/projects/id/versions/headVersionId with the name
  W->>DO: nameVersion RPC
  DO->>DO: UPDATE versions SET name
  DO-->>All: history
  W-->>E: VersionInfo
  All->>All: History panels reload
  Note over DO: a name closes the version, the next save adds a new version
```

## Preview a version

```mermaid
sequenceDiagram
  autonumber
  actor U as Person
  participant H as History panel
  participant E as Editor
  participant W as Worker
  participant DO as ProjectRepo

  H->>W: GET /api/projects/id/branches
  H->>W: GET /api/projects/id/versions with all=1 and limit=100
  W->>DO: listBranches and listVersions RPC
  W-->>H: branches and versions
  H->>H: layoutGraph, one lane for each branch
  U->>H: click a version row
  H->>E: actions.preview(version)
  E->>W: GET /api/projects/id/versions/versionId/scene
  W->>DO: getVersionScene RPC
  W-->>E: gzip scene
  E->>E: gunzip, show a second read-only Excalidraw over the canvas
  E-->>U: Restore this version, Create branch from this version, Close preview
```

## Restore a version

Restore adds a new version with a copy of the old scene. No version is removed.

```mermaid
sequenceDiagram
  autonumber
  actor U as Person (editor)
  participant E as Editor
  participant S as Sync
  participant DO as ProjectRepo
  participant V as Viewers of the branch
  participant O as Sockets of other branches

  U->>E: Restore this version, confirm
  E->>S: restore(versionId)
  opt unsaved local changes
    S->>DO: save frame
    DO-->>S: saved, the changes stay in the history
  end
  S->>DO: restore (versionId, baseHash)
  DO->>DO: socket is editor? head.hash equals baseHash? version in this branch?
  alt check fails
    DO-->>S: error, or conflict with the current scene
  else
    DO->>DO: INSERT a new version with the old scene and hash, author = this person, no name
    DO-->>S: scene frame restored=true
    DO-->>V: scene frame restored=true
    DO-->>O: history
    DO->>DO: set the cleanup alarm if none is set
    S->>S: dirty = false, replace the scene
    S->>E: applyRemote(json, merge=false)
  end
```

## Create a branch

```mermaid
sequenceDiagram
  autonumber
  actor U as Person
  participant E as Editor (branch main)
  participant S as Sync
  participant W as Worker
  participant DO as ProjectRepo
  participant All as All sockets of the project
  participant E2 as New editor (branch new)

  U->>E: Create branch from this version, type the name
  opt the version is the current version
    E->>S: flush()
    S->>DO: save frame
    DO-->>S: saved
  end
  E->>W: POST /api/projects/id/branches (name, fromVersionId, author)
  W->>DO: createBranch RPC
  DO->>DO: name empty? 400. name exists? 409. version missing? 404
  DO->>DO: INSERT INTO branches (name, from_version_id)
  DO->>DO: INSERT the first version of the branch with a copy of the scene
  DO-->>All: history (source branch), branches (all)
  DO->>DO: set the cleanup alarm if none is set
  W-->>E: 201 BranchInfo
  E->>E: navigate to /p/id?branch=new, the History panel stays open
  E->>S: stop(), close the socket of main
  E2->>DO: connect with branch=new
  DO-->>E2: hello role=editor (first socket of the branch), head
  DO-->>E2: scene frame
```

## Rename a branch

```mermaid
sequenceDiagram
  autonumber
  participant E as Editor
  participant W as Worker
  participant DO as ProjectRepo
  participant S as Sync of each browser on the branch
  participant IDB

  E->>W: PATCH /api/projects/id/branches/old with name new
  W->>DO: renameBranch RPC
  DO->>DO: main? 400. new name exists? 409
  DO->>DO: UPDATE branches and versions SET name/branch = new
  DO->>DO: serializeAttachment(branch = new) on each open socket of the branch
  DO-->>S: branches renamed (old to new)
  S->>S: branch = new, the socket stays open
  S->>IDB: move scene:id:old to scene:id:new
  S->>S: the page changes the URL to ?branch=new
  W-->>E: BranchInfo
```

## Delete a branch

```mermaid
sequenceDiagram
  autonumber
  actor U as Betty
  participant E as Editor of Betty
  participant W as Worker
  participant DO as ProjectRepo
  participant M as Minh, viewer of the branch
  participant IDB as IndexedDB of Minh

  U->>E: Delete branch, confirm
  E->>W: DELETE /api/projects/id/branches/name
  W->>DO: deleteBranch RPC
  DO->>DO: main? 400. missing? 404
  DO->>DO: DELETE versions of the branch (also named), DELETE the branch row
  DO-->>M: branches deleted=name
  DO->>M: close the socket with code 4004
  M->>IDB: delete scene:id:name
  M->>M: open main with a notice The branch was deleted
  W-->>E: 204
  E->>E: open main, no notice
  Note over DO: a browser that connects later to the deleted branch gets branches deleted and close 4004, then opens main
```

## Delete of old versions (alarm)

The first new version sets an alarm for one day later. The alarm deletes versions with no name that were last saved more than 30 days ago, and keeps the newest version of each branch and each version that a branch starts from.

```mermaid
sequenceDiagram
  autonumber
  participant S as Sync (editor)
  participant DO as ProjectRepo
  participant SQL as SQLite of the object
  participant RT as Durable Object runtime
  participant All as Open sockets

  S->>DO: save, restore or create branch adds a version
  DO->>RT: getAlarm()
  alt no alarm
    DO->>RT: setAlarm(now + 1 day)
  end
  Note over RT: one day later, the object wakes if it is not in memory
  RT->>DO: alarm()
  DO->>SQL: DELETE FROM versions WHERE name = '' AND updated_at older than 30 days AND id NOT IN protected
  Note over SQL: protected = MAX(id) of each branch, and each from_version_id
  opt rows deleted
    DO-->>All: history
  end
  DO->>SQL: is there a version with no name that is not protected?
  alt yes
    DO->>RT: setAlarm(now + 1 day)
  else no
    Note over DO: no alarm, the project does not wake each day
  end
```
