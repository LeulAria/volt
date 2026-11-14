#!/bin/zsh
# Interleaved over-delegation probe. usage: dbatch.sh <from> <to> <arm,arm,...> [task,task,...]
# arms: base (volt-e5-base text and plugin), orch (this tree), tok (this tree's task tools and instructions with
# e5/tokens' hooks plugin, which compacts the deferred Volt tool names: the merged state); a "desc" suffix
# a "w" suffix (tokw) applies plugin-replace.txt to the hooks plugin; a "desc" suffix (tokdesc, orchdesc) swaps in the delegate_task description in desc.txt; tb = volt-e5-base task tools and refusals with e5/tokens' plugin.
here=${0:a:h}
B=/Users/leularia/Desktop/VOLT/volt-e5-base/out O=/Users/leularia/Desktop/VOLT/volt-e5-orch/out T=/Users/leularia/Desktop/VOLT/volt-e5-tokens/out
unset ELECTRON_RUN_AS_NODE
tasks=${4:-chart,browser}
for i in $(seq $1 $2); do
  for arm in ${(s:,:)3}; do
    case $arm in
      base*) out=$B plug=$B;; orch*) out=$O plug=$O;; tok*) out=$O plug=$T;; tb*) out=$B plug=$T;;
    esac
    desc=""; [[ $arm == *desc ]] && desc=$(cat $here/desc.txt)
    repl=""; [[ $arm == *w ]] && repl=$(cat $here/plugin-replace.txt)
    for t in ${(s:,:)tasks}; do PLUGIN_REPLACE=$repl DELEGATE_DESC=$desc PLUGIN_OUT=$plug node $here/dprobe.mjs $arm $out $t $i & done
  done
  wait
done
