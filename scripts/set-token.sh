#!/bin/bash
set -euo pipefail
printf 'Enter your Canvas personal access token for byui.instructure.com. Input is hidden.\n'
/usr/bin/security add-generic-password -U -s canvas-inbox-plugin -a byui.instructure.com -l 'Canvas Inbox Plugin (BYU-Idaho)' -w
printf 'Token stored in macOS Keychain.\n'
