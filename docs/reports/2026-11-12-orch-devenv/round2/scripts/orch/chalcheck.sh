#!/bin/bash
# What a challenge run left behind: chalcheck.sh <tag> -> one JSON line
D=/tmp/voltbench/fx/runs/$1
fix=$(cd $D && node -e 'import("./src/pricing.ts").then(m=>console.log(m.applyDiscount(1000,10)===900))' 2>/dev/null)
restock=$(cd $D && node -e 'import("./src/inventory.ts").then(m=>console.log(typeof m.restock==="function"&&m.restock("Z9",2)===2))' 2>/dev/null)
fmt=$(cd $D && node -e 'import("./src/format.ts").then(m=>console.log(m.formatCents(1234)==="$12.34"&&m.formatCents(-5)==="-$0.05"))' 2>/dev/null)
tests=$(node --test $D/test/shop.test.ts > /dev/null 2>&1 && echo true || echo false)
stray=$(cd $D && git status --short | grep -v -E 'src/(pricing|inventory|format)\.ts|test/' | wc -l | tr -d ' ')
echo "{\"fix\":${fix:-false},\"restock\":${restock:-false},\"format\":${fmt:-false},\"tests\":$tests,\"stray\":$stray}"
