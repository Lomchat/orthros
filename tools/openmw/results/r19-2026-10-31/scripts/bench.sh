#!/bin/bash
while kill -0 3454835 2>/dev/null; do sleep 10; done
/srv/orthros/tools/mem-check.sh -w 24 || exit 3
cd /tmp/orthros-scratch/data-r19/bench && /srv/orthros/tools/with-browser-slot.sh node run-chrome.mjs > chrome.out 2>&1
echo "bench rc=$?" >> chrome.out
