# lsif-npm
> *Languag Server Index Format tool for npm*

### Requirements

- [Node.js](https://nodejs.org/en/) at least `10.x.x`

### About

This tool supports rewriting monikers from the tsc scheme to the npm scheme.

See also the [Language Server Index Format Specification](https://github.com/Microsoft/language-server-protocol/blob/master/indexFormat/specification.md)

### How to Run the Tool

The easiest way to run the tool is to install the latest version (which are pre-release version starting with 0.x right now). For example `npm install -g lsif-npm`. Then create a LSIF dump for TypeScript using [lsif-tsc](https://github.com/microsoft/lsif-node/blob/master/tsc/README.md) and store it to a file using `--out` option. Something like `lsif-tsc -p .\tsconfig.json --out dump.lsif`. To make the monikers npm specific use the created dump as an input to the lsif-npm tool. Something like `lisf-npm --in .\dump.lsif --package .\package.json --stdout` which print the dump with both tsc and npm monikers to stdout. Also of interest could be the overall [readme](https://github.com/microsoft/lsif-node/blob/master/README.md)