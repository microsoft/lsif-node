# Language Server Index Format

The purpose of the Language Server Index Format (LSIF) is it to define a standard format for language servers or other programming tools to dump their knowledge about a workspace. This dump can later be used to answer language server [LSP](https://microsoft.github.io/language-server-protocol/) requests for the same workspace without running the language server itself. Since much of the information would be invalidated by a change to the workspace, the dumped information typically excludes requests used when mutating a document. So, for example, the result of a code complete request is typically not part of such a dump.

A first draft specification can be found [here](https://github.com/Microsoft/language-server-protocol/blob/master/indexFormat/specification.md).

## How to Run the tools

- `> npm install -g lsif` to install the LSIF tool chain.
- `> lsif tsc -p .\tsconfig.json --stdout` creates a LSIF dump for the given typescript project. Output format is new line separated JSON.

If the project provides and npm package or is depending on other npm modules the TypeScript monikers can be converted into stable npm monikers. To do so you can either ask the tsc tool to already do that using

- `> lsif tsc -p .\tsconfig.json --package .\package.json --stdout`

or you can run the tool separate in case you want to inspect the newly generated NPM monikers using

- `lsif tsc -p .\tsconfig.json --stdout || lsif npm --stdin --package .\package.json --stdout`

Please note that the tools are work in progress and that we have not done any extensive testing so far. Known issues are:

1. Go to Declaration for function overloads doesn't honor the signature
1. Go to Type Declaration is not fully implement
1. Document link support and go to implementation is completely  missing

Both tools support --help to get information about their command line arguments.

## LSIF utility tools

You can validate LSIF output using the [LSIF utility tools](tooling/README.md).

## LSIF extension

There is also an [extension for VS Code](https://github.com/Microsoft/vscode-lsif-extension) that can serve the content of a LSIF JSON file. Consider you have dumped the content of a workspace into an LSIF JSON file then you can use the extension to serve the supported LSP requests. This works as follows:

- follow the steps in 'How to Run the tools` above and create a dump.
- `> git clone https://github.com/Microsoft/vscode-lsif-extension.git`
- `> cd vscode-lsif-extension`
- `> npm install`
- `> npm run compile`
- open the workspace on vscode-lsif-extension using code.
- switch to the debug viewlet and launch `Launch Client`
- in the launch version of VS Code open the command palette and execute the command: `Open LSIF Database`
- in the open file picker dialog navigate to a created dump and select it.

![The extension](./images/extension.png)

# Contributing

This project welcomes contributions and suggestions.  Most contributions require you to agree to a
Contributor License Agreement (CLA) declaring that you have the right to, and actually do, grant us
the rights to use your contribution. For details, visit https://cla.microsoft.com.

When you submit a pull request, a CLA-bot will automatically determine whether you need to provide
a CLA and decorate the PR appropriately (e.g., label, comment). Simply follow the instructions
provided by the bot. You will only need to do this once across all repos using our CLA.

This project has adopted the [Microsoft Open Source Code of Conduct](https://opensource.microsoft.com/codeofconduct/).
For more information see the [Code of Conduct FAQ](https://opensource.microsoft.com/codeofconduct/faq/) or
contact [opencode@microsoft.com](mailto:opencode@microsoft.com) with any additional questions or comments.

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
