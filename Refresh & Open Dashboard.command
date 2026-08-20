#!/bin/bash
# Double-click me.
#
# Brings your AI usage data up to date, rebuilds the offline HTML file, then
# opens the live dashboard in your browser. Everything runs on this machine;
# nothing is uploaded. Close the Terminal window (or press Ctrl+C) to stop the
# local server.
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 22.5+ is required and was not found on PATH."
  echo "Install it from https://nodejs.org, then double-click this file again."
  read -r -p "Press return to close." _
  exit 1
fi
export TOKENFLOW_HOME="${TOKENFLOW_HOME:-$PWD/.tokenflow}"
node bin/tokenflow.js up "$@"
status=$?
if [ $status -ne 0 ]; then
  echo
  echo "Exited with status $status."
  read -r -p "Press return to close." _
fi
