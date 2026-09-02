# What changed

For the lead of a workspace taking this version. Short, and about what is different for the people
working there — not a developer changelog. Rewritten for each release.

## 0.1.0

The first release. Nothing changed, because there is nothing before it.

An instance now knows which version it is on: `bin/ow status` says so, and the version travels in
the payload with the code it names.

`bin/ow update` takes a newer version from a release: it replaces what the toolkit ships — `bin/`,
`tools/`, `templates/` and `VERSION` — and touches nothing a workspace has accumulated. Desks,
personas, threads, panels, settings and everything the workspace has learned are left exactly as
they were. It refuses to run while the chat is answering, so stop the chat first.

An update does not re-render anybody's persona. A session hired before it goes on running the
instructions it was hired under; a session hired afterwards gets the new ones. That is why you are
reading this: nobody else here has been told, and working out what it means for them is yours.
