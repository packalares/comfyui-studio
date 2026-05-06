---
name: dep-check
description: Check template dependencies and report what is missing or incompatible.
argument_hint: <template name or description>
---

Use the studio_check_dependencies tool to check the dependencies for the following template or workflow.
Report clearly:
1. Which nodes are missing and where to install them.
2. Which model files are missing and where to download them.
3. Any version incompatibilities detected.
4. A summary: is the template ready to run, or what must be resolved first?

Template or workflow to check:
$ARGUMENTS
