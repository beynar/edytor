# Security policy

## Supported versions

Edytor is a pre-release. Only the newest `edytor@next` on npm gets fixes; a fix ships as the
next pre-release, with a note in the
[changelog](https://edytor.dev/docs/reference/migration). The untagged `edytor@0.0.11`
predates the current code and is not supported.

## Reporting a vulnerability

Please do not open a public issue. Report it privately through GitHub's
[security advisory form](https://github.com/beynar/edytor/security/advisories/new) (the
repository's **Security** tab, **Report a vulnerability**), with:

- the version (`npm view edytor dist-tags.next`, or the commit);
- what an attacker controls (a document's content, a pasted value, a websocket client, a
  request to the room) and what they gain;
- a reproduction: a document's JSON value, a page, a frame sequence or a test.

You should get an answer within a week. Once a fix is released, the advisory is published with
credit to you unless you ask otherwise.

## Scope

In scope: the editor package (`edytor`, `edytor/protocol`, `edytor/crdt`) and the room
(`edytor/cloudflare`): script injection through content, links, embeds, pastes or labels; a
client writing as another user, past its read-only access or past a room's quotas; a room
crashing, storing unbounded data or answering with more than a request should cost; a document
that a well-formed sequence of edits corrupts.

Out of scope: your own `authorize` function and host Worker, the demo deployments, and
denial of service that needs more traffic than the room's documented quotas let through.

What the room bounds by default is listed in
[the room's quotas](https://edytor.dev/docs/server/room#quotas) and
[the comments' quotas](https://edytor.dev/docs/server/comments#quotas).
