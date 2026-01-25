#!/bin/bash
set -e

echo "=== Refresh Hook Tests ==="
echo ""

# Clean state
rm -f .planning/intel/.last_injected_hash.*

echo "1. First call with session_id → should emit"
OUTPUT=$(echo '{"session_id":"sess-A"}' | node bin/intel.js hook refresh)
if echo "$OUTPUT" | grep -q "<codebase-intelligence>"; then
  echo "   ✓ PASS: emitted on first call"
else
  echo "   ✗ FAIL: no output on first call"
  exit 1
fi

echo "2. Same session_id again → should be silent (dedupe)"
OUTPUT=$(echo '{"session_id":"sess-A"}' | node bin/intel.js hook refresh)
if [ -z "$OUTPUT" ]; then
  echo "   ✓ PASS: silent on second call (same session)"
else
  echo "   ✗ FAIL: emitted on second call (should dedupe)"
  exit 1
fi

echo "3. Different session_id → should emit"
OUTPUT=$(echo '{"session_id":"sess-B"}' | node bin/intel.js hook refresh)
if echo "$OUTPUT" | grep -q "<codebase-intelligence>"; then
  echo "   ✓ PASS: emitted for different session"
else
  echo "   ✗ FAIL: no output for different session"
  exit 1
fi

echo "4. Same tag as SessionStart (not codebase-intelligence-refresh)"
OUTPUT=$(echo '{"session_id":"sess-C"}' | node bin/intel.js hook refresh)
if echo "$OUTPUT" | grep -q "<codebase-intelligence>" && ! echo "$OUTPUT" | grep -q "<codebase-intelligence-refresh>"; then
  echo "   ✓ PASS: uses correct tag"
else
  echo "   ✗ FAIL: wrong tag"
  exit 1
fi

echo "5. Contains (refreshed: timestamp) header"
if echo "$OUTPUT" | grep -q "(refreshed:"; then
  echo "   ✓ PASS: has refresh timestamp"
else
  echo "   ✗ FAIL: missing refresh timestamp"
  exit 1
fi

echo "6. Fallback to conversation_id"
rm -f .planning/intel/.last_injected_hash.*
OUTPUT=$(echo '{"conversation_id":"conv-123"}' | node bin/intel.js hook refresh)
if echo "$OUTPUT" | grep -q "<codebase-intelligence>"; then
  echo "   ✓ PASS: works with conversation_id"
else
  echo "   ✗ FAIL: conversation_id fallback broken"
  exit 1
fi

echo "7. Fallback to empty payload (uses pid)"
rm -f .planning/intel/.last_injected_hash.*
OUTPUT=$(echo '{}' | node bin/intel.js hook refresh)
if echo "$OUTPUT" | grep -q "<codebase-intelligence>"; then
  echo "   ✓ PASS: works with empty payload (pid fallback)"
else
  echo "   ✗ FAIL: pid fallback broken"
  exit 1
fi

echo "8. Summary change triggers re-emit within session"
rm -f .planning/intel/.last_injected_hash.*
echo '{"session_id":"sess-D"}' | node bin/intel.js hook refresh > /dev/null
# Modify summary
ORIG=$(cat .planning/intel/summary.md)
echo -e "\n<!-- test change -->" >> .planning/intel/summary.md
OUTPUT=$(echo '{"session_id":"sess-D"}' | node bin/intel.js hook refresh)
# Restore
echo "$ORIG" > .planning/intel/summary.md
if echo "$OUTPUT" | grep -q "<codebase-intelligence>"; then
  echo "   ✓ PASS: re-emits when summary changes"
else
  echo "   ✗ FAIL: didn't re-emit on summary change"
  exit 1
fi

echo "9. SessionStart uses same tag"
OUTPUT=$(echo '{"source":"startup"}' | node bin/intel.js hook sessionstart)
if echo "$OUTPUT" | grep -q "<codebase-intelligence>" && ! echo "$OUTPUT" | grep -q "<codebase-intelligence-refresh>"; then
  echo "   ✓ PASS: SessionStart uses correct tag"
else
  echo "   ✗ FAIL: SessionStart wrong tag"
  exit 1
fi

echo "10. Hash files are per-session"
rm -f .planning/intel/.last_injected_hash.*
echo '{"session_id":"sess-X"}' | node bin/intel.js hook refresh > /dev/null
echo '{"session_id":"sess-Y"}' | node bin/intel.js hook refresh > /dev/null
COUNT=$(ls .planning/intel/.last_injected_hash.* 2>/dev/null | wc -l)
if [ "$COUNT" -eq 2 ]; then
  echo "   ✓ PASS: separate hash files per session"
else
  echo "   ✗ FAIL: expected 2 hash files, got $COUNT"
  exit 1
fi

# Cleanup
rm -f .planning/intel/.last_injected_hash.*

echo ""
echo "=== All 10 tests passed ==="
