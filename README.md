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

Copyright (c) Microsoft Corporation. All rights reserved.

Licensed under the [MIT](LICENSE) License.

Microsoft, Windows, Microsoft Azure and/or other Microsoft products and services referenced in the documentation
may be either trademarks or registered trademarks of Microsoft in the United States and/or other countries.
The licenses for this project do not grant you rights to use any Microsoft names, logos, or trademarks.
Microsoft's general trademark guidelines can be found at http://go.microsoft.com/fwlink/?LinkID=254653.

Privacy information can be found at https://privacy.microsoft.com/en-us/

Microsoft and any contributors reserve all others rights, whether under their respective copyrights, patents,
or trademarks, whether by implication, estoppel or otherwise.
