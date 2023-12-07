# lsif-npm

_Language Server Index Format tool for npm_

### Requirements

- [Node.js](https://nodejs.org/en/) at least `10.x.x`

### About

This tool rewrites monikers from the tsc scheme to the npm scheme.

See also the [Language Server Index Format Specification](https://github.com/Microsoft/language-server-protocol/blob/master/indexFormat/specification.md)

### How to Run the Tool

The tool got now integrated into the `lsif-tsc` tool. Simply use the `--package` command line option of the `lsif-tsc` tool.

You can still use the tool to post process a dump that got created using lsif tsc without emitting npm monikers. Then simply use a command like this `lsif-npm --in .\dump.lsif --package .\package.json --stdout`.