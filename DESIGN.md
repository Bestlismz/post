# POC design decision

The POC exists to answer one question. Can one Docker deployment preserve a user-authenticated browser session, scan one authorized group, prepare a reply, require exact human confirmation, attempt one submission, and retain enough state to avoid a duplicate after a retry or restart?

## Chosen shape

One container runs the Node application, headed Chromium, Xvfb, x11vnc, and noVNC. The application is the only public port. It proxies noVNC and disconnects desktop sockets before Playwright takes the browser lease. Chromium owns a persistent profile volume. The application owns a separate durable state volume.

The workflow data shape is:

```text
Target -> versioned Draft -> immutable Review -> Submission
Submission = attempted | verified | unknown
```

A target key combines mode, group ID, post ID, and optional comment ID. One target can have at most one submission row for the lifetime of the state volume. The application writes `attempted` before the remote click. A crash or ambiguous result becomes `unknown`; the application never retries it automatically.

The frontend has one route through the experiment. The operator opens the desktop, signs in, binds one group, scans, selects a target, generates and edits a draft, reviews the exact destination and message, checks the confirmation box, and submits once.

## Alternatives

The two-container design isolates the browser more cleanly and is the better production direction. It lost for this POC because CDP readiness, noVNC proxying, and cross-container lifecycle add work without increasing the strength of the first experiment.

A model-controlled browser was rejected. The model only produces text. Playwright owns navigation and submission through deterministic selectors.

## What this does not prove

The fixture proves the workflow, restart behavior, and duplicate lock. It does not prove that current Facebook markup exposes stable identifiers or selectors. Live mode remains an authorized manual smoke test and fails closed when selectors or identity are ambiguous.

