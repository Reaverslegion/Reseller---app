#!/bin/bash
# TEST-ONLY changes for the emulator test app. Made on GitHub's test machine only; never saved to the repository and
# never in the app you install. Every change only affects plain "http://localhost" addresses, which the real app never uses.
#   1. Fill opens the fake eBay sold pages (http://localhost:8790) instead of www.ebay.co.uk, so tests never touch eBay.
#   2. Android allows the app to talk to "localhost" without encryption (the private test Scan service on the test machine).
#   3. The app's web view may call that http address from its https page.
#   4. The test app's web view can be inspected, so the tests can read the screen (your real app can't be).
set -euo pipefail
stage=${1:?before|android}
if [ "$stage" = before ]; then
  n=$(grep -c '"https://www.ebay.co.uk/sch/i.html?"+(kw?' index.html)
  [ "$n" = 1 ] || { echo "Fill address not found exactly once ($n): update prepare-test-app.sh"; exit 1; }
  sed -i 's#"https://www.ebay.co.uk/sch/i.html?"+(kw?#"http://localhost:8790/sch/i.html?"+(kw?#' index.html
  echo "test app: Fill uses the fake eBay sold pages"
else
  R=android/app/src/main/res; M=android/app/src/main/AndroidManifest.xml; C=android/app/src/main/assets/capacitor.config.json
  mkdir -p $R/xml
  cat > $R/xml/network_security_config.xml <<'XML'
<?xml version="1.0" encoding="utf-8"?>
<network-security-config><domain-config cleartextTrafficPermitted="true"><domain includeSubdomains="false">localhost</domain><domain includeSubdomains="false">127.0.0.1</domain></domain-config></network-security-config>
XML
  grep -q networkSecurityConfig $M || sed -i 's#<application#<application android:networkSecurityConfig="@xml/network_security_config"#' $M
  grep -c 'networkSecurityConfig' $M
  node -e 'const f=process.argv[1],c=JSON.parse(require("fs").readFileSync(f,"utf8"));c.android={...(c.android||{}),allowMixedContent:true,webContentsDebuggingEnabled:true};require("fs").writeFileSync(f,JSON.stringify(c,null,2));console.log("test app config:",JSON.stringify(c.android))' $C
fi
