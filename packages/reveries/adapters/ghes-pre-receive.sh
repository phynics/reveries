#!/bin/sh
set -eu

# Git invokes pre-receive with the bare repository as cwd and sends
# old-object new-object ref lines on stdin. The checker reads only objects;
# it never updates a ref before Git accepts the whole receive transaction.
exec reveries receive-check "$@"
