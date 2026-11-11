#!/bin/bash
# TEST app only: lets the emulator check read its screen (web view inspection on). It holds only invented test data and a
# throwaway test key; your real app's release build keeps inspection off.
set -euo pipefail
node -e 'const f="android/app/src/main/assets/capacitor.config.json",fs=require("fs"),c=JSON.parse(fs.readFileSync(f,"utf8"));c.android={...(c.android||{}),webContentsDebuggingEnabled:true};fs.writeFileSync(f,JSON.stringify(c,null,2));console.log("TEST app: inspection on (test data only)")'
