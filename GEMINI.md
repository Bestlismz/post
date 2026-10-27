# Agent instructions

## Project knowledge (model-kb)

This repository keeps one shared KB in `model-kb/` for every person and every agent working here.

1. Before work, run `python3 model-kb/tools/kb_sync.py status`. If teammates pushed commits that are not yet in
   the KB, run `python3 model-kb/tools/kb_sync.py pull`, fold the digest it prints into the relevant `model-kb/`
   pages, then run `python3 model-kb/tools/kb_sync.py mark`.
2. Read `model-kb/README.md` and only the topics relevant to the task.
3. After a material change, update the relevant topic and add one entry with
   `python3 model-kb/tools/kb_sync.py log "<summary>"`; commit it together with the change.
4. Before pushing, run `status` again; if upstream moved, pull and reconcile the KB first.
