# TypeScript LSIF indexer

Visit https://lsif.dev/ to learn about LSIF.

## Installation

This project is a bugfix fork of [microsoft/lsif-node](https://github.com/microsoft/lsif-node) that has been altered to work with [Sourcegraph](https://sourcegraph.com).

Currently, this project is not published to npm and must be installed from source. To do so, simply run the following in the project root.

```bash
npm install
npm run compile
```

This will populate the files library files referenced by the wrapper scripts `./tsc/bin/lsif-tsc` and `./npm/bin/lsif-npm`.

## Indexing your repository

```
$ /path/to/lsif-node/tsc/bin/lsif-tsc --noContents -p . --stdout | /path/to/lsif-node/npm/bin/lsif-npm --stdin --out dump.lsif
```

In order to work correctly with LSIF dump roots on a Sourcegraph instance, you should **always** `cd` into the project root and supply `projectRoot` as the current directory (`.`). Supplying a `projectRoot` value other than the current directory will cause a mismatch in document URIs that will be unresolvable at query time.

If the project provides and npm package or is depending on other npm modules the TypeScript monikers can be converted into stable npm monikers. To do so run

Use `/path/to/lsif-node/tsc/bin/lsif-tsc --help` for more information.

# Legal Notices

This code was originally authored by Microsoft. This code is released under the [MIT License](./LICENSE).
