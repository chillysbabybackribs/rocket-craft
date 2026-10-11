import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parsePatch, patchTotals } from './patch.ts'

const PATCH = `diff --git a/server.js b/server.js
index 1111111..2222222 100644
--- a/server.js
+++ b/server.js
@@ -1,4 +1,5 @@
 // A small notes API
 import { createServer } from 'node:http'
+import { scryptSync } from 'node:crypto'

-const notes = []
+const notes = [] // { id, userId }
@@ -10,3 +11,3 @@ createServer((req, res) => {
   if (req.method === 'GET') {
-    return res.end('[]')
+    return res.end(JSON.stringify(notes))
   }
\\ No newline at end of file
diff --git a/test/auth.test.js b/test/auth.test.js
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/test/auth.test.js
@@ -0,0 +1,2 @@
+import { test } from 'node:test'
+test('x', () => {})
diff --git a/old.txt b/old.txt
deleted file mode 100644
index 4444444..0000000
--- a/old.txt
+++ /dev/null
@@ -1 +0,0 @@
-gone
diff --git a/logo.png b/logo.png
index 5555555..6666666 100644
Binary files a/logo.png and b/logo.png differ
`

test('a git patch is read into files, kinds, counts and numbered lines', () => {
  const files = parsePatch(PATCH)
  assert.deepEqual(files.map((file) => [file.path, file.kind, file.added, file.removed, file.hunks.length]), [
    ['server.js', 'edited', 3, 2, 2],
    ['test/auth.test.js', 'added', 2, 0, 1],
    ['old.txt', 'deleted', 0, 1, 1],
    ['logo.png', 'binary', 0, 0, 0]
  ])
  const [first] = files[0]!.hunks
  assert.equal(first!.header, '@@ -1,4 +1,5 @@')
  assert.deepEqual(first!.lines.map((line) => [line.type, line.old, line.new]), [
    [' ', 1, 1], [' ', 2, 2], ['+', null, 3], [' ', 3, 4], ['-', 4, null], ['+', null, 5]
  ])
  assert.equal(first!.lines[2]!.text, "import { scryptSync } from 'node:crypto'")
  // The second hunk starts where its header says, and the no-newline marker is not a line.
  const second = files[0]!.hunks[1]!
  assert.deepEqual(second.lines.map((line) => [line.type, line.old, line.new]), [[' ', 10, 11], ['-', 11, null], ['+', null, 12], [' ', 12, 13]])
  assert.deepEqual(patchTotals(files), { files: 4, added: 5, removed: 3 })
})

test('an empty patch is no files', () => {
  assert.deepEqual(parsePatch(''), [])
  assert.deepEqual(patchTotals([]), { files: 0, added: 0, removed: 0 })
})
